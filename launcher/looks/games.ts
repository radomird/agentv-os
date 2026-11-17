// Games on home in Glass and Cinema (D9): a row named Games right under
// the apps. It holds every app on home whose category is games, so Steam and
// each game made on this TV, in the order they have on home. A game shows
// there and not among the apps, and with no game on home there's no row.
// Terminal has no row: each game is a tile of its own, with "games" in its
// corner.

import type { App } from "../api.ts";
import type { Ctx } from "../main.ts";
import { preview } from "./looks.ts";

// The row's name. Only Glass and Cinema draw it, and both write it as it is.
export const GAMES = "Games";

export function isGame(app: App): boolean {
  return app.category === "games";
}

// What the four desktop launchers (Minecraft, Lutris, Heroic, Battle.net)
// say on their tile (ADR-103), from what their description says after its
// first sentence, as the Games page's line over the list reads it.
export const NEEDS_KEYBOARD = "Needs a mouse and keyboard";
export function needsKeyboard(app: { description?: string }): boolean {
  return /^Needs a mouse and keyboard\.?$/.test((app.description ?? "").split(/(?<=\.)\s+/).slice(1).join(" "));
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
  if (open.game) return "Running";
  return open.paused ? "Paused" : "Open";
}
