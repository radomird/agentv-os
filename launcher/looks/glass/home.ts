// Glass's home (D1, Q194): the focused app's featured title fills the
// screen, with its name and a line at the top left, and the profile's apps
// sit on it as frosted tiles, six a row, the first row over the picture and
// the next peeking up from the bottom. Ask, Apps, Settings, the time and the
// profile share the glass bar at the top right.
//
// It uses the profile's one layout for its order (reading order, as Terminal
// places them), and every tile is the same size. An app with no picture of
// its own shows the home's background instead. The games on home have a row
// of their own under the apps, named Games (D9).

import type { App } from "../../api.ts";
import { h } from "../../dom.ts";
import type { Ctx, View } from "../../main.ts";
import { buildTile, underway } from "../../pages/build.ts";
import { logo, openApp } from "../../pages/home.ts";
import { bar } from "../../pages/parts.ts";
import { cardContent, featured, type Featured } from "../cards.ts";
import { GAMES, openWords, shelves } from "../games.ts";
import { named } from "../looks.ts";

const PER_ROW = 6;

// The profile's apps in their layout's reading order.
export function ordered(ctx: Ctx): App[] {
  const byId = new Map(ctx.state.apps.map((app) => [app.id, app]));
  return [...ctx.state.layout]
    .filter((tile) => tile.id !== ctx.state.appsTile)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((tile) => byId.get(tile.id))
    .filter((app): app is App => Boolean(app));
}

function glassTile(ctx: Ctx, app: App): HTMLElement {
  return h(
    "button",
    { class: "tile glass-tile", "data-focus": true, "data-id": app.id, "aria-label": app.name, onclick: () => void openApp(ctx, app) },
    cardContent(app, logo(app, true), false),
    h("span", { class: "glass-label" }, named(app.name)),
  );
}

export function home(ctx: Ctx): View {
  const apps = ordered(ctx);
  const shelf = shelves(apps);
  const tiles = shelf.apps.map((app) => glassTile(ctx, app));
  // Your agent's newest build, while it isn't on home yet (D1).
  const building = underway()[0];
  if (building) tiles.splice(1, 0, buildTile(ctx, building));
  const rows: HTMLElement[] = [];
  for (let at = 0; at < tiles.length; at += PER_ROW) rows.push(h("div", { class: "glass-row" }, ...tiles.slice(at, at + PER_ROW)));
  // The games, six a row as the apps are, with the row's name over the first.
  const games = shelf.games.map((app) => glassTile(ctx, app));
  for (let at = 0; at < games.length; at += PER_ROW) {
    const first = at === 0;
    rows.push(
      h(
        "div",
        { class: `glass-row${first ? " glass-games" : ""}`, role: first ? "group" : undefined, "aria-label": first ? GAMES : undefined },
        first ? h("span", { class: "glass-shelf" }, GAMES) : null,
        ...games.slice(at, at + PER_ROW),
      ),
    );
  }

  // Two pictures, so the next fades in over the last.
  const stills = [h("img", { class: "glass-still", alt: "" }), h("img", { class: "glass-still", alt: "" })];
  let showing = 0;
  const name = h("span", { class: "glass-name" });
  const line = h("span", { class: "glass-line" });
  const stage = h("div", { class: "glass-stage", "aria-hidden": "true" }, ...stills);
  const title = h("div", { class: "glass-title" }, name, line);

  // What the focused tile features: its own title and picture, or its name
  // over the home's background. An app that's open behind home says so in
  // the line under its name.
  let asked = 0;
  const feature = (el: HTMLElement) => {
    const app = apps.find((one) => one.id === el.dataset.id);
    const n = ++asked;
    if (!app) {
      name.textContent = el.getAttribute("aria-label") ?? "";
      line.textContent = "";
      for (const still of stills) still.classList.remove("on");
      return;
    }
    void featured(app).then((found: Featured[]) => {
      if (n !== asked || !el.isConnected) return;
      const first = found[0];
      name.textContent = first?.title ?? named(app.name);
      line.textContent = openWords(ctx, app) || (first?.line ?? "");
      if (!first?.image) {
        for (const still of stills) still.classList.remove("on");
        return;
      }
      const next = stills[1 - showing];
      next.onload = () => {
        if (n !== asked) return;
        stills[showing].classList.remove("on");
        next.classList.add("on");
        showing = 1 - showing;
      };
      next.src = first.image;
    });
  };

  const grid = h("div", { class: "glass-rows", "data-scroll": true }, ...rows);
  const el = h("div", { class: "screen glass-home" }, stage, title, grid, bar(ctx, "home"));
  const first = tiles[0] ?? games[0];
  if (first) feature(first);
  return {
    el,
    first,
    focused(target) {
      if (target.closest(".glass-rows")) feature(target);
    },
    act(action) {
      const id = ctx.focus.get()?.dataset.id;
      if (action === "info" && id && apps.some((app) => app.id === id)) {
        ctx.go(`details/${id}`);
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
