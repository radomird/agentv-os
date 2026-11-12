// The bar in each look (ADR-063, D1): Terminal's along the bottom, Glass's
// in a glass pill and Cinema's along the top. Every page draws it through
// pages/parts.ts, so every page has the look's own.

import type { Ctx } from "../main.ts";
import { lookId } from "./looks.ts";
import { bar as cinema } from "./cinema/bar.ts";
import { bar as glass } from "./glass/bar.ts";
import { bar as terminal } from "./terminal/bar.ts";

export function lookBar(ctx: Ctx, mode: string, info = "", step?: (HTMLElement | string)[], hint = ""): HTMLElement {
  switch (lookId()) {
    case "glass":
      return glass(ctx, mode, info, step, hint);
    case "cinema":
      return cinema(ctx, mode, info, step, hint);
    default:
      return terminal(ctx, mode, info, step, hint);
  }
}
