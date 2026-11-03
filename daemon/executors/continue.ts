// Continue (ADR-003): the ledger's newest row for who's watching, or the
// newest of the title they named, in an app they can still open, opened
// where it got to. An episode watched to its end goes on to the next one;
// anything else opens where it was, and the app's own resume takes it from
// there. The ledger only knows what the box itself launched (Q3).

import type { Item, ItemKind } from "../../apps/contract/contract.ts";
import type { WatchRow } from "../ledger.ts";
import type { Route } from "../router.ts";
import { KIND_ITEMS, match } from "./play.ts";

// Watched to the end: within a minute of it, or 95% of the way.
export function finished(row: WatchRow): boolean {
  if (row.position_s === null || row.duration_s === null || row.duration_s <= 0) return false;
  return row.position_s >= row.duration_s - 60 || row.position_s / row.duration_s >= 0.95;
}

// The row to continue, from the newest first.
export function toContinue(rows: WatchRow[], route: Route, apps: Set<string>): WatchRow | null {
  const kinds: ItemKind[] | null = route.kind ? KIND_ITEMS[route.kind] : null;
  return (
    rows.find((row) => {
      if (!apps.has(row.app_id)) return false;
      if (route.app && row.app_id !== route.app) return false;
      if (kinds && !kinds.includes(row.kind)) return false;
      return !route.query || match(row.title, route.query) >= 2;
    }) ?? null
  );
}

// What the app opens: the same episode, or the next once it was watched.
export function continueItem(row: WatchRow): Item {
  const next = row.episode !== null && finished(row);
  return {
    id: `ledger:${row.id}`,
    kind: row.kind,
    title: row.title,
    ...(row.season !== null ? { season: row.season } : {}),
    ...(row.episode !== null ? { episode: next ? row.episode + 1 : row.episode } : {}),
  };
}
