// The executors (ADR-003, ADR-013): what a route does, the same whichever
// provider routed it. Each one is plain code: a route opens an app at an
// item, offers up to three to choose from, or says why it can't, in one
// line the TV shows and, from stage 8, speaks. A route of none is "i
// didn't get that", and nothing happens (S7.3). What's new and new episodes
// ask TMDB (stage 8, daemon/tmdb.ts): what's new offers up to three to
// choose from, and a new episode is an answer, told.
//
// What needs the TV session, searching apps and opening them, goes to the
// screen daemon as an ask (daemon/say.ts). Make and change ask the builder
// (make.ts, ADR-068).

import type { Item } from "../../apps/contract/contract.ts";
import type { WatchRow } from "../ledger.ts";
import type { Route, Routed } from "../router.ts";
import type { EpisodeAnswer, Feed } from "../tmdb.ts";
import { continueItem, toContinue } from "./continue.ts";
import { change, make, type ExecBuilds } from "./make.ts";
import { newEpisode } from "./newEpisode.ts";
import { pick, rank, toOpen, words, type Found } from "./play.ts";
import { whatsNew } from "./whatsNew.ts";

// One of the things to choose from.
export interface Candidate {
  app: string;
  name: string; // the app's
  item: Item;
}

// A build is one the agent started: a make, reading what was asked, or a
// change an adult said ok to. A change waits for that ok, on the TV or the
// phone (make.ts).
export type Outcome =
  | { kind: "opened"; say: string; app: string; item?: Item }
  | { kind: "choose"; say: string; candidates: Candidate[] }
  | { kind: "told"; say: string; episode?: EpisodeAnswer }
  | { kind: "build"; say: string; build: string; what: string; app?: string }
  | { kind: "change"; say: string; app: string; name: string; what: string; recipe: string | null }
  | { kind: "none"; say: string; why: NoneWhy; detail?: string };

// Why nothing happened: the router couldn't route it, its answer didn't
// fit, the provider didn't answer, an app it named isn't here, nothing
// matched, that request comes later, the app didn't open, or what's new
// needs a TMDB key or a region first. For make and change: a child asked,
// there's no AI to build with, the builder didn't start, the app isn't one
// the agent made, or it isn't clear which one.
export type NoneWhy = "unroutable" | "unreadable" | "failed" | "missing" | "not-found" | "soon" | "not-opened" | "no-tmdb" | "child" | "no-ai" | "not-built" | "not-made" | "which";

export const DIDNT_GET = "i didn't get that";
// With no AI set up yet, where to set one up (D5).
export const NO_AI = "set up an ai first: settings → ai";

// An app who's watching can open, as the executors know it.
export interface ExecApp {
  id: string;
  name: string;
  category: string;
  capabilities: string[];
  made?: boolean; // the box's agent made it
}

export type Opened = { ok: true } | { ok: false; error?: string };

// TMDB for who's watching (daemon/tmdb.ts): what's new on the apps they can
// open, and a show's air dates against their ledger.
export interface ExecNews {
  whatsNew: (only: { app: string | null; kind: "film" | "series" | null }) => Promise<Feed>;
  episode: (query: string | null) => Promise<EpisodeAnswer>;
}

export interface ExecContext {
  apps: ExecApp[]; // the apps who's watching can open
  rows: () => WatchRow[]; // their ledger, newest first
  search: (query: string, apps: string[]) => Promise<Found[]>;
  open: (app: string, item?: Item) => Promise<Opened>;
  news?: ExecNews;
  // The builder, for make and change, when the askbuilds switch is on.
  builds?: ExecBuilds;
}

const lower = (text: string) => text.toLowerCase();

// What a kind is, as the TV says it next to a title.
export const KIND_WORDS: Record<string, string> = { film: "film", series: "show", episode: "episode", track: "song", album: "album", playlist: "playlist", "photo-album": "photos", game: "game" };

// An item as the TV names it: "severance s2 e3".
export function itemWords(item: Item): string {
  const at = [item.season !== undefined ? `s${item.season}` : "", item.episode !== undefined ? `e${item.episode}` : ""].filter(Boolean).join(" ");
  return lower(at ? `${item.title} ${at}` : item.title);
}

export async function opening(ctx: ExecContext, app: ExecApp, item?: Item): Promise<Outcome> {
  const opened = await ctx.open(app.id, item);
  if (!opened.ok) return { kind: "none", why: "not-opened", say: item ? `${lower(app.name)} didn't open ${itemWords(item)}` : `${lower(app.name)} didn't open`, ...(opened.error ? { detail: opened.error } : {}) };
  return { kind: "opened", app: app.id, ...(item ? { item } : {}), say: item ? `${itemWords(item)}, on ${lower(app.name)}` : lower(app.name) };
}

export async function execute(routed: Routed, ctx: ExecContext): Promise<Outcome> {
  const route = routed.route;
  if (route.intent === "none") {
    // With the Ask box building, an AI that isn't set up says where to set
    // it up, as D5's "set up an ai first: settings → ai".
    if (routed.none === "failed" && routed.setup && ctx.builds) return { kind: "none", why: "no-ai", say: routed.setup === "ai" ? NO_AI : (routed.error ?? NO_AI) };
    if (routed.none === "failed") return { kind: "none", why: "failed", say: "your agent didn't answer", ...(routed.error ? { detail: routed.error } : {}) };
    return { kind: "none", why: routed.none === "unreadable" ? "unreadable" : "unroutable", say: DIDNT_GET };
  }
  return run(route, ctx);
}

// A route that isn't none, done: as the router gave it, or as choosing
// something from what's new asks for it.
export async function run(route: Route, ctx: ExecContext): Promise<Outcome> {
  // An app they named: one here, by its id or its name, or one that isn't.
  let app: ExecApp | undefined;
  if (route.app) {
    const said = route.app;
    app = ctx.apps.find((a) => lower(a.id) === lower(said)) ?? ctx.apps.find((a) => words(a.name) === words(said));
    if (!app) return { kind: "none", why: "missing", say: `there's no ${lower(said)} on this tv` };
  }

  // Make and change, for the box's agent to build (ADR-068).
  if (route.intent === "make") return make(route, ctx);
  if (route.intent === "change") return change(route, ctx, app);

  if (route.intent === "whats_new") return whatsNew(route, ctx, app);
  if (route.intent === "new_episode") return newEpisode(route, ctx);

  if (route.intent === "continue") {
    const row = toContinue(ctx.rows(), { ...route, app: app?.id ?? null }, new Set(ctx.apps.map((a) => a.id)));
    if (!row) return { kind: "none", why: "not-found", say: route.query ? `there's nothing called ${lower(route.query)} to continue` : "there's nothing to continue yet" };
    return opening(ctx, ctx.apps.find((a) => a.id === row.app_id)!, continueItem(row));
  }

  // Play: an app on its own, or something in the apps that can search.
  if (!route.query) return opening(ctx, app!);
  // An app they named that can't look things up still opens, since they
  // asked for it, and the TV says why that's all.
  if (app && !app.capabilities.includes("search")) {
    const opened = await opening(ctx, app);
    return opened.kind === "opened" ? { ...opened, say: `${lower(app.name)} can't look up ${lower(route.query)}, so it's open` } : opened;
  }
  const searching = app ? [app] : ctx.apps.filter((a) => a.capabilities.includes("search"));
  if (!searching.length) return { kind: "none", why: "not-found", say: "nothing on this tv can look things up yet" };
  const found = await ctx.search(route.query, searching.map((a) => a.id));
  const chosen = pick(rank(found, route));
  const name = (id: string) => ctx.apps.find((a) => a.id === id)?.name ?? id;
  if ("one" in chosen) return opening(ctx, ctx.apps.find((a) => a.id === chosen.one.app)!, toOpen(chosen.one.item, route));
  if ("some" in chosen) return { kind: "choose", say: "which one?", candidates: chosen.some.map((r) => ({ app: r.app, name: name(r.app), item: toOpen(r.item, route) })) };
  const failed = found.filter((f) => f.error).map((f) => `${lower(name(f.app))}: ${f.error}`);
  return { kind: "none", why: "not-found", say: `i couldn't find ${lower(route.query)}`, ...(failed.length ? { detail: failed.join("; ").slice(0, 200) } : {}) };
}
