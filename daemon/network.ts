// The TV's own network, for Settings (ADR-084): how it's online, the Wi-Fi
// networks nearby, and joining another one after setup. A TV that lost its
// network has the hotspot open again, and this says so for the notice home
// shows.
//
// The daemon can't touch NetworkManager. Looking and joining are root's
// (bin/agentv-hotspot), asked through the same drop setup's hotspot uses,
// and what root found is in /run/agentv-hotspot. A password goes into that
// drop, which only the daemon and root can read, and nowhere else: not a
// log, not an answer, not an event.

import { unwatchFile, watchFile } from "node:fs";
import type { networkInterfaces } from "node:os";
import { join } from "node:path";
import { type Hotspot, type JoinProblem, type Network as Found, validPassword, validSsid } from "./hotspot.ts";
import { network } from "./setup.ts";

// How long root gets for a look and for a join. A join waits 45 s for
// NetworkManager, and as long again to go back when it didn't work.
const LOOK_MS = 30_000;
const JOIN_MS = 100_000;

export interface NetworkState {
  online: boolean;
  via: "wi-fi" | "cable" | null;
  // The Wi-Fi network the TV is on.
  name: string | null;
  // Whether the TV has Wi-Fi, or null before root has looked.
  wifi: boolean | null;
  // Root is looking at the networks nearby.
  looking: boolean;
  // The network being joined, and why the last join from here didn't work.
  joining: string | null;
  problem: { ssid: string; why: JoinProblem } | null;
  // The hotspot, while it's open, by name. After setup it's open because
  // the TV lost its network. Its password isn't here: the notice shows a QR
  // code (/api/hotspot/qr), and this goes to every page of the TV's.
  hotspot: { ssid: string; problem: boolean } | null;
}

export interface ListedNetwork extends Found {
  current: boolean;
}

export interface NetworkOptions {
  hotspot: Hotspot;
  run?: string; // what agentv-hotspot writes: /run/agentv-hotspot
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  // The TV's pages hear when something changed.
  changed?: (state: NetworkState) => void;
  now?: () => number;
}

export class TvNetwork {
  private hotspot: Hotspot;
  private options: NetworkOptions;
  private now: () => number;
  private file: string;
  // What root was asked last, and when, until it has answered.
  private asked: { kind: "look" | "join"; ssid: string; at: number; id: string } | null = null;
  private problem: NetworkState["problem"] = null;
  private said = "";
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: NetworkOptions) {
    this.options = options;
    this.hotspot = options.hotspot;
    this.now = options.now ?? Date.now;
    this.file = join(options.run ?? "/run/agentv-hotspot", "state.json");
    // Root's news, as it's written. The file is in /run, where it comes and
    // goes, so it's looked at, not watched for events.
    if (options.changed) watchFile(this.file, { interval: 1000, persistent: false }, () => this.tell());
  }

  close(): void {
    unwatchFile(this.file);
    clearInterval(this.timer);
  }

  private tell(): void {
    const state = this.state();
    const now = JSON.stringify(state);
    if (now === this.said) return;
    this.said = now;
    this.options.changed?.(state);
  }

  // While root works on something, its answer is looked for often, so the
  // page hears the moment it's there.
  private follow(): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.tell();
      if (!this.asked) clearInterval(this.timer);
    }, 300);
    this.timer.unref();
  }

  // Settles what was asked, once root has answered or took too long.
  private settle(): void {
    const asked = this.asked;
    if (!asked) return;
    const answered = this.hotspot.answered(asked.id) && !this.hotspot.status().joining;
    const late = this.now() - asked.at > (asked.kind === "join" ? JOIN_MS : LOOK_MS);
    if (!answered && !late) return;
    this.asked = null;
    // Given up on: what root never took isn't left for it to find later.
    if (!answered) this.hotspot.takeBack(asked.id);
    if (asked.kind !== "join") return;
    const why = answered ? this.hotspot.radio().why : "failed";
    this.problem = why ? { ssid: asked.ssid, why } : null;
  }

  state(): NetworkState {
    this.settle();
    const hotspot = this.hotspot.status();
    const radio = this.hotspot.radio();
    const net = network(hotspot, this.options.interfaces?.());
    const wifi = net.via === "wi-fi";
    return {
      online: net.online,
      via: net.online ? (wifi ? "wi-fi" : "cable") : null,
      name: wifi ? (radio.wifi ?? net.name) : null,
      wifi: radio.has,
      looking: this.asked?.kind === "look",
      joining: this.asked?.kind === "join" ? this.asked.ssid : hotspot.joining,
      problem: this.problem,
      hotspot: hotspot.on && hotspot.ssid ? { ssid: hotspot.ssid, problem: radio.why !== null } : null,
    };
  }

  // The networks nearby, strongest first, with the one the TV is on marked,
  // as root last saw it. A TV on a cable can be on a Wi-Fi network too.
  networks(): ListedNetwork[] {
    this.settle();
    const hotspot = this.hotspot.status();
    const on = hotspot.on || hotspot.joining ? null : this.hotspot.radio().wifi;
    return this.hotspot.networks().map((found) => ({ ...found, current: found.ssid === on }));
  }

  // Asks root to look again. Null once it's asked, or why not.
  look(): string | null {
    this.settle();
    if (this.asked) return this.asked.kind === "look" ? null : "busy";
    if (this.hotspot.status().on) return "hotspot";
    // A fresh look, and the last join's reason has been read.
    this.problem = null;
    this.asked = { kind: "look", ssid: "", at: this.now(), id: this.hotspot.scan() };
    this.follow();
    return null;
  }

  // Asks root to join a network. Null once it's asked, or why not: "busy"
  // while root is on something else, or what's wrong with the name or the
  // password.
  join(ssid: unknown, password: unknown): string | null {
    this.settle();
    if (this.asked?.kind === "join" || this.hotspot.status().joining) return "busy";
    if (!validSsid(ssid)) return "name";
    if (!validPassword(password)) return "password";
    const at = this.now();
    const why = this.hotspot.join(ssid, password, { closed: true });
    if (why) return "password";
    this.asked = { kind: "join", ssid, at, id: this.hotspot.asked };
    this.problem = null;
    this.follow();
    this.tell();
    return null;
  }
}
