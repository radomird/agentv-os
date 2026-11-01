// The screen daemon's side of a sentence said to the TV (daemon/say.ts):
// it looks X up in the apps who's watching can open, each in its own
// worker, and opens what was chosen, as the person, in the TV session.
// Music looks in the person's own library. A web app that's open behind
// home looks with its page; one that isn't looks without one, and an app
// whose search needs its page says so instead of answering.

import type { Item } from "../apps/contract/contract.ts";
import { validatePackage, type Tier } from "../apps/contract/manifest.ts";
import { AppHost, type PageBroker } from "./apps/loader.ts";
import { MUSIC } from "./music.ts";
import type { SayAnswer, SayAsk } from "./say.ts";

export interface SayScreen {
  open(app: string, item?: Item): Promise<{ ok?: boolean; error?: string }>;
  tell(text: string): Promise<{ ok?: boolean; error?: string }>;
  page(app: string): PageBroker | undefined;
}

export interface SayDeps {
  screen: SayScreen;
  music?: { handle(request: Record<string, unknown>): Promise<object> };
  host: (id: string) => Promise<AppHost | null>; // an app with search, from its package
  log?: (line: string) => void;
}

// How many of each app's finds count.
const ITEMS = 10;

async function searchOne(app: string, ask: Extract<SayAsk, { kind: "search" }>, deps: SayDeps): Promise<{ app: string; items: Item[]; error?: string }> {
  try {
    if (app === MUSIC) {
      if (!deps.music) return { app, items: [], error: "music isn't here" };
      const said = (await deps.music.handle({ op: "search", q: ask.query })) as { ok?: boolean; error?: string; results?: { kind: Item["kind"]; id: string; title: string; subtitle: string; away?: boolean }[] };
      if (!said.ok) return { app, items: [], error: said.error ?? "music didn't look" };
      // What's on a share that isn't there right now can't play.
      const items = (said.results ?? []).filter((r) => !r.away).map((r) => ({ id: r.id, kind: r.kind, title: r.title, subtitle: r.subtitle }));
      return { app, items: items.slice(0, ITEMS) };
    }
    const host = await deps.host(app);
    if (!host) return { app, items: [], error: "it can't look things up" };
    host.setPage(deps.screen.page(app));
    try {
      // The worker's own time limit for search, 10 s, holds it.
      const items = await host.call<Item[]>(ask.viewer, "search", ask.query);
      return { app, items: Array.isArray(items) ? items.slice(0, ITEMS) : [] };
    } finally {
      host.stop();
    }
  } catch (error) {
    deps.log?.(`${app} couldn't look something up: ${(error as Error).message}`);
    return { app, items: [], error: (error as Error).message.slice(0, 120) };
  }
}

export async function answerSay(ask: SayAsk, deps: SayDeps): Promise<SayAnswer> {
  if (ask.kind === "tell") {
    const told = await deps.screen.tell(ask.text.slice(0, 200));
    return { ok: told.ok === true, ...(told.error ? { error: told.error } : {}) };
  }
  if (ask.kind === "search") {
    const found = await Promise.all(ask.apps.map((app) => searchOne(app, ask, deps)));
    return { ok: true, found };
  }
  // Music plays what was found, by its key, or by its name for a row of
  // the ledger, and then shows its page.
  if (ask.app === MUSIC) {
    if (!deps.music) return { ok: false, error: "music isn't here" };
    const item = ask.item;
    if (item) {
      const byName = item.id.startsWith("ledger:");
      const played = (await deps.music.handle(byName ? { op: "play", q: item.title, kind: item.kind } : { op: "play", kind: item.kind, key: item.id })) as { ok?: boolean; error?: string };
      if (!played.ok) return { ok: false, error: played.error ?? "music didn't play it" };
    }
  }
  const opened = await deps.screen.open(ask.app, ask.item);
  return opened.ok ? { ok: true } : { ok: false, error: opened.error ?? "it didn't open" };
}

// An installed app with search, from its package as AgenTV's daemon
// describes it.
export function sayHosts(home: string, userAgent: string, log: (line: string) => void): (id: string) => Promise<AppHost | null> {
  return async (id) => {
    const response = await fetch(`${home}api/apps/${encodeURIComponent(id)}/package`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    const found = response?.ok ? ((await response.json()) as { dir?: string; tier?: string; settings?: Record<string, string> }) : null;
    if (!found?.dir) return null;
    const tier = (found.tier === "built-in" ? "official" : found.tier) as Tier;
    const { manifest } = validatePackage(found.dir, tier);
    if (!manifest?.tv.capabilities.includes("search")) return null;
    return new AppHost({ dir: found.dir, manifest, settings: found.settings ?? {}, userAgent, log });
  };
}
