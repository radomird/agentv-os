// TV setup (stage 5, PHASE-1-PLAN.md "Setup flow"; reworked in phase 2):
// which step the TV is on and what the household chose, kept in setup.json
// in the daemon's own state, so setup picks up at the same step after a
// restart, an update or a reboot (ADR-025, S5.6). The TV's setup page moves
// it on, a step at a time; `agentv setup skip` marks it done, and `agentv
// setup reset` starts it again from the welcome screen.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import type { Feature } from "./features.ts";
import { HOTSPOT_ADDRESS, type HotspotState } from "./hotspot.ts";

// One screen of setup's order: its id, its place among setup's 12 steps
// (ADR-071), what the status bar calls that step, and the switch it waits
// for, when it has one. A step whose switch is off isn't shown, and setup
// goes past it.
export interface StepEntry {
  step: string;
  n: number;
  name: string;
  feature?: Feature;
}

// Setup's order. Steps 1 and 2, the disk and the install, are on the USB
// stick, so the TV starts at 3, and 12 is home. Each screen is one line here,
// and one in setup/steps.ts: another track adds its step in its slot below,
// in both places.
//
// The welcome screen is getting ready's code for a phone, until one joins.
// Getting ready brings the box up to date first (board 35), location
// confirms where the TV is (ADR-055), the AI provider comes with its terms
// (ADR-023), then who watches (ADR-009), what the TV is for, its apps, and
// its theme and background.
export const ORDER = [
  { step: "welcome", n: 3, name: "getting ready" },
  { step: "ready", n: 3, name: "getting ready" },
  { step: "box", n: 4, name: "your box", feature: "boxcheck" },
  { step: "country", n: 5, name: "location" },
  { step: "ai", n: 6, name: "ai" },
  { step: "people", n: 7, name: "who watches" },
  { step: "goal", n: 8, name: "goal" },
  // 9, apps: the starter pack (track 9) and the servers found (track 10)
  // are pages of it, in setup/steps.ts.
  { step: "apps", n: 9, name: "apps" },
  // 10, look and size: track 5's look, and track 4's sizes join its page.
  { step: "look", n: 10, name: "look and size", feature: "looks" },
  { step: "theme", n: 11, name: "theme and background" },
  { step: "background", n: 11, name: "theme and background" },
] as const satisfies readonly StepEntry[];
export const OF = 12;

export type Step = (typeof ORDER)[number]["step"];
export const STEPS: readonly Step[] = ORDER.map((entry) => entry.step);

// How phase 1's status bar counts the steps, while setup's own switch is
// off: six parts, as on that canvas, with the welcome screen and getting
// ready both the first. A step phase 1 didn't have shows its name.
export const PARTS: Partial<Record<Step, string>> = {
  welcome: "1/6 connect",
  ready: "1/6 getting ready",
  country: "1/6 country",
  ai: "2/6 ai",
  people: "3/6 people",
  goal: "4/6 goal",
  apps: "5/6 apps",
  look: "6/6 look",
  theme: "6/6 look",
  background: "6/6 look",
};

// What the status bar says for each step that's shown: "5 of 12 ·
// location" with setup's own switch on, and phase 1's parts with it off.
// With the switch on, each step's number, for its row of blocks.
export interface Progress {
  steps: Step[];
  parts: Partial<Record<Step, string>>;
  numbers: Partial<Record<Step, number>> | null;
  of: number;
}

// What the TV is for (ADR-006): it orders the apps setup suggests and picks
// home's top rail.
export const GOALS = ["streaming", "music", "media", "gaming"] as const;
export type Goal = (typeof GOALS)[number];

// How bringing the box up to date went at getting ready: checking, then
// installing a newer release or none to install, or a check or an install
// that didn't work, which setup carries on past. Skipped when the box has an
// adult PIN, since setup was started again on a box that's set up already,
// and Settings → Updates has the update.
export const UPDATES = ["checking", "installing", "done", "none", "failed", "skipped"] as const;
export type UpdateFirst = (typeof UPDATES)[number];

export interface Ready {
  // When the page asked for the update check, so an older check's answer
  // doesn't count.
  asked: string | null;
  update: UpdateFirst | null;
  // The AgenTV versions on either side of the update.
  from: string | null;
  to: string | null;
}

export interface SetupState {
  done: boolean;
  at?: string; // when it was done
  step: Step;
  // When each step was finished.
  finished: Partial<Record<Step, string>>;
  // Carried on with a keyboard at the welcome screen, with no phone.
  keyboard: boolean;
  goal: Goal | null;
  ready: Ready;
  // The apps asked for at "+ add your own", in the household's words, kept
  // for the TV's agent to build once it can (stage 6).
  wishes: string[];
  // The setup soundtrack muted, from the TV's M or the phone (S5.4).
  muted: boolean;
  // The time zone of the phone setting it up, as the captive page or the
  // companion sent it, which the location step starts from (ADR-059).
  phoneZone: string | null;
}

// How many wishes setup keeps, and how long each may be.
export const WISHES = 5;
const WISH = /^[^\u0000-\u001f\u007f<>]{1,80}$/u;

// How the box is online, for the welcome screen and getting ready.
export interface NetworkState {
  online: boolean;
  via: "ethernet" | "wi-fi" | null;
  // The Wi-Fi the setup hotspot joined, when it's that one.
  name: string | null;
}

const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;
const AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
// A package version, or "dev" for a checkout.
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_~-]{0,63}$/;

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
}

function fresh(): SetupState {
  return { done: false, step: "welcome", finished: {}, keyboard: false, goal: null, ready: { asked: null, update: null, from: null, to: null }, wishes: [], muted: false, phoneZone: null };
}

// The box's network, from its interfaces: a wired or Wi-Fi address that
// isn't its own setup hotspot's.
export function network(hotspot: HotspotState, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): NetworkState {
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!/^(en|eth|wl)/.test(name)) continue;
    if (!addresses?.some((a) => a.family === "IPv4" && !a.internal && a.address !== HOTSPOT_ADDRESS)) continue;
    const wifi = name.startsWith("wl");
    return { online: true, via: wifi ? "wi-fi" : "ethernet", name: wifi ? (hotspot.joined?.ssid ?? null) : null };
  }
  return { online: false, via: null, name: null };
}

export class Setup {
  private path: string;
  private on: (feature: Feature) => Promise<boolean>;
  private order: readonly StepEntry[];

  // The switches come from daemon/features.ts. Tests can give an order of
  // their own, as with a step behind a switch.
  constructor(options: { path: string; on?: (feature: Feature) => Promise<boolean>; order?: readonly StepEntry[] }) {
    this.path = options.path;
    this.on = options.on ?? (async () => false);
    this.order = options.order ?? ORDER;
  }

  // The steps shown, in order: every step whose switch, if it has one, is on.
  async steps(): Promise<Step[]> {
    const shown: Step[] = [];
    for (const entry of this.order) if (!entry.feature || (await this.on(entry.feature))) shown.push(entry.step as Step);
    return shown;
  }

  async progress(): Promise<Progress> {
    const steps = await this.steps();
    const counted = await this.on("setup2");
    const parts: Partial<Record<Step, string>> = {};
    const numbers: Partial<Record<Step, number>> = {};
    for (const entry of this.order) {
      const step = entry.step as Step;
      if (!steps.includes(step)) continue;
      parts[step] = counted ? `${entry.n} of ${OF} · ${entry.name}` : (PARTS[step] ?? entry.name);
      numbers[step] = entry.n;
    }
    return { steps, parts, numbers: counted ? numbers : null, of: OF };
  }

  // What setup.json holds. One from before stage 5 had only done and at.
  async read(): Promise<SetupState> {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      return fresh();
    }
    const steps = await this.steps();
    const state = fresh();
    state.done = data.done === true;
    if (typeof data.at === "string" && AT.test(data.at)) state.at = data.at;
    const known = this.order.map((entry) => entry.step as Step);
    if (known.includes(data.step as Step)) state.step = data.step as Step;
    const finished = (data.finished ?? {}) as Record<string, unknown>;
    for (const step of known) if (typeof finished[step] === "string" && AT.test(finished[step] as string)) state.finished[step] = finished[step] as string;
    // A step the box was already past when it came (an update brought it, as
    // with the country step, or its switch turned on) counts as finished:
    // Settings has the same choice.
    steps.forEach((step, i) => {
      if (state.finished[step] || !steps.slice(i + 1).some((later) => state.finished[later] || state.step === later)) return;
      state.finished[step] = (i > 0 ? state.finished[steps[i - 1]] : undefined) ?? now();
    });
    // A step that isn't shown any more, as when its switch turned off: on to
    // the first one shown that isn't finished.
    if (!steps.includes(state.step)) state.step = steps.find((step) => !state.finished[step]) ?? steps[steps.length - 1];
    state.keyboard = data.keyboard === true;
    if (GOALS.includes(data.goal as Goal)) state.goal = data.goal as Goal;
    const ready = (data.ready ?? {}) as Record<string, unknown>;
    state.ready = {
      asked: typeof ready.asked === "string" && AT.test(ready.asked) ? ready.asked : null,
      update: UPDATES.includes(ready.update as UpdateFirst) ? (ready.update as UpdateFirst) : null,
      from: typeof ready.from === "string" && VERSION.test(ready.from) ? ready.from : null,
      to: typeof ready.to === "string" && VERSION.test(ready.to) ? ready.to : null,
    };
    state.muted = data.muted === true;
    if (typeof data.phoneZone === "string" && ZONE.test(data.phoneZone)) state.phoneZone = data.phoneZone;
    if (Array.isArray(data.wishes)) state.wishes = data.wishes.filter((w): w is string => typeof w === "string" && WISH.test(w)).slice(0, WISHES);
    return state;
  }

  private async save(state: SetupState): Promise<SetupState> {
    await mkdir(dirname(this.path), { recursive: true });
    const next = join(dirname(this.path), ".setup.json.next");
    await writeFile(next, `${JSON.stringify(state, null, 2)}\n`);
    await rename(next, this.path);
    return state;
  }

  // Done, as at the end of setup or with agentv setup skip, or not done,
  // which starts it again from the welcome screen.
  async mark(done: boolean): Promise<SetupState> {
    if (!done) return this.save(fresh());
    return this.save({ ...(await this.read()), done: true, at: now() });
  }

  // To a step. Back is always fine; forward only as far as the first step
  // that isn't finished yet, so no step is skipped.
  async go(step: unknown): Promise<{ state?: SetupState; error?: string }> {
    const steps = await this.steps();
    if (!steps.includes(step as Step)) return { error: `a step: ${steps.join(", ")}` };
    const state = await this.read();
    const open = steps.findIndex((s) => !state.finished[s]);
    const to = steps.indexOf(step as Step);
    if (open >= 0 && to > open) return { error: `${steps[open]} isn't finished yet` };
    state.step = step as Step;
    return { state: await this.save(state) };
  }

  // A step finished: setup moves on to the next one shown. The last one
  // finished leaves setup on it, for the page to mark setup done.
  async finish(step: unknown, change: { keyboard?: unknown } = {}): Promise<{ state?: SetupState; error?: string }> {
    const steps = await this.steps();
    if (!steps.includes(step as Step)) return { error: `a step: ${steps.join(", ")}` };
    const state = await this.read();
    const at = steps.indexOf(step as Step);
    const open = steps.findIndex((s) => !state.finished[s]);
    if (open >= 0 && at > open) return { error: `${steps[open]} isn't finished yet` };
    if (step === "goal" && !state.goal) return { error: "pick what the tv is for first" };
    state.finished[step as Step] = now();
    if (step === "welcome" && typeof change.keyboard === "boolean") state.keyboard = change.keyboard;
    state.step = steps[Math.min(at + 1, steps.length - 1)];
    return { state: await this.save(state) };
  }

  async setGoal(goal: unknown): Promise<{ state?: SetupState; error?: string }> {
    if (!GOALS.includes(goal as Goal)) return { error: `the goal is one of ${GOALS.join(", ")}` };
    const state = await this.read();
    state.goal = goal as Goal;
    return { state: await this.save(state) };
  }

  // How bringing the box up to date goes, from the page at getting ready.
  async setReady(change: unknown): Promise<{ state?: SetupState; error?: string }> {
    const c = (typeof change === "object" && change !== null ? change : {}) as Record<string, unknown>;
    if (!UPDATES.includes(c.update as UpdateFirst)) return { error: `update is one of ${UPDATES.join(", ")}` };
    const version = (value: unknown) => value === undefined || value === null || (typeof value === "string" && VERSION.test(value));
    if (!version(c.from) || !version(c.to)) return { error: "from and to are versions" };
    const state = await this.read();
    state.ready = {
      asked: c.update === "checking" ? now() : state.ready.asked,
      update: c.update as UpdateFirst,
      from: typeof c.from === "string" ? c.from : c.from === null ? null : state.ready.from,
      to: typeof c.to === "string" ? c.to : c.to === null ? null : state.ready.to,
    };
    return { state: await this.save(state) };
  }

  // An app asked for at "+ add your own", kept for later. The same words
  // twice are kept once.
  async wish(text: unknown): Promise<{ state?: SetupState; error?: string }> {
    const words = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
    if (!WISH.test(words)) return { error: "a few words, up to 80 letters, for the app to add" };
    const state = await this.read();
    if (!state.wishes.some((w) => w.toLowerCase() === words.toLowerCase())) {
      if (state.wishes.length >= WISHES) return { error: `that's ${WISHES} for later already` };
      state.wishes.push(words);
    }
    return { state: await this.save(state) };
  }

  // A wish the household has now asked the builder for, kept no longer.
  async asked(text: string): Promise<void> {
    const words = text.trim().replace(/\s+/g, " ").toLowerCase();
    const state = await this.read();
    const left = state.wishes.filter((w) => w.toLowerCase() !== words);
    if (left.length === state.wishes.length) return;
    state.wishes = left;
    await this.save(state);
  }

  // The phone's time zone, once daemon/location.ts has checked it. The
  // latest phone's counts.
  async setPhoneZone(zone: string): Promise<SetupState> {
    const state = await this.read();
    state.phoneZone = ZONE.test(zone) ? zone : null;
    return this.save(state);
  }

  // The soundtrack muted or playing again.
  async setMuted(muted: unknown): Promise<{ state?: SetupState; error?: string }> {
    if (typeof muted !== "boolean") return { error: 'send {"muted": true} or {"muted": false}' };
    const state = await this.read();
    state.muted = muted;
    return { state: await this.save(state) };
  }
}
