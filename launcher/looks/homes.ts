// Home in each look (ADR-063). Each look draws its own from the profile's
// one layout: Terminal uses its places, Glass and Cinema its order and its
// sizes as hints.

import type { Ctx, View } from "../main.ts";
import { lookId } from "./looks.ts";
import { home as terminal } from "./terminal/home.ts";

export function lookHome(ctx: Ctx): View {
  switch (lookId()) {
    default:
      return terminal(ctx);
  }
}
