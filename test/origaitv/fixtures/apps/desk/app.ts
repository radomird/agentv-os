// A web app made for a desktop, for OrigaiTV's tests of the phone's d-pad
// (ADR-008): it only opens its site. The site has no arrow keys of its own,
// so its contract checks press the d-pad the way the TV's remote does. Its
// one hint for the d-pad (ADR-103) is the slider on its rows page, which
// moves by its own buttons.

import type { AppContext, TvApp } from "../../../../../apps/contract/contract.ts";

const app: TvApp = {
  id: "origaitv.desk",

  navigation: [{ url: "/rows\\.html$", rows: [{ row: ".slider", next: ".next", previous: ".previous" }] }],

  async launch(ctx: AppContext) {
    if (!ctx.page) throw new Error("no page");
    await ctx.page.goto("https://desk.test/desktop.html");
  },
};

export default app;
