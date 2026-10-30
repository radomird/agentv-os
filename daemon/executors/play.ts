// Play X (ADR-013): what every app with search found for X, ranked, and
// either one clear best to open or up to three to choose from. An app the
// person named is the only one asked. A kind they said keeps only things
// of that kind, so "the Frozen soundtrack" is never the film. One clear
// best is a title that matches exactly and nothing else does as well; a
// closer look is never a guess, so anything less is offered to choose.

import type { Item, ItemKind } from "../../apps/contract/contract.ts";
import type { Kind, Route } from "../router.ts";

// What one app's search found, or why it couldn't.
export interface Found {
  app: string;
  items: Item[];
  error?: string;
}

// The contract's kinds each of the router's kinds takes.
export const KIND_ITEMS: Record<Kind, ItemKind[]> = {
  film: ["film"],
  series: ["series", "episode"],
  video: ["film", "series", "episode"],
  track: ["track"],
  album: ["album"],
  playlist: ["playlist"],
  artist: ["album", "track", "playlist"],
  music: ["track", "album", "playlist"],
  "photo-album": ["photo-album"],
  game: ["game"],
};

const MUSIC: ItemKind[] = ["track", "album", "playlist"];

// Words as two people would agree they're the same: case, accents and
// punctuation aside.
export function words(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const bare = (text: string) => text.replace(/^the /, "");

// How well a title matches what was said: 3 the same, 2 it starts with it
// ("Frozen II" for "Frozen"), 1 it has every word, 0 not at all.
export function match(title: string, query: string): number {
  const t = bare(words(title));
  const q = bare(words(query));
  if (!t || !q) return 0;
  if (t === q) return 3;
  if (t.startsWith(`${q} `)) return 2;
  return q.split(" ").every((word) => ` ${t} `.includes(` ${word} `)) ? 1 : 0;
}

export interface Ranked {
  app: string;
  item: Item;
  score: number;
  // It matched by who made it, such as an artist's album, not by its title.
  byWho: boolean;
}

// Who made a music item, as Music gives it: "Radiohead · OK Computer".
const who = (item: Item) => (item.subtitle ?? "").split(" · ")[0] ?? "";

// Everything that matches, best first, apps in the order they were asked.
export function rank(found: Found[], route: Route): Ranked[] {
  const query = route.query ?? "";
  const numbered = route.season !== null || route.episode !== null;
  const allowed = numbered ? KIND_ITEMS.series : route.kind ? KIND_ITEMS[route.kind] : null;
  const ranked: Ranked[] = [];
  for (const { app, items } of found) {
    for (const item of items) {
      if (allowed && !allowed.includes(item.kind)) continue;
      const byTitle = match(item.title, query);
      const byArtist = MUSIC.includes(item.kind) && (route.kind === null || route.kind === "artist" || route.kind === "music") ? match(who(item), query) : 0;
      const score = Math.max(byTitle, byArtist);
      if (score > 0) ranked.push({ app, item, score, byWho: byArtist > byTitle });
    }
  }
  return ranked.sort((a, b) => b.score - a.score);
}

export type Pick = { one: Ranked } | { some: Ranked[] } | { none: true };

// One to open, some to choose from, or nothing.
export function pick(ranked: Ranked[]): Pick {
  if (!ranked.length) return { none: true };
  const top = ranked.filter((r) => r.score === ranked[0].score);
  if (ranked[0].score === 3 && top.length === 1) return { one: top[0] };
  // Music by one artist, asked for by the artist's name: any of it will do.
  if (ranked[0].score === 3 && top.every((r) => r.byWho) && new Set(top.map((r) => words(who(r.item)))).size === 1) return { one: top[0] };
  // With exact matches, only those; else the closest. The same thing
  // twice in one app, as a search can give, once.
  const pool = ranked[0].score === 3 ? top : ranked;
  const seen = new Set<string>();
  const some = pool.filter((r) => {
    const key = `${r.app}\n${r.item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { some: some.slice(0, 3) };
}

// The item to open: with the season and episode that were said, if any.
export function toOpen(item: Item, route: Route): Item {
  if (route.season === null && route.episode === null) return item;
  return { ...item, ...(route.season !== null ? { season: route.season } : {}), ...(route.episode !== null ? { episode: route.episode } : {}) };
}
