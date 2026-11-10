// The Ask box building apps (daemon/executors/make.ts, daemon/routes/ask.ts,
// ADR-068): make starts the builder and its confirm, change waits for an
// adult's ok and then starts a new version, a child is told to ask a
// grown-up, no AI says where to set one up, and with the askbuilds switch
// off, make and change are "i didn't get that" as before. Then the daemon's
// side, from a phone, with a stand-in router and builder.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { installLocal } from "../../../daemon/apps/install.ts";
import { DIDNT_GET, execute, NO_AI, type ExecApp, type ExecContext, type Outcome } from "../../../daemon/executors/index.ts";
import type { ExecBuilds } from "../../../daemon/executors/make.ts";
import { askRoutes, type AskRoutes } from "../../../daemon/routes/ask.ts";
import { NONE, type Route, type Routed, type RouterApp } from "../../../daemon/router.ts";
import type { Said } from "../../../daemon/say.ts";
import type { BuildView } from "../../../daemon/builds.ts";
import { Daemon } from "../../../daemon/server.ts";
import { pairPhone, type TestPhone } from "./phone-client.mts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-ask-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const routed = (route: Route, extra: Partial<Routed> = {}): Routed => ({ sentence: "", route, provider: "claude", via: "api", model: "test", ms: 1, ...extra });
const make = (what: string): Route => ({ ...NONE, intent: "make", what });
const change = (what: string, app: string | null = null): Route => ({ ...NONE, intent: "change", what, app });

const APPS: ExecApp[] = [
  { id: "agentv.jellyfin", name: "Jellyfin", category: "media", capabilities: ["launch", "search"] },
  { id: "local.blocks", name: "Blocks", category: "games", capabilities: ["launch"], made: true },
];

// The executors' world, with a stand-in builder that keeps what it was asked.
function context(o: { builds?: Partial<ExecBuilds> | null; apps?: ExecApp[] } = {}) {
  const asked: string[] = [];
  const builds: ExecBuilds = {
    adult: true,
    ready: async () => null,
    make: async (what) => (asked.push(what), { build: "b1" }),
    recipe: async (app) => (app === "local.blocks" ? "game" : null),
    ...o.builds,
  };
  const ctx: ExecContext = {
    apps: o.apps ?? APPS,
    rows: () => [],
    search: async () => [],
    open: async () => ({ ok: true }),
    ...(o.builds === null ? {} : { builds }),
  };
  return { ctx, asked };
}

// --- Make and change -----------------------------------------------------------

test("T11.2 make starts the builder with what was said, and the TV says the agent is reading it", async () => {
  const { ctx, asked } = context();
  assert.deepEqual(await execute(routed(make("a game like Tetris")), ctx), { kind: "build", build: "b1", what: "a game like Tetris", say: "your agent is reading what you asked" });
  assert.deepEqual(asked, ["a game like Tetris"]);
});

test("T11.2 a child's make or change is 'ask a grown-up', and nothing is built", async () => {
  const { ctx, asked } = context({ builds: { adult: false } });
  assert.deepEqual(await execute(routed(make("a game with unicorns")), ctx), { kind: "none", why: "child", say: "ask a grown-up to make apps" });
  assert.deepEqual(await execute(routed(change("make the jump higher", "local.blocks")), ctx), { kind: "none", why: "child", say: "ask a grown-up to change apps" });
  assert.deepEqual(asked, []);
});

test("with no AI ready to build, make says where to set it up, and a builder that won't start says why", async () => {
  const { ctx } = context({ builds: { ready: async () => NO_AI } });
  assert.deepEqual(await execute(routed(make("a quiz")), ctx), { kind: "none", why: "no-ai", say: "set up an ai first: settings → ai" });
  const busy = context({ builds: { make: async () => ({ error: "another build is going; one runs at a time" }) } });
  assert.deepEqual(await execute(routed(make("a quiz")), busy.ctx), { kind: "none", why: "not-built", say: "another build is going; one runs at a time" });
  // An AI that isn't set up can't route anything, so the router says so,
  // and with the Ask box building the TV says where to set it up.
  const failed = routed({ ...NONE }, { none: "failed", error: "set up your agent in settings → ai first", setup: "ai" });
  assert.deepEqual(await execute(failed, context().ctx), { kind: "none", why: "no-ai", say: NO_AI });
  assert.deepEqual(await execute(failed, context({ builds: null }).ctx), { kind: "none", why: "failed", say: "your agent didn't answer", detail: "set up your agent in settings → ai first" }, "with the switch off, as before");
});

test("with the askbuilds switch off, make and change are 'i didn't get that', as before the router knew them", async () => {
  const { ctx } = context({ builds: null });
  assert.deepEqual(await execute(routed(make("a game like Tetris")), ctx), { kind: "none", why: "unroutable", say: DIDNT_GET });
  assert.deepEqual(await execute(routed(change("make it faster", "local.blocks")), ctx), { kind: "none", why: "unroutable", say: DIDNT_GET });
});

test("T11.2 a change to an app the agent made waits for an adult's ok, with its recipe", async () => {
  const { ctx, asked } = context();
  const waiting = await execute(routed(change("make the pieces fall faster", "local.blocks")), ctx);
  assert.deepEqual(waiting, { kind: "change", app: "local.blocks", name: "Blocks", what: "make the pieces fall faster", recipe: "game", say: "change blocks: make the pieces fall faster?" });
  // By its name too, as said.
  assert.equal(((await execute(routed(change("add levels", "Blocks")), ctx)) as Outcome & { app: string }).app, "local.blocks");
  assert.deepEqual(asked, [], "nothing starts before the ok");
});

test("a change names the app or finds the only one the agent made, and says why when it can't", async () => {
  const { ctx } = context();
  assert.equal(((await execute(routed(change("make the jump higher")), ctx)) as Outcome & { app: string }).app, "local.blocks", "the only one the agent made");
  assert.deepEqual(await execute(routed(change("make it faster", "agentv.jellyfin")), ctx), { kind: "none", why: "not-made", say: "your agent didn't make jellyfin, so it can't change it" });
  assert.deepEqual(await execute(routed(change("make it faster", "Snake")), ctx), { kind: "none", why: "missing", say: "there's no snake on this tv" });
  const none = context({ apps: [APPS[0]] });
  assert.deepEqual(await execute(routed(change("make the jump higher")), none.ctx), { kind: "none", why: "not-made", say: "your agent hasn't made any apps yet" });
  const two = context({ apps: [...APPS, { id: "local.quiz", name: "Quiz", category: "games", capabilities: [], made: true }] });
  assert.deepEqual(await execute(routed(change("make the jump higher")), two.ctx), { kind: "none", why: "which", say: "which app? say its name too" });
});

// --- The Ask box's routes ------------------------------------------------------

function fakeKit(o: { on?: boolean; adult?: boolean; outcome?: Outcome; build?: Partial<BuildView> } = {}) {
  const did: string[] = [];
  let said: Said | null = o.outcome ? { n: 7, sentence: "x", from: "iphone", viewer: "ana", state: "done", outcome: o.outcome, at: "" } : null;
  const view = { build: "b1", id: "local.blocks", version: "1.0.0", sentence: "blocks", provider: "claude", path: "plan", state: "confirm", phase: "understand", steps: [], shot: false, at: "", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" }, ...o.build } as BuildView;
  const kit: AskRoutes = {
    on: async () => o.on ?? true,
    adult: async () => o.adult ?? true,
    said: () => said,
    find: async (build) => (build === view.build ? view : build === "b2" ? ({ ...view, build: "b2", state: "starting", phase: "build" } as BuildView) : null),
    confirm: async (build) => (did.push(`confirm ${build}`), { build: view }),
    forget: async (build) => (did.push(`forget ${build}`), {}),
    change: async (app, what) => (did.push(`change ${app}: ${what}`), { build: { ...view, build: "b2", state: "starting", phase: "build" } as BuildView }),
    settle: (n, outcome) => (did.push(`settle ${n} ${outcome.kind}`), (said = { ...said!, outcome })),
    dismiss: (n) => (did.push(`dismiss ${n}`), (said = null), true),
    body: async (request) => (request as unknown as { body: unknown }).body,
    json: () => {},
    log: () => {},
  };
  return { kit, did };
}

async function call(kit: AskRoutes, method: string, path: string, body?: unknown): Promise<{ handled: boolean; status: number; data: any }> {
  let status = 0;
  let data: any;
  const handled = await askRoutes({ ...kit, json: (_r, s, d) => ((status = s), (data = d)) }, { method, body } as unknown as IncomingMessage, {} as ServerResponse, path);
  return { handled, status, data };
}

test("the Ask box's routes answer only their own paths, and not at all with the switch off", async () => {
  const { kit } = fakeKit({ on: false });
  assert.equal((await call(kit, "GET", "/api/asks")).handled, false);
  assert.equal((await call(kit, "GET", "/api/phone/say")).handled, false);
  assert.deepEqual(await call(kit, "GET", "/api/phone/ask"), { handled: true, status: 404, data: { ok: false, error: "not found" } });
});

test("T11.2 GET says what the Ask box is waiting on: a make the agent read, with its recipe, or nothing for a child", async () => {
  const { kit } = fakeKit({ outcome: { kind: "build", build: "b1", what: "a game like tetris", say: "" } });
  const { data } = await call(kit, "GET", "/api/phone/ask");
  assert.deepEqual(data, { ok: true, ask: { kind: "build", n: 7, build: "b1", app: null, what: "a game like tetris", state: "confirm", phase: "understand", name: "Blocks", recipe: "game", says: "a falling-block game", done: 0, steps: 0 } });
  assert.deepEqual((await call(fakeKit({ adult: false, outcome: { kind: "build", build: "b1", what: "x", say: "" } }).kit, "GET", "/api/ask")).data, { ok: true, ask: null });
  assert.deepEqual((await call(fakeKit().kit, "GET", "/api/ask")).data, { ok: true, ask: null });
});

test("T11.2 an adult's ok to a make is the builder's own confirm, and only once the agent has read it", async () => {
  const reading = fakeKit({ outcome: { kind: "build", build: "b1", what: "x", say: "" }, build: { state: "running" } });
  assert.deepEqual((await call(reading.kit, "POST", "/api/phone/ask/confirm", { n: 7 })).data, { ok: false, error: "your agent is still reading it" });
  const { kit, did } = fakeKit({ outcome: { kind: "build", build: "b1", what: "x", say: "" } });
  assert.equal((await call(kit, "POST", "/api/phone/ask/confirm", { n: 6 })).status, 409, "not a newer sentence's");
  assert.equal((await call(kit, "POST", "/api/phone/ask/confirm", { n: 7 })).status, 200);
  assert.deepEqual(did, ["confirm b1"]);
  const no = fakeKit({ outcome: { kind: "build", build: "b1", what: "x", say: "" } });
  assert.equal((await call(no.kit, "POST", "/api/ask/cancel", { n: 7 })).status, 200);
  assert.deepEqual(no.did, ["forget b1", "settle 7 none"]);
});

test("T11.2 an adult's ok to a change starts its new version, and 'not this' drops it; a child can do neither", async () => {
  const outcome: Outcome = { kind: "change", app: "local.blocks", name: "Blocks", what: "make the pieces fall faster", recipe: "game", say: "" };
  const child = fakeKit({ adult: false, outcome });
  assert.deepEqual((await call(child.kit, "POST", "/api/phone/ask/confirm", { n: 7 })).data, { ok: false, error: "ask a grown-up to make apps" });
  assert.deepEqual(child.did, []);
  const { kit, did } = fakeKit({ outcome });
  const ok = await call(kit, "POST", "/api/ask/confirm", { n: 7 });
  assert.equal(ok.status, 200);
  assert.deepEqual(did, ["change local.blocks: make the pieces fall faster", "settle 7 build"]);
  assert.equal(ok.data.ask?.kind, "build");
  const no = fakeKit({ outcome });
  assert.equal((await call(no.kit, "POST", "/api/phone/ask/cancel", { n: 7 })).status, 200);
  assert.deepEqual(no.did, ["dismiss 7"]);
});

// --- From a phone, through the daemon -----------------------------------------

test("T11.2 through the daemon: with the switch on, a phone's make reaches the builder's confirm, a change to the app it made waits for an ok, and a child is told to ask a grown-up", async () => {
  const base = join(scratch, "daemon");
  const builds = join(base, "build");
  const apps = join(base, "apps");
  mkdirSync(join(base, "state"), { recursive: true });
  writeFileSync(join(base, "channel"), "edge\n");
  let heard: RouterApp[] = [];
  let next: Route = { ...NONE };
  const daemon = new Daemon({
    root: join(base, "root"),
    state: join(base, "state"),
    apps,
    port: 0,
    log: () => {},
    builtins: null,
    lanPort: 0,
    lanHost: "127.0.0.1",
    address: () => "127.0.0.1",
    keyStatus: join(base, "key.json"),
    channelFile: join(base, "channel"),
    builds,
    buildRun: join(base, "run"),
    spend: join(base, "spend.json"),
    npmWarnings: join(base, "warnings.json"),
    router: async (sentence, list) => ((heard = list), routed(next, { sentence })),
  });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  const lan = `http://127.0.0.1:${daemon.lanPort}`;
  try {
    const send = (method: string, path: string, body?: unknown, grant?: string) =>
      fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const code = (await (await send("POST", "/api/phones/pair", {})).json()).pairing.code;
    const token = await pairPhone(lan, code, "iphone");
    const phone = (method: string, path: string, body?: unknown, grant?: string) =>
      token.fetch(`${path}`, { method, headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    writeFileSync(join(base, "state", "setup.json"), JSON.stringify({ done: true, at: "2026-11-05T08:00:00Z" }));
    const say = async (sentence: string, route: Route) => ((next = route), (await (await phone("POST", "/api/phone/say", { sentence })).json()).said);

    // Off, as it ships: "i didn't get that", and no Ask routes.
    assert.equal((await say("make me a game like tetris", make("blocks"))).outcome.say, DIDNT_GET);
    assert.equal((await phone("GET", "/api/phone/ask")).status, 404);
    assert.equal((await send("PUT", "/api/features", { askbuilds: true })).status, 200);

    // On, with no AI picked yet: where to set it up.
    assert.deepEqual((await say("make me a game like tetris", make("blocks"))).outcome, { kind: "none", why: "no-ai", say: NO_AI });

    // A plan, its terms accepted on the phone past the PIN.
    assert.equal((await send("PUT", "/api/pin", { pin: "2468" })).status, 200);
    const grant = (await (await phone("POST", "/api/phone/pin", { pin: "2468" })).json()).grant;
    await send("POST", "/api/ai", { provider: "claude", path: "plan" }, grant);
    assert.equal((await phone("POST", "/api/phone/terms", { provider: "claude", path: "plan" }, grant)).status, 200);

    // The router's what is the builder's sentence, so this app's id is local.blocks.
    const made = await say("make me a game like tetris", make("blocks"));
    assert.equal(made.outcome.kind, "build", JSON.stringify(made));
    const start = JSON.parse(readFileSync(join(base, "state", "build-drop", "start.json"), "utf8"));
    assert.deepEqual([start.phase, start.sentence, start.id, start.path], ["understand", "blocks", "local.blocks", "plan"]);
    rmSync(join(base, "state", "build-drop", "start.json")); // root took it
    const version = join(builds, "local.blocks", "1.0.0");
    const status = (change: Record<string, unknown>) => {
      mkdirSync(version, { recursive: true });
      writeFileSync(join(version, "status.json"), JSON.stringify({ build: made.outcome.build, id: "local.blocks", version: "1.0.0", phase: "understand", steps: [], started: "", at: "", ...change }));
    };
    status({ state: "running" });
    assert.equal((await (await phone("POST", "/api/phone/ask/confirm", { n: made.n })).json()).error, "your agent is still reading it");
    status({ state: "confirm", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" } });
    const waiting = (await (await phone("GET", "/api/phone/ask")).json()).ask;
    assert.deepEqual([waiting.kind, waiting.state, waiting.name, waiting.recipe], ["build", "confirm", "Blocks", "game"]);
    assert.equal((await phone("POST", "/api/phone/ask/confirm", { n: made.n })).status, 200);
    const built = JSON.parse(readFileSync(join(base, "state", "build-drop", "start.json"), "utf8"));
    assert.deepEqual([built.phase, built.recipe, built.name], ["build", "game", "Blocks"]);
    rmSync(join(base, "state", "build-drop", "start.json"));

    // Approved and installed: Blocks is on the TV, made by the agent.
    status({ phase: "build", state: "installed", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" } });
    const pkg = join(scratch, "blocks");
    cpSync(join(ROOT, "test/agentv/fixtures/apps/blocks"), pkg, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(pkg, "manifest.json"), "utf8"));
    writeFileSync(join(pkg, "manifest.json"), JSON.stringify({ ...manifest, id: "local.blocks", author: "your agent" }));
    await installLocal(pkg, apps, async () => true);

    // A change: the router hears Blocks is the agent's, and nothing starts before the ok.
    const asked = await say("make the pieces in blocks fall faster", change("make the pieces fall faster", "local.blocks"));
    assert.deepEqual(heard.find((app) => app.id === "local.blocks"), { id: "local.blocks", name: "Blocks", category: "games", made: true });
    assert.deepEqual(asked.outcome, { kind: "change", app: "local.blocks", name: "Blocks", what: "make the pieces fall faster", recipe: "game", say: "change blocks: make the pieces fall faster?" });
    assert.equal((await (await phone("GET", "/api/phone/ask")).json()).ask.kind, "change");
    assert.equal((await send("POST", "/api/ask/confirm", { n: asked.n })).status, 200);
    const changed = JSON.parse(readFileSync(join(base, "state", "build-drop", "start.json"), "utf8"));
    assert.deepEqual([changed.phase, changed.id, changed.version, changed.from, changed.change], ["build", "local.blocks", "1.1.0", "1.0.0", "make the pieces fall faster"]);
    assert.equal((await (await send("GET", "/api/say")).json()).said.outcome.say, "building blocks");

    // A child's profile: ask a grown-up, and the routes say so too.
    const child = (await (await send("POST", "/api/viewers", { name: "mia", role: "child" }, grant)).json()).profile;
    await send("POST", "/api/viewer", { id: child.id });
    assert.deepEqual((await say("make me a game with unicorns", make("a game with unicorns"))).outcome, { kind: "none", why: "child", say: "ask a grown-up to make apps" });
    assert.deepEqual(await (await phone("GET", "/api/phone/ask")).json(), { ok: true, ask: null });
  } finally {
    await daemon.close();
  }
});
