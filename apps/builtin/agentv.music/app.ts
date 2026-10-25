// AgenTV's built-in Music app (ADR-017). Its library and its player live in
// the TV session, as the person the box logs in, since they read files a
// sandboxed app can't: daemon/music.ts and daemon/storage.ts. The launcher
// opens its page and draws its tiles from there; this module is what the
// app contract asks of every app.

import type { Tile, TvApp } from "../../contract/contract.ts";

const app: TvApp = {
  id: "agentv.music",

  // The launcher opens a built-in itself: Music's page.
  async launch() {},

  // The launcher draws what's playing from the TV session's player.
  async tile(): Promise<Tile> {
    return { refreshMins: 60 };
  },
};

export default app;
