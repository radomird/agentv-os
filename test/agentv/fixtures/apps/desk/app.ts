// A web app made for a desktop, for AgenTV's tests of the phone's d-pad
// (ADR-008): it only opens its site. The site has no arrow keys of its own,
// so its contract checks press the d-pad the way the TV's remote does.

import type { AppContext, TvApp } from "../../../../../apps/contract/contract.ts";

const app: TvApp = {
  id: "agentv.desk",

  async launch(ctx: AppContext) {
    if (!ctx.page) throw new Error("no page");
    await ctx.page.goto("https://desk.test/desktop.html");
  },
};

export default app;
