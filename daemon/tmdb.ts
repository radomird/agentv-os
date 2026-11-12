// What's new and new episodes (ADR-003, ADR-013, stage 8: S8.1, S8.2), from
// TMDB's API, never by scraping. The daemon never holds the household's TMDB
// key: it asks the router's service, which does (daemon/tmdb-api.ts), over
// router.sock.
//
// - The region is the one setup chose: the country of the time zone picked
//   in Omarchy's installer (ADR-007), or another one picked in Settings.
// - The household's services are the streaming apps on this box, each
//   matched by its name to the services TMDB lists for the region. The
//   names come from TMDB at runtime, so no service is named here.
// - What's new is what appeared on those services in the last 7 days:
//   films with a digital release in that week, or a first release there,
//   and shows that started or began a new season in it. TMDB's data on
//   where a title is comes from JustWatch, which the TV credits.
// - A child's profile only sees and hears about titles TMDB files under
//   family or kids, on the apps a child can open.
// - A new episode is TMDB's air dates against the ledger: yes when one is
//   out that who's watching hasn't seen, or, with nothing in the ledger,
//   one came out this week. Either way, with the next air date.
//
// What's new is kept in the daemon's state for a few hours, well inside the
// six months TMDB's terms allow, so home doesn't ask TMDB each time.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import type { WatchRow } from "./ledger.ts";
import { match } from "./executors/play.ts";
import type { TmdbAnswer } from "./tmdb-api.ts";

export const TMDB_SOCKET = "/run/agentv-router/router.sock";

// The router's service isn't there: no socket, nobody on it, or it went
// away mid-answer as root stopped it to start it again with a new key.
export const ROUTER_GONE = "the router isn't running";
const ROUTER_DOWN = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]);
// Posters from TMDB's image host, which home's tiles may show (ADR-014).
export const TMDB_POSTERS = "https://image.tmdb.org/t/p/w342";
// "This week": a release can take TMDB's data a few days to show (the plan's
// risk table), so the rail says this week, never today.
export const WINDOW_DAYS = 7;
const REFRESH_MS = 3 * 3600_000;
const PROVIDERS_MS = 24 * 3600_000;
// How many titles the feed keeps, and how many of a service's ongoing shows
// it asks about a new season.
const KEEP = 30;
const SEASON_CHECKS = 6;
// Subscription, free and with ads: what a household's own services carry.
// Renting and buying aren't "on" a service.
const ON_SERVICE = "flatrate|free|ads";
// TMDB's genres for a child's profile: family for films, kids or family for
// shows.
const FAMILY_FILMS = "10751";
const FAMILY_SHOWS = "10762|10751";

export type TmdbGet = (path: string) => Promise<TmdbAnswer>;

// TMDB through the router's service, which holds the key.
export function tmdbViaRouter(socket = TMDB_SOCKET, timeoutMs = 20_000): TmdbGet {
  return (path) =>
    new Promise((resolve) => {
      const asked = request({ socketPath: socket, path: "/tmdb", method: "POST", headers: { "Content-Type": "application/json" }, timeout: timeoutMs }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(text) as TmdbAnswer);
          } catch {
            resolve({ ok: false, error: "the router didn't answer" });
          }
        });
      });
      asked.on("timeout", () => {
        asked.destroy();
        resolve({ ok: false, error: "tmdb took too long to answer" });
      });
      asked.on("error", (error: NodeJS.ErrnoException) => resolve({ ok: false, error: ROUTER_DOWN.has(error.code ?? "") ? ROUTER_GONE : error.message }));
      asked.end(JSON.stringify({ path }));
    });
}

export interface WatchProvider {
  id: number;
  name: string;
}

// An app on the box, as what's new knows it.
export interface NewsApp {
  id: string;
  name: string;
  category: string;
}

// One of the household's services: an app on the box, and the services
// TMDB lists for the region by its name.
export interface Service {
  app: string;
  name: string;
  providers: WatchProvider[];
}

export interface NewTitle {
  kind: "film" | "series";
  id: number; // TMDB's
  title: string;
  date?: string; // the day it came out or its season started, when TMDB says
  season?: number; // a new season of a show
  poster?: string;
  app: string; // the app on this box it's on
  popularity: number;
}

export type NewsWhy = "no-key" | "no-region" | "no-services" | "failed";

export interface Feed {
  ok: boolean;
  why?: NewsWhy;
  error?: string;
  region: string | null;
  from: string;
  to: string;
  at: string | null; // when TMDB was asked
  services: Service[];
  titles: NewTitle[];
}

export interface Aired {
  season: number;
  episode: number;
  date: string;
}

export interface EpisodeAnswer {
  ok: boolean;
  why?: NewsWhy | "not-found" | "not-theirs" | "which";
  error?: string;
  show?: string;
  yes?: boolean;
  latest?: Aired | null; // the newest that's out
  next?: Aired | null; // the next to come out
  ended?: boolean;
  say: string;
}

// --- Words and days -----------------------------------------------------------

// A name as a list of words, for matching an app to a service: "Lumen+"
// and "Lumen Plus" are the same, and "Kino" is part of "Kino Kids".
export function serviceWords(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Whether TMDB's service is the app's: the app's name, word for word,
// somewhere in the service's.
export function sameService(app: string, provider: string): boolean {
  const a = serviceWords(app);
  return a.length > 0 && ` ${serviceWords(provider)} `.includes(` ${a} `);
}

const pad = (n: number) => String(n).padStart(2, "0");

// A day on the box's own clock, as TMDB writes dates.
export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function atNoon(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

export function daysBefore(day: string, n: number): string {
  const date = atNoon(day);
  date.setDate(date.getDate() - n);
  return dayOf(date);
}

function daysBetween(from: string, to: string): number {
  return Math.round((atNoon(to).getTime() - atNoon(from).getTime()) / 86_400_000);
}

const DAY = /^\d{4}-\d\d-\d\d$/;

// A day as the TV says it: today, tomorrow, or "on fri 7 nov".
export function spokenDay(day: string, today: string): string {
  const away = daysBetween(today, day);
  if (away === 0) return "today";
  if (away === 1) return "tomorrow";
  if (away === -1) return "yesterday";
  const date = atNoon(day);
  const words = date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) });
  return `on ${words.replace(",", "")}`;
}

const episodeWords = (a: { season: number; episode: number }) => `S${a.season} E${a.episode}`;

// --- TMDB's answers, held to what's used --------------------------------------

interface Found {
  id: number;
  title: string;
  date?: string;
  poster?: string;
  popularity: number;
}

function results(data: unknown, kind: "film" | "series"): Found[] {
  const list = (data as { results?: unknown })?.results;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).flatMap((r): Found[] => {
    const v = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    const title = kind === "film" ? v.title : v.name;
    if (!Number.isInteger(v.id) || typeof title !== "string" || !title.trim() || v.adult === true) return [];
    const date = kind === "film" ? v.release_date : v.first_air_date;
    const poster = typeof v.poster_path === "string" && /^\/[\w.-]{1,80}$/.test(v.poster_path) ? `${TMDB_POSTERS}${v.poster_path}` : undefined;
    return [{ id: v.id as number, title: title.trim().slice(0, 120), ...(typeof date === "string" && DAY.test(date) ? { date } : {}), ...(poster ? { poster } : {}), popularity: typeof v.popularity === "number" ? v.popularity : 0 }];
  });
}

function aired(value: unknown): Aired | null {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (!Number.isInteger(v.season_number) || !Number.isInteger(v.episode_number) || typeof v.air_date !== "string" || !DAY.test(v.air_date)) return null;
  return { season: v.season_number as number, episode: v.episode_number as number, date: v.air_date };
}

interface Show {
  id: number;
  name: string;
  status: string;
  latest: Aired | null;
  next: Aired | null;
  seasons: { season: number; date: string | null; episodes: number }[];
}

function show(data: unknown): Show | null {
  const v = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  if (!Number.isInteger(v.id) || typeof v.name !== "string") return null;
  const seasons = Array.isArray(v.seasons) ? v.seasons : [];
  return {
    id: v.id as number,
    name: v.name.slice(0, 120),
    status: typeof v.status === "string" ? v.status : "",
    latest: aired(v.last_episode_to_air),
    next: aired(v.next_episode_to_air),
    seasons: seasons.flatMap((s) => {
      const x = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
      return Number.isInteger(x.season_number) ? [{ season: x.season_number as number, date: typeof x.air_date === "string" && DAY.test(x.air_date) ? x.air_date : null, episodes: Number.isInteger(x.episode_count) ? (x.episode_count as number) : 0 }] : [];
    }),
  };
}

function providers(data: unknown): WatchProvider[] {
  const list = (data as { results?: unknown })?.results;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p) => {
    const v = (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
    return Number.isInteger(v.provider_id) && typeof v.provider_name === "string" ? [{ id: v.provider_id as number, name: v.provider_name.slice(0, 80) }] : [];
  });
}

// --- What's new ------------------------------------------------------------------

export interface NewsOptions {
  get: TmdbGet;
  state: string; // the daemon's own state, for whats-new.json
  keySet: () => boolean; // /etc/agentv/tmdb.json says there's a key
  region: () => Promise<string | null>;
  apps: () => Promise<NewsApp[]>; // every app on the box
  now?: () => Date;
  log?: (line: string) => void;
}

type Role = "adult" | "child";

export class News {
  private o: NewsOptions;
  private feeds = new Map<string, Feed>();
  private running = new Map<string, Promise<Feed>>();
  private regionProviders = new Map<string, { at: number; list: WatchProvider[] }>();
  private regionList?: { at: number; list: { code: string; name: string }[] };
  private loaded = false;

  constructor(options: NewsOptions) {
    this.o = options;
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  today(): string {
    return dayOf(this.now());
  }

  // Every service TMDB lists for the region, films' and shows' together.
  async providers(region: string): Promise<{ ok: boolean; list: WatchProvider[]; error?: string }> {
    const kept = this.regionProviders.get(region);
    if (kept && this.now().getTime() - kept.at < PROVIDERS_MS) return { ok: true, list: kept.list };
    const asked = await Promise.all(["movie", "tv"].map((kind) => this.o.get(`/watch/providers/${kind}?watch_region=${region}`)));
    const failed = asked.find((a) => !a.ok);
    if (failed) return { ok: false, list: kept?.list ?? [], error: failed.error };
    const byId = new Map<number, WatchProvider>();
    for (const a of asked) for (const p of providers(a.data)) byId.set(p.id, p);
    const list = [...byId.values()];
    this.regionProviders.set(region, { at: this.now().getTime(), list });
    return { ok: true, list };
  }

  // Whether the router's service has the key yet: root starts it again
  // just after keeping one, so a moment can pass before it does, and the
  // one that's stopping can still answer, or hang up mid-answer.
  async ready(timeoutMs = 8000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const asked = await this.o.get("/configuration");
      const waiting = !asked.ok && (asked.error === "there's no tmdb key on the box" || asked.error === ROUTER_GONE || asked.error === "the router didn't answer");
      if (!waiting) return true;
      if (Date.now() > until) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  // TMDB's regions, by their two letters and English names, for Settings to
  // pick from.
  async regions(): Promise<{ ok: boolean; regions: { code: string; name: string }[]; error?: string }> {
    if (this.regionList && this.now().getTime() - this.regionList.at < PROVIDERS_MS) return { ok: true, regions: this.regionList.list };
    const asked = await this.o.get("/watch/providers/regions");
    if (!asked.ok) return { ok: false, regions: this.regionList?.list ?? [], error: asked.error };
    const list = ((asked.data as { results?: unknown })?.results as unknown[] | undefined) ?? [];
    const regions = list
      .flatMap((r) => {
        const v = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
        return typeof v.iso_3166_1 === "string" && /^[A-Z]{2}$/.test(v.iso_3166_1) && typeof v.english_name === "string" ? [{ code: v.iso_3166_1, name: v.english_name.slice(0, 60) }] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    this.regionList = { at: this.now().getTime(), list: regions };
    return { ok: true, regions };
  }

  // The household's services: each streaming app on the box, with the
  // services TMDB lists for the region by its name.
  async services(region: string): Promise<{ ok: boolean; services: Service[]; error?: string }> {
    const apps = (await this.o.apps()).filter((app) => app.category === "streaming");
    if (!apps.length) return { ok: true, services: [] };
    const found = await this.providers(region);
    if (!found.ok && !found.list.length) return { ok: false, services: [], error: found.error };
    return { ok: true, services: apps.map((app) => ({ app: app.id, name: app.name, providers: found.list.filter((p) => sameService(app.name, p.name)) })) };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const kept = JSON.parse(await readFile(join(this.o.state, "whats-new.json"), "utf8")) as Record<string, Feed>;
      for (const [key, feed] of Object.entries(kept)) if (feed && Array.isArray(feed.titles)) this.feeds.set(key, feed);
    } catch {
      // Nothing kept yet.
    }
  }

  private async keep(): Promise<void> {
    await mkdir(this.o.state, { recursive: true });
    const next = join(this.o.state, ".whats-new.json.next");
    await writeFile(next, `${JSON.stringify(Object.fromEntries(this.feeds))}\n`);
    await rename(next, join(this.o.state, "whats-new.json"));
  }

  private empty(why: NewsWhy, region: string | null, services: Service[] = [], error?: string): Feed {
    const to = this.today();
    return { ok: false, why, ...(error ? { error } : {}), region, from: daysBefore(to, WINDOW_DAYS), to, at: null, services, titles: [] };
  }

  // What's new on every service of the household's, for an adult's profile
  // or a child's, asked of TMDB at most every few hours.
  async feed(role: Role = "adult", fresh = false): Promise<Feed> {
    if (!this.o.keySet()) return this.empty("no-key", null);
    const region = await this.o.region();
    if (!region) return this.empty("no-region", null);
    await this.load();
    const found = await this.services(region);
    if (!found.ok) {
      // With TMDB not answering, what was kept for the region this week.
      const kept = [...this.feeds.entries()].find(([key, feed]) => key.startsWith(`${role}:${region}:`) && feed.to === this.today())?.[1];
      return kept ? { ...kept, error: found.error } : this.empty("failed", region, [], found.error);
    }
    const services = found.services.filter((s) => s.providers.length);
    if (!services.length) return this.empty("no-services", region, found.services);
    const key = `${role}:${region}:${services.map((s) => `${s.app}=${s.providers.map((p) => p.id).join("|")}`).join(",")}`;
    const kept = this.feeds.get(key);
    if (!fresh && kept?.at && kept.to === this.today() && this.now().getTime() - Date.parse(kept.at) < REFRESH_MS) return kept;
    const running = this.running.get(key);
    if (running) return running;
    const asking = this.ask(role, region, services, found.services)
      .then(async (feed) => {
        if (feed.ok) {
          // Only the newest of each kind of feed is kept.
          for (const old of [...this.feeds.keys()]) if (old.startsWith(`${role}:`)) this.feeds.delete(old);
          this.feeds.set(key, feed);
          await this.keep().catch((error) => this.o.log?.(`what's new wasn't kept: ${(error as Error).message}`));
          return feed;
        }
        // TMDB not answering keeps what was there, while it's still this week.
        return kept && kept.to === this.today() ? { ...kept, error: feed.error } : feed;
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, asking);
    return asking;
  }

  private async ask(role: Role, region: string, services: Service[], all: Service[]): Promise<Feed> {
    const to = this.today();
    const from = daysBefore(to, WINDOW_DAYS);
    const titles = new Map<string, NewTitle>();
    const add = (title: NewTitle) => {
      const id = `${title.kind}:${title.id}`;
      const before = titles.get(id);
      // The same title on two services is the first service's.
      if (!before) titles.set(id, title);
      else if (!before.season && title.season) titles.set(id, { ...title, app: before.app });
    };
    let errors = 0;
    let error: string | undefined;
    const get = async (path: string) => {
      const said = await this.o.get(path);
      if (!said.ok) {
        errors++;
        error ??= said.error;
      }
      return said;
    };
    for (const service of services) {
      const base = `watch_region=${region}&with_watch_providers=${service.providers.map((p) => p.id).join("|")}&with_watch_monetization_types=${ON_SERVICE}&include_adult=false&sort_by=popularity.desc`;
      const films = role === "child" ? `&with_genres=${FAMILY_FILMS}` : "";
      const shows = role === "child" ? `&with_genres=${FAMILY_SHOWS}` : "";
      const [digital, premiere, started, airing] = await Promise.all([
        // A film with a digital release this week, wherever TMDB has one.
        get(`/discover/movie?${base}${films}&with_release_type=4|6&release_date.gte=${from}&release_date.lte=${to}`),
        // A film that came out this week, such as a service's own.
        get(`/discover/movie?${base}${films}&primary_release_date.gte=${from}&primary_release_date.lte=${to}`),
        // A show that started this week.
        get(`/discover/tv?${base}${shows}&first_air_date.gte=${from}&first_air_date.lte=${to}`),
        // Shows with an episode out this week, which may be a new season.
        get(`/discover/tv?${base}${shows}&air_date.gte=${from}&air_date.lte=${to}`),
      ]);
      for (const f of [...results(digital.data, "film"), ...results(premiere.data, "film")]) {
        add({ kind: "film", id: f.id, title: f.title, ...(f.date && f.date >= from && f.date <= to ? { date: f.date } : {}), ...(f.poster ? { poster: f.poster } : {}), app: service.app, popularity: f.popularity });
      }
      const newShows = results(started.data, "series").filter((s) => !s.date || (s.date >= from && s.date <= to));
      for (const s of newShows) add({ kind: "series", id: s.id, title: s.title, ...(s.date ? { date: s.date } : {}), ...(s.poster ? { poster: s.poster } : {}), app: service.app, popularity: s.popularity });
      // Of the shows with an episode out, the ones whose season began this
      // week: TMDB's season dates, from each show's own page.
      const ongoing = results(airing.data, "series").filter((s) => !newShows.some((n) => n.id === s.id)).slice(0, SEASON_CHECKS);
      const pages = await Promise.all(ongoing.map((s) => get(`/tv/${s.id}`)));
      ongoing.forEach((s, i) => {
        const page = show(pages[i].data);
        if (!page?.latest) return;
        const season = page.seasons.find((x) => x.season === page.latest!.season);
        if (!season?.date || season.season < 2 || season.date < from || season.date > to) return;
        add({ kind: "series", id: s.id, title: s.title, season: season.season, date: season.date, ...(s.poster ? { poster: s.poster } : {}), app: service.app, popularity: s.popularity });
      });
    }
    if (errors && !titles.size) return { ...this.empty("failed", region, all, error), at: null };
    const sorted = [...titles.values()].sort((a, b) => b.popularity - a.popularity).slice(0, KEEP);
    this.o.log?.(`what's new for ${role === "child" ? "a child's profile" : "an adult's"} in ${region}: ${sorted.length} titles on ${services.length} services${errors ? `, ${errors} of tmdb's answers missing` : ""}`);
    return { ok: true, region, from, to, at: this.now().toISOString(), services: all, titles: sorted };
  }

  // What's new for who's watching: titles on the apps they can open, and
  // only those, or on one app, or of one kind.
  async forViewer(role: Role, apps: string[], only: { app?: string | null; kind?: "film" | "series" | null } = {}): Promise<Feed> {
    const feed = await this.feed(role);
    const theirs = new Set(apps);
    return {
      ...feed,
      services: feed.services.filter((s) => theirs.has(s.app)),
      titles: feed.titles.filter((t) => theirs.has(t.app) && (!only.app || t.app === only.app) && (!only.kind || t.kind === only.kind)),
    };
  }

  // --- New episodes ----------------------------------------------------------------

  // Whether there's a new episode of a show, for who's watching: TMDB's air
  // dates against what the ledger says they watched. With no show named,
  // their newest show in the ledger. A child's only counts when it's on an
  // app they can open, or in their own ledger.
  async episode(query: string | null, rows: WatchRow[], role: Role, apps: string[]): Promise<EpisodeAnswer> {
    if (!this.o.keySet()) return { ok: false, why: "no-key", say: NO_KEY };
    const shows = rows.filter((r) => r.kind === "series" || r.kind === "episode");
    const named = query?.trim() || shows[0]?.title || "";
    if (!named) return { ok: false, why: "which", say: "Which show? Say its name." };
    const searched = await this.o.get(`/search/tv?query=${encodeURIComponent(named).replace(/%20/g, "+")}&include_adult=false`);
    if (!searched.ok) return { ok: false, why: "failed", error: searched.error, say: COULDNT_CHECK };
    const best = results(searched.data, "series")
      .map((s) => ({ s, score: match(s.title, named) }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score || b.s.popularity - a.s.popularity)[0]?.s;
    if (!best) return { ok: false, why: "not-found", say: `Couldn't find a show called ${named}` };
    const watched = shows.find((r) => match(r.title, best.title) === 3 && r.season !== null && r.episode !== null) ?? null;
    if (role === "child" && !shows.some((r) => match(r.title, best.title) === 3) && !(await this.onTheirApps(best.id, apps))) {
      return { ok: false, why: "not-theirs", say: `${best.title} isn't on your apps` };
    }
    const page = await this.o.get(`/tv/${best.id}`);
    const found = page.ok ? show(page.data) : null;
    if (!found) return { ok: false, why: "failed", error: page.error, say: COULDNT_CHECK };
    return answerEpisode(found, watched, this.today());
  }

  // Whether TMDB has a show on one of these apps' services in the region.
  private async onTheirApps(id: number, apps: string[]): Promise<boolean> {
    const region = await this.o.region();
    if (!region) return false;
    const services = (await this.services(region)).services.filter((s) => apps.includes(s.app));
    const ids = new Set(services.flatMap((s) => s.providers.map((p) => p.id)));
    if (!ids.size) return false;
    const where = await this.o.get(`/tv/${id}/watch/providers`);
    const here = ((where.data as { results?: Record<string, Record<string, unknown>> })?.results ?? {})[region] ?? {};
    return ["flatrate", "free", "ads"].some((kind) => (Array.isArray(here[kind]) ? here[kind] : []).some((p: { provider_id?: unknown }) => ids.has(p.provider_id as number)));
  }
}

export const NO_KEY = "Set up New this week in Settings first";
// No service's name in an answer: who was asked is in the log.
const COULDNT_CHECK = "Couldn't check just now";

// The answer, from a show's air dates and the episode they last watched.
export function answerEpisode(found: Show, watched: Pick<WatchRow, "season" | "episode"> | null, today: string): EpisodeAnswer {
  const name = found.name;
  const latest = found.latest && found.latest.date <= today ? found.latest : null;
  const next = found.next && found.next.date >= today ? found.next : null;
  const ended = /^(ended|canceled|cancelled)$/i.test(found.status);
  let yes = false;
  let first: string;
  if (watched && latest && (latest.season > watched.season! || (latest.season === watched.season && latest.episode > watched.episode!))) {
    // The one after theirs: the next in their season, or the next season's
    // first once they've seen the last of theirs.
    const theirs = found.seasons.find((s) => s.season === watched.season);
    const after = theirs && watched.episode! >= theirs.episodes && theirs.episodes > 0 ? { season: watched.season! + 1, episode: 1 } : { season: watched.season!, episode: watched.episode! + 1 };
    yes = true;
    first = `Yes, ${name} ${episodeWords(after)} is out`;
  } else if (watched) {
    first = `No, you've seen the newest ${name}`;
  } else if (latest && daysBetween(latest.date, today) <= WINDOW_DAYS) {
    yes = true;
    first = `Yes, ${name} ${episodeWords(latest)} came out ${spokenDay(latest.date, today)}`;
  } else {
    first = `No new episode of ${name} this week`;
  }
  const then = next ? `The next is ${episodeWords(next)}, ${spokenDay(next.date, today)}` : ended ? "It has ended" : "There's no date for the next one yet";
  return { ok: true, show: found.name, yes, latest, next, ended, say: `${first}. ${then}.` };
}
