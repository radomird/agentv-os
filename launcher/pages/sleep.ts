// Settings → Power's sleep row (ADR-072): "sleep when the tv's been off for
// an hour", off by default. With it on, the screen daemon suspends the box
// once the TV has been off that long (daemon/sleep.ts). The phone can't wake
// a sleeping box, so the row's line says what can. Turning it on or off asks
// for the adult PIN, when there is one, like Settings → Updates' overnight
// row.

import { h } from "../dom.ts";
import type { Ctx } from "../main.ts";

export function sleepRow(ctx: Ctx): HTMLElement[] {
  const on = ctx.state.settings.sleepWhenOff === true;
  return [
    h(
      "button",
      { class: "button wide", "data-focus": true, "data-action": "sleep", onclick: () => void toggle(ctx) },
      h("span", {}, "sleep when the tv's been off for an hour"),
      h("span", { class: "button-value" }, on ? "[x]" : "[ ]"),
    ),
    ...(on ? [h("p", { class: "panel-note" }, "wake it with its power button or a usb keyboard. the phone can't.")] : []),
  ];
}

async function toggle(ctx: Ctx): Promise<void> {
  const grant = await ctx.grant("sleep");
  if (grant === null) return;
  try {
    await ctx.saveSettings({ sleepWhenOff: ctx.state.settings.sleepWhenOff !== true }, grant);
  } catch (error) {
    ctx.forgetGrant();
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
    return;
  }
  ctx.sounds.play("confirm");
  ctx.render("settings/power", "sleep");
}
