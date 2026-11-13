// What's new (ADR-003, ADR-013, S8.1): what appeared on the household's
// services in the last 7 days, from TMDB's discover for setup's region
// (daemon/tmdb.ts). The TV says up to three, newest and most watched first,
// and offers them to choose from, on the TV and the phone. Choosing one
// looks it up in its app and plays it, as "play X on Y" would. Only titles
// on the apps who's watching can open count, so a child's profile hears
// only of theirs.

import type { Item } from "../../apps/contract/contract.ts";
import type { Route } from "../router.ts";
import { NO_KEY, type NewTitle } from "../tmdb.ts";
import type { ExecApp, ExecContext, Outcome } from "./index.ts";

// A title from what's new, as something to choose. Its id says it's TMDB's,
// so choosing it looks it up in its app rather than opening it by the id.
export function newItem(title: NewTitle): Item {
  return {
    id: `tmdb:${title.kind}:${title.id}`,
    kind: title.kind,
    title: title.title,
    ...(title.year ? { year: title.year } : {}),
    ...(title.season ? { season: title.season, subtitle: `season ${title.season}` } : {}),
    ...(title.poster ? { poster: title.poster } : {}),
  };
}

export const fromWhatsNew = (item: Item) => item.id.startsWith("tmdb:");

// "a, b and c", as the TV says a list.
export function listed(words: string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const spoken = (t: NewTitle) => (t.season ? `${t.title}, season ${t.season}` : t.title);

export async function whatsNew(route: Route, ctx: ExecContext, app?: ExecApp): Promise<Outcome> {
  if (!ctx.news) return { kind: "none", why: "soon", say: "Can't show New this week yet" };
  // Films and shows: TMDB knows nothing new about music or games.
  const kind = route.kind === "film" ? "film" : route.kind === "series" ? "series" : null;
  if (route.kind && route.kind !== "video" && !kind) return { kind: "none", why: "not-found", say: "New this week is films and shows only" };
  const feed = await ctx.news.whatsNew({ app: app?.id ?? null, kind });
  if (!feed.ok) {
    if (feed.why === "no-key") return { kind: "none", why: "no-tmdb", say: NO_KEY };
    if (feed.why === "no-region") return { kind: "none", why: "no-tmdb", say: "Pick your location in Settings first" };
    if (feed.why === "no-services") return { kind: "none", why: "not-found", say: `Can't see New this week for your apps in ${feed.region ?? "your location"}` };
    return { kind: "none", why: "failed", say: "Couldn't check just now", ...(feed.error ? { detail: feed.error } : {}) };
  }
  const where = app ? app.name : "your apps";
  if (!feed.titles.length) return { kind: "none", why: "not-found", say: `Nothing new on ${where} this week` };
  const top = feed.titles.slice(0, 3);
  const name = (id: string) => ctx.apps.find((a) => a.id === id)?.name ?? id;
  return {
    kind: "choose",
    say: `New this week: ${listed(top.map(spoken))}`,
    candidates: top.map((t) => ({ app: t.app, name: name(t.app), item: newItem(t) })),
  };
}
