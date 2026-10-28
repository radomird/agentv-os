// Apps (ADR-015): everything on the box, on the home screen or not. Enter
// opens an app, i shows its details, p puts it on home or takes it off, and e
// edits home. An adult adds AgenTV's official apps from here (ADR-042), and
// asks their agent for one of their own, whose builds show here until
// they're on home (ADR-043 to ADR-046). What a phone shared waits under
// Shared until someone takes it off, with Delete (ADR-050).

import { screen, type App } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { buildTile, underway } from "./build.ts";
import { logo } from "./home.ts";
import { bar, heading, togglePin } from "./parts.ts";
import { removeShare, shares, sharedTile } from "./shared.ts";

function appTile(ctx: Ctx, app: App): HTMLElement {
  return h(
    "button",
    {
      class: "tile size-s",
      "data-focus": true,
      "data-id": app.id,
      "aria-label": app.name,
      onclick: async () => {
        // Its setup first, when a field it needs isn't filled in.
        if (app.needsSetup && app.tier !== "built-in") {
          ctx.go(`app-setup/${app.id}`);
          return;
        }
        const reply = await screen.open(app.id);
        if (!reply.ok) ctx.toast(reply.error ?? `${app.name} didn't open`, "fail");
      },
    },
    h("div", { class: "tile-top" }, logo(app)),
    h("span", { class: "tile-name" }, app.name.toLowerCase()),
  );
}

export function apps(ctx: Ctx): View {
  const pinned = new Set(ctx.state.layout.map((tile) => tile.id));
  const on = ctx.state.apps.filter((app) => pinned.has(app.id));
  const off = ctx.state.apps.filter((app) => !pinned.has(app.id));

  // AgenTV's official apps that aren't here yet, for an adult (ADR-042).
  const official =
    ctx.state.viewer.role === "adult"
      ? h(
          "button",
          { class: "tile size-s tile-apps", "data-focus": true, "data-action": "add-app", onclick: () => ctx.go("add-app") },
          h("div", { class: "tile-top" }, h("span", { class: "tile-count" }, "more apps")),
          h("span", { class: "tile-name" }, "+ add an app"),
        )
      : null;

  // Your agent makes one from what you say (ADR-043 to ADR-046), for an adult.
  const add =
    ctx.state.viewer.role === "adult"
      ? h(
          "button",
          { class: "tile size-s tile-apps", "data-focus": true, "data-action": "build", onclick: () => ctx.go("build") },
          h("div", { class: "tile-top" }, h("span", { class: "tile-count" }, "make one")),
          h("span", { class: "tile-name" }, "+ add your own"),
        )
      : null;
  const building = underway();
  const shared = shares();

  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      // Longer than the screen with a few shares, it scrolls with the focus.
      { class: "page apps-page", "data-scroll": true },
      h(
        "div",
        { class: "page-head" },
        h("div", {}, ...heading("tv apps", "apps.")),
        h("button", { class: "button", "data-focus": true, onclick: () => ctx.go("settings") }, "settings →"),
      ),
      h("div", { class: "section" }, "# on your home"),
      on.length ? h("div", { class: "row" }, ...on.map((app) => appTile(ctx, app))) : h("div", { class: "empty" }, "nothing yet"),
      ...(building.length ? [h("div", { class: "section" }, "# your agent's builds"), h("div", { class: "row" }, ...building.map((b) => buildTile(ctx, b)))] : []),
      h("div", { class: "section" }, "# not on your home"),
      h("div", { class: "row" }, ...off.map((app) => appTile(ctx, app)), ...(official ? [official] : []), ...(add ? [add] : [])),
      ...(shared.length ? [h("div", { class: "section" }, "# shared"), h("div", { class: "row" }, ...shared.map((share) => sharedTile(ctx, share)))] : []),
    ),
    bar(ctx, "apps", shared.length ? "↵ open · i details · p pin to home · e edit home · del takes a share off" : "↵ open · i details · p pin to home · e edit home"),
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
