// The setup hotspot (ADR-007, stage 4): on first boot with no network, the
// box opens its own Wi-Fi network, and a phone that joins it from the QR code
// on the TV gets the captive page, where it picks the home Wi-Fi. Opening
// the network, its addresses and its firewall holes is root's job
// (bin/agentv-hotspot, run by agentv-hotspot.service): it says how things
// stand in /run/agentv-hotspot, and this reads that. The daemon can't touch
// NetworkManager, so the home Wi-Fi's name and password go the way the
// provider key goes: a drop in its own private state, which
// agentv-hotspot.path hands to root.
//
// After setup, Settings changes the Wi-Fi through the same drop, with the
// hotspot closed (daemon/network.ts): a look at the networks nearby, and a
// join. Root says which network the TV is on and how the last join went.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The box's own address on its hotspot, where the captive page is.
export const HOTSPOT_ADDRESS = "10.42.0.1";

export interface HotspotState {
  on: boolean;
  ssid: string | null;
  password: string | null;
  // The home Wi-Fi it's joining now, the one it joined and its address
  // there, and why the last try didn't work.
  joining: string | null;
  joined: { ssid: string; address: string | null } | null;
  error: string | null;
}

export interface Network {
  ssid: string;
  signal: number;
  secure: boolean;
}

// Why a join didn't work: the password, a network out of reach, or anything
// else.
export type JoinProblem = "password" | "missing" | "failed";

// What root says about the TV's own Wi-Fi, for Settings.
export interface RadioState {
  // The network the TV is on, when root last looked or joined.
  wifi: string | null;
  // Whether the TV has Wi-Fi at all, or null before root has looked.
  has: boolean | null;
  // Why the last join didn't work.
  why: JoinProblem | null;
}

export interface HotspotOptions {
  state: string; // the daemon's own state: the drop goes in <state>/hotspot-drop
  run?: string; // what agentv-hotspot writes: /run/agentv-hotspot
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

// A Wi-Fi network's name: 1 to 32 bytes, with nothing that isn't text.
export function validSsid(ssid: unknown): ssid is string {
  return typeof ssid === "string" && ssid.length > 0 && Buffer.byteLength(ssid) <= 32 && !/[\u0000-\u001f\u007f]/.test(ssid);
}

// A WPA password: 8 to 63 plain characters, or 64 hex digits. An open
// network has none.
export function validPassword(password: unknown): password is string {
  return typeof password === "string" && (password === "" || /^[\x20-\x7e]{8,63}$/.test(password) || /^[0-9a-fA-F]{64}$/.test(password));
}

// How often a request to the hotspot's page is noted, at most.
const USED_EVERY_MS = 10_000;

export class Hotspot {
  private run: string;
  private dropDir: string;
  private usedFile: string;
  private usedAt = 0;
  // Asks that wait for root to take the one before them.
  private waiting: { id: string; request: object }[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  // The id of the last join handed to root, and of the last ask to close.
  asked = "";
  private stopping = "";

  constructor(options: HotspotOptions) {
    this.run = options.run ?? "/run/agentv-hotspot";
    this.dropDir = join(options.state, "hotspot-drop");
    this.usedFile = join(options.state, "hotspot-page");
  }

  // Notes that someone is using the hotspot's page, for root's watch: while
  // they are, it doesn't close the hotspot to look for the home Wi-Fi
  // (bin/agentv-hotspot, page_in_use). The file's time is all it says.
  used(now = Date.now()): void {
    if (now - this.usedAt < USED_EVERY_MS) return;
    this.usedAt = now;
    try {
      writeFileSync(this.usedFile, "", { mode: 0o600 });
    } catch {
      // The watch then takes it that nobody is.
    }
  }

  status(): HotspotState {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(readFileSync(join(this.run, "state.json"), "utf8"));
    } catch {
      // No hotspot this boot.
    }
    const joined = data.joined as { ssid?: unknown; address?: unknown } | null | undefined;
    return {
      on: data.on === true,
      ssid: text(data.ssid),
      password: text(data.password),
      joining: text(data.joining),
      joined: joined && text(joined.ssid) ? { ssid: joined.ssid as string, address: text(joined.address) } : null,
      error: text(data.error),
    };
  }

  // The networks the box could see before it opened its own, strongest
  // first.
  networks(): Network[] {
    try {
      const data = JSON.parse(readFileSync(join(this.run, "networks.json"), "utf8"));
      if (!Array.isArray(data)) return [];
      return data
        .filter((n) => validSsid(n?.ssid))
        .map((n) => ({ ssid: n.ssid as string, signal: Math.max(0, Math.min(100, Number(n.signal) || 0)), secure: n.secure !== false }))
        .sort((a, b) => b.signal - a.signal);
    } catch {
      return [];
    }
  }

  radio(): RadioState {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(readFileSync(join(this.run, "state.json"), "utf8"));
    } catch {
      // Root hasn't looked this boot.
    }
    const why = text(data.why) ?? (text(data.error) ? "failed" : null);
    return {
      wifi: text(data.wifi),
      has: typeof data.radio === "boolean" ? data.radio : null,
      why: why === "password" || why === "missing" ? why : why ? "failed" : null,
    };
  }

  // Whether root has answered the ask with that id (what scan and join gave
  // back): the drop is taken, and root's last word in state.json names it.
  // Root writes the id with the write that finishes the ask, so nothing here
  // compares a time: a write from just before the ask, or one that finishes
  // an earlier ask, isn't this one's answer.
  answered(id: string): boolean {
    if (id === "" || existsSync(join(this.dropDir, "request.json")) || this.waiting.some((ask) => ask.id === id)) return false;
    try {
      return JSON.parse(readFileSync(join(this.run, "state.json"), "utf8")).answered === id;
    } catch {
      return false;
    }
  }

  // Takes back the ask with that id, if root never took it: after root's
  // time is up, a join still lying there would be joined whenever root next
  // came by, even at the next start, and it has a password in it. Another
  // ask's drop stays.
  takeBack(id: string): void {
    const file = join(this.dropDir, "request.json");
    this.waiting = this.waiting.filter((ask) => ask.id !== id);
    try {
      if (id !== "" && JSON.parse(readFileSync(file, "utf8")).id === id) rmSync(file);
    } catch {
      // Root took it, or there was none.
    }
  }

  // Asks root to look at the networks nearby, with the hotspot closed.
  // The id it gives back is what answered() takes.
  scan(): string {
    return this.drop({ scan: true });
  }

  // Asks root to join the home Wi-Fi. Null once it's asked, or why not. The
  // id of the last ask is in asked, for answered().
  // Setup's pages join through the hotspot, so only while it's on. Settings
  // joins with it closed too (closed).
  join(ssid: unknown, password: unknown, options: { closed?: boolean } = {}): string | null {
    const why = this.refuses(ssid, password, options);
    if (why) return why;
    const seen = this.networks().find((n) => n.ssid === ssid);
    this.asked = this.drop({ join: { ssid, password, hidden: !seen } });
    return null;
  }

  // Why a join wouldn't be handed to root, or null when it would. Nothing
  // is asked of root here.
  refuses(ssid: unknown, password: unknown, options: { closed?: boolean } = {}): string | null {
    if (!options.closed && !this.status().on) return "The setup Wi-Fi isn't on";
    if (!validSsid(ssid)) return "That isn't a Wi-Fi network's name";
    if (!validPassword(password)) return "Wi-Fi passwords have 8 to 63 characters";
    const seen = this.networks().find((n) => n.ssid === ssid);
    if (seen?.secure && password === "") return `${ssid} needs its password`;
    return null;
  }

  // Asks root to close the hotspot, as setup ends. Once is enough: while
  // root hasn't taken the last such ask, another would only wait behind it.
  stop(): void {
    if (this.waiting.some((ask) => ask.id === this.stopping)) return;
    try {
      if (this.stopping !== "" && JSON.parse(readFileSync(join(this.dropDir, "request.json"), "utf8")).id === this.stopping) return;
    } catch {
      // Root took it, or there was none.
    }
    this.stopping = this.drop({ stop: true });
  }

  // The drop holds one ask. One made while root hasn't taken the last would
  // replace it, and that one would never be answered. So it waits its turn
  // here, and goes in once root has taken the one before.
  private drop(request: object): string {
    const id = randomBytes(8).toString("hex");
    this.waiting.push({ id, request });
    this.next();
    if (this.waiting.length > 0 && !this.timer) {
      this.timer = setInterval(() => this.next(), 200);
      this.timer.unref();
    }
    return id;
  }

  // Hands root the ask that has waited longest, if the drop is free.
  next(): void {
    const file = join(this.dropDir, "request.json");
    if (this.waiting.length > 0 && !existsSync(file)) {
      const { id, request } = this.waiting.shift()!;
      mkdirSync(this.dropDir, { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.next`, JSON.stringify({ ...request, id }), { mode: 0o600 });
      renameSync(`${file}.next`, file);
    }
    if (this.waiting.length === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

// What a phone's camera reads to join a Wi-Fi network.
export function wifiQr(ssid: string, password: string | null): string {
  const escape = (value: string) => value.replace(/([\\;,:"])/g, "\\$1");
  return password ? `WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};;` : `WIFI:T:nopass;S:${escape(ssid)};;`;
}
