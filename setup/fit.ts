// Setup's Fit to screen (ADR-103), a page of the look step right after the
// size, in Terminal's style as all of setup is: the four corner marks, the
// picture's size, and the tip for a TV that can show the whole picture
// itself. Left and right change it, and the TV takes each step at once.
// Continue goes on to the theme. With the sizes off there's no margin, and
// the look step goes straight on. The marks and the stepper are
// launcher/fit.ts, which Settings, Appearance uses too.

import { h } from "../launcher/dom.ts";
import { FIT_HEADLINE, FIT_TIP, fitParts } from "../launcher/fit.ts";
import { loadSizes, MARGIN, setMargin } from "../launcher/size.ts";
import { NEEDS_PIN } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

// Setup draws on 1920 by 1080, zoomed to the screen (launcher/dom.ts).
const CANVAS = { width: 1920, height: 1080 };

export async function fitStep(ctx: Ctx): Promise<View> {
  const display = await loadSizes();
  const parts = fitParts({
    margin: display?.margin ?? MARGIN,
    canvas: CANVAS,
    save: async (margin) => {
      const asked = await ctx
        .guarded("the size", async (grant) => {
          const answer = await setMargin(margin, grant);
          if (answer.error?.toLowerCase() === NEEDS_PIN) throw new Error(NEEDS_PIN);
          return answer;
        })
        .catch((error: Error) => ({ value: { error: error.message } as Awaited<ReturnType<typeof setMargin>> }));
      return asked?.value ?? { error: "Couldn't change the picture size" };
    },
    failed: (error) => {
      ctx.sounds.play("failure");
      ctx.toast(error, "fail");
    },
    moved: () => ctx.focus.refresh(),
  });
  const next = () => {
    ctx.sounds.play("confirm");
    void ctx.finish("look");
  };
  const go = h("button", { class: "button", "data-focus": true, "data-action": "continue", onclick: next }, "Continue");
  parts.size.addEventListener("click", next);
  const el = h(
    "div",
    { class: "setup-page d3 setup-fit" },
    parts.marks,
    h("div", { class: "setup-top" }, h("div", {}, ...heading("tv fit", FIT_HEADLINE, ctx.reduced()))),
    h("p", { class: "setup-line" }, FIT_TIP),
    h("div", { class: "fit-controls" }, parts.size, go),
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
