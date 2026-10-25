// The home screen (ADR-015, ADR-016, ADR-018): a 4 × 3 grid of the viewer's
// tiles, each showing only an app's logo, its name and what's happening with
// it, never a tier. An app with tile() sends data for its tiles and the
// launcher draws it in the theme, with icons from its own pixel set; no app
// code runs here. Small keeps the logo unless tile('s') sends a headline.
//
// The built-in apps open here, not in a window of their own: Clock opens the
// ambient screen and Weather its settings. Clock's time ticks here too, since
// a tile only refreshes every few minutes.

import { daemon, screen, type App, type TileData, type TileEntry } from "../api.ts";
import { clock, h, monogram, tint } from "../dom.ts";
import { span, type Placed } from "../layout.ts";
import type { Ctx, View } from "../main.ts";
import { pixel } from "../pixels.ts";
import { bar } from "./parts.ts";
import { later, release, tonight } from "./updates.ts";

export const CLOCK = "agentv.clock";
export const WEATHER = "agentv.weather";

// How many entries each size fits, in order (ADR-016): small has room for
// one line under its headline, medium for a few columns, large for a week.
const FITS = { s: 1, m: 3, l: 7 } as const;

// How wide a pixel icon is drawn, by where it is.
const ICON_PX = { headline: { s: 180, m: 150, l: 250 }, entry: { s: 84, m: 150, l: 84 } } as const;

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

// How far in, as a bar. Its width goes in through the style object, which
// the launcher's content security policy allows, unlike a style attribute.
function progressBar(progress: number): HTMLElement {
  const done = h("span", { class: "entry-progress-done" });
  done.style.width = `${(progress * 100).toFixed(1)}%`;
  return h("span", { class: "entry-progress", role: "img", "aria-label": `watched ${Math.round(progress * 100)} percent` }, done);
}

function entry(app: App, item: TileEntry, size: Placed["size"], at: number): HTMLElement {
  const icon = item.image ? null : pixel(item.icon, ICON_PX.entry[size]);
  const progress = typeof item.progress === "number" ? Math.max(0, Math.min(1, item.progress)) : null;
  return h(
    "div",
    { class: `entry${icon ? " entry-icon" : ""}${item.item ? " entry-item" : ""}`, "data-entry": item.item ? at : undefined },
    item.label ? h("span", { class: "entry-label" }, item.label) : null,
    item.image ? h("img", { src: daemon.image(app.id, item.image), alt: item.label ?? "" }) : null,
    icon,
    item.value || item.caption
      ? h(
          "span",
          { class: "entry-text" },
          item.value ? h("span", { class: "entry-value" }, item.value) : null,
          item.caption ? h("span", { class: "entry-caption" }, item.caption) : null,
          progress !== null ? progressBar(progress) : null,
        )
      : null,
  );
}

// The row along a tile's top once it shows content: the app's name, and on
// the right what the content is of, such as the weather's city.
function head(app: App, right: string): HTMLElement {
  return h(
    "div",
    { class: "tile-head" },
    h("span", { class: `tile-head-name ink-${app.tier === "built-in" ? 4 : tint(app.id)}` }, app.name.toLowerCase()),
    right ? h("span", { class: "tile-head-label" }, right) : null,
  );
}

// What edit mode put on a tile (its size and its corner) stays when the
// tile's content arrives after it.
function replaceKeeping(el: HTMLElement, ...children: HTMLElement[]): void {
  const kept = [...el.querySelectorAll<HTMLElement>(":scope > .badge, :scope > .corner")];
  el.replaceChildren(...children, ...kept);
}

// Draws what an app's tile() sent, in place of the logo and name. A tile
// with nothing to show stays as it is, and so does a small one with no
// headline.
export function drawTile(el: HTMLElement, app: App, size: Placed["size"], data: TileData | null): void {
  if (!data || (!data.headline && !data.entries?.length) || (size === "s" && !data.headline)) return;
  const headline = data.headline;
  const label = headline?.label ?? app.sizes.find((choice) => choice.size === size)?.label ?? "";
  const icon = pixel(headline?.icon, ICON_PX.headline[size]);
  const now =
    headline && (headline.value || headline.caption || icon)
      ? h(
          "div",
          { class: "tile-now" },
          icon,
          h(
            "span",
            { class: "tile-now-text" },
            headline.value ? h("span", { class: "headline-value" }, headline.value) : null,
            headline.caption ? h("span", { class: "headline-caption" }, headline.caption) : null,
          ),
        )
      : null;
  const entries = (data.entries ?? []).slice(0, FITS[size]);
  el.classList.add("has-content");
  // Choosing an entry that carries an item opens it (ADR-016); the tile
  // keeps them for its click.
  (el as HTMLElement & { entryItems?: TileEntry[] }).entryItems = entries;
  replaceKeeping(
    el,
    head(app, label),
    h(
      "div",
      { class: "tile-content" },
      now,
      entries.length ? h("div", { class: `entries entries-${entries.length}` }, ...entries.map((item, at) => entry(app, item, size, at))) : null,
    ),
  );
}

// Clock's tile: the time, kept ticking here, with the date on the small
// tile and the day, the date and the city on the medium one (canvas
// board 26).
export function drawClock(el: HTMLElement, app: App, size: Placed["size"], place = ""): void {
  const draw = () => {
    const date = new Date();
    const short = date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "").toLowerCase();
    const time = h("span", { class: "clock-time" }, clock(date));
    const day = h("span", { class: "clock-day" }, date.toLocaleDateString("en-GB", { weekday: "long" }).toLowerCase());
    const full = h("span", { class: "clock-date" }, date.toLocaleDateString("en-GB", { day: "numeric", month: "long" }).toLowerCase());
    replaceKeeping(
      el,
      head(app, size === "s" ? short : place),
      size === "s" ? time : h("div", { class: "clock-row" }, time, h("span", { class: "clock-when" }, day, full)),
    );
  };
  el.classList.add("has-content", "clock-tile");
  draw();
  const timer = setInterval(() => {
    if (!el.isConnected) clearInterval(timer);
    else if (el.querySelector(".clock-time")?.textContent !== clock()) draw();
  }, 5_000);
}

// Fills a tile with what its app's tile() sent.
async function fill(el: HTMLElement, app: App, placed: Placed): Promise<void> {
  let data: TileData | null = null;
  try {
    data = await daemon.tile(app.id, placed.size);
  } catch {
    if (app.id !== CLOCK) return;
  }
  if (!el.isConnected) return;
  if (app.id === CLOCK && app.tier === "built-in") drawClock(el, app, placed.size, data?.headline?.label);
  else drawTile(el, app, placed.size, data);
}

// What choosing a built-in does (ADR-015): they open here, not in a window.
export function openBuiltin(ctx: Ctx, app: App): void {
  if (app.id === CLOCK) ctx.ambient();
  else if (app.id === WEATHER) ctx.go("settings/weather");
  else ctx.go(`details/${app.id}`);
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
            // A click on an entry that carries an item opens it there.
            const chosen = (event.target as Element).closest<HTMLElement>("[data-entry]");
            const item = chosen ? (el as HTMLElement & { entryItems?: TileEntry[] }).entryItems?.[Number(chosen.dataset.entry)]?.item : undefined;
            if (item && app.tier !== "built-in") {
              const reply = await screen.openItem(app.id, item);
              if (!reply.ok) ctx.toast(reply.error ?? `${app.name} didn't open ${item.title}`, "fail");
              return;
            }
            if (app.tier === "built-in") {
              openBuiltin(ctx, app);
              return;
            }
            const reply = await screen.open(app.id);
            if (!reply.ok) ctx.toast(reply.error ?? `${app.name} didn't open`, "fail");
          },
    },
    h("div", { class: "tile-top" }, logo(app), editing ? state({ ...ctx, running: new Map() }, app) : state(ctx, app)),
    h("div", { class: "tile-body" }, h("span", { class: "tile-name" }, app.name.toLowerCase())),
  );
  void fill(el, app, placed);
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

  // A new release says so in the bar (ADR-025, board 31), until Later.
  const next = release(ctx.updates);
  const notice = !next ? "" : tonight(ctx.updates) ? `agentv ${next} installs tonight` : later(ctx.updates) ? "" : `agentv ${next} is ready · settings → updates`;
  const el = h("div", { class: "screen" }, grid, bar(ctx, "home", notice));
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
