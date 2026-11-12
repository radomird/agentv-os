// The app library, "Add an app" (ADR-042, D11): AgenTV's apps that aren't
// on the TV yet, each with its one line. Choosing one asks for the adult PIN,
// when there is one, and it installs in the background, as setup's apps step
// does, with the program a native app needs, such as Steam. Each tile says
// how its install is going, and one that's in opens from here. The last tile
// is for an app that isn't in the list: "Can't find it? Build your own"
// opens Ask, ready to make one. A child's profile doesn't get this page.

import { daemon, screen, type App, type Available, type AvailableApp } from "../api.ts";
import { h } from "../dom.ts";
import { loadingMark } from "../loading.ts";
import { icon } from "../looks/icons.ts";
import type { Ctx, View } from "../main.ts";
import { askBuilds, askWith } from "./ask.ts";
import { logo } from "./home.ts";
import { bar, heading } from "./parts.ts";

// The tile in focus, by its app or its action, so the page drawn again keeps
// the focus there. Anything else in focus, such as the bar while the list
// was on its way, gives the first tile the focus.
function focusedTile(ctx: Ctx): string | undefined {
  const at = ctx.focus.get();
  return at?.closest(".add-row") ? (at.dataset.id ?? at.dataset.action) : undefined;
}

// Kept between visits so the page draws at once, and asked for again as it
// opens and as an install moves on.
let available: Available | null = null;
let loadedAt = 0;
// The ask that's on its way, so a page drawn again before it answers waits
// for it too, rather than showing its loading mark until something else
// draws the page.
let loading: Promise<Available> | null = null;

export function loadAvailable(): Promise<Available> {
  loadedAt = Date.now();
  loading = daemon.available().catch((error: Error): Available => ({ apps: [], error: error.message }));
  return loading.then((answer) => (available = answer));
}

// What OK does on a tile, at its top, and how its install is going, under
// its name in place of its one line.
const ACTIONS: Record<string, string> = { none: "Add", installed: "Open", failed: "Try again" };
const STATES: Record<string, string> = {
  queued: "Waiting…",
  installing: "Installing…",
  installed: "Installed",
  failed: "Couldn't install",
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
    h("span", { class: "tile-name" }, app.name),
    app.state
      ? h("span", { class: `tile-line add-state${app.state === "failed" ? " tile-quit" : app.state === "installed" ? "" : " tile-state"}` }, STATES[app.state])
      : h("span", { class: "tile-line" }, app.description),
  );
}

// The library's last tile, the same shape as the apps before it (D11): Ask's
// sparkle where an app has its logo, and Ask opens ready with "make ".
function buildOwn(ctx: Ctx): HTMLElement {
  return h(
    "button",
    {
      class: "tile size-s build-own",
      "data-focus": true,
      "data-action": "build",
      "aria-label": "Can't find it? Build your own",
      // With the Ask box on, it's the Ask box (ADR-068).
      onclick: () => (askBuilds() ? askWith(ctx, "make ") : ctx.go("build")),
    },
    h("div", { class: "tile-top" }, h("span", { class: "logo mono-2", "aria-hidden": "true" }, icon("ask", 44)), h("span", { class: "tile-count" }, "Can't find it?")),
    h("span", { class: "tile-name" }, "Build your own"),
  );
}

async function choose(ctx: Ctx, app: AvailableApp): Promise<void> {
  if (app.state === "queued" || app.state === "installing") {
    ctx.toast(`Installing ${app.name}…`);
    return;
  }
  if (app.state === "installed") {
    const reply = await screen.open(app.id);
    if (!reply.ok) ctx.toast(reply.error ?? `Couldn't open ${app.name}`, "fail");
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
  ctx.toast(`Adding ${app.name}…`, "ok");
  ctx.render("add-app", app.id);
}

export function addApp(ctx: Ctx): View {
  const apps = available?.apps ?? [];
  // What the list has to say when it has no apps to show. Building your own
  // is there all the same, once the list has answered.
  const line = !available ? null : available.error && apps.length === 0 ? "Couldn't load the apps" : apps.length === 0 ? "You have every app" : null;
  const body = !available
    ? [h("div", { class: "empty" }, loadingMark())]
    : [line ? h("div", { class: "empty add-empty" }, line) : null, h("div", { class: "row add-row" }, ...apps.map((app) => appTile(ctx, app)), buildOwn(ctx))];
  const el = h("div", { class: "screen" }, h("div", { class: "page add-page" }, h("div", { class: "page-head" }, h("div", {}, ...heading("tv apps add", "Add an app"))), ...body), bar(ctx, "apps"));
  // Asked for again as the page opens, then drawn once it's here.
  const asked = Date.now() - loadedAt > 2000 ? loadAvailable() : !available && loading ? loading.then((answer) => (available = answer)) : null;
  if (asked) {
    void asked.then(() => {
      if (el.isConnected) ctx.render("add-app", focusedTile(ctx));
    });
  }
  return { el, first: el.querySelector<HTMLElement>(".row [data-focus]") ?? undefined };
}

// An install moved on: the page again, if it's the one showing.
export function installMoved(ctx: Ctx, showing: boolean): void {
  if (!showing) return;
  void loadAvailable().then(() => ctx.render("add-app", focusedTile(ctx)));
}
