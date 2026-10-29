// The router's eval (test/agentv/evals/router, ADR-019 layer 6), checked
// on every push with no key (layer 2): the phrase set has what S7.1 and
// S7.3 ask of it, the scorer reads answers fairly, and the runner scores a
// stand-in provider end to end and fails --strict below the bars.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { INTENTS, KINDS, NONE, parseRoute, type Route } from "../../../daemon/router.ts";
import { runCases } from "../evals/router/run.mts";
import { meets, phrases, result, same, score, wrong, type Expect } from "../evals/router/score.ts";

const RUN = join(import.meta.dirname, "../evals/router/run");
const set = phrases();

// The answer each case expects, taking the first of any list.
function expected(e: Expect): Route {
  const first = <T,>(v: T | T[] | undefined): T | null => (v === undefined ? null : Array.isArray(v) ? (v[0] ?? null) : v);
  if (e.intent === "none") return { ...NONE };
  return { intent: e.intent, query: first(e.query) as string | null, kind: first(e.kind), app: first(e.app) as string | null, season: e.season ?? null, episode: e.episode ?? null };
}

test("S7.1 S7.3 the phrase set has 20 phrasings for each of the four requests, and 20 that can't be routed", () => {
  const counts: Record<string, number> = {};
  for (const c of set.cases) counts[c.expect.intent] = (counts[c.expect.intent] ?? 0) + 1;
  assert.deepEqual(counts, { continue: 20, play: 20, whats_new: 20, new_episode: 20, none: 20 });
  assert.equal(new Set(set.cases.map((c) => c.id)).size, set.cases.length);
  assert.equal(new Set(set.cases.map((c) => c.say.toLowerCase())).size, set.cases.length);
});

test("S7.1 play goes across kinds, with collisions between kinds", () => {
  const plays = set.cases.filter((c) => c.expect.intent === "play");
  const kinds = new Set(plays.flatMap((c) => (c.expect.kind === undefined ? [] : [c.expect.kind].flat())).filter(Boolean));
  for (const kind of ["film", "series", "album", "track", "playlist", "artist", "photo-album", "game"]) assert.ok(kinds.has(kind as never), kind);
  const collisions = plays.filter((c) => c.collision);
  assert.ok(collisions.length >= 8, `${collisions.length} collisions`);
  // A title said once with no kind and once with one, each way.
  for (const title of ["Frozen", "Bohemian Rhapsody", "The Last of Us"]) {
    const said = collisions.filter((c) => c.expect.query === title);
    assert.ok(said.some((c) => c.expect.kind === null) && said.some((c) => c.expect.kind !== null && c.expect.kind !== undefined), title);
  }
});

test("every expectation is a route the schema allows, and its apps are the box's or named as said", () => {
  const ids = new Set(set.apps.map((a) => a.id));
  for (const c of set.cases) {
    const route = expected(c.expect);
    assert.ok((INTENTS as readonly string[]).includes(route.intent) || route.intent === "none", c.id);
    for (const kind of [c.expect.kind ?? null].flat()) assert.ok(kind === null || (KINDS as readonly string[]).includes(kind), `${c.id} ${kind}`);
    if (route.intent !== "none") assert.deepEqual(parseRoute(route), route, c.id);
    for (const app of [c.expect.app ?? null].flat()) if (app && !ids.has(app)) assert.ok(!/^[a-z]+\.[a-z]/.test(app), `${c.id}: ${app} looks like an id that isn't on the box`);
  }
});

test("the scorer reads a title the same whatever its case, accents, punctuation or leading the", () => {
  assert.ok(same("Shōgun", "shogun"));
  assert.ok(same("The Bear", "bear"));
  assert.ok(same("Portal 2", "portal 2!"));
  assert.ok(!same("Portal", "Portal 2"));
  assert.ok(!same("Frozen II", "Frozen"));
});

test("the scorer counts only the slots a case names, and any of a list", () => {
  const e: Expect = { intent: "play", query: "Frozen", kind: ["video", "film"] };
  assert.deepEqual(wrong({ ...NONE, intent: "play", query: "frozen", kind: "film", app: "agentv.plex" }, e), []);
  assert.deepEqual(wrong({ ...NONE, intent: "play", query: "Frozen", kind: null }, e), ['kind null, not "video" or "film"']);
  assert.deepEqual(wrong({ ...NONE, intent: "continue", query: "Frozen" }, e), ["intent continue, not play"]);
  assert.deepEqual(wrong({ ...NONE, intent: "play", query: null, app: "agentv.steam" }, { intent: "play", query: null, app: "agentv.steam" }), []);
  assert.deepEqual(wrong({ ...NONE, intent: "play", query: "Severance", season: 2, episode: 4 }, { intent: "play", query: "Severance", season: 2, episode: 3 }), ["episode 4, not 3"]);
  // A provider that didn't answer is a miss, whatever was expected.
  assert.equal(result(set.cases.at(-1)!, { sentence: "", route: { ...NONE }, none: "failed", error: "timeout", provider: "claude", via: "api", model: null, ms: 0 }).ok, false);
});

test("S7.1 S7.3 a provider that answers as expected meets every bar, and one that guesses fails S7.3", async () => {
  const right = await runCases({ cases: set.cases, apps: set.apps, concurrency: 8, backend: { provider: "claude", via: "api", model: "test", ask: async (ask) => ({ value: expected(set.cases.find((c) => ask.user.endsWith(JSON.stringify(c.say)))!.expect) }) } });
  const s = score(right);
  assert.deepEqual([s.routed.percent, s.unroutable.percent], [100, 100]);
  assert.deepEqual(meets(s), { routed: true, unroutable: true, seconds: true });
  // A guess for every sentence it can't route.
  const guessing = await runCases({ cases: set.cases, apps: set.apps, concurrency: 8, backend: { provider: "claude", via: "api", model: "test", ask: async (ask) => {
    const c = set.cases.find((c) => ask.user.endsWith(JSON.stringify(c.say)))!;
    return { value: c.expect.intent === "none" ? { ...NONE, intent: "play", query: c.say } : expected(c.expect) };
  } } });
  const g = score(guessing);
  assert.equal(g.routed.percent, 100);
  assert.ok(g.unroutable.right <= 1, `${g.unroutable.right}`); // "play" alone is none either way
  assert.equal(meets(g).unroutable, false);
});

// A stand-in for Anthropic's API that answers each sentence as the phrase
// set expects, or wrongly for the ones it's told to.
let server: Server;
let base = "";
let miss = new Set<string>();
before(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const c = set.cases.find((c) => body.messages[0].content.endsWith(JSON.stringify(c.say)))!;
    const route = miss.has(c.id) ? { ...NONE, intent: "whats_new" } : expected(c.expect);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ type: "message", model: body.model, content: [{ type: "text", text: JSON.stringify(route) }], stop_reason: "end_turn", usage: { input_tokens: 1500, output_tokens: 40 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

// The runner as CI runs it, on its own, so the stand-in can answer it.
const run = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(RUN, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

test("S7.1 the runner scores a provider end to end, with a line a sentence and the table", async () => {
  miss = new Set();
  const { status, stdout } = await run(["--provider", "claude", "--base", base, "--strict"], { ANTHROPIC_API_KEY: "test-key" });
  assert.equal(status, 0, stdout);
  assert.match(stdout, /^ok continue-01 "continue my show" \(\d+ ms\)$/m);
  assert.match(stdout, /\| S7\.1, S7\.2: the four requests \| 80 of 80 \| 100% \| 95%, meets it \|/);
  assert.match(stdout, /\| S7\.3: none, never a guess \| 20 of 20 \| 100% \| every one, meets it \|/);
  assert.match(stdout, /### Router evals: claude, its API with a key, claude-haiku-5-5/);
});

test("S7.1 --strict fails below 95%, and says which it missed and why", async () => {
  miss = new Set(set.cases.filter((c) => c.expect.intent === "play").slice(0, 5).map((c) => c.id));
  const { status, stdout } = await run(["--provider", "claude", "--base", base, "--strict"], { ANTHROPIC_API_KEY: "test-key" });
  assert.equal(status, 1);
  assert.match(stdout, /\| 75 of 80 \| 93\.8% \| 95%, below it \|/);
  assert.match(stdout, /^not ok play-01 "play Frozen": intent whats_new, not play/m);
  assert.match(stdout, /\| play-01 \| play Frozen \| intent whats_new, not play \|/);
});

test("the runner says which key it needs, and that a provider with no plan has no CLI", async () => {
  const noKey = await run(["--provider", "gemini"], { GEMINI_API_KEY: "" });
  assert.equal(noKey.status, 3);
  assert.match(noKey.stderr, /GEMINI_API_KEY isn't set/);
  const noPlan = await run(["--provider", "muse", "--via", "cli"]);
  assert.equal(noPlan.status, 2);
  assert.match(noPlan.stderr, /muse has no plan a box offers/);
});
