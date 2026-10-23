// Parts more than one page uses: the status bar along the bottom (ADR-014) and
// the shell-prompt heading.

import { clock, h } from "../dom.ts";
import { pin, unpin } from "../layout.ts";
import type { Ctx } from "../main.ts";

// The bar: the mode, then links to apps and settings, or what this mode's
// keys do; on the right, info and the clock.
export function bar(ctx: Ctx, mode: string, info = "", step?: (HTMLElement | string)[]): HTMLElement {
  const time = h("span", { class: "bar-clock" }, clock());
  const timer = setInterval(() => {
    if (!time.isConnected) clearInterval(timer);
    else time.textContent = clock();
  }, 10_000);
  const links = step ?? [
    h("button", { class: "bar-link", "data-focus": true, onclick: () => ctx.go("apps") }, "apps"),
    h("span", {}, "·"),
    h("button", { class: "bar-link", "data-focus": true, onclick: () => ctx.go("settings") }, ctx.updates.status?.agentv.available ? "settings ●" : "settings"),
  ];
  return h(
    "div",
    { class: "bar" },
    h("div", { class: "bar-left" }, h("span", { class: "bar-mode" }, mode), ...links),
    h("div", { class: "bar-right" }, h("span", {}, info || ctx.state.viewer.name), time),
  );
}

export function heading(command: string, title: string): HTMLElement[] {
  return [h("div", { class: "prompt" }, h("b", {}, "~"), ` $ ${command}`), h("h1", { class: "headline" }, title)];
}

// Puts an app on home, small in the first free cell, or takes it off. False
// when nothing changed.
export async function togglePin(ctx: Ctx, id: string): Promise<boolean> {
  const onHome = ctx.state.layout.some((tile) => tile.id === id);
  const layout = onHome ? unpin(ctx.state.layout, id) : pin(ctx.state.layout, id);
  if (!layout) {
    ctx.toast("there's no room on home: make room in edit home first", "fail");
    ctx.sounds.play("failure");
    return false;
  }
  if (!(await ctx.saveLayout(layout))) return false;
  ctx.sounds.play("confirm");
  return true;
}
