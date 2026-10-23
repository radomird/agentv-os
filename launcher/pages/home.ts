// The home screen (ADR-015, ADR-016, ADR-018): a 4 × 3 grid of the viewer's
// tiles, each showing only an app's logo, its name and what's happening with
// it, never a tier. An app with tile() sends data for its medium and large
// tiles and the launcher draws it in the theme; no app code runs here.

import { daemon, screen, type App, type TileData, type TileEntry } from "../api.ts";
import { h, monogram, tint } from "../dom.ts";
import { span, type Placed } from "../layout.ts";
import type { Ctx, View } from "../main.ts";
import { bar } from "./parts.ts";

export function logo(app: App, big = false): HTMLElement {
  const el = h("span", { class: `logo mono-${tint(app.id)}${big ? " logo-big" : ""}` });
  if (app.icon) el.append(h("img", { src: app.icon, alt: "" }));
  else el.append(monogram(app.name));
  return el;
}

// What a small tile says about its app: open behind home, setup still
// needed, or what it's for. A game still running has Quit (ADR-031).
function state(ctx: Ctx, app: App): HTMLElement {
  const open = ctx.running.get(app.id);
  if (open?.game) return h("span", { class: "tile-state" }, "running ", h("span", { class: "tile-quit" }, "· q quit"));
  if (open) return h("span", { class: "tile-state" }, open.paused ? "paused" : "open");
  return app.needsSetup ? h("span", { class: "tile-state" }, "set up") : h("span", { class: "tile-label" }, app.category);
}

async function quit(ctx: Ctx, app: App): Promise<void> {
  const reply = await screen.quit(app.id);
  if (reply.ok) {
    ctx.sounds.play("confirm");
    ctx.toast(`${app.name.toLowerCase()} closed`, "ok");
  } else {
    ctx.sounds.play("failure");
    ctx.toast(reply.error ?? `${app.name} didn't close`, "fail");
  }
}

function entry(app: App, item: TileEntry): HTMLElement {
  return h(
    "div",
    { class: "entry" },
    item.image ? h("img", { src: daemon.image(app.id, item.image), alt: item.label ?? "" }) : null,
    item.label ? h("span", { class: "entry-label" }, item.label) : null,
    item.value ? h("span", {}, item.value) : null,
    item.caption ? h("span", { class: "entry-caption" }, item.caption) : null,
  );
}

// Fills a medium or large tile with what the app's tile() sent. A tile with
// nothing to show stays as it is.
async function fill(el: HTMLElement, app: App, placed: Placed): Promise<void> {
  let data: TileData | null = null;
  try {
    data = await daemon.tile(app.id, placed.size);
  } catch {
    return;
  }
  if (!data || (!data.headline && !data.entries?.length) || !el.isConnected) return;
  const { w, h: rows } = span(placed.size);
  const fits = Math.max(0, w * rows * 2 - 2);
  const content = h(
    "div",
    { class: "tile-content" },
    data.headline?.label ? h("span", { class: "headline-label" }, data.headline.label) : null,
    data.headline?.value ? h("span", { class: "headline-value" }, data.headline.value) : null,
    data.headline?.caption ? h("span", { class: "headline-caption" }, data.headline.caption) : null,
    data.entries?.length ? h("div", { class: "entries" }, ...data.entries.slice(0, fits).map((item) => entry(app, item))) : null,
  );
  el.querySelector(".tile-body")?.replaceWith(h("div", { class: "tile-body" }, content));
}

function appTile(ctx: Ctx, app: App, placed: Placed, editing: boolean): HTMLElement {
  const el = h(
    "button",
    {
      class: `tile size-${placed.size}`,
      "data-focus": true,
      "data-id": app.id,
      "aria-label": app.name,
      onclick: editing
        ? undefined
        : async (event: MouseEvent) => {
            // A click on a game's "q quit" quits it.
            if ((event.target as Element).closest(".tile-quit")) {
              await quit(ctx, app);
              return;
            }
            const reply = await screen.open(app.id);
            if (!reply.ok) ctx.toast(reply.error ?? `${app.name} didn't open`, "fail");
          },
    },
    h("div", { class: "tile-top" }, logo(app), editing ? state({ ...ctx, running: new Map() }, app) : state(ctx, app)),
    h("div", { class: "tile-body" }, h("span", { class: "tile-name" }, app.name.toLowerCase())),
  );
  if (placed.size !== "s") void fill(el, app, placed);
  return el;
}

function appsTile(ctx: Ctx, count: number, editing: boolean): HTMLElement {
  return h(
    "button",
    { class: "tile tile-apps size-s", "data-focus": true, "data-id": ctx.state.appsTile, onclick: editing ? undefined : () => ctx.go("apps") },
    h("div", { class: "tile-top" }, h("span", { class: "tile-count" }, count === 1 ? "1 installed" : `${count} installed`)),
    h("span", { class: "tile-name" }, "all apps →"),
  );
}

// Puts a tile in its cells.
export function placeTile(el: HTMLElement, placed: Placed): void {
  const { w, h: rows } = span(placed.size);
  el.style.gridColumn = `${placed.x + 1} / span ${w}`;
  el.style.gridRow = `${placed.y + 1} / span ${rows}`;
}

// A home tile, drawn for home or for edit mode, where choosing it doesn't
// open anything. Null for an app that isn't on the box any more.
export function tileFor(ctx: Ctx, placed: Placed, editing = false): HTMLElement | null {
  const app = ctx.state.apps.find((a) => a.id === placed.id);
  const el =
    placed.id === ctx.state.appsTile ? appsTile(ctx, ctx.state.apps.length, editing) : app ? appTile(ctx, app, placed, editing) : null;
  if (el) placeTile(el, placed);
  return el;
}

export function home(ctx: Ctx): View {
  const grid = h("div", { class: "grid" });
  const byId = new Map(ctx.state.apps.map((app) => [app.id, app]));
  const ordered = [...ctx.state.layout].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const placed of ordered) {
    const tile = tileFor(ctx, placed);
    if (tile) grid.append(tile);
  }

  const el = h("div", { class: "screen" }, grid, bar(ctx, "home"));
  return {
    el,
    first: grid.querySelector<HTMLElement>("[data-focus]") ?? undefined,
    act(action) {
      // i on a focused tile opens its app's details (ADR-018), and e edits
      // home (ADR-015).
      const id = ctx.focus.get()?.dataset.id;
      if (action === "info" && id && byId.has(id)) {
        ctx.go(`details/${id}`);
        return true;
      }
      if (action === "edit") {
        ctx.edit();
        return true;
      }
      // q (or a gamepad's X) on an app open behind home closes it.
      if (action === "quit" && id && ctx.running.has(id) && byId.has(id)) {
        void quit(ctx, byId.get(id)!);
        return true;
      }
      return false;
    },
  };
}
