// The executors (ADR-003, ADR-013): what a route does, the same whichever
// provider routed it. Each one is plain code: a route opens an app at an
// item, offers up to three to choose from, or says why it can't, in one
// line the TV shows, written for the screen, so the TV has no "I". With a
// key for an AI that has a voice, the TV says the same line. A route of none
// is "Didn't get that", and nothing happens (S7.3). What's new and new episodes
// ask TMDB (stage 8, daemon/tmdb.ts): what's new offers up to three to
// choose from, and a new episode is an answer, told.
//
// What needs the TV session, searching apps and opening them, goes to the
// screen daemon as an ask (daemon/say.ts). Make and change ask the builder
// (make.ts, ADR-068).

import type { Item } from "../../apps/contract/contract.ts";
import { AI_NAMES } from "../../builder/reasons.ts";
import type { WatchRow } from "../ledger.ts";
import { noAnswer } from "../providers/no-answer.ts";
import { NONE, type Route, type Routed } from "../router.ts";
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
  // detail is the raw reason, for the log. It never reaches a screen
  // (daemon/say.ts takes it out).
  | { kind: "none"; say: string; why: NoneWhy; detail?: string };

// Why nothing happened: the router couldn't route it, its answer didn't
// fit, the provider didn't answer, an app it named isn't here, nothing
// matched, that request comes later, the app didn't open, or what's new
// needs a TMDB key or a region first. For make and change: a child asked,
// there's no AI to build with, the builder didn't start, the app isn't one
// the agent made, or it isn't clear which one.
export type NoneWhy = "unroutable" | "unreadable" | "failed" | "missing" | "not-found" | "soon" | "not-opened" | "no-tmdb" | "child" | "no-ai" | "not-built" | "not-made" | "which";

export const DIDNT_GET = "Didn't get that";
// With no AI set up yet, where to set one up (D5).
export const NO_AI = "Set up AI in Settings first";

// An app who's watching can open, as the executors know it.
export interface ExecApp {
  id: string;
  name: string;
  category: string;
  capabilities: string[];
  made?: boolean; // the box's agent made it
}

export type Opened = { ok: true } | { ok: false; error?: string };

// What showing a title's own page in its app came to: its page, the app's
// own search for it, or an app with no way to show one.
export type Shown = "title" | "search" | "unsupported";

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
  // A title's own page in its app, without playing it (ADR-097).
  show?: (app: string, item: Item) => Promise<{ ok: true; shown: Shown } | { ok: false; error?: string }>;
  news?: ExecNews;
  // The builder, for make and change, when the askbuilds switch is on.
  builds?: ExecBuilds;
}

const lower = (text: string) => text.toLowerCase();

// What a kind is, as the TV says it next to a title.
export const KIND_WORDS: Record<string, string> = { film: "film", series: "show", episode: "episode", track: "song", album: "album", playlist: "playlist", "photo-album": "photos", game: "game" };

// An item as the TV names it: "Severance S2 E3".
export function itemWords(item: Item): string {
  const at = [item.season !== undefined ? `S${item.season}` : "", item.episode !== undefined ? `E${item.episode}` : ""].filter(Boolean).join(" ");
  return at ? `${item.title} ${at}` : item.title;
}

export async function opening(ctx: ExecContext, app: ExecApp, item?: Item): Promise<Outcome> {
  const opened = await ctx.open(app.id, item);
  if (!opened.ok) return { kind: "none", why: "not-opened", say: `Couldn't open ${item ? itemWords(item) : app.name}`, ...(opened.error ? { detail: opened.error } : {}) };
  return { kind: "opened", app: app.id, ...(item ? { item } : {}), say: item ? `${itemWords(item)}, on ${app.name}` : app.name };
}

export async function execute(routed: Routed, ctx: ExecContext): Promise<Outcome> {
  const route = routed.route;
  if (route.intent === "none") {
    // An AI that isn't set up says what to set up, in the router's own plain
    // line (daemon/router-client.ts). With the Ask box building, that's why
    // nothing was made.
    const setUp = routed.setup === "ai" ? NO_AI : (routed.error ?? NO_AI);
    if (routed.none === "failed" && routed.setup && ctx.builds) return { kind: "none", why: "no-ai", say: setUp };
    if (routed.none === "failed" && routed.setup) return { kind: "none", why: "failed", say: setUp };
    // No answer: the plain line for why, and the raw reason for the log.
    if (routed.none === "failed") return { kind: "none", why: "failed", say: noAnswer(routed.error, AI_NAMES[routed.provider]), ...(routed.error ? { detail: routed.error } : {}) };
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
    if (!app) return { kind: "none", why: "missing", say: `${said} isn't on this TV` };
  }

  // Make and change, for the box's agent to build (ADR-068).
  if (route.intent === "make") return make(route, ctx);
  if (route.intent === "change") return change(route, ctx, app);

  if (route.intent === "whats_new") return whatsNew(route, ctx, app);
  if (route.intent === "new_episode") return newEpisode(route, ctx);

  if (route.intent === "continue") {
    const row = toContinue(ctx.rows(), { ...route, app: app?.id ?? null }, new Set(ctx.apps.map((a) => a.id)));
    if (!row) return { kind: "none", why: "not-found", say: route.query ? `Couldn't find ${route.query} to continue` : "There's nothing to continue yet" };
    return opening(ctx, ctx.apps.find((a) => a.id === row.app_id)!, continueItem(row));
  }

  // Play: an app on its own, or something in the apps that can search.
  if (!route.query) return opening(ctx, app!);
  // An app they named that can't look things up still opens, since they
  // asked for it, and the TV says why that's all.
  if (app && !app.capabilities.includes("search")) {
    const opened = await opening(ctx, app);
    return opened.kind === "opened" ? { ...opened, say: `Opened ${app.name}. It can't find ${route.query}.` } : opened;
  }
  const searching = app ? [app] : ctx.apps.filter((a) => a.capabilities.includes("search"));
  if (!searching.length) return { kind: "none", why: "not-found", say: "No app here can search yet" };
  const found = await ctx.search(route.query, searching.map((a) => a.id));
  const chosen = pick(rank(found, route));
  const name = (id: string) => ctx.apps.find((a) => a.id === id)?.name ?? id;
  if ("one" in chosen) return opening(ctx, ctx.apps.find((a) => a.id === chosen.one.app)!, toOpen(chosen.one.item, route));
  if ("some" in chosen) return { kind: "choose", say: "Which one?", candidates: chosen.some.map((r) => ({ app: r.app, name: name(r.app), item: toOpen(r.item, route) })) };
  // An app that opened to look with its page is on its own search for it
  // now, which is the best place to leave the person.
  const searched = found.find((f) => f.opened && !f.error);
  if (searched) return { kind: "opened", app: searched.app, say: `Searched ${name(searched.app)} for ${route.query}` };
  const failed = found.filter((f) => f.error).map((f) => `${lower(name(f.app))}: ${f.error}`);
  return { kind: "none", why: "not-found", say: `Couldn't find ${route.query}`, ...(failed.length ? { detail: failed.join("; ").slice(0, 200) } : {}) };
}

// A title chosen on New this week (ADR-097): its app opens on the title's
// own page, found by TMDB's name, kind and year, where Play is one press
// away. One the app can't find leaves it on its own search for the title.
// An app with no way to show a title's page plays it, as "play it on that
// app" would.
export async function openNew(item: Item, app: ExecApp, ctx: ExecContext): Promise<Outcome> {
  const shown = ctx.show ? await ctx.show(app.id, item) : ({ ok: true, shown: "unsupported" } as const);
  if (!shown.ok) return { kind: "none", why: "not-opened", say: `Couldn't open ${item.title}`, ...(shown.error ? { detail: shown.error } : {}) };
  if (shown.shown === "title") return { kind: "opened", app: app.id, item, say: `${itemWords(item)}, on ${app.name}` };
  if (shown.shown === "search") return { kind: "opened", app: app.id, say: `Searched ${app.name} for ${item.title}` };
  const route: Route = { ...NONE, intent: "play", query: item.title, kind: item.kind === "film" ? "film" : "series", app: app.id, season: item.season ?? null };
  return run(route, ctx);
}
