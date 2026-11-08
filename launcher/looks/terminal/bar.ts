// Terminal's status bar (ADR-014, D1): inside the safe area at the bottom,
// with the page's mode in a block, then home, apps, ask and settings, and
// the viewer and the time at its right end. Apps is always one press away.

import { clock, h } from "../../dom.ts";
import type { Ctx } from "../../main.ts";
import { keyHints, sections } from "../parts.ts";

export function bar(ctx: Ctx, mode: string, info = "", step?: (HTMLElement | string)[]): HTMLElement {
  const time = h("span", { class: "bar-clock" }, clock());
  const timer = setInterval(() => {
    if (!time.isConnected) clearInterval(timer);
    else time.textContent = clock();
  }, 10_000);
  const links =
    step ??
    sections(ctx)
      .filter((section) => section.key !== mode)
      .map((section) => h("button", { class: "bar-link", "data-focus": true, "data-action": `bar-${section.key}`, onclick: section.open }, section.label));
  const note = keyHints(info) ? "" : info;
  return h(
    "div",
    { class: "bar" },
    h("div", { class: "bar-left" }, h("span", { class: "bar-mode" }, mode), ...links),
    h("div", { class: "bar-right" }, h("span", { class: "bar-viewer" }, note || ctx.state.viewer.name.toLowerCase()), time),
  );
}
