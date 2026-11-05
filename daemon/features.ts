// The switches phase 2's screens land behind (PHASE-2-PLAN.md, "Shared
// interfaces"): something people can see merges switched off on stable, and
// an edge box can turn it on. The defaults are here, and a change is kept in
// features.json in the daemon's own state.
//
// This is setup's copy of the spec, until the switches' own module lands:
// the same file, names and shape, so the two meet in one place.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const FEATURES = {
  boxcheck: false,
  sizes: false,
  looks: false,
  dynamicbg: false,
  setup2: false,
  remote2: false,
  starter: false,
  discover: false,
  askbuilds: false,
} as const;

export type Feature = keyof typeof FEATURES;

export function isFeature(name: unknown): name is Feature {
  return typeof name === "string" && Object.hasOwn(FEATURES, name);
}

export class Features {
  private path: string;

  constructor(options: { state: string }) {
    this.path = join(options.state, "features.json");
  }

  // Every switch: its default, unless features.json says otherwise.
  async read(): Promise<Record<Feature, boolean>> {
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(await readFile(this.path, "utf8"));
    } catch {}
    const all = { ...FEATURES } as Record<Feature, boolean>;
    for (const name of Object.keys(FEATURES) as Feature[]) if (typeof saved?.[name] === "boolean") all[name] = saved[name] as boolean;
    return all;
  }

  async on(name: Feature): Promise<boolean> {
    return (await this.read())[name];
  }
}
