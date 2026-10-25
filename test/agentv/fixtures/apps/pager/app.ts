// A web app for AgenTV's tests that does its work in its page, the way a
// streaming service's app does: whether it's signed in, from the site's own
// cookie, and its sign-in form; playback read from the page's player and
// title, a title opened with the site's own search, and an attempt to take
// its page somewhere it may not go.

import type { AppContext, Item, PlaybackState, TvApp } from "../../../../../apps/contract/contract.ts";

function page(ctx: AppContext) {
  if (!ctx.page) throw new Error("no page");
  return ctx.page;
}

const app: TvApp = {
  id: "agentv.pager",

  async launch(ctx: AppContext) {
    await page(ctx).goto(`${ctx.settings.serverUrl}/`);
  },

  signIn: {
    async isSignedIn(ctx: AppContext) {
      const p = page(ctx);
      if (!p.url().startsWith(ctx.settings.serverUrl)) return false;
      return p.evaluate(() => document.cookie.split("; ").includes("signed=in"));
    },
    async open(ctx: AppContext) {
      await page(ctx).goto(`${ctx.settings.serverUrl}/login.html`);
    },
  },

  // Sends its page to another site, which the loader refuses.
  async search(ctx: AppContext, query: string): Promise<Item[]> {
    await page(ctx).goto(`https://elsewhere.invalid/?q=${encodeURIComponent(query)}`);
    return [];
  },

  playback: {
    async open(ctx: AppContext, item: Item) {
      const p = page(ctx);
      await p.goto(`${ctx.settings.serverUrl}/search.html`);
      await p.waitForSelector("#q", { timeout: 5000 });
      await p.fill("#q", item.title);
      await p.press("#q", "Enter");
      await p.click("#play");
    },
    async readPlaybackState(ctx: AppContext): Promise<PlaybackState | null> {
      const p = page(ctx);
      if (!p.url().startsWith(ctx.settings.serverUrl)) return null;
      return p.evaluate((suffix: string) => {
        const player = document.querySelector<HTMLElement>("#player");
        if (!player) return null;
        const [, title, season, episode] = /^(.*) · S(\d+) E(\d+)$/.exec(document.title) ?? [];
        return {
          title: `${title}${suffix}`,
          season: Number(season),
          episode: Number(episode),
          position: Number(player.dataset.position),
          duration: Number(player.dataset.duration),
          playing: player.dataset.playing === "yes",
        };
      }, "");
    },
  },
};

export default app;
