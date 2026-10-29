// How the router's eval scores one answer against what the phrase set
// expects (phrases.json), and the whole run against the bars:
// - S7.1: the four requests, 95% or better on Claude;
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
export function same(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .replace(/^the /, "");
  return norm(a) === norm(b);
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

export interface Score {
  routed: { right: number; of: number; percent: number }; // S7.1, S7.2, S7.4
  unroutable: { right: number; of: number; percent: number }; // S7.3
  byIntent: Record<string, { right: number; of: number }>;
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
  for (const r of results) {
    const group = (byIntent[r.expect.intent] ??= { right: 0, of: 0 });
    group.of++;
    if (r.ok) group.right++;
  }
  const routed = results.filter((r) => r.expect.intent !== "none");
  const unroutable = results.filter((r) => r.expect.intent === "none");
  const count = (rs: Result[]) => rs.filter((r) => r.ok).length;
  const times = results.filter((r) => r.routed.none !== "failed").map((r) => r.routed.ms).sort((a, b) => a - b);
  return {
    routed: { right: count(routed), of: routed.length, percent: percent(count(routed), routed.length) },
    unroutable: { right: count(unroutable), of: unroutable.length, percent: percent(count(unroutable), unroutable.length) },
    byIntent,
    failed: results.filter((r) => r.routed.none === "failed").length,
    ms: { median: quantile(times, 0.5), p90: quantile(times, 0.9), max: times.at(-1) ?? 0 },
    spent: Math.round(results.reduce((sum, r) => sum + (r.routed.spent ?? 0), 0) * 1e6) / 1e6,
  };
}

// Whether a run meets the bars: S7.1's 95% and S7.3's every one, and on a
// CLI, S7.4's 5 s, which is a target that's recorded rather than a bar.
export function meets(s: Score): { routed: boolean; unroutable: boolean; seconds: boolean } {
  return { routed: s.routed.percent >= BAR.routed, unroutable: s.unroutable.percent >= BAR.unroutable, seconds: s.ms.median < BAR.seconds * 1000 };
}
