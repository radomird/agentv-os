// Parts more than one page uses: the status bar along the bottom (ADR-014) and
// the shell-prompt heading.

import { clock, h } from "../dom.ts";
import type { Ctx } from "../main.ts";

export function bar(ctx: Ctx, mode: string, info = ""): HTMLElement {
  const time = h("span", { class: "bar-clock" }, clock());
  const timer = setInterval(() => {
    if (!time.isConnected) clearInterval(timer);
    else time.textContent = clock();
  }, 10_000);
  return h(
    "div",
    { class: "bar" },
    h(
      "div",
      { class: "bar-left" },
      h("span", { class: "bar-mode" }, mode),
      h("button", { class: "bar-link", "data-focus": true, onclick: () => ctx.go("apps") }, "apps"),
      h("span", {}, "·"),
      h("button", { class: "bar-link", "data-focus": true, onclick: () => ctx.go("settings") }, "settings"),
    ),
    h("div", { class: "bar-right" }, h("span", {}, info || ctx.state.viewer.name), time),
  );
}

export function heading(command: string, title: string): HTMLElement[] {
  return [h("div", { class: "prompt" }, h("b", {}, "~"), ` $ ${command}`), h("h1", { class: "headline" }, title)];
}
