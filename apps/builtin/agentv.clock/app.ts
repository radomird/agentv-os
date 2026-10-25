// AgenTV's built-in Clock app (ADR-015, ADR-016): the time, and in its medium
// size the date and the city of the box's time zone. The launcher keeps the
// time ticking on its own, since a tile refreshes at most every 5 minutes;
// this only says what goes around it.

import type { AppContext, Tile, TileSize, TvApp } from "../../contract/contract.ts";

const app: TvApp = {
  id: "agentv.clock",

  // The launcher opens a built-in itself: the clock opens the ambient screen.
  async launch() {},

  async tile(ctx: AppContext, size: TileSize): Promise<Tile> {
    const place = ctx.settings.place || "";
    return { headline: { label: size === "m" ? place : "" }, refreshMins: 60 };
  },
};

export default app;
