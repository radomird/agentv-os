// An app's details (ADR-018): the one place that says who made it, what it can
// reach and which tile sizes it has, with the brand owner's note for an app
// named after someone else's brand. An adult ticks it for children here too
// (ADR-009). You get here with i, a gamepad's Y or by holding OK on its tile,
// and while the app is open, Quit closes it (ADR-084).

import { daemon, screen } from "../api.ts";
import { named, said } from "../looks/looks.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { logo, openBuiltin, quit } from "./home.ts";
import { builtActions } from "./build.ts";
import { bar, childProfileButton, togglePin } from "./parts.ts";

export function details(ctx: Ctx, id: string): View {
  const app = ctx.state.apps.find((a) => a.id === id);
  if (!app) {
    const el = h("div", { class: "screen" }, h("div", { class: "page" }, h("p", { class: "empty" }, "that app isn't on this tv any more")), bar(ctx, "apps"));
    return { el };
  }

  const onHome = ctx.state.layout.some((tile) => tile.id === id);
  const toggle = h(
    "button",
    {
      class: "button",
      "data-focus": true,
      "data-action": "home",
      onclick: async () => {
        if (await togglePin(ctx, id)) ctx.render(`details/${id}`, toggle.dataset.action);
      },
    },
    h("span", {}, "on home"),
    h("span", { class: "button-value" }, onHome ? "[x]" : "[ ]"),
  );

  // Whether a child's profile can open it, past the PIN once there is one.
  const children =
    ctx.state.viewer.role === "adult"
      ? h(
          "button",
          {
            class: "button",
            "data-focus": true,
            "data-action": "children",
            onclick: async () => {
              const grant = await ctx.grant("the apps children can open");
              if (grant === null) return;
              try {
                await daemon.forChildren(id, !app.forChildren, grant || undefined);
              } catch (error) {
                ctx.forgetGrant();
                ctx.sounds.play("failure");
                ctx.toast((error as Error).message, "fail");
                return;
              }
              app.forChildren = !app.forChildren;
              ctx.sounds.play("confirm");
              ctx.render(`details/${id}`, "children");
            },
          },
          h("span", {}, "for children"),
          h("span", { class: "button-value" }, app.forChildren ? "[x]" : "[ ]"),
        )
      : null;

  const open = h(
    "button",
    {
      class: "button primary",
      "data-focus": true,
      onclick: async () => {
        if (app.tier === "built-in") {
          openBuiltin(ctx, app);
          return;
        }
        const reply = await screen.open(id);
        if (!reply.ok) ctx.toast(reply.error ?? `${app.name} didn't open`, "fail");
      },
    },
    "↵ open",
  );

  // Only while it's open behind home. The page is drawn again once it has
  // closed, and the button goes.
  const close = ctx.running.has(id) ? h("button", { class: "button", "data-focus": true, "data-action": "quit", onclick: () => void quit(ctx, app) }, said("quit")) : null;

  const sizes = app.sizes.map((choice) => `${choice.size} ${choice.label}`).join(" · ");
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page" },
      h(
        "div",
        { class: "details-head" },
        logo(app, true),
        h(
          "div",
          {},
          h("div", { class: "prompt" }, h("b", {}, "~"), ` $ tv app ${named(app.name)}`),
          h("h1", { class: "headline" }, named(app.name)),
          h("div", { class: "maker" }, app.maker),
        ),
      ),
      h(
        "div",
        { class: "details" },
        h(
          "dl",
          { class: "facts" },
          h("dt", {}, "made by"),
          h("dd", {}, app.maker),
          h("dt", {}, "what it's for"),
          h("dd", {}, app.description.toLowerCase()),
          h("dt", {}, "can reach"),
          h("dd", {}, app.reach.join(", ")),
          h("dt", {}, "tile sizes"),
          h("dd", {}, sizes),
          h("dt", {}, "version"),
          h("dd", {}, app.version),
          app.credit ? h("dt", {}, "data") : null,
          app.credit ? h("dd", {}, app.credit) : null,
        ),
        h("div", { class: "actions" }, open, close, toggle, children, childProfileButton(ctx, app, () => ctx.render(`details/${id}`, "child-profile")), ...builtActions(ctx, id)),
      ),
      app.owner ? h("p", { class: "owner" }, app.owner) : null,
    ),
    bar(ctx, "apps"),
  );
  return { el, first: open };
}
