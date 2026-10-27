// Apps → add an app (ADR-042): the official apps in AgenTV's signed index
// that aren't on the TV yet, each with its one line. Choosing one asks for
// the adult PIN, when there is one, and root installs it in the background,
// as setup's apps step does, with the program a native app needs, such as
// Steam. Each tile says how its install is going, and one that's in opens
// from here. A child's profile doesn't get this page.

import { daemon, screen, type App, type Available, type AvailableApp } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { logo } from "./home.ts";
import { bar, heading } from "./parts.ts";

// Kept between visits so the page draws at once, and asked for again as it
// opens and as an install moves on.
let available: Available | null = null;
let loadedAt = 0;

export async function loadAvailable(): Promise<Available> {
  loadedAt = Date.now();
  try {
    available = await daemon.available();
  } catch (error) {
    available = { apps: [], error: (error as Error).message };
  }
  return available;
}

// What Enter does on a tile, at its top, and how its install is going, under
// its name in place of its one line.
const ACTIONS: Record<string, string> = { none: "add", installed: "open", failed: "retry" };
const STATES: Record<string, (app: AvailableApp) => string> = {
  queued: () => "queued",
  installing: () => "installing",
  installed: () => "installed, and on your home",
  failed: (app) => `failed: ${app.error ?? "it didn't install"}`,
};

function appTile(ctx: Ctx, app: AvailableApp): HTMLElement {
  const action = ACTIONS[app.state ?? "none"];
  return h(
    "button",
    {
      class: "tile size-s add-tile",
      "data-focus": true,
      "data-id": app.id,
      "aria-label": app.name,
      onclick: () => void choose(ctx, app),
    },
    h("div", { class: "tile-top" }, logo({ id: app.id, name: app.name } as App), action ? h("span", { class: "tile-label" }, action) : null),
    h("span", { class: "tile-name" }, app.name.toLowerCase()),
    app.state
      ? h("span", { class: `tile-line add-state${app.state === "failed" ? " tile-quit" : app.state === "installed" ? "" : " tile-state"}` }, STATES[app.state](app))
      : h("span", { class: "tile-line" }, app.description.toLowerCase()),
  );
}

async function choose(ctx: Ctx, app: AvailableApp): Promise<void> {
  if (app.state === "queued" || app.state === "installing") {
    ctx.toast(`${app.name.toLowerCase()} is installing`);
    return;
  }
  if (app.state === "installed") {
    const reply = await screen.open(app.id);
    if (!reply.ok) ctx.toast(reply.error ?? `${app.name} didn't open`, "fail");
    return;
  }
  const grant = await ctx.grant("adding an app");
  if (grant === null) return;
  try {
    available = await daemon.addApp(app.id, grant || undefined);
    loadedAt = Date.now();
  } catch (error) {
    ctx.forgetGrant();
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
    return;
  }
  ctx.sounds.play("confirm");
  ctx.toast(`adding ${app.name.toLowerCase()}`, "ok");
  ctx.render("add-app", app.id);
}

export function addApp(ctx: Ctx): View {
  const apps = available?.apps ?? [];
  let body: HTMLElement;
  if (!available) body = h("div", { class: "empty" }, "…");
  else if (available.error && apps.length === 0) body = h("div", { class: "empty" }, `the app list couldn't be read: ${available.error}`);
  else if (apps.length === 0) body = h("div", { class: "empty" }, "every official app is on this tv.");
  else body = h("div", { class: "row add-row" }, ...apps.map((app) => appTile(ctx, app)));
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page" },
      h("div", { class: "page-head" }, h("div", {}, ...heading("tv apps add", "add an app."))),
      h("p", { class: "panel-note" }, "agentv's official apps. each one installs in the background, with what it needs, and lands on your home."),
      body,
    ),
    bar(ctx, "apps", "↵ add · esc back"),
  );
  // Asked for again as the page opens, then drawn once it's here.
  if (Date.now() - loadedAt > 2000) {
    void loadAvailable().then(() => {
      if (el.isConnected) ctx.render("add-app", ctx.focus.get()?.dataset.id);
    });
  }
  return { el, first: el.querySelector<HTMLElement>(".row [data-focus]") ?? undefined };
}

// An install moved on: the page again, if it's the one showing.
export function installMoved(ctx: Ctx, showing: boolean): void {
  if (!showing) return;
  void loadAvailable().then(() => ctx.render("add-app", ctx.focus.get()?.dataset.id));
}
