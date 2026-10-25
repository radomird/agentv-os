// The setup hotspot (ADR-007, stage 4): on first boot with no network, the
// box opens its own Wi-Fi network, and a phone that joins it from the QR code
// on the TV gets the captive page, where it picks the home Wi-Fi. Opening
// the network, its addresses and its firewall holes is root's job
// (bin/agentv-hotspot, run by agentv-hotspot.service): it says how things
// stand in /run/agentv-hotspot, and this reads that. The daemon can't touch
// NetworkManager, so the home Wi-Fi's name and password go the way the
// provider key goes: a drop in its own private state, which
// agentv-hotspot.path hands to root.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export class Hotspot {
  private run: string;
  private dropDir: string;

  constructor(options: HotspotOptions) {
    this.run = options.run ?? "/run/agentv-hotspot";
    this.dropDir = join(options.state, "hotspot-drop");
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

  // Asks root to join the home Wi-Fi. Null once it's asked, or why not.
  join(ssid: unknown, password: unknown): string | null {
    if (!this.status().on) return "the setup hotspot isn't on";
    if (!validSsid(ssid)) return "that isn't a wi-fi network's name";
    if (!validPassword(password)) return "a wi-fi password is 8 to 63 characters";
    const seen = this.networks().find((n) => n.ssid === ssid);
    if (seen?.secure && password === "") return `${ssid} needs its password`;
    this.drop({ join: { ssid, password, hidden: !seen } });
    return null;
  }

  // Asks root to close the hotspot, as setup ends.
  stop(): void {
    this.drop({ stop: true });
  }

  private drop(request: object): void {
    mkdirSync(this.dropDir, { recursive: true, mode: 0o700 });
    const file = join(this.dropDir, "request.json");
    writeFileSync(`${file}.next`, JSON.stringify(request), { mode: 0o600 });
    renameSync(`${file}.next`, file);
  }
}

// What a phone's camera reads to join a Wi-Fi network.
export function wifiQr(ssid: string, password: string | null): string {
  const escape = (value: string) => value.replace(/([\\;,:"])/g, "\\$1");
  return password ? `WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};;` : `WIFI:T:nopass;S:${escape(ssid)};;`;
}
