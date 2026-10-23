// Apps (ADR-015): everything on the box, on the home screen or not. Choosing
// an app opens its details, where it can be opened, or put on home or taken
// off it.

import type { App } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { logo } from "./home.ts";
import { bar, heading } from "./parts.ts";

function appTile(ctx: Ctx, app: App): HTMLElement {
  return h(
    "button",
    { class: "tile size-s", "data-focus": true, "data-id": app.id, "aria-label": app.name, onclick: () => ctx.go(`details/${app.id}`) },
    h("div", { class: "tile-top" }, logo(app)),
    h("span", { class: "tile-name" }, app.name.toLowerCase()),
  );
}

export function apps(ctx: Ctx): View {
  const pinned = new Set(ctx.state.layout.map((tile) => tile.id));
  const on = ctx.state.apps.filter((app) => pinned.has(app.id));
  const off = ctx.state.apps.filter((app) => !pinned.has(app.id));

  const add = h(
    "button",
    {
      class: "tile size-s",
      "data-focus": true,
      onclick: () => ctx.toast("asking the agent for an app is coming soon"),
    },
    h("div", { class: "tile-top" }, h("span", { class: "tile-label" }, "coming soon")),
    h("span", { class: "tile-name" }, "+ add your own"),
  );

  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page" },
      h(
        "div",
        { class: "page-head" },
        h("div", {}, ...heading("tv apps", "apps.")),
        h("button", { class: "button", "data-focus": true, onclick: () => ctx.go("settings") }, "settings →"),
      ),
      h("div", { class: "section" }, "# on your home"),
      on.length ? h("div", { class: "row" }, ...on.map((app) => appTile(ctx, app))) : h("div", { class: "empty" }, "nothing yet"),
      h("div", { class: "section" }, "# not on your home"),
      h("div", { class: "row" }, ...off.map((app) => appTile(ctx, app)), add),
    ),
    bar(ctx, "apps", ctx.state.apps.length === 1 ? "1 app" : `${ctx.state.apps.length} apps`),
  );
  return { el, first: el.querySelector<HTMLElement>(".row [data-focus]") ?? undefined };
}
