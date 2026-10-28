// A streaming service's app, built on this box by its agent from AgenTV's
// streaming recipe (ADR-011, ADR-046). What the service's pages look like
// lives here and nowhere else, and it stays on this box. The daemon loads it
// in a worker of its own, with one page in the TV's browser, on its declared
// origins only.

import type { AppContext, TvApp } from "../../apps/contract/contract.ts";

const HOME = "https://service.example/";

const app: TvApp = {
  id: "local.service",

  async launch(ctx: AppContext) {
    await ctx.page?.goto(HOME);
  },

  signIn: {
    // Signed in when the page shows what only a signed-in page has. Fill
    // in what this service's pages show.
    async isSignedIn(ctx: AppContext) {
      const page = ctx.page;
      if (!page) return false;
      return Boolean(await page.evaluate(() => false).catch(() => false));
    },
    async open(ctx: AppContext) {
      await ctx.page?.goto(HOME);
    },
  },
};

export default app;
