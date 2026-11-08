// Feature switches (PHASE-2-PLAN.md, "Shared interfaces"). Something people
// can see lands switched off, so a piece of work can merge before its design
// is signed off. Each switch's default lives here, and a box's own changes
// live in features.json in the daemon's state.
//
// - A switch's default flips to on here when its design page is signed off
//   and its checks pass. The switches go away by 1.0.
// - Turning one on is for edge boxes only. On stable, a switch is on only
//   when its default is, so a box that goes back to stable shows stable.
// - Turning one off works everywhere.
// - features.json keeps only what differs from the defaults, so a switch
//   someone set back follows its default again when that flips.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Every switch, off until its design page is signed off. The track that
// owns each one is in PHASE-2-PLAN.md's tracks table.
export const FEATURES = {
  boxcheck: false, // the box check (track 3)
  sizes: false, // sizes on any TV (track 4)
  looks: false, // three looks for home (track 5)
  dynamicbg: false, // dynamic backgrounds (track 6)
  setup2: false, // setup, part 2 (track 7)
  remote2: false, // the phone remote (track 8)
  starter: false, // the streaming starter pack (track 9)
  discover: false, // servers on your network (track 10)
  askbuilds: false, // the Ask box builds (track 11)
} as const satisfies Record<string, boolean>;

export type Feature = keyof typeof FEATURES;
export type FeatureMap = Record<Feature, boolean>;

export const FEATURE_NAMES = Object.keys(FEATURES) as Feature[];

export function isFeature(name: unknown): name is Feature {
  return typeof name === "string" && Object.hasOwn(FEATURES, name);
}

export interface FeaturesOptions {
  state: string; // the daemon's own state: features.json goes in it
  // The channel this box updates from, as `agentv channel` says it. The
  // daemon always gives it. Without it, as in a test, what features.json
  // says counts, as on edge.
  channel?: () => Promise<string>;
  defaults?: FeatureMap; // for tests
}

export type FeatureChange = { ok: true; features: FeatureMap } | { ok: false; status: number; error: string };

export class Features {
  private path: string;
  private channel: () => Promise<string>;
  private defaults: FeatureMap;

  constructor(options: FeaturesOptions) {
    this.path = join(options.state, "features.json");
    this.channel = options.channel ?? (async () => "edge");
    this.defaults = { ...FEATURES, ...options.defaults };
  }

  // What this box changed, by name: only known switches, only true or false.
  private changes(): Partial<FeatureMap> {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return {};
    }
    const changes: Partial<FeatureMap> = {};
    if (!data || typeof data !== "object" || Array.isArray(data)) return changes;
    for (const [name, on] of Object.entries(data)) {
      if (isFeature(name) && typeof on === "boolean") changes[name] = on;
    }
    return changes;
  }

  // Every switch and whether it's on, in the order of FEATURES.
  async read(): Promise<FeatureMap> {
    const edge = (await this.channel()) === "edge";
    const changes = this.changes();
    const all = {} as FeatureMap;
    for (const name of FEATURE_NAMES) {
      const changed = changes[name];
      // A switch turned on while on edge stays off on stable.
      all[name] = changed === undefined || (changed && !edge) ? this.defaults[name] : changed;
    }
    return all;
  }

  // The same, by the name some tracks wrote to the spec before this landed.
  all(): Promise<FeatureMap> {
    return this.read();
  }

  async on(name: Feature): Promise<boolean> {
    return (await this.read())[name];
  }

  // Sets some switches, from { "looks": true, ... }. All or nothing: one
  // unknown name or a switch turned on off edge changes none of them.
  async set(wanted: unknown): Promise<FeatureChange> {
    if (!wanted || typeof wanted !== "object" || Array.isArray(wanted)) {
      return { ok: false, status: 400, error: 'Send the switches to change, like {"looks": true}.' };
    }
    const entries = Object.entries(wanted);
    if (entries.length === 0) return { ok: false, status: 400, error: "Name a switch to change." };
    for (const [name, on] of entries) {
      if (!isFeature(name)) return { ok: false, status: 404, error: `There's no switch called ${JSON.stringify(name).slice(0, 40)}. The switches are ${FEATURE_NAMES.join(", ")}.` };
      if (typeof on !== "boolean") return { ok: false, status: 400, error: `${name} takes true or false.` };
    }
    const turningOn = entries.some(([name, on]) => on && !this.defaults[name as Feature]);
    if (turningOn && (await this.channel()) !== "edge") {
      return { ok: false, status: 409, error: "Switches only turn on on edge. Run agentv channel edge, then agentv update, and try again." };
    }
    const changes = this.changes();
    for (const [name, on] of entries as [Feature, boolean][]) {
      if (on === this.defaults[name]) delete changes[name];
      else changes[name] = on;
    }
    this.write(changes);
    return { ok: true, features: await this.read() };
  }

  private write(changes: Partial<FeatureMap>): void {
    if (Object.keys(changes).length === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    mkdirSync(join(this.path, ".."), { recursive: true });
    writeFileSync(`${this.path}.next`, `${JSON.stringify(changes, null, 2)}\n`);
    renameSync(`${this.path}.next`, this.path);
  }
}

// Every switch, and one switch, from the daemon's state, for code that has
// no Features of its own. Inside the daemon, use daemon.features, which
// knows the box's channel.
export function features(state: string): Promise<FeatureMap> {
  return new Features({ state }).read();
}

export function featureOn(state: string, name: Feature): Promise<boolean> {
  return new Features({ state }).on(name);
}
