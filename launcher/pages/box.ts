// Settings → About → this box (ADR-061): the same lines as setup's box step,
// above AgenTV's version and credits. On a 4K TV, "check 4k again" runs the
// 4K test in front of everything for five seconds, as after a new GPU.

import { box, boxStyles, checkSmooth } from "../box.ts";
import { boxLines, type SmoothState } from "../box-lines.ts";
import { h } from "../dom.ts";
import type { Ctx } from "../main.ts";

async function fill(ctx: Ctx, el: HTMLElement): Promise<void> {
  if (!(await box.on())) return;
  const [report, check] = await Promise.all([box.report(), box.smooth().catch(() => null)]);
  const smooth: SmoothState = check?.passed ? "passed" : check?.result ? "failed" : "unchecked";
  const rows = h(
    "div",
    { class: "box-rows" },
    ...boxLines(report, smooth).map((line) => h("div", { class: "box-row", "data-row": line.key }, h("span", { class: "box-label" }, line.label), h("span", { class: "box-value" }, line.value))),
  );
  const again = h(
    "button",
    {
      class: "button",
      "data-focus": true,
      "data-action": "box-check",
      onclick: async () => {
        const state = await checkSmooth({ host: document.body, front: "checking 4k…" });
        if (!state) {
          ctx.toast("the 4k test didn't finish", "fail");
          return;
        }
        ctx.toast(state.passed ? "4k stays smooth on this box" : "4k isn't smooth here, so 1080p is the better pick", state.passed ? "ok" : undefined);
        await fill(ctx, el);
      },
    },
    check?.result ? "check 4k again" : "check 4k",
  );
  el.replaceChildren(h("div", { class: "panel-title" }, `this box${report.model ? ` · ${report.model.toLowerCase()}` : ""}`), rows, ...(report.verdicts.fourK ? [again] : []));
  ctx.focus.refresh();
}

export function aboutBox(ctx: Ctx): HTMLElement {
  boxStyles();
  const el = h("div", { class: "box-about" });
  void fill(ctx, el).catch(() => {});
  return el;
}
