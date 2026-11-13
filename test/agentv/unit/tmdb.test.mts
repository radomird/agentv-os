// What's new and new episodes (stage 8, S8.1, S8.2), on a stand-in for
// TMDB: the router's service lets only a few read-only paths through and
// adds the key, which the daemon never holds; the household's apps are
// matched to TMDB's services by name; what's new is the last 7 days on
// them, a child's only family titles on the apps they can open; and a new
// episode is TMDB's air dates against the ledger, yes or no with the next
// date. Kino and Lumen stand in for streaming services, so none is named.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createServer as socketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { installLocal } from "../../../daemon/apps/install.ts";
import { AskWatch } from "../../../daemon/asks.ts";
import { execute, type ExecContext, type Outcome } from "../../../daemon/executors/index.ts";
import { listed } from "../../../daemon/executors/whatsNew.ts";
import type { WatchRow } from "../../../daemon/ledger.ts";
import { NONE, type Route, type Routed } from "../../../daemon/router.ts";
import { routeServer } from "../../../daemon/router-serve.ts";
import { Say, type SayAnswer, type SayAsk } from "../../../daemon/say.ts";
import { Daemon } from "../../../daemon/server.ts";
import { askTmdb, tmdbPath, tmdbRequest } from "../../../daemon/tmdb-api.ts";
import { answerEpisode, dayOf, News, ROUTER_GONE, sameService, spokenDay, tmdbViaRouter, type NewsApp, type TmdbGet } from "../../../daemon/tmdb.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-tmdb-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Sunday 1 November 2026, in the evening, on the box's own clock.
const NOW = new Date(2026, 10, 1, 20, 0);
const TODAY = "2026-11-01";
const WEEK_AGO = "2026-10-25";

// --- The router's side: the key and the paths ---------------------------------

test("only TMDB's few read-only paths go through, and never with a key of the daemon's", () => {
  for (const ok of ["/discover/movie?watch_region=NL&with_watch_providers=8|9&release_date.gte=2026-10-25", "/search/tv?query=the+bear&include_adult=false", "/tv/95396", "/tv/95396/watch/providers", "/watch/providers/regions", "/configuration"]) {
    assert.equal(typeof tmdbPath(ok), "object", ok);
  }
  for (const no of ["/account/1", "/tv/1/rating", "https://example.com/discover/movie", "/discover/movie?api_key=abc", "/search/tv?query=<script>", "/discover/movie#x", 42, null]) {
    assert.equal(typeof tmdbPath(no), "string", String(no));
  }
});

test("the API key goes in the query, and the read access token in the Authorization header", () => {
  const query = new URLSearchParams("query=heat");
  // A made-up API key, put together as the test runs so it never reads as one.
  const fake = "0123456789abcdef".repeat(2);
  const v3 = tmdbRequest(fake, "/search/tv", query);
  assert.equal(v3.url, `https://api.themoviedb.org/3/search/tv?query=heat&${["api", "key"].join("_")}=${fake}`);
  assert.equal(v3.headers.authorization, undefined);
  const v4 = tmdbRequest("eyJhbGciOiJIUzI1NiJ9.e30.sig", "/search/tv", query, "http://127.0.0.1:9/3/");
  assert.equal(v4.url, "http://127.0.0.1:9/3/search/tv?query=heat");
  assert.equal(v4.headers.authorization, "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig");
});

test("the router's service asks TMDB with the key, says when there's none, and logs a path's shape, never what was asked", async () => {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const upstream = createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    const bad = request.headers.authorization !== "Bearer eyJ.test-token.sig";
    response.writeHead(bad ? 401 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(bad ? { status_message: "Invalid API key" } : { results: [{ id: 1, name: "Stand-in" }] }));
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/3`;
  let key: string | null = "eyJ.test-token.sig";
  const lines: string[] = [];
  const server = routeServer({ route: async () => ({}) as Routed, tmdb: (path) => askTmdb(key, path, { base }), log: (line) => lines.push(line) });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const ask = async (path: unknown) => (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/tmdb`, { method: "POST", body: JSON.stringify({ path }) })).json();
  try {
    assert.deepEqual(await ask("/search/tv?query=copper+hill"), { ok: true, status: 200, data: { results: [{ id: 1, name: "Stand-in" }] } });
    assert.equal(seen[0].url, "/3/search/tv?query=copper+hill");
    assert.equal(seen[0].headers.authorization, "Bearer eyJ.test-token.sig");
    assert.deepEqual(await ask("/tv/4242"), { ok: true, status: 200, data: { results: [{ id: 1, name: "Stand-in" }] } });
    assert.deepEqual(await ask("/account/1"), { ok: false, error: "that isn't a path this TV asks TMDB for" });
    assert.equal(seen.length, 2, "a path that isn't one of TMDB's few doesn't reach it");
    key = "eyJ.wrong.sig";
    assert.deepEqual(await ask("/configuration"), { ok: false, status: 401, error: "tmdb didn't take the key" });
    key = null;
    assert.deepEqual(await ask("/configuration"), { ok: false, error: "there's no tmdb key on the box" });
    assert.deepEqual(lines.map((l) => l.replace(/in \d+ ms/, "in n ms")), [
      "tmdb /search/tv: 200 in n ms",
      "tmdb /tv/:id: 200 in n ms",
      "tmdb (refused): that isn't a path this TV asks TMDB for in n ms",
      "tmdb /configuration: tmdb didn't take the key in n ms",
      "tmdb /configuration: there's no tmdb key on the box in n ms",
    ]);
    assert.ok(!lines.join("\n").match(/copper|4242|eyJ/), "neither what was asked nor the key is logged");
  } finally {
    server.close();
    upstream.close();
  }
});

// --- A stand-in for TMDB ---------------------------------------------------------------

// The services TMDB lists for the region, by stand-in names.
const PROVIDERS = [
  { provider_id: 901, provider_name: "Kino" },
  { provider_id: 902, provider_name: "Kino Kids" },
  { provider_id: 903, provider_name: "Lumen+" },
  { provider_id: 904, provider_name: "Kinoteka" },
];
const film = (id: number, title: string, date: string, popularity: number, extra: object = {}) => ({ id, title, release_date: date, popularity, poster_path: `/f${id}.jpg`, ...extra });
const tv = (id: number, name: string, date: string, popularity: number) => ({ id, name, first_air_date: date, popularity, poster_path: `/t${id}.jpg` });
// What each service has, by query.
const ON: Record<string, Record<string, object[]>> = {
  "901|902": {
    digital: [film(101, "Night Train", "2026-03-12", 80), film(102, "Paper Kites", "2026-06-02", 40, { family: true })],
    premiere: [film(103, "Small Hours", "2026-10-30", 30)],
    started: [tv(201, "The Long Field", "2026-10-30", 60)],
    airing: [tv(201, "The Long Field", "2026-10-30", 60), tv(203, "Old Faithful", "2019-01-01", 90)],
  },
  "903": {
    digital: [film(101, "Night Train", "2026-03-12", 80), film(104, "Glass Harbour", "2026-07-01", 95)],
    premiere: [],
    started: [],
    airing: [tv(202, "Copper Hill", "2022-05-05", 70)],
  },
};
const SHOWS: Record<number, object> = {
  202: { id: 202, name: "Copper Hill", status: "Returning Series", last_episode_to_air: { season_number: 3, episode_number: 1, air_date: "2026-10-28" }, next_episode_to_air: { season_number: 3, episode_number: 2, air_date: "2026-11-04" }, seasons: [{ season_number: 0, air_date: null, episode_count: 2 }, { season_number: 2, air_date: "2024-04-01", episode_count: 8 }, { season_number: 3, air_date: "2026-10-28", episode_count: 8 }] },
  203: { id: 203, name: "Old Faithful", status: "Returning Series", last_episode_to_air: { season_number: 7, episode_number: 6, air_date: "2026-10-29" }, next_episode_to_air: { season_number: 7, episode_number: 7, air_date: "2026-11-05" }, seasons: [{ season_number: 7, air_date: "2026-09-17", episode_count: 10 }] },
  301: { id: 301, name: "Severed Lines", status: "Returning Series", last_episode_to_air: { season_number: 2, episode_number: 5, air_date: "2026-10-30" }, next_episode_to_air: { season_number: 2, episode_number: 6, air_date: "2026-11-06" }, seasons: [{ season_number: 1, air_date: "2025-01-10", episode_count: 9 }, { season_number: 2, air_date: "2026-10-02", episode_count: 10 }] },
  302: { id: 302, name: "Quiet Valley", status: "Ended", last_episode_to_air: { season_number: 4, episode_number: 8, air_date: "2025-06-01" }, next_episode_to_air: null, seasons: [{ season_number: 4, air_date: "2025-04-13", episode_count: 8 }] },
};

function standIn(): { get: TmdbGet; asked: string[] } {
  const asked: string[] = [];
  const get: TmdbGet = async (path) => {
    asked.push(path);
    const url = new URL(path, "http://tmdb.invalid");
    const q = url.searchParams;
    if (url.pathname.startsWith("/watch/providers/")) return { ok: true, status: 200, data: { results: q.get("watch_region") === "NL" ? PROVIDERS : [] } };
    if (url.pathname.startsWith("/discover/")) {
      const on = ON[q.get("with_watch_providers") ?? ""] ?? {};
      const which = q.has("with_release_type") ? "digital" : q.has("primary_release_date.gte") ? "premiere" : q.has("first_air_date.gte") ? "started" : "airing";
      const family = q.has("with_genres");
      return { ok: true, status: 200, data: { results: (on[which] ?? []).filter((r) => !family || (r as { family?: boolean }).family) } };
    }
    if (url.pathname === "/search/tv") {
      const all = [tv(301, "Severed Lines", "2025-01-10", 50), tv(305, "Severed Lines Live", "2026-01-01", 5), tv(302, "Quiet Valley", "2021-04-01", 20), tv(202, "Copper Hill", "2022-05-05", 70)];
      return { ok: true, status: 200, data: { results: all.filter((s) => s.name.toLowerCase().includes((q.get("query") ?? "").toLowerCase())) } };
    }
    const where = /^\/tv\/(\d+)\/watch\/providers$/.exec(url.pathname);
    if (where) return { ok: true, status: 200, data: { results: { NL: { flatrate: Number(where[1]) === 202 ? [{ provider_id: 903, provider_name: "Lumen+" }] : [] } } } };
    const show = /^\/tv\/(\d+)$/.exec(url.pathname);
    if (show && SHOWS[Number(show[1])]) return { ok: true, status: 200, data: SHOWS[Number(show[1])] };
    return { ok: false, status: 404, error: "The resource you requested could not be found." };
  };
  return { get, asked };
}

const APPS: NewsApp[] = [
  { id: "local.kino", name: "Kino", category: "streaming" },
  { id: "local.lumen", name: "Lumen+", category: "streaming" },
  { id: "official.jelly", name: "Jelly", category: "media" },
];

function news(options: { key?: boolean; region?: string | null; get?: TmdbGet; state?: string } = {}) {
  const tmdb = standIn();
  const n = new News({
    get: options.get ?? tmdb.get,
    state: options.state ?? mkdtempSync(join(scratch, "state-")),
    keySet: () => options.key ?? true,
    region: async () => (options.region === undefined ? "NL" : options.region),
    apps: async () => APPS,
    now: () => NOW,
  });
  return { n, asked: tmdb.asked };
}

// --- The household's services ---------------------------------------------------------

test("an app is matched to TMDB's services by its name, word for word, and a plus is a plus", () => {
  assert.ok(sameService("Kino", "Kino"));
  assert.ok(sameService("Kino", "Kino Kids"));
  assert.ok(sameService("Lumen+", "Lumen Plus"));
  assert.ok(sameService("Lumen Plus", "Lumen+"));
  assert.ok(!sameService("Kino", "Kinoteka"), "a word that only starts the same isn't the service");
  assert.ok(sameService("Lumen", "Lumen+ Kids"), "an app called Lumen is on Lumen+ Kids too");
  assert.ok(!sameService("", "Kino"));
});

test("the household's services are the streaming apps on the box, each with what TMDB lists by its name for the region", async () => {
  const { n } = news();
  const { services } = await n.services("NL");
  assert.deepEqual(services, [
    { app: "local.kino", name: "Kino", providers: [{ id: 901, name: "Kino" }, { id: 902, name: "Kino Kids" }] },
    { app: "local.lumen", name: "Lumen+", providers: [{ id: 903, name: "Lumen+" }] },
  ]);
});

test("with a key just kept, the daemon waits for the router's service to have it, which root starts again", async () => {
  let asks = 0;
  const { n } = news({ get: async () => (++asks < 3 ? { ok: false, error: "there's no tmdb key on the box" } : { ok: true, status: 200, data: {} }) });
  assert.equal(await n.ready(5000), true);
  assert.equal(asks, 3);
  const { n: never } = news({ get: async () => ({ ok: false, error: "the router isn't running" }) });
  assert.equal(await never.ready(300), false, "and stops waiting after a while");
  const { n: other } = news({ get: async () => ({ ok: false, status: 401, error: "tmdb didn't take the key" }) });
  assert.equal(await other.ready(300), true, "TMDB refusing the key is an answer, not a wait");
});

test("a router that hangs up mid-answer, as root stops it to start it again, isn't running, and the daemon waits for it", async () => {
  const socket = join(mkdtempSync(join(scratch, "router-")), "router.sock");
  const router = socketServer((connection) => connection.once("data", () => connection.destroy()));
  await new Promise<void>((resolve) => router.listen(socket, resolve));
  try {
    const get = tmdbViaRouter(socket, 2000);
    assert.deepEqual(await get("/configuration"), { ok: false, error: ROUTER_GONE });
    const { n } = news({ get });
    assert.equal(await n.ready(300), false, "it's waited for, not taken as ready");
  } finally {
    await new Promise((resolve) => router.close(resolve));
  }
  assert.deepEqual(await tmdbViaRouter(socket, 2000)("/configuration"), { ok: false, error: ROUTER_GONE }, "and with nobody on the socket, it isn't running either");
});

// --- What's new (S8.1) -----------------------------------------------------------------

test("S8.1 what's new is the last 7 days on the household's services: digital releases, premieres, new shows and new seasons", async () => {
  const { n, asked } = news();
  const feed = await n.feed("adult");
  assert.equal(feed.ok, true);
  assert.equal(feed.from, WEEK_AGO);
  assert.equal(feed.to, TODAY);
  assert.deepEqual(
    feed.titles.map((t) => [t.kind, t.title, t.app, t.season ?? null, t.date ?? null]),
    [
      ["film", "Glass Harbour", "local.lumen", null, null],
      ["film", "Night Train", "local.kino", null, null],
      ["series", "Copper Hill", "local.lumen", 3, "2026-10-28"],
      ["series", "The Long Field", "local.kino", null, "2026-10-30"],
      ["film", "Paper Kites", "local.kino", null, null],
      ["film", "Small Hours", "local.kino", null, "2026-10-30"],
    ],
  );
  assert.equal(feed.titles[0].poster, "https://image.tmdb.org/t/p/w342/f104.jpg");
  // Old Faithful has an episode out, but its season began in September.
  assert.ok(!feed.titles.some((t) => t.title === "Old Faithful"));
  // Every discover asks for the region, the service's own ids, what's on
  // it rather than to rent or buy, and this week.
  const discovers = asked.filter((p) => p.startsWith("/discover/"));
  assert.equal(discovers.length, 8);
  for (const p of discovers) {
    const q = new URL(p, "http://x").searchParams;
    assert.equal(q.get("watch_region"), "NL");
    assert.ok(["901|902", "903"].includes(q.get("with_watch_providers") ?? ""), p);
    assert.equal(q.get("with_watch_monetization_types"), "flatrate|free|ads");
    assert.equal(q.get("include_adult"), "false");
    assert.ok(p.includes(`.gte=${WEEK_AGO}`) && p.includes(`.lte=${TODAY}`), p);
  }
  assert.ok(!asked.some((p) => p.includes("904")), "a service only named like one of theirs isn't asked about");
});

test("what's new is kept for a few hours, and kept when TMDB stops answering", async () => {
  const state = mkdtempSync(join(scratch, "kept-"));
  const first = news({ state });
  await first.n.feed("adult");
  const count = first.asked.length;
  await first.n.feed("adult");
  assert.equal(first.asked.length, count, "asked again within the hour, it isn't asked of TMDB");
  // A daemon started again reads what was kept.
  let reached = 0;
  const down = news({ state, get: async () => (reached++, { ok: false, error: "tmdb couldn't be reached" }) });
  const kept = await down.n.feed("adult");
  assert.equal(kept.titles.length, 6);
  // Asked for a fresh one while TMDB is down, it says so and keeps what it had.
  const fresh = await down.n.feed("adult", true);
  assert.ok(reached > 0);
  assert.equal(fresh.titles.length, 6);
  assert.equal(fresh.error, "tmdb couldn't be reached");
});

test("a child's profile only sees family titles, on the apps a child can open", async () => {
  const { n, asked } = news();
  const feed = await n.forViewer("child", ["local.kino"]);
  assert.deepEqual(feed.titles.map((t) => t.title), ["Paper Kites"]);
  const discovers = asked.filter((p) => p.startsWith("/discover/"));
  assert.ok(discovers.every((p) => /with_genres=(10751|10762\|10751)(&|$)/.test(decodeURIComponent(p))), "every ask is for family or kids titles");
  // An adult who can open both sees both, and a named app keeps only its own.
  const adult = await n.forViewer("adult", ["local.kino", "local.lumen"], { app: "local.lumen" });
  assert.deepEqual(adult.titles.map((t) => t.title), ["Glass Harbour", "Copper Hill"]);
  assert.deepEqual((await n.forViewer("adult", ["local.kino", "local.lumen"], { kind: "series" })).titles.map((t) => t.title), ["Copper Hill", "The Long Field"]);
});

test("what's new with no key, no region or no service TMDB knows says which", async () => {
  assert.equal((await news({ key: false }).n.feed()).why, "no-key");
  assert.equal((await news({ region: null }).n.feed()).why, "no-region");
  const elsewhere = await news({ region: "AQ" }).n.feed();
  assert.equal(elsewhere.why, "no-services");
  assert.deepEqual(elsewhere.services.map((s) => s.providers.length), [0, 0]);
});

// --- New episodes (S8.2) ------------------------------------------------------------

const row = (title: string, season: number, episode: number): WatchRow => ({ id: 1, viewer_id: "radomir", app_id: "local.kino", kind: "episode", title, season, episode, position_s: 2500, duration_s: 2600, started_at: "2026-10-20T20:00:00Z", updated_at: "2026-10-20T20:45:00Z" });

test("days as the TV says them: today, tomorrow, and a weekday with its date", () => {
  assert.equal(dayOf(NOW), TODAY);
  assert.equal(spokenDay("2026-11-01", TODAY), "today");
  assert.equal(spokenDay("2026-11-02", TODAY), "tomorrow");
  assert.equal(spokenDay("2026-10-31", TODAY), "yesterday");
  assert.equal(spokenDay("2026-11-06", TODAY), "on Fri 6 Nov");
  assert.equal(spokenDay("2027-01-08", TODAY), "on Fri 8 Jan 2027");
});

test("S8.2 a new episode is yes when one is out after the one they watched, with the next air date", async () => {
  const { n } = news();
  const yes = await n.episode("severed lines", [row("Severed Lines", 2, 3)], "adult", ["local.kino"]);
  assert.deepEqual({ yes: yes.yes, say: yes.say }, { yes: true, say: "Yes, Severed Lines S2 E4 is out. The next is S2 E6, on Fri 6 Nov." });
  assert.deepEqual(yes.latest, { season: 2, episode: 5, date: "2026-10-30" });
  assert.deepEqual(yes.next, { season: 2, episode: 6, date: "2026-11-06" });
  const no = await n.episode("Severed Lines", [row("Severed Lines", 2, 5)], "adult", ["local.kino"]);
  assert.deepEqual({ yes: no.yes, say: no.say }, { yes: false, say: "No, you've seen the newest Severed Lines. The next is S2 E6, on Fri 6 Nov." });
});

test("S8.2 with nothing in the ledger, it's yes when one came out this week; an ended show says so", async () => {
  const { n } = news();
  assert.equal((await n.episode("severed lines", [], "adult", [])).say, "Yes, Severed Lines S2 E5 came out on Fri 30 Oct. The next is S2 E6, on Fri 6 Nov.");
  assert.equal((await n.episode("quiet valley", [], "adult", [])).say, "No new episode of Quiet Valley this week. It has ended.");
  // With no show named, the newest show in their ledger.
  assert.equal((await n.episode(null, [row("Severed Lines", 2, 4)], "adult", [])).say, "Yes, Severed Lines S2 E5 is out. The next is S2 E6, on Fri 6 Nov.");
  assert.equal((await n.episode(null, [], "adult", [])).why, "which");
  assert.equal((await n.episode("dune", [], "adult", [])).say, "Couldn't find a show called dune");
});

test("a season watched to its last episode goes on to the next season's first, and no next date is said plainly", () => {
  const show = { id: 1, name: "Copper Hill", status: "Returning Series", latest: { season: 3, episode: 1, date: "2026-10-28" }, next: null, seasons: [{ season: 2, date: "2024-04-01", episodes: 8 }, { season: 3, date: "2026-10-28", episodes: 8 }] };
  assert.equal(answerEpisode(show, { season: 2, episode: 8 }, TODAY).say, "Yes, Copper Hill S3 E1 is out. There's no date for the next one yet.");
});

test("a child only hears about a show on their apps, or one in their own ledger", async () => {
  const { n } = news();
  assert.equal((await n.episode("severed lines", [], "child", ["local.kino"])).say, "Severed Lines isn't on your apps");
  assert.equal((await n.episode("copper hill", [], "child", ["local.lumen"])).yes, true);
  assert.equal((await n.episode("severed lines", [row("Severed Lines", 2, 1)], "child", ["local.kino"])).yes, true);
});

// --- The executors ---------------------------------------------------------------------

function context(n: News, role: "adult" | "child" = "adult"): { ctx: ExecContext; calls: string[] } {
  const calls: string[] = [];
  const apps = [
    { id: "local.kino", name: "Kino", category: "streaming", capabilities: ["launch", "search", "playback"] },
    { id: "local.lumen", name: "Lumen+", category: "streaming", capabilities: ["launch", "search", "playback"] },
  ];
  const ctx: ExecContext = {
    apps,
    rows: () => [],
    search: async (query, ids) => (calls.push(`search ${query} in ${ids}`), []),
    open: async (app) => (calls.push(`open ${app}`), { ok: true }),
    news: { whatsNew: (only) => n.forViewer(role, apps.map((a) => a.id), only), episode: (query) => n.episode(query, [], role, apps.map((a) => a.id)) },
  };
  return { ctx, calls };
}
const routed = (route: Route): Routed => ({ sentence: "", route, provider: "claude", via: "api", model: "test", ms: 1 });

test("S8.1 'what's new' says the top three and offers them to choose from, and nothing opens until one is picked", async () => {
  const { ctx, calls } = context(news().n);
  const outcome = await execute(routed({ ...NONE, intent: "whats_new" }), ctx);
  assert.equal(outcome.kind, "choose");
  const choose = outcome as Extract<Outcome, { kind: "choose" }>;
  assert.equal(choose.say, "New this week: Glass Harbour, Night Train and Copper Hill, season 3");
  assert.deepEqual(choose.candidates.map((c) => [c.name, c.item.id, c.item.kind, c.item.title, c.item.season ?? null]), [
    ["Lumen+", "tmdb:film:104", "film", "Glass Harbour", null],
    ["Kino", "tmdb:film:101", "film", "Night Train", null],
    ["Lumen+", "tmdb:series:202", "series", "Copper Hill", 3],
  ]);
  assert.deepEqual(calls, []);
  const onKino = await execute(routed({ ...NONE, intent: "whats_new", app: "kino", kind: "series" }), ctx);
  assert.equal(onKino.say, "New this week: The Long Field");
  assert.equal(listed(["a", "b"]), "a and b");
});

test("what's new without a key says where to add one; a request for music says it only knows films and shows", async () => {
  const { ctx } = context(news({ key: false }).n);
  assert.deepEqual(await execute(routed({ ...NONE, intent: "whats_new" }), ctx), { kind: "none", why: "no-tmdb", say: "Set up New this week in Settings first" });
  assert.deepEqual(await execute(routed({ ...NONE, intent: "new_episode", query: "copper hill" }), ctx), { kind: "none", why: "no-tmdb", say: "Set up New this week in Settings first" });
  const { ctx: c2 } = context(news().n);
  assert.deepEqual(await execute(routed({ ...NONE, intent: "whats_new", kind: "album" }), c2), { kind: "none", why: "not-found", say: "New this week is films and shows only" });
});

test("S8.2 'is there a new episode of' is told, yes or no with the next air date, and nothing opens", async () => {
  const { ctx, calls } = context(news().n);
  const outcome = await execute(routed({ ...NONE, intent: "new_episode", query: "Copper Hill" }), ctx);
  assert.equal(outcome.kind, "told");
  assert.equal(outcome.say, "Yes, Copper Hill S3 E1 came out on Wed 28 Oct. The next is S3 E2, on Wed 4 Nov.");
  assert.deepEqual(calls, []);
});

test("S8.1 a title picked from what's new opens on its own page in its app; one it can't find is left on the app's search, and an app that can't show a page plays it, as 'play it on that app' would", async () => {
  const { n } = news();
  const asks: SayAsk[] = [];
  // What the TV session says the app's playback.show came to: none, for an
  // app without one.
  let shown: SayAnswer["shown"];
  const apps = [
    { id: "local.kino", name: "Kino", category: "streaming", capabilities: ["launch", "search", "playback"] },
    { id: "local.lumen", name: "Lumen+", category: "streaming", capabilities: ["launch", "search", "playback"] },
  ];
  const say = new Say({
    route: async (sentence) => ({ sentence, route: { ...NONE, intent: "whats_new" }, provider: "claude", via: "api", model: "test", ms: 1 }),
    viewer: async () => ({ id: "radomir", name: "radomir", role: "adult" }),
    apps: async () => apps,
    rows: () => [],
    news: (_viewer, list) => ({ whatsNew: (only) => n.forViewer("adult", list.map((a) => a.id), only), episode: (query) => n.episode(query, [], "adult", []) }),
    ask: async (ask) => {
      asks.push(ask);
      if (ask.kind === "search") return { ok: true, found: [{ app: "local.lumen", items: [{ id: "lumen-77", kind: "film", title: "Glass Harbour" }, { id: "lumen-78", kind: "film", title: "Glass Harbour 2" }] }] };
      if (ask.kind === "show") return { ok: true, ...(shown ? { shown } : {}) };
      return { ok: true };
    },
    changed: () => {},
  });
  const glass = { id: "tmdb:film:104", kind: "film", title: "Glass Harbour", year: 2026, poster: "https://image.tmdb.org/t/p/w342/f104.jpg" };
  for (const [answer, outcome] of [
    ["title", { kind: "opened", app: "local.lumen", item: glass, say: "Glass Harbour, on Lumen+" }],
    ["search", { kind: "opened", app: "local.lumen", say: "Searched Lumen+ for Glass Harbour" }],
  ] as const) {
    shown = answer;
    const said = await say.hear("what's new", "iphone");
    asks.splice(0);
    assert.deepEqual((await say.pick(said.n, 0)).said?.outcome, outcome);
    assert.deepEqual(asks, [{ kind: "show", app: "local.lumen", item: glass, viewer: { id: "radomir", name: "radomir", role: "adult" } }], "the item is TMDB's name, kind and year, and nothing is searched for or played");
  }
  shown = undefined;
  asks.splice(0);
  const said = await say.hear("what's new", "iphone");
  assert.equal(said.outcome?.kind, "choose");
  // Over an app, the TV session's overlay says the three, and the phone has them.
  assert.deepEqual(asks.splice(0), [{ kind: "tell", text: "New this week: Glass Harbour, Night Train and Copper Hill, season 3. Pick on your phone." }], "nothing is looked up or opened until one is picked");
  const picked = await say.pick(said.n, 0);
  assert.deepEqual(picked.said?.outcome, { kind: "opened", app: "local.lumen", item: { id: "lumen-77", kind: "film", title: "Glass Harbour" }, say: "Glass Harbour, on Lumen+" });
  assert.deepEqual(
    asks.map((a) => (a.kind === "search" ? `search ${a.query} in ${a.apps}` : a.kind === "open" ? `open ${a.app} ${a.item?.id}` : a.kind === "show" ? `show ${a.app} ${a.item.id}` : a.kind)),
    ["show local.lumen tmdb:film:104", "search Glass Harbour in local.lumen", "open local.lumen lumen-77"],
  );
});

// --- Through the daemon -------------------------------------------------------------------

test("S8.1 the daemon's what's new is for who's watching, and the TMDB key goes to root and never comes back", async () => {
  const base = join(scratch, "daemon");
  const etc = join(base, "etc");
  mkdirSync(etc, { recursive: true });
  const apps = join(base, "apps");
  for (const [id, name] of [["local.kino", "Kino"], ["local.lumen", "Lumen+"]]) {
    const dir = join(scratch, id);
    cpSync(join(ROOT, "test/agentv/fixtures/apps/pager"), dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, id, name, author: "your agent", tv: { ...manifest.tv, childSafe: false } }));
    await installLocal(dir, apps, async () => true);
  }
  const tmdb = standIn();
  const lines: string[] = [];
  // The box's country is TMDB's region (ADR-055), from the tz database's
  // tables here, on a box in Amsterdam's time zone.
  process.env.AGENTV_ZONE_TAB = join(ROOT, "test/agentv/fixtures/met/zone.tab");
  process.env.AGENTV_ISO3166_TAB = join(ROOT, "test/agentv/fixtures/met/iso3166.tab");
  const daemon = new Daemon({ root: join(base, "root"), state: join(base, "state"), apps, builtins: null, port: 0, log: (line) => lines.push(line), keyStatus: join(etc, "key.json"), tmdbStatus: join(etc, "tmdb.json"), keyWaitMs: 3000, tmdb: tmdb.get, newsNow: () => NOW, country: { zone: async () => "Europe/Amsterdam" } });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  const send = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
  };
  // agentv-key.path, as root would, once the daemon leaves the key.
  const drop = join(base, "state", "key-drop", "tmdb.json");
  const KEY = "eyJhbGciOiJIUzI1NiJ9.stand-in-token.signature";
  const root = setInterval(() => {
    try {
      const { key } = JSON.parse(readFileSync(drop, "utf8"));
      rmSync(drop);
      writeFileSync(join(etc, "tmdb.json"), JSON.stringify({ set: key !== null, at: new Date().toISOString() }));
    } catch {
      // Nothing dropped yet.
    }
  }, 20);
  try {
    assert.equal((await send("PUT", "/api/country", { code: "NL" })).data.code, "NL");
    const before = (await send("GET", "/api/whats-new")).data.feed as { why: string };
    assert.equal(before.why, "no-key");
    assert.deepEqual((await send("PUT", "/api/tmdb-key", { key: "short" })).data, { ok: false, error: "that doesn't look like a tmdb key" });
    const kept = await send("PUT", "/api/tmdb-key", { key: KEY });
    assert.equal(kept.status, 200);
    assert.deepEqual((kept.data.key as { set: boolean }).set, true);
    assert.equal(kept.data.region, "NL");
    assert.deepEqual((kept.data.services as { name: string }[]).map((s) => s.name), ["Kino", "Lumen+"]);
    const feed = (await send("GET", "/api/whats-new")).data.feed as { ok: boolean; titles: { title: string }[] };
    assert.equal(feed.ok, true);
    assert.equal(feed.titles[0].title, "Glass Harbour");
    const answer = (await send("POST", "/api/whats-new/episode", { query: "copper hill" })).data.answer as { yes: boolean };
    assert.equal(answer.yes, true);
    // A title chosen on New this week opens on its own page in its app,
    // through the TV session, found there by its name, kind and year. One
    // its app doesn't have leaves it on the app's own search for it.
    const asks: SayAsk[] = [];
    const tvSession = new AskWatch<SayAsk, SayAnswer>({
      url: `${url}/`,
      path: "api/say/ask",
      what: "a sentence",
      handle: async (ask) => {
        asks.push(ask);
        if (ask.kind === "show") return { ok: true, shown: ask.item.year === 2026 ? "title" : "search" };
        return { ok: true };
      },
      failed: (error) => ({ ok: false, error: error.message }),
      log: () => {},
      retryMs: 50,
    });
    tvSession.start();
    try {
      const opened = await send("POST", "/api/whats-new/open", { id: "tmdb:film:104" });
      const item = { id: "tmdb:film:104", kind: "film", title: "Glass Harbour", year: 2026, poster: "https://image.tmdb.org/t/p/w342/f104.jpg" };
      assert.deepEqual((opened.data.said as { outcome: unknown }).outcome, { kind: "opened", app: "local.lumen", item, say: "Glass Harbour, on Lumen+" });
      assert.deepEqual(
        asks.filter((a) => a.kind !== "tell").map((a) => (a.kind === "show" ? { kind: a.kind, app: a.app, item: a.item } : a)),
        [{ kind: "show", app: "local.lumen", item }],
        "nothing is searched for or played: the title's own page is shown",
      );
      assert.equal((await send("POST", "/api/whats-new/open", { id: "tmdb:film:999" })).status, 404);
    } finally {
      tvSession.stop();
    }
    assert.ok(!JSON.stringify(await send("GET", "/api/whats-new/settings")).includes(KEY), "the key never comes back out");
    assert.ok(!lines.join("\n").includes(KEY), "nor is it logged");
    assert.equal((await send("PUT", "/api/country", { code: "the netherlands" })).status, 400);
    assert.deepEqual((await send("DELETE", "/api/tmdb-key")).data.key, { set: false, at: (JSON.parse(readFileSync(join(etc, "tmdb.json"), "utf8")) as { at: string }).at });
  } finally {
    clearInterval(root);
    await daemon.close();
  }
});

test("with a key just kept, Settings has the household's services even when the old router answers just before it stops", async () => {
  const base = join(scratch, "restart");
  const etc = join(base, "etc");
  mkdirSync(etc, { recursive: true });
  const apps = join(base, "apps");
  for (const [id, name] of [["local.kino", "Kino"], ["local.lumen", "Lumen+"]]) {
    const dir = join(scratch, `restart-${id}`);
    cpSync(join(ROOT, "test/agentv/fixtures/apps/pager"), dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, id, name, author: "your agent", tv: { ...manifest.tv, childSafe: false } }));
    await installLocal(dir, apps, async () => true);
  }
  // The router's service: once root keeps the key, the old one answers
  // one more ask and stops, and the new one is up a moment later, as on a
  // box where agentv-key.service starts it again.
  const tmdb = standIn();
  let router: "up" | "stopping" | "down" = "up";
  const get: TmdbGet = async (path) => {
    if (router === "down") return { ok: false, error: ROUTER_GONE };
    if (router === "stopping") {
      router = "down";
      setTimeout(() => (router = "up"), 400);
    }
    return tmdb.get(path);
  };
  const daemon = new Daemon({ root: join(base, "root"), state: join(base, "state"), apps, builtins: null, port: 0, log: () => {}, keyStatus: join(etc, "key.json"), tmdbStatus: join(etc, "tmdb.json"), keyWaitMs: 3000, tmdb: get, country: { zone: async () => "Europe/Amsterdam" } });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  const drop = join(base, "state", "key-drop", "tmdb.json");
  const root = setInterval(() => {
    try {
      const { key } = JSON.parse(readFileSync(drop, "utf8"));
      rmSync(drop);
      writeFileSync(join(etc, "tmdb.json"), JSON.stringify({ set: key !== null, at: new Date().toISOString() }));
      router = "stopping";
    } catch {
      // Nothing dropped yet.
    }
  }, 20);
  try {
    const kept = (await (await fetch(`${url}/api/tmdb-key`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "eyJhbGciOiJIUzI1NiJ9.stand-in-token.signature" }) })).json()) as { services?: { name: string }[]; error?: string };
    assert.equal(kept.error, undefined);
    assert.deepEqual(kept.services?.map((s) => s.name), ["Kino", "Lumen+"]);
  } finally {
    clearInterval(root);
    await daemon.close();
  }
});
