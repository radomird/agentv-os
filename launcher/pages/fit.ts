// Fit to screen in Settings, Appearance (ADR-103): its own page, over the
// whole screen so the corner marks sit where the margin puts them, in the
// look home has. Left and right change the picture's size, which the TV
// takes at once; OK or Done goes back to Appearance. The marks and the
// stepper are launcher/fit.ts, which setup uses too.

import { h } from "../dom.ts";
import { FIT_HEADLINE, FIT_TIP, fitParts } from "../fit.ts";
import { canvas } from "../looks/looks.ts";
import { MARGIN, setMargin, sizes } from "../size.ts";
import type { Ctx, View } from "../main.ts";
import { heading } from "./parts.ts";

export function fitPage(ctx: Ctx): View {
  const parts = fitParts({
    margin: sizes()?.margin ?? MARGIN,
    canvas: canvas(),
    save: (margin) => setMargin(margin, ctx.held()),
    failed: (error) => {
      ctx.sounds.play("failure");
      ctx.toast(error, "fail");
    },
    moved: () => ctx.focus.refresh(),
  });
  const done = h("button", { class: "button", "data-focus": true, "data-action": "fit-done", onclick: () => ctx.back() }, "Done");
  parts.size.addEventListener("click", () => ctx.back());
  const el = h(
    "div",
    { class: "screen fit-screen" },
    parts.marks,
    h("div", { class: "page fit" }, ...heading("tv fit", FIT_HEADLINE), h("div", { class: "panel-note fit-tip" }, FIT_TIP), h("div", { class: "fit-controls" }, parts.size, done)),
  );
  return {
    el,
    first: parts.size,
    act(action) {
      if ((action === "left" || action === "right") && ctx.focus.get() === parts.size) {
        if (parts.step(action === "right" ? 1 : -1)) ctx.sounds.play("move");
        else ctx.sounds.play("failure");
        return true;
      }
      return false;
    },
  };
}
