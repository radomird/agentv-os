// Games on home in Glass and Cinema (D9): a row named Games right under
// the apps. It holds every app on home whose category is games, so Steam and
// each game made on this TV, in the order they have on home. A game shows
// there and not among the apps, and with no game on home there's no row.
// Terminal has no row: each game is a tile of its own, with "games" in its
// corner.

import type { App } from "../api.ts";
import type { Ctx } from "../main.ts";
import { preview, said } from "./looks.ts";

// The row's name. Only Glass and Cinema draw it, and both write it as it is.
export const GAMES = "Games";

export function isGame(app: App): boolean {
  return app.category === "games";
}

// Home's apps in two rows: the apps, and the games. Each keeps its order.
export function shelves(all: App[]): { apps: App[]; games: App[] } {
  return { apps: all.filter((app) => !isGame(app)), games: all.filter(isGame) };
}

// What an app that's open behind home says: a game that's running says so,
// and anything else says open or paused. Nothing when it isn't open, and
// nothing in a look's preview, which shows each app as it is once set up.
export function openWords(ctx: Ctx, app: App): string {
  if (preview()) return "";
  const open = ctx.running.get(app.id);
  if (!open) return "";
  if (open.game) return said("running");
  return said(open.paused ? "paused" : "open");
}
