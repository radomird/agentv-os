// AgenTV's built-in New this week (stage 8, S8.1): home's top rail for
// streaming, what came out this week on the household's services. The
// daemon draws its tile itself, from TMDB through the router's service
// (daemon/tmdb.ts), since the household's TMDB key is root's and no app's
// worker may reach it. This only stands in for the tile until then.

import type { Tile, TileSize, TvApp } from "../../contract/contract.ts";

const app: TvApp = {
  id: "agentv.new",

  // The launcher opens a built-in itself: this one opens Settings → new this
  // week.
  async launch() {},

  async tile(_ctx, size: TileSize): Promise<Tile> {
    return { headline: { label: size === "s" ? "" : "New this week" }, refreshMins: 180 };
  },
};

export default app;
