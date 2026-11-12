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
import vm from "node:vm";
import { BLANK } from "../../../builder/browse.ts";
import { allowed, declaredBy, pageServer, reachable } from "../../../builder/sandbox/net.ts";
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

// Root's ticket: in stage B it carries the origins an adult approved with the app.
const ticket = (phase: string, origins: string[] = ["https://stand-in.test"]): Ticket => ({ build: "b1", id: "local.stand-in", version: "1.0.0", dir: "/x", provider: "claude", path: "key", recipe: "streaming", phase, ...(phase === "stage-b" ? { origins } : {}) });
const RECIPES = join(import.meta.dirname, "../../../builder/recipes");

// The builder's side of page.sock, on a socket file here.
async function pageSock(o: { phase?: string; ask?: (url: string) => Promise<object>; looksAt?: (ticket: Ticket, url: URL) => boolean }) {
  const path = join(scratch, `page${++count}.sock`);
  const asked: string[] = [];
  const server = pageServer({
    ticket: () => (o.phase ? ticket(o.phase) : null),
    declared: () => ["https://stand-in.test"],
    ...(o.looksAt ? { looksAt: o.looksAt } : {}),
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
  assert.match((await b.post(JSON.stringify({ url: "https://elsewhere.test/" }))).body.error, /https:\/\/elsewhere\.test isn't one of the origins approved with the app/);
  assert.equal((await b.post(JSON.stringify({ url: "http://stand-in.test/" }))).status, 403);
  assert.equal((await b.post("not json")).status, 400);
  assert.equal((await b.post(JSON.stringify({ url: "https://stand-in.test/", pad: "x".repeat(5000) }))).status, 413);
  const seen = await b.post(JSON.stringify({ url: "https://stand-in.test/browse" }));
  assert.deepEqual([seen.status, seen.body.ok, b.asked], [200, true, ["https://stand-in.test/browse"]]);

  // M5: and only a page the recipe has stage B look at.
  const picky = await pageSock({ phase: "stage-b", looksAt: (_ticket, url) => url.pathname === "/browse" });
  assert.match((await picky.post(JSON.stringify({ url: "https://stand-in.test/account" }))).body.error, /isn't a page a build looks at while signed in/);
  assert.equal((await picky.post(JSON.stringify({ url: "https://stand-in.test/browse" }))).status, 200);
  assert.deepEqual(picky.asked, ["https://stand-in.test/browse"]);
});

test("H2 in stage B the way out goes by root's ticket: an origin the build wrote into its state after approval isn't reached", () => {
  const dir = join(scratch, "late");
  mkdirSync(dir, { recursive: true });
  // What a build could leave in its own folder after its app was approved.
  writeFileSync(join(dir, "state.json"), JSON.stringify({ origins: [{ origin: "https://stand-in.test" }, { origin: "https://late.example", why: "added after approval" }] }));
  const stageB = { ...ticket("stage-b"), dir };
  const said = declaredBy(stageB, RECIPES);
  assert.deepEqual(reachable(stageB, said), ["https://stand-in.test"], "stage B's pages");
  const hosts = allowed(stageB, said);
  assert.ok(hosts.has("stand-in.test:443") && !hosts.has("late.example:443"), "and stage B's filter");
  // A stage B ticket with no approved list reaches no origin at all.
  assert.deepEqual(reachable({ ...stageB, origins: undefined }, said), []);
  // Before approval, in stage A, what's declared is live at once, as before.
  assert.ok(allowed({ ...ticket("build"), dir }, said).has("late.example:443"));
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
  assert.match((await second).error!, /^Your TV isn't ready yet$/);
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

test("H2 the daemon knows the build in stage B from root's ticket, with the origins approved with its app, never from the build's folder", () => {
  const { o, builds } = box();
  assert.equal(builds.stageB(), null);
  writeFileSync(join(o.run, "ticket.json"), JSON.stringify({ ...ticket("build"), dir: "" }));
  assert.equal(builds.stageB(), null, "stage A sees no signed-in page");
  writeFileSync(join(o.run, "ticket.json"), JSON.stringify({ ...ticket("stage-b", ["https://stand-in.test", "http://plain.test", 7 as never]), dir: "" }));
  // The build's own state says more: it doesn't count.
  mkdirSync(join(o.builds, "local.stand-in", "1.0.0"), { recursive: true });
  writeFileSync(join(o.builds, "local.stand-in", "1.0.0", "state.json"), JSON.stringify({ origins: [{ origin: "https://stand-in.test", why: "its pages" }, { origin: "https://late.example", why: "added after approval" }] }));
  const running = builds.stageB()!;
  assert.deepEqual([running.id, running.version, running.origins], ["local.stand-in", "1.0.0", ["https://stand-in.test"]]);
  assert.ok(running.looksAt(new URL("https://stand-in.test/search?q=heat")));
  assert.ok(!running.looksAt(new URL("https://late.example/search")), "not an origin from its state");
  assert.ok(!running.looksAt(new URL("https://stand-in.test/account")), "M5: not an account page");
  assert.ok(!running.looksAt(new URL("http://stand-in.test/search")));
  writeFileSync(join(o.run, "ticket.json"), JSON.stringify({ ...ticket("stage-b"), origins: undefined, dir: "" }));
  assert.deepEqual(builds.stageB()!.origins, [], "a ticket with no approved list opens nothing");
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
    // H2: what the build wrote into its own state after approval opens nothing.
    mkdirSync(join(builds, "local.stand-in", "1.0.0"), { recursive: true });
    writeFileSync(join(builds, "local.stand-in", "1.0.0", "state.json"), JSON.stringify({ origins: [{ origin: "https://stand-in.test" }, { origin: "https://elsewhere.test" }] }));
    const elsewhere = await post("/api/builder/page", { url: "https://elsewhere.test/" });
    assert.equal(elsewhere.status, 403);
    assert.match((await elsewhere.json()).error, /isn't one of the origins approved with local\.stand-in/);
    // M5: an account page of the service is never opened for a build.
    for (const path of ["/account", "/settings/payment", "/en-gb/account", "/#/account", "/browse#!/settings"]) {
      const refused = await post("/api/builder/page", { url: `https://stand-in.test${path}` });
      assert.equal(refused.status, 403, path);
      assert.match((await refused.json()).error, /isn't a page a build looks at while signed in/);
    }
    assert.equal(await daemon.pageAsks.take(20), null, "nothing was asked of the TV's browser");
    const fromPhone = (await post("/api/builder/page", { url: "https://stand-in.test/" }, `http://127.0.0.1:${daemon.lanPort}`)).status;
    assert.ok([401, 404].includes(fromPhone), `never from a phone's port (${fromPhone})`);

    // The screen daemon takes the ask and answers it.
    const asking = post("/api/builder/page", { url: "https://stand-in.test/browse" });
    const { ask } = await (await fetch(`${url}/api/builder/page-ask`)).json();
    assert.deepEqual(ask, { n: 1, url: "https://stand-in.test/browse", origins: ["https://stand-in.test"] });
    assert.equal((await post(`/api/builder/page-ask/${ask.n}`, { ok: true, url: ask.url, title: "Stand-in", lines: ["h1"], html: "<p>x</p>" })).status, 200);
    assert.deepEqual(await (await asking).json(), { ok: true, url: "https://stand-in.test/browse", title: "Stand-in", lines: ["h1"], html: "<p>x</p>" });
    assert.equal((await post(`/api/builder/page-ask/${ask.n}`, { ok: true })).status, 404);

    // M5: a page the service sent the browser on to instead isn't handed over.
    const sentOn = post("/api/builder/page", { url: "https://stand-in.test/watch/1" });
    const moved = (await (await fetch(`${url}/api/builder/page-ask`)).json()).ask;
    assert.equal((await post(`/api/builder/page-ask/${moved.n}`, { ok: true, url: "https://stand-in.test/account/payment", title: "Your account", lines: ["h1 \"ana@example.org\""], html: "<p>ana@example.org</p>" })).status, 200);
    const kept = await (await sentOn).json();
    assert.equal(kept.ok, false);
    assert.match(kept.error, /the service went on to another page/);
    assert.ok(!JSON.stringify(kept).includes("ana@example.org"));
    // The same for a site that keeps the page after the #.
    const routed = post("/api/builder/page", { url: "https://stand-in.test/#/browse" });
    const hashed = (await (await fetch(`${url}/api/builder/page-ask`)).json()).ask;
    assert.equal(hashed.url, "https://stand-in.test/#/browse", "a named page after the # is asked for as it is");
    assert.equal((await post(`/api/builder/page-ask/${hashed.n}`, { ok: true, url: "https://stand-in.test/#/account", title: "Your account", lines: ["h1 \"ana@example.org\""], html: "<p>ana@example.org</p>" })).status, 200);
    const held = await (await routed).json();
    assert.match(held.error, /the service went on to another page/);
    assert.ok(!JSON.stringify(held).includes("ana@example.org"));

    // A signed-in page's copy is far bigger than the daemon's other bodies,
    // and gets there whole.
    const big = `<!doctype html><main>${'<a class="title" href="/watch/1">a film</a>'.repeat(20_000)}</main>`;
    assert.ok(big.length > 512 * 1024);
    const bigger = post("/api/builder/page", { url: "https://stand-in.test/browse" });
    const next = (await (await fetch(`${url}/api/builder/page-ask`)).json()).ask;
    assert.equal((await post(`/api/builder/page-ask/${next.n}`, { ok: true, url: next.url, title: "Stand-in", lines: ["h1"], html: big })).status, 200);
    assert.equal((await (await bigger).json()).html, big);
  } finally {
    await daemon.close();
  }
});

// --- What a page shows of the account ------------------------------------------

test("M5 an email address and a card's digits are blanked in the page, before a build sees them", () => {
  // The same JavaScript the page runs (builder/browse.ts).
  const { blank, blankEmail } = vm.runInNewContext(`(() => {${BLANK}; return { blank, blankEmail }; })()`) as { blank: (text: string) => string; blankEmail: (text: string) => string };
  assert.equal(blank("Signed in as ana.k+tv@example.co.uk"), "Signed in as [email]");
  assert.equal(blank("Visa 4111 1111 1111 1111, expires 12/29"), "Visa [number], expires 12/29");
  assert.equal(blank("4111111111111111"), "[number]");
  assert.equal(blank("Amex 3782-822463-10005"), "Amex [number]");
  assert.equal(blank("123456789012 and 1234567890123456789"), "[number] and [number]", "12 to 19 digits");
  assert.equal(blank("Visa ending in 4242"), "Visa ending in [digits]");
  assert.equal(blank("Card \u2022\u2022\u2022\u2022 4242"), "Card \u2022\u2022\u2022\u2022 [digits]");
  assert.equal(blank("Mastercard ****4242, last four: 4242"), "Mastercard ****[digits], last four: [digits]");
  // What an app needs stays: a title's year, episode numbers, a short id.
  for (const text of ["Heat (1995)", "Season 2, Episode 10", "Episodes 1 2 3 4 5 6 7 8 9 10 11 12 13", "12345678901", "12345678901234567890", "1h 52m", "4K", "pi is 3.14159265358979"]) assert.equal(blank(text), text, text);
  // In an address or an attribute only an email goes: a long number there is an id.
  assert.equal(blankEmail("/watch/80123456789012?as=ana@example.org"), "/watch/80123456789012?as=[email]");
});
