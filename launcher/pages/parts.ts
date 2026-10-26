// Parts more than one page uses: the status bar along the bottom (ADR-014),
// the shell-prompt heading, and the service's profile for children.

import { daemon, type App } from "../api.ts";
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
    h("button", { class: "bar-link", "data-focus": true, onclick: () => ctx.go("settings") }, ctx.updates.status?.agentv.available && !ctx.updates.status.waiting ? "settings ●" : "settings"),
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

// The service's profile a child watching opens, for an app with profiles
// (ADR-009): each choice moves to the next profile the app listed, then
// none, past the adult PIN. An app lists them the first time an adult opens
// it. App details show it, and setup's "which profile is for children?"
// will too. Null for a child, or an app without profiles. changed runs once
// a new one is kept.
export function childProfileButton(ctx: Ctx, app: App, changed: () => void): HTMLElement | null {
  const profiles = app.profiles;
  if (!profiles || ctx.state.viewer.role !== "adult") return null;
  const listed = profiles.names.length > 0;
  return h(
    "button",
    {
      class: "button",
      "data-focus": true,
      "data-action": "child-profile",
      onclick: async () => {
        if (!listed) {
          ctx.toast(`open ${app.name.toLowerCase()} once, signed in, and its profiles show here`);
          return;
        }
        const grant = await ctx.grant("the profile for children");
        if (grant === null) return;
        const choices: (string | null)[] = [...profiles.names, null];
        const next = choices[(choices.indexOf(profiles.forChildren) + 1) % choices.length];
        try {
          await daemon.childProfile(app.id, next, grant || undefined);
        } catch (error) {
          ctx.forgetGrant();
          ctx.sounds.play("failure");
          ctx.toast((error as Error).message, "fail");
          return;
        }
        profiles.forChildren = next;
        ctx.sounds.play("confirm");
        changed();
      },
    },
    h("span", {}, "profile for children"),
    h("span", { class: "button-value" }, listed ? `‹ ${(profiles.forChildren ?? "none").toLowerCase()} ›` : "open it first"),
  );
}
