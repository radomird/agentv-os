// The screen daemon's side of a sentence said to the TV (daemon/say.ts):
// it looks X up in the apps who's watching can open, each in its own
// worker, and opens what was chosen, as the person, in the TV session.
// Music looks in the person's own library. A web app that's open behind
// home looks with its page; one that isn't looks without one. An app asked
// alone, one that was named or a title from New this week, whose search
// needs its page opens first, the way its tile opens it, and looks once its
// page is there. It stays open, so when nothing matches, the person is left
// on the app's own search for it.
//
// A title chosen on New this week opens on its own page in its app, through
// the app's playback.show, opening the app first and waiting for its page.

import type { Item } from "../apps/contract/contract.ts";
import { validatePackage, type Tier } from "../apps/contract/manifest.ts";
import { AppError, AppHost, type PageBroker } from "./apps/loader.ts";
import type { Found } from "./executors/play.ts";
import { MUSIC } from "./music.ts";
import type { LiveState, SayAnswer, SayAsk } from "./say.ts";

export interface SayScreen {
  open(app: string, item?: Item): Promise<{ ok?: boolean; error?: string }>;
  tell(text: string): Promise<{ ok?: boolean; error?: string }>;
  live(state: LiveState, text: string): Promise<{ ok?: boolean; error?: string }>;
  speak(clip: number): Promise<{ ok?: boolean; error?: string }>;
  page(app: string): PageBroker | undefined;
  // An app that's just been opened: its page once it has loaded and the
  // service's profile for who's watching is settled, or undefined if it
  // doesn't come in time.
  ready(app: string): Promise<PageBroker | undefined>;
}

export interface SayDeps {
  screen: SayScreen;
  music?: { handle(request: Record<string, unknown>): Promise<object> };
  // An app with search, or with playback for a show ask, from its package.
  host: (id: string, need?: "search" | "playback") => Promise<AppHost | null>;
  log?: (line: string) => void;
}

// How many of each app's finds count.
const ITEMS = 10;

async function searchOne(app: string, ask: Extract<SayAsk, { kind: "search" }>, deps: SayDeps): Promise<Found> {
  try {
    if (app === MUSIC) {
      if (!deps.music) return { app, items: [], error: "Music isn't available" };
      const said = (await deps.music.handle({ op: "search", q: ask.query })) as { ok?: boolean; error?: string; results?: { kind: Item["kind"]; id: string; title: string; subtitle: string; away?: boolean }[] };
      if (!said.ok) return { app, items: [], error: said.error ?? "Couldn't search" };
      // What's on a share that isn't there right now can't play.
      const items = (said.results ?? []).filter((r) => !r.away).map((r) => ({ id: r.id, kind: r.kind, title: r.title, subtitle: r.subtitle }));
      return { app, items: items.slice(0, ITEMS) };
    }
    const host = await deps.host(app);
    if (!host) return { app, items: [], error: "it can't look things up" };
    const page = deps.screen.page(app);
    host.setPage(page);
    try {
      // The worker's own time limit for search, 10 s, holds it.
      const search = async () => {
        const items = await host.call<Item[]>(ask.viewer, "search", ask.query);
        return Array.isArray(items) ? items.slice(0, ITEMS) : [];
      };
      try {
        return { app, items: await search() };
      } catch (error) {
        // The app's own search said no, with no page to look with: its
        // search needs its page. Asked alone, it opens and looks again.
        const alone = ask.apps.length === 1 && host.manifest.tv.runtime === "web";
        if (page || !alone || !(error instanceof AppError) || error.kind !== "failed") throw error;
        deps.log?.(`${app} couldn't look without its page (${error.message}), so it opens first`);
        const opened = await deps.screen.open(app);
        if (!opened.ok) throw error;
        const ready = await deps.screen.ready(app);
        if (!ready) throw error;
        host.setPage(ready);
        try {
          return { app, items: await search(), opened: true };
        } catch (again) {
          deps.log?.(`${app} couldn't look something up with its page: ${(again as Error).message}`);
          return { app, items: [], error: (again as Error).message.slice(0, 120), opened: true };
        }
      }
    } finally {
      host.stop();
    }
  } catch (error) {
    deps.log?.(`${app} couldn't look something up: ${(error as Error).message}`);
    return { app, items: [], error: (error as Error).message.slice(0, 120) };
  }
}

// A title's own page in its app, without playing it (ADR-097): the app
// opens, or comes in front, and once its page is there, its playback.show
// finds the title. An app with no playback.show says so, and the daemon
// plays the title the way "play it on that app" would.
async function showTitle(ask: Extract<SayAsk, { kind: "show" }>, deps: SayDeps): Promise<SayAnswer> {
  const host = await deps.host(ask.app, "playback").catch(() => null);
  if (!host) return { ok: true, shown: "unsupported" };
  try {
    if (!(await host.has("playback.show"))) return { ok: true, shown: "unsupported" };
    const opened = await deps.screen.open(ask.app);
    if (!opened.ok) return { ok: false, error: opened.error ?? "it didn't open" };
    if (host.manifest.tv.runtime === "web") {
      const page = await deps.screen.ready(ask.app);
      if (!page) return { ok: false, error: "its page didn't load in time" };
      host.setPage(page);
    }
    const found = await host.call<boolean>(ask.viewer, "playback.show", ask.item);
    return { ok: true, shown: found === true ? "title" : "search" };
  } catch (error) {
    deps.log?.(`${ask.app} couldn't show a title's page: ${(error as Error).message}`);
    return { ok: false, error: (error as Error).message.slice(0, 120) };
  } finally {
    host.stop();
  }
}

export async function answerSay(ask: SayAsk, deps: SayDeps): Promise<SayAnswer> {
  if (ask.kind === "live") {
    const shown = await deps.screen.live(ask.state, ask.text.slice(0, 300));
    return { ok: shown.ok === true, ...(shown.error ? { error: shown.error } : {}) };
  }
  // What came of a sentence, said aloud (stage 8).
  if (ask.kind === "speak") {
    const played = await deps.screen.speak(ask.clip);
    return { ok: played.ok === true, ...(played.error ? { error: played.error } : {}) };
  }
  if (ask.kind === "tell") {
    const told = await deps.screen.tell(ask.text.slice(0, 200));
    return { ok: told.ok === true, ...(told.error ? { error: told.error } : {}) };
  }
  if (ask.kind === "search") {
    const found = await Promise.all(ask.apps.map((app) => searchOne(app, ask, deps)));
    return { ok: true, found };
  }
  if (ask.kind === "show") return showTitle(ask, deps);
  // Music plays what was found, by its key, or by its name for a row of
  // the ledger, and then shows its page.
  if (ask.app === MUSIC) {
    if (!deps.music) return { ok: false, error: "Music isn't available" };
    const item = ask.item;
    if (item) {
      const byName = item.id.startsWith("ledger:");
      const played = (await deps.music.handle(byName ? { op: "play", q: item.title, kind: item.kind } : { op: "play", kind: item.kind, key: item.id })) as { ok?: boolean; error?: string };
      if (!played.ok) return { ok: false, error: played.error ?? "Couldn't play that" };
    }
  }
  const opened = await deps.screen.open(ask.app, ask.item);
  return opened.ok ? { ok: true } : { ok: false, error: opened.error ?? "it didn't open" };
}

// An installed app with search, or with playback for a title's own page,
// from its package as AgenTV's daemon describes it.
export function sayHosts(home: string, userAgent: string, log: (line: string) => void): SayDeps["host"] {
  return async (id, need = "search") => {
    const response = await fetch(`${home}api/apps/${encodeURIComponent(id)}/package`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    const found = response?.ok ? ((await response.json()) as { dir?: string; tier?: string; settings?: Record<string, string>; thisBox?: boolean }) : null;
    if (!found?.dir) return null;
    const tier = (found.tier === "built-in" ? "official" : found.tier) as Tier;
    const { manifest } = validatePackage(found.dir, tier, { thisBox: found.thisBox === true });
    if (!manifest?.tv.capabilities.includes(need)) return null;
    return new AppHost({ dir: found.dir, manifest, settings: found.settings ?? {}, userAgent, log, harness: { thisBox: found.thisBox === true } });
  };
}
