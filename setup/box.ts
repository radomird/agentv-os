// Your box (ADR-061, D3's "4 Your box"): right after getting ready, what the
// box is, a line a finding, read from the couch, and OK carries on. Setup
// uses it from here on. On a 4K TV the 4K test runs while the screen is up,
// drawn faintly behind the lines, and the box line says how it went. OK
// before it's done stops it, and the box counts as not checked yet.

import { box, boxStyles, checkSmooth, type BoxReport } from "../launcher/box.ts";
import { boxLines, type SmoothState } from "../launcher/box-lines.ts";
import { h } from "../launcher/dom.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

function rows(report: BoxReport, smooth: SmoothState): HTMLElement {
  return h(
    "div",
    { class: "box-rows" },
    ...boxLines(report, smooth).map((line) => h("div", { class: "box-row", "data-row": line.key }, h("span", { class: "box-label" }, line.label), h("span", { class: "box-value" }, line.value))),
  );
}

export async function yourBox(ctx: Ctx): Promise<View> {
  boxStyles();
  let report: BoxReport | null = await box.report().catch(() => null);
  const check = await box.smooth().catch(() => null);
  let smooth: SmoothState = check?.passed ? "passed" : check?.result ? "failed" : "unchecked";
  let running = false;
  let stopped = false;

  const list = h("div", { class: "box-list" });
  const draw = () => list.replaceChildren(report ? rows(report, smooth) : h("span", { class: "setup-note" }, "couldn't read the box. setup carries on without it."));
  const ok = h(
    "button",
    {
      class: "button primary",
      "data-focus": true,
      "data-action": "continue",
      onclick: () => {
        stopped = true;
        void ctx.finish("box");
      },
    },
    "↵ ok",
  );
  const model = report?.model.toLowerCase();
  const el = h(
    "div",
    { class: "setup-page box-step" },
    h("div", {}, ...heading("agentv box", "here's your box.", ctx.reduced()), h("div", { class: "setup-note" }, [model, "setup uses this from here on"].filter(Boolean).join(" · "))),
    list,
    h("div", {}, ok),
  );
  draw();

  // The 4K test, on a 4K TV with no result for this GPU yet.
  if (report && check?.needed) {
    running = true;
    smooth = "checking";
    draw();
    void checkSmooth({ host: el, opacity: 0.12, keepGoing: () => !stopped && el.isConnected }).then(async (state) => {
      running = false;
      if (!state || stopped) return;
      smooth = state.passed ? "passed" : "failed";
      report = await box.report().catch(() => report);
      draw();
    });
  }

  return {
    el,
    first: ok,
    info: "↵ ok",
    heard(event) {
      // Something about the box changed, such as Widevine arriving: the
      // lines again, unless the test is still running.
      if (event !== "box" || running) return;
      void box.report().then(
        (next) => {
          report = next;
          draw();
        },
        () => {},
      );
    },
    stop() {
      stopped = true;
    },
  };
}
