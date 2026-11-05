// The router's eval (test/agentv/evals/router, ADR-019 layer 6), checked
// on every push with no key (layer 2): the phrase set has what S7.1 and
// S7.3 ask of it, the scorer reads answers fairly, and the runner scores a
// stand-in provider end to end and fails --strict below the bars.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { INTENTS, KINDS, NONE, parseRoute, type Route } from "../../../daemon/router.ts";
import { runCases } from "../evals/router/run.mts";
import { holds, meets, phrases, result, same, score, set as setOf, worse, wrong, type Expect } from "../evals/router/score.ts";

const RUN = join(import.meta.dirname, "../evals/router/run");
const set = phrases();

// The answer each case expects, taking the first of any list.
function expected(e: Expect): Route {
  const first = <T,>(v: T | T[] | undefined): T | null => (v === undefined ? null : Array.isArray(v) ? (v[0] ?? null) : v);
  if (e.intent === "none") return { ...NONE };
  if (e.intent === "make" || e.intent === "change") return { ...NONE, intent: e.intent, app: e.intent === "change" ? ((first(e.app) as string | null) ?? null) : null, what: (e.what ?? []).join(" ") };
  return { intent: e.intent, query: first(e.query) as string | null, kind: first(e.kind), app: first(e.app) as string | null, season: e.season ?? null, episode: e.episode ?? null, what: null };
}

test("S7.1 S7.3 T11.1 the phrase set has 20 phrasings for each of the six requests, 10 with make's or change's words that aren't a build, and 20 that can't be routed", () => {
  const counts: Record<string, number> = {};
  for (const c of set.cases) counts[setOf(c.id)] = (counts[setOf(c.id)] ?? 0) + 1;
  assert.deepEqual(counts, { continue: 20, play: 20, "whats-new": 20, "new-episode": 20, make: 20, change: 20, collide: 10, none: 20 });
  // Each request's set is that request, every one, so its score is how well that request routes.
  for (const c of set.cases) {
    const name = setOf(c.id);
    if (name !== "collide") assert.equal(c.expect.intent, name.replace("-", "_"), c.id);
    else assert.ok(c.expect.intent === "none" || c.expect.intent === "play", c.id);
  }
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

test("T11.1 make and change say what each must hold, a change names an app the agent made or none, and the collisions are play or none", () => {
  const made = new Set(set.apps.filter((a) => a.made).map((a) => a.id));
  for (const c of set.cases.filter((c) => c.expect.intent === "make" || c.expect.intent === "change")) {
    assert.ok(Array.isArray(c.expect.what) && c.expect.what.length > 0, c.id);
    // What it must hold is the person's own words.
    for (const word of c.expect.what!) assert.ok(holds(c.say, [word]), `${c.id}: ${word}`);
    if (c.expect.intent === "make") assert.equal(c.expect.app, null, c.id);
    else assert.ok(c.expect.app === null || made.has(c.expect.app as string), c.id);
  }
  // Some changes name no app at all, for the one in front or the only one.
  assert.ok(set.cases.filter((c) => c.expect.intent === "change" && c.expect.app === null).length >= 2);
  // make and play collide both ways, as the plan asks: make a game like a
  // title that plays, and a playlist that isn't a build.
  assert.ok(set.cases.filter((c) => setOf(c.id) === "make" && c.collision).length >= 5);
  for (const say of ["make a playlist of my 80s songs", "make it louder", "change the channel", "play Blocks", "watch The Making of Dune"]) assert.ok(set.cases.some((c) => setOf(c.id) === "collide" && c.say === say), say);
  // The router hears which apps the agent made.
  assert.deepEqual([...made].sort(), ["local.blocks", "local.bus-times", "local.family-quiz", "local.kino", "local.radio"]);
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

test("T11.1 the scorer reads what by the words it must hold, and holds make and change to the bar on their own", () => {
  assert.ok(holds("a game like Tetris!", ["game", "tetris"]));
  assert.ok(holds("add a two-player mode", ["two", "player"]));
  assert.ok(!holds("a game like Tetris", ["chess"]));
  const e: Expect = { intent: "make", what: ["game", "tetris"], app: null };
  assert.deepEqual(wrong({ ...NONE, intent: "make", what: "Game like TETRIS" }, e), []);
  assert.deepEqual(wrong({ ...NONE, intent: "make", what: "a puzzle" }, e), ['what "a puzzle", not one with "game" and "tetris"']);
  assert.deepEqual(wrong({ ...NONE, intent: "change", app: "local.blocks", what: "jump higher" }, { intent: "change", app: "local.blocks", what: ["jump"] }), []);
  assert.deepEqual(wrong({ ...NONE, intent: "change", app: null, what: "jump higher" }, { intent: "change", app: "local.blocks", what: ["jump"] }), ['app null, not "local.blocks"']);
  // 19 of 20 changes is 95%, and 18 is below it, even with everything else right.
  const routed = (id: string, ok: boolean) => ({ id, ok, say: "", expect: { intent: "change" as const }, routed: { sentence: "", route: { ...NONE }, provider: "claude" as const, via: "api" as const, model: null, ms: 1 }, problems: ok ? [] : ["x"] });
  const others = Array.from({ length: 200 }, (_, i) => ({ ...routed(`play-${i}`, true), expect: { intent: "play" as const } }));
  assert.equal(meets(score([...others, ...Array.from({ length: 20 }, (_, i) => routed(`change-${i + 1}`, i !== 0))])).builds, true);
  const below = score([...others, ...Array.from({ length: 20 }, (_, i) => routed(`change-${i + 1}`, i > 1))]);
  assert.equal(below.bySet.change.percent, 90);
  assert.equal(meets(below).routed, true);
  assert.equal(meets(below).builds, false);
});

test("T11.1 an earlier run says which sets and sentences got worse", () => {
  const r = (id: string, ok: boolean) => ({ id, ok, say: id, expect: { intent: "play" as const }, routed: { sentence: "", route: { ...NONE }, provider: "claude" as const, via: "api" as const, model: null, ms: 1 }, problems: ok ? [] : ["intent none, not play"] });
  const before = [r("play-01", true), r("play-02", true), r("continue-01", false)];
  const got = worse(before, [r("play-01", true), r("play-02", false), r("continue-01", true), r("make-01", false)]);
  assert.deepEqual(got.sets, [{ set: "play", was: 100, now: 50 }]);
  assert.deepEqual(got.cases, [{ id: "play-02", say: "play-02", problems: ["intent none, not play"] }]);
  // A set that's new since has nothing to be worse than.
  assert.deepEqual(worse(before, [r("make-01", false)]), { sets: [], cases: [] });
});

test("the scorer counts only the slots a case names, and any of a list", () => {
  const e: Expect = { intent: "play", query: "Frozen", kind: ["video", "film"] };
  assert.deepEqual(wrong({ ...NONE, intent: "play", query: "frozen", kind: "film", app: "agentv.plex" }, e), []);
  assert.deepEqual(wrong({ ...NONE, intent: "play", query: "Frozen", kind: null }, e), ['kind null, not "video" or "film"']);
  assert.deepEqual(wrong({ ...NONE, intent: "continue", query: "Frozen" }, e), ["intent continue, not play"]);
  assert.deepEqual(wrong({ ...NONE, intent: "play", query: null, app: "agentv.steam" }, { intent: "play", query: null, app: "agentv.steam" }), []);
  assert.deepEqual(wrong({ ...NONE, intent: "play", query: "Severance", season: 2, episode: 4 }, { intent: "play", query: "Severance", season: 2, episode: 3 }), ["episode 4, not 3"]);
  // A provider that didn't answer is a miss, whatever was expected, and
  // with none answered there's no time per sentence to meet the target.
  const unanswered = result(set.cases.at(-1)!, { sentence: "", route: { ...NONE }, none: "failed", error: "timeout", provider: "claude", via: "api", model: null, ms: 0 });
  assert.equal(unanswered.ok, false);
  assert.equal(meets(score([unanswered])).seconds, false);
});

test("S7.1 S7.3 a provider that answers as expected meets every bar, and one that guesses fails S7.3", async () => {
  const right = await runCases({ cases: set.cases, apps: set.apps, concurrency: 8, backend: { provider: "claude", via: "api", model: "test", ask: async (ask) => ({ value: expected(set.cases.find((c) => ask.user.endsWith(JSON.stringify(c.say)))!.expect) }) } });
  const s = score(right);
  assert.deepEqual([s.routed.percent, s.unroutable.percent], [100, 100]);
  assert.deepEqual(meets(s), { routed: true, builds: true, unroutable: true, seconds: true });
  assert.deepEqual([s.bySet.make.percent, s.bySet.change.percent, s.bySet.collide.percent], [100, 100, 100]);
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
  assert.match(stdout, /\| S7\.1, S7\.2: every request \| 125 of 125 \| 100% \| 95%, meets it \|/);
  assert.match(stdout, /\| T11\.1: make \| 20 of 20 \| 100% \| 95%, meets it \|/);
  assert.match(stdout, /\| T11\.1: change \| 20 of 20 \| 100% \| 95%, meets it \|/);
  assert.match(stdout, /\| make or change words, not a build \| 10 of 10 \| 100% \| +\|/);
  assert.match(stdout, /\| S7\.3: none, never a guess \| 25 of 25 \| 100% \| every one, meets it \|/);
  assert.match(stdout, /### Router evals: claude, its API with a key, claude-haiku-5-5/);
});

test("S7.1 --strict fails below 95%, and says which it missed and why", async () => {
  miss = new Set(set.cases.filter((c) => setOf(c.id) === "play").slice(0, 7).map((c) => c.id));
  const { status, stdout } = await run(["--provider", "claude", "--base", base, "--strict"], { ANTHROPIC_API_KEY: "test-key" });
  assert.equal(status, 1);
  assert.match(stdout, /\| 118 of 125 \| 94\.4% \| 95%, below it \|/);
  assert.match(stdout, /\| play \| 13 of 20 \| 65% \| +\|/);
  assert.match(stdout, /^not ok play-01 "play Frozen": intent whats_new, not play/m);
  assert.match(stdout, /\| play-01 \| play Frozen \| intent whats_new, not play \|/);
});

test("T11.1 --strict fails when make or change is below 95% on its own, though every request together meets it", async () => {
  miss = new Set(set.cases.filter((c) => setOf(c.id) === "change").slice(0, 2).map((c) => c.id));
  const { status, stdout } = await run(["--provider", "claude", "--base", base, "--strict"], { ANTHROPIC_API_KEY: "test-key" });
  assert.equal(status, 1, stdout);
  assert.match(stdout, /\| S7\.1, S7\.2: every request \| 123 of 125 \| 98\.4% \| 95%, meets it \|/);
  assert.match(stdout, /\| T11\.1: change \| 18 of 20 \| 90% \| 95%, below it \|/);
});

test("T11.1 with an earlier run, the runner says what got worse, and --strict fails on a set that did", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentv-evals-"));
  try {
    miss = new Set();
    const earlier = join(dir, "earlier.json");
    assert.equal((await run(["--provider", "claude", "--base", base, "--json", earlier], { ANTHROPIC_API_KEY: "test-key" })).status, 0);
    const same = await run(["--provider", "claude", "--base", base, "--baseline", earlier, "--strict"], { ANTHROPIC_API_KEY: "test-key" });
    assert.equal(same.status, 0, same.stdout);
    assert.match(same.stdout, /^Nothing got worse since the earlier run\.$/m);
    miss = new Set(["continue-03"]);
    const now = await run(["--provider", "claude", "--base", base, "--baseline", earlier, "--strict"], { ANTHROPIC_API_KEY: "test-key" });
    assert.equal(now.status, 1, now.stdout);
    assert.match(now.stdout, /^- continue: 100% then, 95% now$/m);
    assert.match(now.stdout, /^- continue-03 "resume": intent whats_new, not continue$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the runner says which key it needs, and that a provider with no plan has no CLI", async () => {
  const noKey = await run(["--provider", "gemini"], { GEMINI_API_KEY: "" });
  assert.equal(noKey.status, 3);
  assert.match(noKey.stderr, /GEMINI_API_KEY isn't set/);
  const noPlan = await run(["--provider", "muse", "--via", "cli"]);
  assert.equal(noPlan.status, 2);
  assert.match(noPlan.stderr, /muse has no plan a box offers/);
});
