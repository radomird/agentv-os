// This TV's sleep row in Settings (ADR-072): "Sleep after an hour off", off
// by default. With it on, the screen daemon suspends the box once the TV has
// been off that long (daemon/sleep.ts). The phone can't wake a sleeping box,
// so turning it on says what can. Turning it on or off asks for the adult
// PIN, when there is one, like Updates' overnight row.

import { h } from "../dom.ts";
import type { Ctx } from "../main.ts";

export function sleepRow(ctx: Ctx): HTMLElement[] {
  const on = ctx.state.settings.sleepWhenOff === true;
  return [
    h(
      "button",
      { class: "button wide", "data-focus": true, "data-action": "sleep", onclick: () => void toggle(ctx) },
      h("span", {}, "Sleep after an hour off"),
      h("span", { class: "button-value" }, on ? "On" : "Off"),
    ),
  ];
}

async function toggle(ctx: Ctx): Promise<void> {
  const grant = await ctx.grant("sleep");
  if (grant === null) return;
  const on = ctx.state.settings.sleepWhenOff !== true;
  try {
    await ctx.saveSettings({ sleepWhenOff: on }, grant);
  } catch (error) {
    ctx.forgetGrant();
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
    return;
  }
  ctx.sounds.play("confirm");
  // The one line about it, said as it's turned on.
  if (on) ctx.toast("Wake it with the power button or a keyboard. Your phone can't.", "ok");
  ctx.render("settings/tv", "sleep");
}
