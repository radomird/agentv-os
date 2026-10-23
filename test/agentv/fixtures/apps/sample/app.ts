// A sample app for AgenTV's tests: a web app on a server the person names in
// setup. It answers from fixed data, so the tests need no server.

import type { AppContext, Item, TileSize, Tile, TvApp } from "../../../../../apps/contract/contract.ts";
import { library } from "./library.ts";

const app: TvApp = {
  id: "agentv.sample",

  async launch(ctx: AppContext) {
    await ctx.page?.goto(`${ctx.settings.serverUrl}/web/`);
  },

  signIn: {
    async isSignedIn() {
      return true;
    },
  },

  async search(_ctx: AppContext, query: string): Promise<Item[]> {
    const words = query.toLowerCase();
    return library.filter((item) => item.title.toLowerCase().includes(words));
  },

  playback: {
    async open() {},
    async readPlaybackState() {
      return null;
    },
  },

  async tile(_ctx: AppContext, size: TileSize): Promise<Tile> {
    const entries = library.map((item) => ({ label: item.title, item }));
    return size === "s" ? {} : { headline: entries[0], entries: entries.slice(1) };
  },
};

export default app;
