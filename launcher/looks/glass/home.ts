// Glass's home (D12, signed off 2026-11-16). At rest it's the top shelf and
// the pinned row, and nothing else: the shelf shows the films and shows of
// the app in focus on the pinned row as sharp poster cards, with the bar at
// its top right, and the pinned row sits under it in one frosted panel.
//
// Down from the pinned row, or Apps in the bar, brings the list of apps up:
// the page scrolls until the pinned row is at the top, and the list rises
// in under it. It's every other app on home in rows of six, then Games,
// then Your own, Not on home ending with Add an app, and From your phones,
// as Apps has them. In Glass, Apps is this list. Back, Home, or up from the
// list's first row takes home back to rest.
//
// Any app or game on home can be pinned, six at most, and a pinned one is
// only in the pinned row. The list uses the profile's one layout for its
// order, and every tile is the same size. Ask, Apps, Settings, the time and
// the profile share the glass bar.

import { type App, type TileEntry, daemon } from "../../api.ts";
import { h, zoom } from "../../dom.ts";
import type { Ctx, View } from "../../main.ts";
import { buildTile, underway } from "../../pages/build.ts";
import { logo, NEW, openApp, openEntry } from "../../pages/home.ts";
import { bar, HOLD_HINT } from "../../pages/parts.ts";
import { removeShare, sharedTile, shares } from "../../pages/shared.ts";
import { cardContent, richest, tileData } from "../cards.ts";
import { GAMES, isGame, NEEDS_KEYBOARD, needsKeyboard, openWords, shelves } from "../games.ts";

const PER_ROW = 6;
export const MOST_PINNED = 6;

// The profile's apps in their layout's reading order.
export function ordered(ctx: Ctx): App[] {
  const byId = new Map(ctx.state.apps.map((app) => [app.id, app]));
  return [...ctx.state.layout]
    .filter((tile) => tile.id !== ctx.state.appsTile)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((tile) => byId.get(tile.id))
    .filter((app): app is App => Boolean(app));
}

// The pinned row's apps, in its order: what the daemon says, or, for a home
// that never had it, the first six apps that aren't games.
export function pinnedApps(ctx: Ctx, apps: App[] = ordered(ctx)): App[] {
  const byId = new Map(apps.map((app) => [app.id, app]));
  const ids = ctx.state.pinned ?? apps.filter((app) => !isGame(app)).map((app) => app.id);
  return ids
    .map((id) => byId.get(id))
    .filter((app): app is App => Boolean(app))
    .slice(0, MOST_PINNED);
}

// What the next draw of home opens on: the list, and the app to focus. Apps
// in the bar sets it from another page, and so does an app added to home.
// Edit mode draws home with the list up too, and leaves the rest as it was.
type Open = { list: boolean; focus?: string; editing?: boolean };
let next: Open | null = null;
export function openNext(open: Open): void {
  next = open;
}

// Where the list was the last time home was on the screen. Home drawn
// again, as when an app opens or closes behind it, or Back from a page,
// comes back to it; the Home key and a new start come back to rest.
let was: Open = { list: false };

// An app's tile. In the list, an app open behind home says so under its
// name, as the shelf does for the pinned row.
function glassTile(ctx: Ctx, app: App, state = false): HTMLElement {
  const open = state ? openWords(ctx, app) || (needsKeyboard(app) ? NEEDS_KEYBOARD : "") : "";
  return h(
    "button",
    { class: "tile glass-tile", "data-focus": true, "data-id": app.id, "data-details": app.id, "aria-label": app.name, onclick: () => void openApp(ctx, app) },
    cardContent(app, logo(app, true), false),
    h("span", { class: "glass-label" }, app.name, open ? h("small", {}, open) : null),
  );
}

// Tiles in rows of six; the first row has a name over it, when given.
function rowsOf(tiles: HTMLElement[], name?: { text: string; games?: boolean }): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (let at = 0; at < tiles.length; at += PER_ROW) {
    const first = at === 0 && name;
    const label = first ? h("span", { class: name.games ? "glass-shelf" : "glass-heading" }, name.text) : null;
    const extra = first ? (name.games ? " glass-games" : " glass-named") : "";
    rows.push(h("div", { class: `glass-row${extra}`, role: first ? "group" : undefined, "aria-label": first ? name.text : undefined }, label, ...tiles.slice(at, at + PER_ROW)));
  }
  return rows;
}

// A shelf card: the title's poster, how far in, and its name under it.
function card(ctx: Ctx, app: App, entry: TileEntry, at: number): HTMLElement {
  const title = entry.item?.title ?? entry.label ?? app.name;
  // Its width goes in through the style object, which the launcher's
  // content security policy allows, unlike a style attribute.
  let progress: HTMLElement | null = null;
  if (typeof entry.progress === "number") {
    const done = h("span");
    done.style.width = `${Math.round(entry.progress * 100)}%`;
    progress = h("span", { class: "glass-progress", role: "img", "aria-label": `Watched ${Math.round(entry.progress * 100)} percent` }, done);
  }
  return h(
    "button",
    {
      class: "tile glass-card",
      "data-focus": true,
      "data-action": `card-${at}`,
      "aria-label": title,
      onclick: () => (entry.item ? void openEntry(ctx, app, entry.item) : void openApp(ctx, app)),
    },
    h("span", { class: "glass-card-art" }, h("img", { src: daemon.image(app.id, entry.image!), alt: "" }), progress),
    h("span", { class: "glass-label" }, title, entry.caption ? h("small", {}, entry.caption.split(" · ")[0]) : null),
  );
}

// Scrolls the page to a place over Glass's slow time, as the list comes up
// or goes, then calls done. At once with less motion; the list then only
// fades. Gives back a way to end it at once, as a key pressed meanwhile does.
function glide(page: HTMLElement, to: number, done: () => void): () => void {
  const from = page.scrollTop;
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    page.scrollTop = to;
    done();
  };
  const still = document.documentElement.classList.contains("reduce-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still || Math.abs(to - from) < 1) {
    end();
    return end;
  }
  const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--slow")) || 320;
  const start = performance.now();
  // Close to the motion tokens' cubic-bezier(0.2, 0.8, 0.2, 1).
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const step = (now: number) => {
    if (over) return;
    const t = Math.min(1, (now - start) / ms);
    page.scrollTop = from + (to - from) * ease(t);
    if (t < 1 && page.isConnected) requestAnimationFrame(step);
    else end();
  };
  requestAnimationFrame(step);
  return end;
}

export function home(ctx: Ctx): View {
  const open = next ?? (was.list ? was : null);
  next = null;
  const apps = ordered(ctx);
  const pinned = pinnedApps(ctx, apps);
  const pinnedIds = new Set(pinned.map((app) => app.id));
  const shelf = shelves(apps.filter((app) => !pinnedIds.has(app.id)));
  const adult = ctx.state.viewer.role === "adult";

  // The pinned row, in its frosted panel.
  const pinnedTiles = pinned.map((app) => glassTile(ctx, app));
  const panel = h("div", { class: "glass-row glass-pinned", role: "group", "aria-label": "Top row" }, ...pinnedTiles);

  // The list: the other apps, Games, Your own, Not on home, From your phones.
  const listRows = rowsOf(shelf.apps.map((app) => glassTile(ctx, app, true)));
  const sections: HTMLElement[] = [];
  const section = (key: string, rows: HTMLElement[]) => rows.length && sections.push(h("div", { class: "glass-section", "data-section": key }, ...rows));
  section("games", rowsOf(shelf.games.map((app) => glassTile(ctx, app, true)), { text: GAMES, games: true }));
  section("own", rowsOf(underway().map((b) => buildTile(ctx, b)), { text: "Your own" }));
  const onHome = new Set(ctx.state.layout.map((tile) => tile.id));
  const off = ctx.state.apps.filter((app) => !onHome.has(app.id)).map((app) => glassTile(ctx, app));
  const add = adult
    ? h(
        "button",
        { class: "tile glass-tile glass-add", "data-focus": true, "data-action": "add-app", "aria-label": "Add an app", onclick: () => ctx.go("add-app") },
        h("span", { class: "card-content" }, h("span", { class: "logo logo-big logo-plus mono-1", "aria-hidden": "true" })),
        h("span", { class: "glass-label" }, "Add an app"),
      )
    : null;
  section("off", rowsOf([...off, ...(add ? [add] : [])], { text: "Not on home" }));
  const shared = shares();
  section("phones", rowsOf(shared.map((share) => sharedTile(ctx, share)), { text: "From your phones" }));
  const list = h("div", { class: "glass-list" }, ...listRows, ...sections);

  // The top shelf: the bar, and what the app in focus on the pinned row has.
  const stills = [h("img", { class: "glass-still", alt: "" }), h("img", { class: "glass-still", alt: "" })];
  let showing = 0;
  const stage = h("div", { class: "glass-stage", "aria-hidden": "true" }, ...stills);
  const heading = h("div", { class: "glass-shelf-name" });
  const shown = h("div", { class: "glass-shelf-shown" });
  const top = h("div", { class: "glass-top" }, bar(ctx, "home", "", undefined, HOLD_HINT), heading, shown);

  // The picture behind the shelf, faded in over the last.
  const wash = (image: string | null | undefined) => {
    if (!image) {
      for (const still of stills) still.classList.remove("on");
      return;
    }
    const nextStill = stills[1 - showing];
    nextStill.onload = () => {
      if (nextStill.getAttribute("src") !== image) return;
      stills[showing].classList.remove("on");
      nextStill.classList.add("on");
      showing = 1 - showing;
    };
    nextStill.src = image;
  };

  // What the shelf shows for an app: its titles with a picture, as cards,
  // or its name and what it's doing.
  let asked = 0;
  let featuredId: string | null = null;
  const feature = (el: HTMLElement) => {
    const app = apps.find((one) => one.id === el.dataset.id);
    if (!app || featuredId === app.id) return;
    featuredId = app.id;
    const n = ++asked;
    void tileData(app, richest(app)).then((data) => {
      if (n !== asked || !el.isConnected) return;
      const entries = (data?.entries ?? []).filter((entry) => entry.image);
      if (!entries.length) {
        heading.replaceChildren();
        shown.replaceChildren(h("div", { class: "glass-name" }, app.name), h("div", { class: "glass-line" }, openWords(ctx, app)));
        wash(null);
        return;
      }
      const builtin = app.tier === "built-in";
      const line = app.id === NEW && builtin ? "New this week" : entries.some((entry) => typeof entry.progress === "number") ? `Continue on ${app.name}` : `New on ${app.name}`;
      heading.replaceChildren(...(builtin ? [] : [logo(app)]), h("span", {}, line));
      const cards = h("div", { class: "glass-cards", "data-scroll": true }, ...entries.map((entry, at) => card(ctx, app, entry, at)));
      shown.replaceChildren(cards);
      wash(daemon.image(app.id, entries[0].image!));
    });
  };

  const page = h("div", { class: "glass-rows", "data-scroll": true }, top, panel, list);
  const el = h("div", { class: `screen glass-home ${open?.list ? "list" : "rest"}` }, stage, page);

  // Where the page is with the list up: its first row right under the
  // pinned row, at the top of the screen.
  const inPage = (one: HTMLElement): number => {
    let y = 0;
    for (let at: HTMLElement | null = one; at && at !== page; at = at.offsetParent as HTMLElement | null) y += at.offsetTop;
    return y;
  };
  const listTop = (): number => {
    const first = list.querySelector<HTMLElement>(".glass-row");
    if (!first) return 0;
    const stuck = parseFloat(getComputedStyle(panel).top) || 36;
    return Math.max(0, inPage(first) - stuck - panel.offsetHeight - 90);
  };
  // Rows that went up under the pinned row fade, so its glass only ever
  // has the shelf's picture behind it.
  const fade = () => {
    const under = panel.getBoundingClientRect().bottom;
    for (const row of rowsInList()) row.classList.toggle("gone", row.getBoundingClientRect().top - 56 * zoom() < under);
  };
  page.addEventListener("scroll", fade, { passive: true });
  const listTiles = () => [...list.querySelectorAll<HTMLElement>("[data-focus]")];
  const rowsInList = () => [...list.querySelectorAll<HTMLElement>(".glass-row")];
  const middle = (one: Element) => one.getBoundingClientRect().left + one.getBoundingClientRect().width / 2;
  const nearestIn = (row: Element, from: Element): HTMLElement | undefined => {
    const at = middle(from);
    return [...row.querySelectorAll<HTMLElement>("[data-focus]")].sort((a, b) => Math.abs(middle(a) - at) - Math.abs(middle(b) - at))[0];
  };

  // The page moving, as the list comes up or goes: marked "moving" until
  // it's there, and a key pressed meanwhile ends it at once and then acts.
  let finish: (() => void) | null = null;
  const move = (to: number, done: () => void) => {
    el.classList.add("moving");
    finish = glide(page, to, () => {
      finish = null;
      el.classList.remove("moving");
      done();
    });
  };

  // The list comes up, and the focus goes to target when it's there.
  const toList = (target?: HTMLElement) => {
    const to = target ?? listTiles()[0];
    if (!to) return false;
    el.classList.remove("rest");
    el.classList.add("list");
    if (!el.classList.contains("editing")) was = { list: true };
    move(listTop(), () => ctx.focus.set(to));
    return true;
  };
  // Home at rest again, with the focus on a pinned app. While editing, the
  // list stays up and only the focus goes to the pinned row.
  const toRest = (target?: HTMLElement) => {
    const to = target ?? pinnedTiles.find((tile) => tile.dataset.id === featuredId) ?? pinnedTiles[0];
    if (el.classList.contains("editing")) {
      if (to) ctx.focus.set(to);
      return true;
    }
    el.classList.remove("list");
    el.classList.add("rest");
    was = { list: false };
    move(0, () => to && ctx.focus.set(to));
    return true;
  };

  // Drawn with the list up, the page starts where the list does, once it's
  // on the screen and the focus is in: right after whatever drew it.
  const settle = () => {
    if (page.isConnected && el.classList.contains("list") && page.scrollTop < listTop() - 1) page.scrollTop = listTop();
  };

  const wanted = open?.focus ? el.querySelector<HTMLElement>(`[data-id="${CSS.escape(open.focus)}"]`) : null;
  const first = wanted ?? (open?.list ? listTiles()[0] : undefined) ?? pinnedTiles[0] ?? listTiles()[0];
  if (pinnedTiles[0]) feature(first && pinnedTiles.includes(first) ? first : pinnedTiles[0]);
  if (open?.list || (first && list.contains(first))) {
    el.classList.remove("rest");
    el.classList.add("list");
    queueMicrotask(settle);
  }
  if (!open?.editing) was = { list: el.classList.contains("list"), focus: first && list.contains(first) ? first.dataset.id : undefined };

  return {
    el,
    first,
    focused(target) {
      if (target.closest(".glass-pinned")) feature(target);
      if (!el.classList.contains("editing") && el.classList.contains("list") && list.contains(target)) was = { list: true, focus: target.dataset.id };
      // With the list up, the pinned row stays at the top: the page never
      // sits short of where the list starts.
      settle();
      const art = target.querySelector<HTMLImageElement>(".glass-card-art img");
      if (art) wash(art.getAttribute("src"));
    },
    apps() {
      if (el.classList.contains("list")) return true;
      return toList();
    },
    act(action) {
      finish?.();
      const from = ctx.focus.get();
      const inList = Boolean(from && list.contains(from));
      const inPinned = Boolean(from && panel.contains(from));
      const resting = el.classList.contains("rest");
      // Back and Home take the list away, and so does up on the pinned row
      // while it's up.
      if ((action === "back" || action === "home") && !resting) return toRest();
      if (action === "up" && inPinned && !resting && !el.classList.contains("editing")) return toRest();
      // Down from the pinned row brings the list up, on the app under.
      if (action === "down" && inPinned && from) {
        const firstRow = rowsInList()[0];
        return toList(firstRow ? nearestIn(firstRow, from) : undefined) || true;
      }
      // Down from the shelf's cards comes back to the pinned row.
      if (action === "down" && from?.closest(".glass-cards")) {
        const back = pinnedTiles.find((tile) => tile.dataset.id === featuredId) ?? pinnedTiles[0];
        if (back) ctx.focus.set(back);
        return true;
      }
      // In the list, up and down go a row at a time, to the tile nearest
      // across, and up from its first row takes home back to rest.
      if ((action === "up" || action === "down") && inList && from) {
        const rows = rowsInList();
        const at = rows.indexOf(from.closest(".glass-row") as HTMLElement);
        const to = rows[at + (action === "down" ? 1 : -1)];
        if (to) {
          const nearest = nearestIn(to, from);
          if (nearest) ctx.focus.set(nearest);
          return true;
        }
        if (action === "up") return toRest(nearestIn(panel, from));
        return true;
      }
      const id = from?.dataset.id;
      const share = shared.find((one) => one.id === from?.dataset.share);
      if (action === "remove" && share) {
        void removeShare(ctx, share).then((gone) => gone && ctx.render("home", "add-app"));
        return true;
      }
      if (action === "info" && id && ctx.state.apps.some((app) => app.id === id)) {
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
