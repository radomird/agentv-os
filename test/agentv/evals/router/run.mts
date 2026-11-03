// Runs the router's phrase set on one provider (ADR-019, layer 6): through
// its API with the key in its usual variable (ANTHROPIC_API_KEY and so on),
// or through a plan's CLI from a home that's signed in to it. It prints a
// line per sentence and the scores, and with --strict fails when a bar
// isn't met. See ./run for the options.

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import type { Provider } from "../../../../daemon/ai.ts";
import { cliBackend, isCliProvider } from "../../../../daemon/providers/cli.ts";
import { apiBackend, KEY_VARS } from "../../../../daemon/providers/index.ts";
import { Router, type Backend, type Routed } from "../../../../daemon/router.ts";
import { BAR, meets, phrases, result, score, type Case, type Result, type Score } from "./score.ts";

const PROVIDERS: Provider[] = ["claude", "chatgpt", "gemini", "grok", "muse"];

export interface RunOptions {
  backend?: Backend;
  // Or the box's own router, which says whose answer it is.
  route?: (sentence: string, apps: RunOptions["apps"]) => Promise<Routed>;
  cases: Case[];
  apps: Parameters<Router["route"]>[1];
  concurrency: number;
  each?: (r: Result) => void;
}

// Every case, a few at a time, in the phrase set's order.
export async function runCases(o: RunOptions): Promise<Result[]> {
  const route = o.route ?? ((sentence: string, apps: RunOptions["apps"]) => new Router(o.backend!).route(sentence, apps));
  const results: Result[] = new Array(o.cases.length);
  let next = 0;
  const worker = async () => {
    while (next < o.cases.length) {
      const i = next++;
      const said = o.cases[i].say;
      const routed = await route(said, o.apps).catch((error: Error): Routed => ({ sentence: said, route: { intent: "none", query: null, kind: null, app: null, season: null, episode: null }, none: "failed", error: error.message, provider: "claude", via: "api", model: null, ms: 0 }));
      results[i] = result(o.cases[i], routed);
      o.each?.(results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  return results;
}

const seconds = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

export function line(r: Result): string {
  const said = JSON.stringify(r.say);
  return r.ok ? `ok ${r.id} ${said} (${seconds(r.routed.ms)})` : `not ok ${r.id} ${said}: ${r.problems.join("; ")} (${seconds(r.routed.ms)})`;
}

// The scores as a Markdown table, for a run's summary and the log.
export function markdown(title: string, s: Score, results: Result[], via: "api" | "cli"): string {
  const met = meets(s);
  const mark = (ok: boolean) => (ok ? "meets it" : "below it");
  const rows = [
    `### ${title}`,
    "",
    "| Check | Right | Score | Bar |",
    "| --- | --- | --- | --- |",
    `| S7.1, S7.2: the four requests | ${s.routed.right} of ${s.routed.of} | ${s.routed.percent}% | ${BAR.routed}%, ${mark(met.routed)} |`,
    ...Object.entries(s.byIntent)
      .filter(([intent]) => intent !== "none")
      .map(([intent, g]) => `| ${intent} | ${g.right} of ${g.of} | ${Math.round((g.right / g.of) * 1000) / 10}% | |`),
    `| S7.3: none, never a guess | ${s.unroutable.right} of ${s.unroutable.of} | ${s.unroutable.percent}% | every one, ${mark(met.unroutable)} |`,
    `| Time per sentence | median ${seconds(s.ms.median)}, p90 ${seconds(s.ms.p90)}, longest ${seconds(s.ms.max)} | | ${via === "cli" ? `S7.4's target is under ${BAR.seconds} s, ${mark(met.seconds)}` : ""} |`,
    `| Spent | ${via === "cli" ? "on the plan" : `$${s.spent.toFixed(4)}`} | | |`,
  ];
  if (s.failed) rows.push("", `The provider didn't answer ${s.failed} of them.`);
  const misses = results.filter((r) => !r.ok);
  if (misses.length) {
    rows.push("", "| Missed | Said | Why |", "| --- | --- | --- |");
    for (const r of misses) rows.push(`| ${r.id} | ${r.say.replace(/\|/g, "/")} | ${r.problems.join("; ").replace(/\|/g, "/")} |`);
  }
  return `${rows.join("\n")}\n`;
}

const USAGE = "Usage: run --provider <claude|chatgpt|gemini|grok|muse> [--via api|cli] [--model <id>] [--home <dir>] [--base <url>] [--concurrency <n>] [--only <id,...>] [--json <file>] [--markdown <file>] [--strict]\n       run --via box [--daemon <url>] [...]";

// The box's own router, through its daemon, as the household's sentences go.
function boxRoute(daemon: string): (sentence: string, apps: RunOptions["apps"]) => Promise<Routed> {
  return async (sentence, apps) => {
    const response = await fetch(`${daemon.replace(/\/$/, "")}/api/router/route`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sentence, apps }), signal: AbortSignal.timeout(60_000) });
    const answer = (await response.json()) as { ok?: boolean; routed?: Routed; error?: string };
    if (!answer.routed) throw new Error(answer.error ?? `the daemon answered ${response.status}`);
    return answer.routed;
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      daemon: { type: "string", default: "http://127.0.0.1:3000" },
      via: { type: "string", default: "api" },
      model: { type: "string" },
      home: { type: "string" },
      base: { type: "string" },
      concurrency: { type: "string" },
      only: { type: "string" },
      json: { type: "string" },
      markdown: { type: "string" },
      strict: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const set = phrases();
  const only = values.only ? new Set(values.only.split(",")) : null;
  const cases = set.cases.filter((c) => !only || only.has(c.id));
  if (values.via === "box") {
    // One at a time, as a household talks, so each time is its own.
    const results = await runCases({ route: boxRoute(values.daemon!), cases, apps: set.apps, concurrency: 1, each: (r) => console.log(line(r)) });
    const first = results.find((r) => r.routed.none !== "failed")?.routed ?? results[0]?.routed;
    const s = score(results);
    const via = first?.via ?? "api";
    const table = markdown(`Router evals on this box: ${first?.provider ?? "its provider"}, ${via === "cli" ? "its CLI on a plan" : "its API with a key"}, ${first?.model ?? "the plan's own model"}`, s, results, via);
    console.log(`\n${table}`);
    if (values.json) writeFileSync(values.json, `${JSON.stringify({ provider: first?.provider, via, model: first?.model ?? null, score: s, results }, null, 2)}\n`);
    if (values.markdown) writeFileSync(values.markdown, table, { flag: "a" });
    const met = meets(s);
    return values.strict && !(met.routed && met.unroutable) ? 1 : 0;
  }
  const provider = values.provider as Provider;
  if (!PROVIDERS.includes(provider) || (values.via !== "api" && values.via !== "cli")) {
    console.error(USAGE);
    return 2;
  }
  let backend: Backend;
  if (values.via === "cli") {
    if (!isCliProvider(provider)) {
      console.error(`run: ${provider} has no plan a box offers, so no CLI to route through`);
      return 2;
    }
    backend = cliBackend(provider, { home: values.home ?? homedir(), ...(values.model ? { model: values.model } : {}) });
  } else {
    const key = process.env[KEY_VARS[provider]];
    if (!key) {
      console.error(`run: ${KEY_VARS[provider]} isn't set`);
      return 3;
    }
    backend = apiBackend(provider, { key, ...(values.model ? { model: values.model } : {}), ...(values.base ? { base: values.base } : {}) });
  }

  // A plan's CLI one sentence at a time, as the box runs it, so its time is
  // each sentence's own.
  const concurrency = Number(values.concurrency ?? (values.via === "cli" ? 1 : 4));
  const results = await runCases({ backend, cases, apps: set.apps, concurrency, each: (r) => console.log(line(r)) });
  const s = score(results);
  const title = `Router evals: ${provider}, ${values.via === "cli" ? "its CLI on a plan" : "its API with a key"}, ${backend.model ?? "the plan's own model"}`;
  const table = markdown(title, s, results, values.via);
  console.log(`\n${table}`);
  if (values.json) writeFileSync(values.json, `${JSON.stringify({ provider, via: values.via, model: backend.model, score: s, results }, null, 2)}\n`);
  if (values.markdown) writeFileSync(values.markdown, table, { flag: "a" });
  const met = meets(s);
  return values.strict && !(met.routed && met.unroutable) ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
