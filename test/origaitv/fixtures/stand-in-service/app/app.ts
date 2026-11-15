// The app the agent would write for the stand-in service in stage A, from
// the streaming recipe's template.

import type { AppContext, TvApp } from "../../../../../apps/contract/contract.ts";

const HOME = "https://stand-in.test/";

const app: TvApp = {
  id: "local.stand-in",

  async launch(ctx: AppContext) {
    await ctx.page?.goto(HOME);
  },

  signIn: {
    // Signed in when the page has the profile menu, which only a signed-in
    // page shows.
    async isSignedIn(ctx: AppContext) {
      const page = ctx.page;
      if (!page) return false;
      return Boolean(await page.evaluate(() => document.querySelector('[data-testid="profile-menu"]') !== null));
    },
    async open(ctx: AppContext) {
      await ctx.page?.goto(`${HOME}signin`);
    },
  },
};

export default app;
