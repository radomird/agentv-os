// The feature switches (PHASE-2-PLAN.md, "Shared interfaces"): something
// people can see lands switched off on stable, so a track can merge before
// its design is signed off. The defaults are here, and the changes an edge
// box made are in features.json in the daemon's state.
//
// Track 5 wrote this to the spec before track 12's version landed. The
// names, the file and what GET /api/features answers are the spec's, so
// track 12's replaces it as it is.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const FEATURES = ["boxcheck", "sizes", "looks", "dynamicbg", "setup2", "remote2", "starter", "discover", "askbuilds"] as const;

export type Feature = (typeof FEATURES)[number];

export type Features = Record<Feature, boolean>;

const DEFAULTS: Features = Object.fromEntries(FEATURES.map((name) => [name, false])) as Features;

// Every switch, as the box has it: the default, or what features.json says
// for a name it knows. A file that isn't there or isn't JSON changes nothing.
export async function features(state: string): Promise<Features> {
  let saved: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(join(state, "features.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch {
    // none changed
  }
  const result = { ...DEFAULTS };
  for (const name of FEATURES) if (typeof saved[name] === "boolean") result[name] = saved[name] as boolean;
  return result;
}

export async function featureOn(state: string, name: Feature): Promise<boolean> {
  return (await features(state))[name];
}
