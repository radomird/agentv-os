// The feature switches (PHASE-2-PLAN.md, "Shared interfaces"): what people
// can see of a phase 2 track lands switched off, and an edge box can turn it
// on to try it. The defaults live here, and a box's changes in features.json
// in the daemon's state. GET /api/features answers with all of them.
//
// This is the spec's shape, written ahead of the track that owns the switches
// so the sizes can merge behind theirs. When that track's version lands, this
// file is theirs.

import { readFileSync } from "node:fs";
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
  private file: string;

  constructor(options: { state: string }) {
    this.file = join(options.state, "features.json");
  }

  // Every switch: the default, with features.json's change on top. A file
  // that isn't there or isn't JSON changes nothing, and a name it doesn't
  // know is left out.
  all(): Record<Feature, boolean> {
    const result: Record<Feature, boolean> = { ...FEATURES };
    let saved: unknown = null;
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      // None yet.
    }
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const [name, on] of Object.entries(saved)) {
        if (isFeature(name) && typeof on === "boolean") result[name] = on;
      }
    }
    return result;
  }

  on(name: Feature): boolean {
    return this.all()[name];
  }
}
