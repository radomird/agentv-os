// An app's details (ADR-018): the one place that says who made it, what it can
// reach and which tile sizes it has, with the brand owner's note for an app
// named after someone else's brand.

import { screen } from "../api.ts";
import { h } from "../dom.ts";
import { pin, unpin } from "../layout.ts";
import type { Ctx, View } from "../main.ts";
import { logo } from "./home.ts";
import { bar } from "./parts.ts";

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
        const layout = onHome ? unpin(ctx.state.layout, id) : pin(ctx.state.layout, id);
        if (!layout) {
          ctx.toast("there's no room on home: make room in edit layout first", "fail");
          return;
        }
        if (await ctx.saveLayout(layout)) {
          ctx.sounds.play("confirm");
          ctx.render(`details/${id}`, toggle.dataset.action);
        }
      },
    },
    h("span", {}, "on home"),
    h("span", { class: "button-value" }, onHome ? "[x]" : "[ ]"),
  );

  const open = h(
    "button",
    {
      class: "button primary",
      "data-focus": true,
      onclick: async () => {
        const reply = await screen.open(id);
        if (!reply.ok) ctx.toast(reply.error ?? `${app.name} didn't open`, "fail");
      },
    },
    "↵ open",
  );

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
          h("div", { class: "prompt" }, h("b", {}, "~"), ` $ tv app ${app.name.toLowerCase()}`),
          h("h1", { class: "headline" }, app.name.toLowerCase()),
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
        ),
        h("div", { class: "actions" }, open, toggle),
      ),
      app.owner ? h("p", { class: "owner" }, app.owner) : null,
    ),
    bar(ctx, "apps"),
  );
  return { el, first: open };
}
