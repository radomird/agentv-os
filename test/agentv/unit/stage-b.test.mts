// A streaming service's stage B (ADR-011): the build sees the service's
// signed-in pages only through AgenTV. The builder's way out takes an ask
// only in stage B and only for the build's declared origins
// (builder/sandbox/net.ts), the daemon checks it again against root's
// ticket and queues it, and the screen daemon takes it and answers
// (daemon/page-asks.ts); the screen daemon's own part is in screen.test.mts.
// And the daemon starts stage B by itself once the household signed in.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pageServer } from "../../../builder/sandbox/net.ts";
import type { Ticket } from "../../../builder/sandbox/relay.ts";
import { Builds } from "../../../daemon/builds.ts";
import { PageAsks, PageAskWatch } from "../../../daemon/page-asks.ts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-stage-b-"));
const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
  rmSync(scratch, { recursive: true, force: true });
});
let count = 0;

const ticket = (phase: string): Ticket => ({ build: "b1", id: "local.stand-in", version: "1.0.0", dir: "/x", provider: "claude", path: "key", recipe: "streaming", phase });

// The builder's side of page.sock, on a socket file here.
async function pageSock(o: { phase?: string; ask?: (url: string) => Promise<object> }) {
  const path = join(scratch, `page${++count}.sock`);
  const asked: string[] = [];
  const server = pageServer({
    ticket: () => (o.phase ? ticket(o.phase) : null),
    declared: () => ["https://stand-in.test"],
    ask: o.ask ?? (async (url) => (asked.push(url), { ok: true, url, title: "Stand-in", lines: [] })),
    log: () => {},
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(path, done));
  const post = (body: string) =>
    new Promise<{ status: number; body: any }>((done, fail) => {
      const request = httpRequest({ socketPath: path, method: "POST", path: "/snapshot", headers: { "Content-Type": "application/json" } }, (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => (text += chunk));
        response.on("end", () => done({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
      });
      request.on("error", fail);
      request.end(body);
    });
  return { post, asked };
}

test("ADR-011 the builder's way out takes a look at a signed-in page only in stage B, on the build's declared origins", async () => {
  const stageA = await pageSock({ phase: "build" });
  assert.equal((await stageA.post(JSON.stringify({ url: "https://stand-in.test/" }))).status, 403);
  assert.deepEqual(stageA.asked, []);
  const none = await pageSock({});
  assert.match((await none.post(JSON.stringify({ url: "https://stand-in.test/" }))).body.error, /for stage B/);

  const b = await pageSock({ phase: "stage-b" });
  assert.match((await b.post(JSON.stringify({ url: "https://elsewhere.test/" }))).body.error, /https:\/\/elsewhere\.test isn't one of the build's declared origins/);
  assert.equal((await b.post(JSON.stringify({ url: "http://stand-in.test/" }))).status, 403);
  assert.equal((await b.post("not json")).status, 400);
  assert.equal((await b.post(JSON.stringify({ url: "https://stand-in.test/", pad: "x".repeat(5000) }))).status, 413);
  const seen = await b.post(JSON.stringify({ url: "https://stand-in.test/browse" }));
  assert.deepEqual([seen.status, seen.body.ok, b.asked], [200, true, ["https://stand-in.test/browse"]]);
});

test("ADR-011 one look at a time, and a TV that doesn't answer says so", async () => {
  let release: () => void = () => {};
  const slow = await pageSock({ phase: "stage-b", ask: () => new Promise((done) => (release = () => done({ ok: true }))) });
  const first = slow.post(JSON.stringify({ url: "https://stand-in.test/a" }));
  await new Promise((done) => setTimeout(done, 50));
  assert.equal((await slow.post(JSON.stringify({ url: "https://stand-in.test/b" }))).status, 429);
  release();
  assert.equal((await first).status, 200);
  const broken = await pageSock({
    phase: "stage-b",
    ask: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.match((await broken.post(JSON.stringify({ url: "https://stand-in.test/" }))).body.error, /the TV couldn't show it: connect ECONNREFUSED/);
});

test("the daemon's asks wait for the screen daemon, take only what a page answer has, and give up in time", async () => {
  const asks = new PageAsks();
  const asked = asks.ask("https://stand-in.test/", ["https://stand-in.test"]);
  const ask = (await asks.take(1000))!;
  assert.deepEqual(ask, { n: 1, url: "https://stand-in.test/", origins: ["https://stand-in.test"] });
  assert.equal(asks.answer(ask.n, { ok: true, url: "https://stand-in.test/", title: "Stand-in", lines: ["h1 \"Stand-in\" h1", 3], html: "<p>x</p>", cookies: "no" }), true);
  assert.deepEqual(await asked, { ok: true, url: "https://stand-in.test/", title: "Stand-in", lines: ['h1 "Stand-in" h1'], html: "<p>x</p>" });
  assert.equal(asks.answer(ask.n, { ok: true }), false, "once");
  assert.equal(await asks.take(20), null);
  // A taker waiting first gets the next ask at once.
  const taking = asks.take(1000);
  const second = asks.ask("https://stand-in.test/b", ["https://stand-in.test"], 30);
  assert.equal((await taking)!.url, "https://stand-in.test/b");
  assert.match((await second).error!, /didn't answer in time/);
});

test("ADR-011 the screen daemon's watch takes each ask and answers it with what it read", async () => {
  const asks = new PageAsks();
  const daemon = createServer(async (request, response) => {
    const send = (body: object) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/api/builder/page-ask") return send({ ok: true, ask: await asks.take(500) });
    const n = /^\/api\/builder\/page-ask\/(\d+)$/.exec(request.url ?? "");
    let text = "";
    for await (const chunk of request) text += chunk;
    if (n) return send({ ok: asks.answer(Number(n[1]), JSON.parse(text)) });
    send({ ok: false });
  });
  servers.push(daemon);
  await new Promise<void>((done) => daemon.listen(0, "127.0.0.1", done));
  const read: string[] = [];
  const watch = new PageAskWatch({
    url: `http://127.0.0.1:${(daemon.address() as { port: number }).port}/`,
    snapshot: async (url, origins) => (read.push(`${url} ${origins.join(",")}`), { ok: true, url, title: "Stand-in", lines: ["h1"], html: "<p>x</p>" }),
    log: () => {},
    retryMs: 50,
  });
  watch.start();
  try {
    const said = await asks.ask("https://stand-in.test/browse", ["https://stand-in.test"], 5000);
    assert.deepEqual(said, { ok: true, url: "https://stand-in.test/browse", title: "Stand-in", lines: ["h1"], html: "<p>x</p>" });
    assert.deepEqual(read, ["https://stand-in.test/browse https://stand-in.test"]);
  } finally {
    watch.stop();
  }
});

// --- The daemon starts stage B, and keeps to it --------------------------------

function box() {
  const base = join(scratch, `box${++count}`);
  const o = { state: join(base, "daemon"), drop: join(base, "daemon", "build-drop"), builds: join(base, "build"), run: join(base, "run"), spend: join(base, "spend.json") };
  mkdirSync(o.builds, { recursive: true });
  mkdirSync(o.run, { recursive: true });
  let clock = Date.parse("2026-10-27T18:00:00Z");
  const builds = new Builds({ ...o, now: () => new Date((clock += 1000)) });
  const take = (name: string) => {
    const path = join(o.drop, `${name}.json`);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    rmSync(path);
    return data;
  };
  const status = (id: string, change: Record<string, unknown>) => {
    mkdirSync(join(o.builds, id, "1.0.0"), { recursive: true });
    writeFileSync(join(o.builds, id, "1.0.0", "status.json"), JSON.stringify({ id, version: "1.0.0", steps: [], started: "", at: "2026-10-27T18:30:00Z", ...change }));
  };
  return { o, builds, take, status };
}

test("ADR-011 a streaming service's app on home goes on with stage B by itself once it's signed in, one build at a time", async () => {
  const { builds, take, status } = box();
  const made = (await builds.ask("add stand-in", { provider: "claude", path: "key" })).build!;
  take("start");
  const understood = { name: "Stand-in", recipe: "streaming", says: "A made-up streaming service" };
  status(made.id, { build: made.build, phase: "build", state: "installed", understood });
  let signedIn = false;
  const tend = () => builds.tend({ signedIn: async (id) => id === made.id && signedIn });
  assert.equal(await tend(), false, "not before the household signed in");
  signedIn = true;
  assert.equal(await tend(), true);
  const start = take("start");
  assert.deepEqual([start.build, start.phase, start.recipe, start.name], [made.build, "stage-b", "streaming", "Stand-in"]);

  // Learning it: the TV says so, and stage B is the build's to try again,
  // never to put away, since its app is on home.
  status(made.id, { build: made.build, phase: "stage-b", state: "failed", reason: "study: it stopped", understood, at: "2026-10-27T18:40:00Z" });
  assert.equal(await tend(), false, "a failed stage B isn't started again by itself");
  assert.match((await builds.forget(made.build)).error!, /its app is on the tv: try again, or remove the app/);
  assert.equal((await builds.retry(made.build)).error, undefined);
  assert.equal(take("start").phase, "stage-b");
});

test("ADR-011 the daemon knows the build in stage B from root's ticket, with the origins it declared", () => {
  const { o, builds } = box();
  assert.equal(builds.stageB(), null);
  writeFileSync(join(o.run, "ticket.json"), JSON.stringify({ ...ticket("build"), dir: "" }));
  assert.equal(builds.stageB(), null, "stage A sees no signed-in page");
  writeFileSync(join(o.run, "ticket.json"), JSON.stringify({ ...ticket("stage-b"), dir: "" }));
  mkdirSync(join(o.builds, "local.stand-in", "1.0.0"), { recursive: true });
  writeFileSync(join(o.builds, "local.stand-in", "1.0.0", "state.json"), JSON.stringify({ origins: [{ origin: "https://stand-in.test", why: "its pages" }, { origin: "http://plain.test" }] }));
  assert.deepEqual(builds.stageB(), { id: "local.stand-in", version: "1.0.0", origins: ["https://stand-in.test"] });
  writeFileSync(join(o.run, "ticket.json"), JSON.stringify({ ...ticket("stage-b"), id: "../../etc", dir: "" }));
  assert.equal(builds.stageB(), null);
});

test("ADR-011 the daemon passes on a look at a signed-in page only for the build in stage B, and only from its own port", async () => {
  const { Daemon } = await import("../../../daemon/server.ts");
  const base = join(scratch, `daemon${++count}`);
  mkdirSync(join(base, "root", "setup"), { recursive: true });
  const run = join(base, "run");
  const builds = join(base, "build");
  mkdirSync(run, { recursive: true });
  const daemon = new Daemon({ root: join(base, "root"), state: join(base, "state"), port: 0, log: () => {}, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1", keyStatus: join(base, "key.json"), builds, buildRun: run, spend: join(base, "spend.json"), npmWarnings: join(base, "warnings.json") });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  try {
    const post = (path: string, body: unknown, base = url) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("/api/builder/page", { url: "https://stand-in.test/" })).status, 409, "no build is in stage B");
    writeFileSync(join(run, "ticket.json"), JSON.stringify(ticket("stage-b")));
    mkdirSync(join(builds, "local.stand-in", "1.0.0"), { recursive: true });
    writeFileSync(join(builds, "local.stand-in", "1.0.0", "state.json"), JSON.stringify({ origins: [{ origin: "https://stand-in.test" }] }));
    assert.equal((await post("/api/builder/page", { url: "https://elsewhere.test/" })).status, 403);
    const fromPhone = (await post("/api/builder/page", { url: "https://stand-in.test/" }, `http://127.0.0.1:${daemon.lanPort}`)).status;
    assert.ok([401, 404].includes(fromPhone), `never from a phone's port (${fromPhone})`);

    // The screen daemon takes the ask and answers it.
    const asking = post("/api/builder/page", { url: "https://stand-in.test/browse" });
    const { ask } = await (await fetch(`${url}/api/builder/page-ask`)).json();
    assert.deepEqual(ask, { n: 1, url: "https://stand-in.test/browse", origins: ["https://stand-in.test"] });
    assert.equal((await post(`/api/builder/page-ask/${ask.n}`, { ok: true, url: ask.url, title: "Stand-in", lines: ["h1"], html: "<p>x</p>" })).status, 200);
    assert.deepEqual(await (await asking).json(), { ok: true, url: "https://stand-in.test/browse", title: "Stand-in", lines: ["h1"], html: "<p>x</p>" });
    assert.equal((await post(`/api/builder/page-ask/${ask.n}`, { ok: true })).status, 404);
  } finally {
    await daemon.close();
  }
});
