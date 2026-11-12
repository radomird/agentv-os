// Settings → About → your setup (ADR-061): the same lines as setup's box
// step, above AgenTV's version and credits. On a 4K TV, "Check 4K again" runs
// the 4K test in front of everything for five seconds, as after a new GPU.

import { box, boxStyles, checkSmooth, drawsFourK } from "../box.ts";
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
        if (!drawsFourK()) {
          ctx.toast("Your TV isn't in 4K right now", "fail");
          return;
        }
        const state = await checkSmooth({ host: document.body, front: "Checking 4K…" });
        if (!state) {
          ctx.toast("Couldn't check 4K", "fail");
          return;
        }
        ctx.toast(state.passed ? "4K plays smoothly here" : "4K stutters here. 1080p looks better.", state.passed ? "ok" : undefined);
        await fill(ctx, el);
      },
    },
    check?.result ? "Check 4K again" : "Check 4K",
  );
  el.replaceChildren(h("div", { class: "panel-title" }, `Your setup${report.model ? ` · ${report.model}` : ""}`), rows, ...(report.verdicts.fourK ? [again] : []));
  ctx.focus.refresh();
}

export function aboutBox(ctx: Ctx): HTMLElement {
  boxStyles();
  const el = h("div", { class: "box-about" });
  void fill(ctx, el).catch(() => {});
  return el;
}
