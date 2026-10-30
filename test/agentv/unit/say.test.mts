// A sentence said to the TV (daemon/say.ts, daemon/executors/, ADR-013,
// ADR-023): play X across kinds through every app's search, one clear best
// or up to three to choose from, continue from the ledger, the two requests
// stage 8 answers, and a sentence the router can't route coming to "i
// didn't get that" with nothing done (S7.3). Then the daemon's side, from a
// phone, with a stand-in router and a stand-in screen daemon.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Item } from "../../../apps/contract/contract.ts";
import { installLocal } from "../../../daemon/apps/install.ts";
import { AskWatch } from "../../../daemon/asks.ts";
import { continueItem, finished, toContinue } from "../../../daemon/executors/continue.ts";
import { DIDNT_GET, execute, type ExecApp, type ExecContext } from "../../../daemon/executors/index.ts";
import { match, pick, rank, type Found } from "../../../daemon/executors/play.ts";
import type { WatchRow } from "../../../daemon/ledger.ts";
import { NONE, type Route, type Routed, type RouterApp } from "../../../daemon/router.ts";
import { cleanSayAnswer, type SayAnswer, type SayAsk } from "../../../daemon/say.ts";
import { Daemon } from "../../../daemon/server.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-say-"));

const play = (query: string | null, extra: Partial<Route> = {}): Route => ({ ...NONE, intent: "play", query, ...extra });
const item = (kind: Item["kind"], title: string, extra: Partial<Item> = {}): Item => ({ id: `${kind}:${title}`, kind, title, ...extra });

const FOUND: Found[] = [
  { app: "local.kino", items: [item("film", "Frozen"), item("film", "Frozen II"), item("series", "Severance")] },
  { app: "agentv.music", items: [item("album", "Frozen", { subtitle: "Various Artists · Frozen" }), item("album", "OK Computer", { subtitle: "Radiohead · OK Computer" }), item("album", "Kid A", { subtitle: "Radiohead · Kid A" })] },
];

// --- Play X --------------------------------------------------------------------

test("a title matches the same whatever its case, accents or leading the, and a sequel isn't the same", () => {
  assert.equal(match("Frozen", "frozen"), 3);
  assert.equal(match("The Bear", "bear"), 3);
  assert.equal(match("Shōgun", "shogun"), 3);
  assert.equal(match("Frozen II", "Frozen"), 2);
  assert.equal(match("The Last of Us Part II", "last of us part"), 2);
  assert.equal(match("Planet Frozen", "frozen planet"), 1);
  assert.equal(match("Frost", "frozen"), 0);
});

test("S7.1 play Frozen with no kind said is a collision: the film and the soundtrack to choose from, and never the sequel", () => {
  const chosen = pick(rank(FOUND, play("Frozen")));
  assert.ok("some" in chosen);
  assert.deepEqual(chosen.some.map((r) => [r.app, r.item.kind, r.item.title]), [
    ["local.kino", "film", "Frozen"],
    ["agentv.music", "album", "Frozen"],
  ]);
});

test("S7.1 a kind that was said keeps only that kind: the soundtrack is the album, and watch is the film", () => {
  const soundtrack = pick(rank(FOUND, play("Frozen", { kind: "album" })));
  assert.ok("one" in soundtrack && soundtrack.one.app === "agentv.music" && soundtrack.one.item.kind === "album");
  const watch = pick(rank(FOUND, play("Frozen", { kind: "video" })));
  assert.ok("one" in watch && watch.one.app === "local.kino" && watch.one.item.kind === "film");
  // A season or an episode means a show.
  assert.ok("none" in pick(rank(FOUND, play("Frozen", { season: 1 }))));
});

test("music by an artist plays any of theirs, and a near match is offered, not opened", () => {
  const radiohead = pick(rank(FOUND, play("Radiohead", { kind: "artist" })));
  assert.ok("one" in radiohead && radiohead.one.item.title === "OK Computer");
  const near = pick(rank([{ app: "local.kino", items: [item("series", "Frozen Planet")] }], play("Frozen")));
  assert.ok("some" in near && near.some.length === 1, "a title that only starts the same is never a guess");
  assert.ok("none" in pick(rank(FOUND, play("Dune"))));
});

test("S7.1 up to three to choose from, each once", () => {
  const many: Found[] = [{ app: "local.kino", items: ["A", "B", "C", "D"].map((x) => item("film", "Heat", { id: x })).concat([item("film", "Heat")]) }];
  const chosen = pick(rank(many, play("Heat")));
  assert.ok("some" in chosen && chosen.some.length === 3);
});

// --- Continue ------------------------------------------------------------------

const row = (id: number, app: string, title: string, extra: Partial<WatchRow> = {}): WatchRow => ({ id, viewer_id: "ana", app_id: app, kind: "episode", title, season: 2, episode: 3, position_s: 600, duration_s: 3000, started_at: "", updated_at: "", ...extra });

test("continue takes the newest row in an app who's watching can open, or the newest of the title they named", () => {
  const rows = [row(3, "local.gone", "Bluey"), row(2, "local.kino", "Severance"), row(1, "agentv.jellyfin", "The Bear")];
  const apps = new Set(["local.kino", "agentv.jellyfin"]);
  assert.equal(toContinue(rows, { ...NONE, intent: "continue" }, apps)?.id, 2);
  assert.equal(toContinue(rows, { ...NONE, intent: "continue", query: "the bear" }, apps)?.id, 1);
  assert.equal(toContinue(rows, { ...NONE, intent: "continue", app: "agentv.jellyfin" }, apps)?.id, 1);
  assert.equal(toContinue(rows, { ...NONE, intent: "continue", query: "Bluey" }, apps), null, "Bluey's app isn't here any more");
  assert.equal(toContinue(rows, { ...NONE, intent: "continue", kind: "album" }, apps), null);
});

test("continue opens the same episode, or the next once it was watched to its end", () => {
  assert.deepEqual(continueItem(row(5, "local.kino", "Severance")), { id: "ledger:5", kind: "episode", title: "Severance", season: 2, episode: 3 });
  const done = row(6, "local.kino", "Severance", { position_s: 2970 });
  assert.equal(finished(done), true);
  assert.equal(continueItem(done).episode, 4);
  assert.deepEqual(continueItem(row(7, "local.kino", "Heat", { kind: "film", season: null, episode: null, position_s: 7000, duration_s: 7100 })), { id: "ledger:7", kind: "film", title: "Heat" });
});

// --- The executors ---------------------------------------------------------------

const APPS: ExecApp[] = [
  { id: "local.kino", name: "Kino", category: "streaming", capabilities: ["launch", "search", "playback"] },
  { id: "agentv.music", name: "Music", category: "music", capabilities: ["launch", "search", "nowPlaying"] },
  { id: "agentv.steam", name: "Steam", category: "games", capabilities: ["launch"] },
];

function context(rows: WatchRow[] = [], opened: { ok: boolean; error?: string } = { ok: true }) {
  const calls: string[] = [];
  const ctx: ExecContext = {
    apps: APPS,
    rows: () => rows,
    search: async (query, apps) => {
      calls.push(`search ${query} in ${apps.join(",")}`);
      return FOUND.filter((f) => apps.includes(f.app));
    },
    open: async (app, it) => {
      calls.push(`open ${app}${it ? ` ${it.kind} ${it.title}${it.episode ? ` e${it.episode}` : ""}` : ""}`);
      return opened.ok ? { ok: true } : { ok: false, error: opened.error };
    },
  };
  return { ctx, calls };
}

const routed = (route: Route, extra: Partial<Routed> = {}): Routed => ({ sentence: "", route, provider: "claude", via: "api", model: "test", ms: 1, ...extra });

test("S7.3 a sentence that can't be routed is 'i didn't get that', and nothing is looked up or opened", async () => {
  for (const none of ["unroutable", "unreadable"] as const) {
    const { ctx, calls } = context();
    assert.deepEqual(await execute(routed({ ...NONE }, { none }), ctx), { kind: "none", why: none, say: DIDNT_GET });
    assert.deepEqual(calls, []);
  }
  const { ctx, calls } = context();
  assert.deepEqual(await execute(routed({ ...NONE }, { none: "failed", error: "the provider refused the key (401)" }), ctx), { kind: "none", why: "failed", say: "your agent didn't answer", detail: "the provider refused the key (401)" });
  assert.deepEqual(calls, []);
});

test("play: the one clear best opens, a collision is offered, an app named alone opens, and one that isn't here says so", async () => {
  let { ctx, calls } = context();
  assert.deepEqual(await execute(routed(play("Frozen", { kind: "album" })), ctx), { kind: "opened", app: "agentv.music", item: FOUND[1].items[0], say: "frozen, on music" });
  assert.deepEqual(calls, ["search Frozen in local.kino,agentv.music", "open agentv.music album Frozen"]);
  ({ ctx, calls } = context());
  const choose = await execute(routed(play("Frozen")), ctx);
  assert.equal(choose.kind, "choose");
  assert.deepEqual(choose.kind === "choose" && choose.candidates.map((c) => `${c.name} ${c.item.kind}`), ["Kino film", "Music album"]);
  assert.deepEqual(calls, ["search Frozen in local.kino,agentv.music"], "nothing opens until one is picked");
  ({ ctx, calls } = context());
  assert.deepEqual(await execute(routed(play(null, { app: "agentv.steam" })), ctx), { kind: "opened", app: "agentv.steam", say: "steam" });
  ({ ctx, calls } = context());
  assert.deepEqual(await execute(routed(play("Inception", { app: "Moviebox" })), ctx), { kind: "none", why: "missing", say: "there's no moviebox on this tv" });
  assert.deepEqual(calls, []);
  // An app named by its name, and only that app is asked.
  ({ ctx, calls } = context());
  await execute(routed(play("Severance", { app: "kino", season: 2, episode: 3 })), ctx);
  assert.deepEqual(calls, ["search Severance in local.kino", "open local.kino series Severance e3"]);
});

test("play on an app that can't look things up opens it, and says that's all; nothing found says so", async () => {
  let { ctx } = context();
  assert.deepEqual(await execute(routed(play("Portal 2", { app: "agentv.steam" })), ctx), { kind: "opened", app: "agentv.steam", say: "steam can't look up portal 2, so it's open" });
  ({ ctx } = context());
  assert.deepEqual(await execute(routed(play("Dune")), ctx), { kind: "none", why: "not-found", say: "i couldn't find dune" });
  ({ ctx } = context([], { ok: false, error: "it isn't signed in" }));
  assert.deepEqual(await execute(routed(play("Frozen", { kind: "film" })), ctx), { kind: "none", why: "not-opened", say: "kino didn't open frozen", detail: "it isn't signed in" });
});

test("continue opens from the ledger, and says when there's nothing to continue", async () => {
  let { ctx, calls } = context([row(9, "local.kino", "Severance", { position_s: 2990 })]);
  assert.deepEqual(await execute(routed({ ...NONE, intent: "continue" }), ctx), { kind: "opened", app: "local.kino", item: { id: "ledger:9", kind: "episode", title: "Severance", season: 2, episode: 4 }, say: "severance s2 e4, on kino" });
  assert.deepEqual(calls, ["open local.kino episode Severance e4"]);
  ({ ctx } = context());
  assert.deepEqual(await execute(routed({ ...NONE, intent: "continue" }), ctx), { kind: "none", why: "not-found", say: "there's nothing to continue yet" });
  assert.deepEqual(await execute(routed({ ...NONE, intent: "continue", query: "Andor" }), ctx), { kind: "none", why: "not-found", say: "there's nothing called andor to continue" });
});

test("what's new and new episodes are routed, and the TV says plainly it can't answer them yet (stage 8)", async () => {
  const { ctx, calls } = context();
  assert.deepEqual(await execute(routed({ ...NONE, intent: "whats_new" }), ctx), { kind: "none", why: "soon", say: "i can't tell you what's new yet" });
  assert.deepEqual(await execute(routed({ ...NONE, intent: "new_episode", query: "Severance" }), ctx), { kind: "none", why: "soon", say: "i can't check for new episodes yet" });
  assert.deepEqual(calls, []);
});

test("the screen daemon's answer is held to its shape: items it can't read are dropped", () => {
  const answer = cleanSayAnswer({ ok: true, found: [{ app: "local.kino", items: [{ id: "1", kind: "film", title: "Heat", poster: "javascript:alert(1)", season: -2 }, { id: 2, kind: "film", title: "x" }, { id: "3", kind: "toaster", title: "y" }] }, "junk"] });
  assert.deepEqual(answer, { ok: true, found: [{ app: "local.kino", items: [{ id: "1", kind: "film", title: "Heat" }] }] });
});

// --- From a phone, through the daemon ---------------------------------------------

const base = join(scratch, "daemon");
let daemon: Daemon;
let url = "";
let lan = "";
let token = "";
let heard: RouterApp[] = [];
const asks: SayAsk[] = [];
let routes: Record<string, Route | Error> = {};
let watch: AskWatch<SayAsk, SayAnswer>;

before(async () => {
  const apps = join(base, "apps");
  // Kino stands in for a streaming service the box's agent built.
  const kino = join(scratch, "kino");
  cpSync(join(ROOT, "test/agentv/fixtures/apps/pager"), kino, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(kino, "manifest.json"), "utf8"));
  writeFileSync(join(kino, "manifest.json"), JSON.stringify({ ...manifest, id: "local.kino", name: "Kino", author: "your agent", tv: { ...manifest.tv, childSafe: false } }));
  await installLocal(kino, apps, async () => true);
  daemon = new Daemon({
    root: join(base, "root"),
    state: join(base, "state"),
    apps,
    builtins: join(ROOT, "apps/builtin"),
    port: 0,
    log: () => {},
    lanPort: 0,
    lanHost: "127.0.0.1",
    address: () => "127.0.0.1",
    keyStatus: join(base, "key.json"),
    router: async (sentence, list) => {
      heard = list;
      const route = routes[sentence];
      if (route instanceof Error) return routed({ ...NONE }, { sentence, none: "failed", error: route.message });
      return routed(route ?? { ...NONE }, { sentence, ...(route ? {} : { none: "unroutable" as const }) });
    },
  });
  url = `http://127.0.0.1:${await daemon.listen()}`;
  lan = `http://127.0.0.1:${daemon.lanPort}`;
  const code = (await (await post("/api/phones/pair", {})).json()).pairing.code;
  token = (await (await fetch(`${lan}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "iphone" }) })).json()).token;
  // The screen daemon, as the person: it finds what FOUND has, and opens.
  watch = new AskWatch<SayAsk, SayAnswer>({
    url: `${url}/`,
    path: "api/say/ask",
    what: "a sentence",
    handle: async (ask) => {
      asks.push(ask);
      if (ask.kind === "search") return { ok: true, found: FOUND.filter((f) => ask.apps.includes(f.app)) };
      return { ok: true };
    },
    failed: (error) => ({ ok: false, error: error.message }),
    log: () => {},
    retryMs: 50,
  });
  watch.start();
});

after(async () => {
  watch.stop();
  await daemon.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((done) => setTimeout(done, 20));
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const phone = (path: string, body?: unknown) =>
  fetch(`${lan}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("the TV takes a sentence only once setup is done", async () => {
  const early = await phone("/api/phone/say", { sentence: "play frozen" });
  assert.equal(early.status, 409);
  assert.equal((await early.json()).error, "the tv takes requests once setup is done");
  writeFileSync(join(base, "state", "setup.json"), JSON.stringify({ done: true, at: "2026-10-29T18:00:00Z" }));
  assert.equal((await phone("/api/phone/say", { sentence: " " })).status, 400);
});

test("S7.1 a phone's 'play frozen' hears the apps who's watching can open, and both the TV and the phone get the two to choose from", async () => {
  routes = { "play frozen": play("Frozen") };
  const said = await (await phone("/api/phone/say", { sentence: "play frozen" })).json();
  assert.equal(said.ok, true);
  assert.deepEqual(heard.map((app) => app.id).sort(), ["agentv.music", "local.kino"], "the router hears of the apps that play things, not Clock or Weather");
  assert.equal(said.said.from, "iphone");
  assert.equal(said.said.outcome.kind, "choose", JSON.stringify(said));
  assert.deepEqual(said.said.outcome.candidates.map((c: { name: string; item: Item }) => [c.name, c.item.kind]), [["Kino", "film"], ["Music", "album"]]);
  assert.deepEqual((await (await fetch(`${url}/api/say`)).json()).said.n, said.said.n);
  const state = await (await phone("/api/phone/state")).json();
  assert.equal(state.said.outcome.kind, "choose");
  assert.equal(state.said.route, undefined, "the phone gets what happened, not the route");
  // Over an app in front, the TV says the phone has them.
  await until(() => asks.some((ask) => ask.kind === "tell"));
  assert.ok(asks.some((ask) => ask.kind === "tell" && ask.text === "which one? your phone has them"));
  // The phone picks the soundtrack, and the TV session opens it in Music.
  asks.length = 0;
  const picked = await (await phone("/api/phone/say/pick", { n: said.said.n, choice: 1 })).json();
  assert.equal(picked.said.outcome.kind, "opened");
  assert.equal(picked.said.outcome.say, "frozen, on music");
  assert.deepEqual(asks, [{ kind: "open", app: "agentv.music", item: FOUND[1].items[0], n: (asks[0] as SayAsk & { n: number }).n }]);
  assert.equal((await phone("/api/phone/say/pick", { n: said.said.n, choice: 0 })).status, 409, "once picked, there's nothing to choose");
});

test("S7.3 a sentence the router can't route is 'i didn't get that' on the TV and the phone, and the TV session isn't asked anything", async () => {
  routes = {};
  asks.length = 0;
  const said = await (await phone("/api/phone/say", { sentence: "turn the lights off" })).json();
  assert.deepEqual(said.said.outcome, { kind: "none", why: "unroutable", say: "i didn't get that" });
  assert.equal(said.said.route.intent, "none");
  // Only the line over the app in front, if there is one: nothing looked
  // up, nothing opened.
  await until(() => asks.length > 0);
  assert.deepEqual(asks.map(({ n: _n, ...ask }: SayAsk & { n?: number }) => ask), [{ kind: "tell", text: "i didn't get that" }]);
  assert.equal((await (await phone("/api/phone/state")).json()).said.outcome.say, "i didn't get that");
  routes = { "play heat": new Error("the provider is busy, or the key is out of credit (429)") };
  asks.length = 0;
  const failed = await (await post("/api/say", { sentence: "play heat" })).json();
  assert.deepEqual(failed.said.outcome, { kind: "none", why: "failed", say: "your agent didn't answer", detail: "the provider is busy, or the key is out of credit (429)" });
  await until(() => asks.length > 0);
  assert.deepEqual(asks.map((ask) => ask.kind), ["tell"]);
});

test("continue opens what who's watching last watched, and Back on the TV puts it away", async () => {
  const viewer = await daemon.profiles.active();
  daemon.ledger.viewer({ id: viewer.id, name: viewer.name, role: viewer.role });
  daemon.ledger.record(viewer.id, "local.kino", "episode", { title: "Severance", season: 2, episode: 3, position: 1200, duration: 3000, playing: false });
  routes = { "carry on": { ...NONE, intent: "continue" } };
  asks.length = 0;
  const said = await (await post("/api/say", { sentence: "carry on" })).json();
  assert.equal(said.said.outcome.say, "severance s2 e3, on kino");
  assert.equal(asks[0].kind === "open" && asks[0].app, "local.kino");
  assert.equal((await (await post("/api/say/dismiss", { n: said.said.n })).json()).ok, true);
  assert.equal((await (await fetch(`${url}/api/say`)).json()).said, null);
});

test("a child's profile routes only to children's apps", async () => {
  // A child's profile needs the adult PIN first.
  assert.equal((await fetch(`${url}/api/pin`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "2468" }) })).status, 200);
  const grant = (await (await post("/api/pin/check", { pin: "2468" })).json()).grant;
  const made = await (await fetch(`${url}/api/viewers`, { method: "POST", headers: { "Content-Type": "application/json", "X-AgenTV-Grant": grant }, body: JSON.stringify({ name: "mila", role: "child" }) })).json();
  const child = made.profile;
  assert.ok(child, JSON.stringify(made));
  await post("/api/viewer", { id: child.id });
  routes = { "play frozen": play("Frozen") };
  const said = await (await phone("/api/phone/say", { sentence: "play frozen" })).json();
  assert.deepEqual(heard.map((app) => app.id), ["agentv.music"], "Kino isn't one of a child's apps");
  assert.equal(said.said.outcome.kind, "opened", "so the soundtrack is the one clear match");
  assert.equal(said.said.viewer, child.id);
});

test("with no router on the box, the TV says voice isn't set up yet", async () => {
  const bare = new Daemon({ root: join(base, "root"), state: join(scratch, "bare"), builtins: null, port: 0, log: () => {}, keyStatus: join(base, "key.json") });
  const at = `http://127.0.0.1:${await bare.listen()}`;
  let said;
  try {
    mkdirSync(join(scratch, "bare"), { recursive: true });
    writeFileSync(join(scratch, "bare", "setup.json"), JSON.stringify({ done: true, at: "2026-10-29T18:00:00Z" }));
    said = await (await fetch(`${at}/api/say`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sentence: "play frozen" }) })).json();
  } finally {
    await bare.close();
  }
  assert.deepEqual(said.said?.outcome, { kind: "none", why: "failed", say: "your agent didn't answer", detail: "voice isn't set up on this box yet" });
});
