// How the router's eval scores one answer against what the phrase set
// expects (phrases.json), and the whole run against the bars:
// - S7.1: the requests, 95% or better on Claude;
// - T11.1: make and change, each at the same 95%, with the sentences that
//   use their words but aren't a build (the collide set) scored as well;
// - S7.3: every sentence that can't be routed is none, never a guess;
// - S7.4: the same on a plan's CLI, with the time per sentence, under 5 s
//   as the target.
// Other providers are scored the same way and recorded (S7.2).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Intent, Kind, Route, Routed, RouterApp } from "../../../../daemon/router.ts";

type OneOf<T> = T | T[];

export interface Expect {
  intent: Intent | "none";
  query?: OneOf<string | null>;
  kind?: OneOf<Kind | null>;
  app?: OneOf<string | null>;
  season?: number | null;
  episode?: number | null;
  // For make and change: words what must hold, every one, as two people
  // would agree they're there. null: there's no what.
  what?: string[] | null;
}

export interface Case {
  id: string;
  say: string;
  expect: Expect;
  collision?: string;
  note?: string;
}

export interface Phrases {
  about: string;
  apps: RouterApp[];
  cases: Case[];
}

export const PHRASES = join(import.meta.dirname, "phrases.json");

export function phrases(path = PHRASES): Phrases {
  return JSON.parse(readFileSync(path, "utf8")) as Phrases;
}

// A title as two people would agree it's the same: case, accents,
// punctuation and a leading "the" aside.
const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function same(a: string, b: string): boolean {
  return norm(a).replace(/^the /, "") === norm(b).replace(/^the /, "");
}

// Whether a make's or a change's what holds each of the words, case,
// accents and punctuation aside: "a game like Tetris" holds "tetris".
export function holds(what: string, words: string[]): boolean {
  const said = ` ${norm(what)} `;
  return words.every((word) => said.includes(norm(word)));
}

const list = <T>(value: OneOf<T>): T[] => (Array.isArray(value) ? value : [value]);

// What's wrong with a route, by slot, or nothing.
export function wrong(route: Route, expect: Expect): string[] {
  const problems: string[] = [];
  if (route.intent !== expect.intent) return [`intent ${route.intent}, not ${expect.intent}`];
  if (expect.intent === "none") return [];
  const strings = (name: "query" | "app") => {
    const want = expect[name];
    if (want === undefined) return;
    const got = route[name];
    const ok = list(want).some((w) => (w === null ? got === null : got !== null && same(got, w)));
    if (!ok) problems.push(`${name} ${JSON.stringify(got)}, not ${list(want).map((w) => JSON.stringify(w)).join(" or ")}`);
  };
  strings("query");
  strings("app");
  if (expect.kind !== undefined && !list(expect.kind).includes(route.kind)) problems.push(`kind ${JSON.stringify(route.kind)}, not ${list(expect.kind).map((k) => JSON.stringify(k)).join(" or ")}`);
  for (const name of ["season", "episode"] as const) {
    if (expect[name] !== undefined && route[name] !== expect[name]) problems.push(`${name} ${route[name]}, not ${expect[name]}`);
  }
  if (expect.what !== undefined) {
    // A route from before make and change has no what at all.
    const got = typeof route.what === "string" ? route.what : null;
    const ok = expect.what === null ? got === null : got !== null && holds(got, expect.what);
    if (!ok) problems.push(`what ${JSON.stringify(got)}, not ${expect.what === null ? "null" : `one with ${expect.what.map((w) => JSON.stringify(w)).join(" and ")}`}`);
  }
  return problems;
}

export interface Result {
  id: string;
  say: string;
  expect: Expect;
  routed: Routed;
  ok: boolean;
  problems: string[];
}

export function result(c: Case, routed: Routed): Result {
  const problems = routed.none === "failed" ? [`the provider didn't answer: ${routed.error}`] : wrong(routed.route, c.expect);
  return { id: c.id, say: c.say, expect: c.expect, routed, ok: problems.length === 0, problems };
}

export const BAR = { routed: 95, unroutable: 100, seconds: 5 };

// The set a case is in, from its id: "make-04" is in make, "collide-02" in
// collide. Each request's set is 20 sentences that are that request, so a
// set's score is how well that request routes, and the four from before
// keep their 20 as they were.
export const set = (id: string) => id.replace(/-\d+$/, "");

// The sets that build, each held to the same bar as the rest (T11.1).
export const BUILD_SETS = ["make", "change"];

export interface Score {
  routed: { right: number; of: number; percent: number }; // S7.1, S7.2, S7.4
  unroutable: { right: number; of: number; percent: number }; // S7.3
  byIntent: Record<string, { right: number; of: number }>;
  bySet: Record<string, { right: number; of: number; percent: number }>;
  failed: number; // sentences the provider didn't answer
  ms: { median: number; p90: number; max: number };
  spent: number; // dollars, as priced
}

const percent = (right: number, of: number) => (of ? Math.round((right / of) * 1000) / 10 : 0);

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

export function score(results: Result[]): Score {
  const byIntent: Score["byIntent"] = {};
  const bySet: Score["bySet"] = {};
  for (const r of results) {
    const group = (byIntent[r.expect.intent] ??= { right: 0, of: 0 });
    const inSet = (bySet[set(r.id)] ??= { right: 0, of: 0, percent: 0 });
    group.of++;
    inSet.of++;
    if (r.ok) group.right++;
    if (r.ok) inSet.right++;
  }
  for (const s of Object.values(bySet)) s.percent = percent(s.right, s.of);
  const routed = results.filter((r) => r.expect.intent !== "none");
  const unroutable = results.filter((r) => r.expect.intent === "none");
  const count = (rs: Result[]) => rs.filter((r) => r.ok).length;
  const times = results.filter((r) => r.routed.none !== "failed").map((r) => r.routed.ms).sort((a, b) => a - b);
  return {
    routed: { right: count(routed), of: routed.length, percent: percent(count(routed), routed.length) },
    unroutable: { right: count(unroutable), of: unroutable.length, percent: percent(count(unroutable), unroutable.length) },
    byIntent,
    bySet,
    failed: results.filter((r) => r.routed.none === "failed").length,
    ms: { median: quantile(times, 0.5), p90: quantile(times, 0.9), max: times.at(-1) ?? 0 },
    spent: Math.round(results.reduce((sum, r) => sum + (r.routed.spent ?? 0), 0) * 1e6) / 1e6,
  };
}

// Whether a run meets the bars: S7.1's 95%, and T11.1's same 95% for make
// and for change on their own, S7.3's every one, and on a CLI, S7.4's 5 s,
// which is a target that's recorded rather than a bar. A run of only some
// cases holds the sets it has.
export function meets(s: Score): { routed: boolean; builds: boolean; unroutable: boolean; seconds: boolean } {
  const builds = BUILD_SETS.every((name) => !s.bySet[name] || s.bySet[name].percent >= BAR.routed);
  // With nothing answered there's no time to meet the target with.
  return { routed: s.routed.percent >= BAR.routed, builds, unroutable: s.unroutable.percent >= BAR.unroutable, seconds: s.failed < s.routed.of + s.unroutable.of && s.ms.median < BAR.seconds * 1000 };
}

// What got worse since an earlier run of the same phrase set: each set
// that scores lower, and each sentence it got right then and not now.
// T11.1 asks that play, continue, what's new and new episodes don't get
// worse once make and change join them.
export interface Worse {
  sets: { set: string; was: number; now: number }[];
  cases: { id: string; say: string; problems: string[] }[];
}

export function worse(before: Pick<Result, "id" | "ok">[], now: Result[]): Worse {
  const was = new Map(before.map((r) => [r.id, r.ok]));
  const cases = now.filter((r) => was.get(r.id) === true && !r.ok).map((r) => ({ id: r.id, say: r.say, problems: r.problems }));
  const tally = (rs: Pick<Result, "id" | "ok">[]) => {
    const t: Record<string, { right: number; of: number }> = {};
    for (const r of rs) {
      const one = (t[set(r.id)] ??= { right: 0, of: 0 });
      one.of++;
      if (r.ok) one.right++;
    }
    return t;
  };
  const then = tally(before.filter((r) => now.some((n) => n.id === r.id)));
  const after = tally(now.filter((r) => was.has(r.id)));
  const sets = Object.entries(after)
    .map(([name, t]) => ({ set: name, was: percent(then[name]?.right ?? 0, then[name]?.of ?? 0), now: percent(t.right, t.of) }))
    .filter((s) => s.now < s.was);
  return { sets, cases };
}
