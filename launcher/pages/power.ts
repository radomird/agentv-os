// Restart and Shut down (ADR-033), rows in Settings, This TV, each asking
// first on a screen of its own. Restart goes right after its question. Shut down counts
// down 10 seconds, which Cancel stops, then the screen daemon turns the box
// off through Omarchy's own command. Only an adult gets here, never while an
// update runs, and the adult PIN, when there is one, asks first (ADR-009).
//
// Restart to the boot menu (ADR-060) is a restart whose next boot waits on
// the boot menu, where a snapshot can be picked, so nobody has to catch the
// quiet second at power on. It's only on a box whose boot loader takes the
// request.

import { screen } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";
import { installing } from "./updates.ts";
import { sleepRow } from "./sleep.ts";

export const COUNTDOWN_S = 10;

export type Power = "restart" | "shutdown" | "bootmenu";

// What the box said last about restarting to its boot menu. Settings is drawn
// again in place whenever the daemon has news, and the row keeps its place,
// and the focus on it, while the box is asked again.
let bootMenuShown = false;

// This TV's rows for it in Settings: Restart, Shut down, the boot menu on a
// box that can, and sleep. While an update runs, each says why not.
export function powerRows(ctx: Ctx): HTMLElement[] {
  const go = (route: string) => () => {
    if (!installing(ctx.updates)) return ctx.go(route);
    ctx.sounds.play("failure");
    ctx.toast("Not during an update", "fail");
  };
  // It shows once the box says it can.
  const bootMenu = h("button", { class: bootMenuShown ? "button" : "button hidden", "data-focus": true, "data-action": "bootmenu", onclick: go("power/bootmenu") }, "Restart to the boot menu");
  void screen.bootMenu().then((can) => {
    bootMenuShown = can;
    bootMenu.classList.toggle("hidden", !can);
  });
  return [
    h("button", { class: "button", "data-focus": true, "data-action": "restart", onclick: go("power/restart") }, "Restart"),
    h("button", { class: "button", "data-focus": true, "data-action": "shutdown", onclick: go("power/shutdown") }, "Shut down"),
    bootMenu,
    ...sleepRow(ctx),
  ];
}

export function power(ctx: Ctx, what: Power): View {
  // The boot menu's is a restart too, that waits on the menu.
  const restart = what !== "shutdown";
  const menu = what === "bootmenu";
  const summary = h(
    "div",
    { class: "panel-note check-summary" },
    menu
      ? "You can pick an earlier backup there"
      : restart
        ? "Apps close, then you're back on home"
        : "Apps close, and it turns off in 10 seconds",
  );
  const count = h("div", { class: "power-count hidden" });
  const choose = h(
    "button",
    { class: "button primary", "data-focus": true, "data-action": what, onclick: () => void askFirst() },
    restart ? "Restart" : "Shut down",
  );
  const cancel = h("button", { class: "button", "data-focus": true, "data-action": "cancel", onclick: () => stop() }, "Cancel");
  const actions = h("div", { class: "check-actions" }, choose, cancel);
  const question = menu ? "Restart to the boot menu?" : restart ? "Restart?" : "Shut down?";
  const [prompt, title] = heading(`tv power ${menu ? "boot-menu" : what}`, question);
  const el = h("div", { class: "screen" }, h("div", { class: "page power" }, prompt, title, summary, count, actions), bar(ctx, "power"));

  let timer = 0;
  let going = false;
  let grant = "";

  // The PIN first, when there is one, then the restart or the countdown.
  const askFirst = async () => {
    const got = await ctx.grant(restart ? "restarting" : "shutting down");
    if (got === null || !el.isConnected) return;
    grant = got;
    if (restart) void go();
    else countdown();
  };

  // Back to Settings, with the countdown stopped.
  const stop = () => {
    clearInterval(timer);
    timer = 0;
    if (!going) ctx.back();
  };

  // The question again, after something stopped the countdown.
  const asked = () => {
    clearInterval(timer);
    timer = 0;
    title.textContent = question;
    count.classList.add("hidden");
    choose.classList.remove("hidden");
    summary.textContent = "An update started, so it stayed on";
  };

  const go = async () => {
    going = true;
    clearInterval(timer);
    timer = 0;
    actions.classList.add("hidden");
    // The headline says it, so the line under it goes.
    title.textContent = restart ? "Restarting…" : "Shutting down…";
    summary.textContent = "";
    const reply = await screen.power(what, grant);
    if (reply.pin) ctx.forgetGrant();
    if (reply.ok) {
      ctx.sounds.play("confirm");
      return;
    }
    going = false;
    ctx.sounds.play("failure");
    ctx.toast(reply.error ?? (restart ? "Couldn't restart" : "Couldn't shut down"), "fail");
    if (el.isConnected) ctx.back();
  };

  // Shut down's 10 seconds, on the screen, with Cancel. It stops when the
  // page goes, or when an update starts (ADR-025).
  const countdown = () => {
    const end = Date.now() + COUNTDOWN_S * 1000;
    title.textContent = "Shutting down…";
    choose.classList.add("hidden");
    count.classList.remove("hidden");
    const tick = () => {
      if (!el.isConnected) {
        clearInterval(timer);
        return;
      }
      if (installing(ctx.updates)) return asked();
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      count.textContent = String(left);
      summary.textContent = `Shutting down in ${left} ${left === 1 ? "second" : "seconds"}`;
      if (left === 0) void go();
    };
    // The number first, so the focus ring finds Cancel where it ends up.
    tick();
    ctx.focus.set(cancel);
    timer = window.setInterval(tick, 200);
  };

  return {
    el,
    first: choose,
    // Back is Cancel, and Home stops the countdown on its way home.
    act(action) {
      if (going) return action !== "home";
      if (action === "back") {
        stop();
        return true;
      }
      if (action === "home") clearInterval(timer);
      return false;
    },
  };
}
