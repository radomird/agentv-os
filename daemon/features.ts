// Feature switches (PHASE-2-PLAN.md, "Shared interfaces"): each phase 2 track
// lands what people can see behind a switch of its own, off by default, so it
// can merge before its design is signed off. The defaults live here, and a
// change lives in features.json in the daemon's own state. GET /api/features
// answers with every switch.
//
// Written to the plan's spec ahead of track 12's version, with the same file,
// names and API, so a rebase onto it keeps working.

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
};

export type Feature = keyof typeof FEATURES;

export function isFeature(name: unknown): name is Feature {
  return typeof name === "string" && Object.hasOwn(FEATURES, name);
}

export class Features {
  readonly path: string;

  constructor(options: { state: string }) {
    this.path = join(options.state, "features.json");
  }

  // Every switch: the default, or what features.json says. A name it doesn't
  // know, or a value that isn't true or false, is left out.
  async all(): Promise<Record<Feature, boolean>> {
    const all = { ...FEATURES };
    let saved: unknown;
    try {
      saved = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      return all;
    }
    if (typeof saved !== "object" || saved === null) return all;
    for (const [name, on] of Object.entries(saved)) {
      if (isFeature(name) && typeof on === "boolean") all[name] = on;
    }
    return all;
  }

  async on(name: Feature): Promise<boolean> {
    return (await this.all())[name];
  }
}
