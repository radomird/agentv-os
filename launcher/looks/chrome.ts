// What Glass's and Cinema's bars both show at their right end (D1): the time,
// kept ticking, and the profile's picture, a letter in its colour.

import { clock, h } from "../dom.ts";
import type { Ctx } from "../main.ts";
import { avatar as profileAvatar } from "../pages/profiles.ts";

export function time(): HTMLElement {
  const el = h("span", { class: "bar-clock" }, clock());
  const timer = setInterval(() => {
    if (!el.isConnected) clearInterval(timer);
    else el.textContent = clock();
  }, 10_000);
  return el;
}

// The profile's picture: the profiles page's own, with its letter as a
// capital in Glass and Cinema.
export function avatar(ctx: Ctx): HTMLElement {
  const el = profileAvatar(ctx.state.viewer);
  el.classList.add("bar-avatar");
  el.textContent = (ctx.state.viewer.name.trim()[0] ?? "?").toUpperCase();
  return el;
}
