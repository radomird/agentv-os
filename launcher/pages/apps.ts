// Apps (ADR-015): everything on the TV, on the home screen or not. OK opens
// an app, and holding OK shows its details, where it goes on home or comes
// off. An adult adds more from the one "Add an app" tile, which opens the
// app library (ADR-042, D11), and the apps being made show here until
// they're on home (ADR-043 to ADR-046). What a phone sent waits under "From
// your phones" until someone removes it (ADR-050).

import { screen, type App } from "../api.ts";
import { h } from "../dom.ts";
import { lookId } from "../looks/looks.ts";
import type { Ctx, View } from "../main.ts";
import { buildTile, underway } from "./build.ts";
import { logo } from "./home.ts";
import { bar, heading, HOLD_HINT, section, togglePin } from "./parts.ts";
import { removeShare, shares, sharedTile } from "./shared.ts";

function appTile(ctx: Ctx, app: App): HTMLElement {
  return h(
    "button",
    {
      class: "tile size-s",
      "data-focus": true,
      "data-id": app.id,
      "data-details": app.id,
      "aria-label": app.name,
      onclick: async () => {
        // Its setup first, when a field it needs isn't filled in.
        if (app.needsSetup && app.tier !== "built-in") {
          ctx.go(`app-setup/${app.id}`);
          return;
        }
        const reply = await screen.open(app.id);
        if (!reply.ok) ctx.toast(reply.error ?? `Couldn't open ${app.name}`, "fail");
      },
    },
    h("div", { class: "tile-top" }, logo(app)),
    h("span", { class: "tile-name" }, app.name),
  );
}

export function apps(ctx: Ctx): View {
  const pinned = new Set(ctx.state.layout.map((tile) => tile.id));
  const on = ctx.state.apps.filter((app) => pinned.has(app.id));
  const off = ctx.state.apps.filter((app) => !pinned.has(app.id));

  // The one way in to more apps, for an adult (D11): the app library, where
  // building your own is the last tile. A plus is its icon, where an app has
  // its logo, drawn in CSS so it's never in the words.
  const add =
    ctx.state.viewer.role === "adult"
      ? h(
          "button",
          { class: "tile size-s tile-apps", "data-focus": true, "data-action": "add-app", "aria-label": "Add an app", onclick: () => ctx.go("add-app") },
          h("div", { class: "tile-top" }, h("span", { class: "logo logo-plus mono-1", "aria-hidden": "true" })),
          h("span", { class: "tile-name" }, "Add an app"),
        )
      : null;
  const building = underway();
  const shared = shares();

  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      // Longer than the screen with a few things from phones, it scrolls with the focus.
      { class: "page apps-page", "data-scroll": true },
      h(
        "div",
        { class: "page-head" },
        h("div", {}, ...heading("tv apps", "Apps")),
        // With the looks, Settings is in every look's bar (D7).
        lookId() ? null : h("button", { class: "button", "data-focus": true, onclick: () => ctx.go("settings") }, "Settings"),
      ),
      section("On home"),
      on.length ? h("div", { class: "row" }, ...on.map((app) => appTile(ctx, app))) : h("div", { class: "empty" }, "Nothing on home yet"),
      ...(building.length ? [section("Your own"), h("div", { class: "row" }, ...building.map((b) => buildTile(ctx, b)))] : []),
      section("Not on home"),
      h("div", { class: "row" }, ...off.map((app) => appTile(ctx, app)), ...(add ? [add] : [])),
      ...(shared.length ? [section("From your phones"), h("div", { class: "row" }, ...shared.map((share) => sharedTile(ctx, share)))] : []),
    ),
    bar(ctx, "apps", "", undefined, HOLD_HINT),
  );
  el.querySelector(".apps-page")!.addEventListener("scroll", () => ctx.focus.refresh(), { passive: true });
  const installed = new Set(ctx.state.apps.map((app) => app.id));
  return {
    el,
    first: el.querySelector<HTMLElement>(".row [data-focus]") ?? undefined,
    act(action) {
      const id = ctx.focus.get()?.dataset.id;
      const share = shared.find((one) => one.id === ctx.focus.get()?.dataset.share);
      if (action === "remove" && share) {
        void removeShare(ctx, share).then((gone) => gone && ctx.render("apps"));
        return true;
      }
      if (action === "info" && id && installed.has(id)) {
        ctx.go(`details/${id}`);
        return true;
      }
      if (action === "pin" && id && installed.has(id)) {
        void togglePin(ctx, id).then((changed) => changed && ctx.render("apps", id));
        return true;
      }
      if (action === "edit") {
        ctx.edit();
        return true;
      }
      return false;
    },
  };
}
