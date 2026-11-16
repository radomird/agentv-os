// Editing home in Glass and Cinema, where home is rows of apps rather than
// Terminal's grid (pages/edit.ts). It's the look's own home, with the same
// keys as Terminal's: OK picks the focused app up, the arrows carry it, OK
// puts it down and Back puts it back. Left and right carry it along its row,
// and in Glass up and down carry it to the row above or below, to the place
// under or over it (ADR-103). Cinema's apps are one row. A game stays among
// the games. Delete takes it off home. Neither look draws an app bigger at
// another size, so + and - do nothing here; sizes are Terminal's, and the
// phone's. Every change is saved as it happens, to the profile's one layout,
// in the order the look draws, and where it can, in the places Terminal's
// grid had, so Terminal's home keeps its shape.
//
// Move in an app's details opens this with the app in hand. Putting it down
// goes home with the focus on it, and Back puts it back and goes back.
//
// Glass edits with its list up, under the pinned row (D12). Left and right
// on the pinned row change its order. Down from it swaps the app with the
// one under it in the list's first row, and up from that row swaps the
// other way, or joins the pinned row while it has room. The pinned row is
// saved with the layout, when the app is put down.

import { reorder, unpin, type Placed } from "../layout.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { shelves } from "./games.ts";
import { MOST_PINNED, openNext, ordered, pinnedApps } from "./glass/home.ts";
import { lookHome } from "./homes.ts";
import { homeGrid, lookId } from "./looks.ts";

function same(a: unknown[], b: unknown[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const HINT = "Editing home. Move with the arrows, then OK";

export function rowEdit(ctx: Ctx, focusOn?: string, moving = false): View {
  const grid = homeGrid();
  const glass = lookId() === "glass";
  let layout = ctx.state.layout.map((tile) => ({ ...tile }));
  let pinned = glass ? pinnedApps(ctx).map((app) => app.id) : [];
  let held: { id: string; before: Placed[]; pinned: string[] } | null =
    moving && focusOn && layout.some((tile) => tile.id === focusOn) ? { id: focusOn, before: layout, pinned } : null;
  // Home as it is now in this edit: the look draws it from a layout of its
  // own, which is saved as each change is made.
  const shadow = (): Ctx => Object.create(ctx, { state: { value: { ...ctx.state, layout, pinned } } }) as Ctx;
  const el = h("div", { class: "row-edit" });
  let inner: View;

  const draw = (focusId?: string): HTMLElement | undefined => {
    if (glass) openNext({ list: true, editing: true });
    inner = lookHome(shadow());
    inner.el.classList.add("editing");
    // The bar's hint says what editing is and its keys, where home says to
    // hold OK for details, as Terminal's bar does while editing.
    const hint = inner.el.querySelector<HTMLElement>(".bar-hint");
    if (hint) {
      hint.textContent = HINT;
      hint.classList.add("edit-hint");
    }
    // An app has no details while editing, as on Terminal's grid, so OK
    // picks it up as the key goes down rather than waiting to see a hold.
    for (const tile of inner.el.querySelectorAll<HTMLElement>("[data-details]")) delete tile.dataset.details;
    // Each move draws home again: its lists keep where they were scrolled.
    const was = [...el.querySelectorAll<HTMLElement>("[data-scroll]")].map((list) => [list.scrollLeft, list.scrollTop]);
    el.replaceChildren(inner.el);
    [...el.querySelectorAll<HTMLElement>("[data-scroll]")].forEach((list, at) => {
      if (was[at]) [list.scrollLeft, list.scrollTop] = was[at];
    });
    for (const tile of el.querySelectorAll<HTMLElement>("[data-id]")) tile.classList.toggle("held", tile.dataset.id === held?.id);
    // The app asked for, or the first: editing starts on an app, never on
    // Cinema's Play.
    const target = focusId ? el.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusId)}"]`) : null;
    const firstApp = [...el.querySelectorAll<HTMLElement>("[data-id]")].find((tile) => layout.some((one) => one.id === tile.dataset.id));
    return target ?? firstApp ?? inner.first;
  };
  const redraw = (focusId?: string) => {
    const target = draw(focusId);
    if (target) ctx.focus.set(target, false);
  };

  // The ids in the held app's shelf, in the order the look draws them: the
  // apps, or the games in their own row.
  const shelfOf = (id: string): string[] => {
    const shelf = shelves(ordered(shadow()).filter((app) => !pinned.includes(app.id)));
    const list = shelf.games.some((app) => app.id === id) ? shelf.games : shelf.apps;
    return list.map((app) => app.id);
  };

  const save = async (before: Placed[], focusId?: string, pinnedBefore = pinned) => {
    const laid = same(before, layout);
    const kept = same(pinnedBefore, pinned);
    if (laid && kept) return;
    if ((laid || (await ctx.saveLayout(layout))) && (kept || (await ctx.savePinned(pinned)))) {
      layout = ctx.state.layout.map((tile) => ({ ...tile }));
      if (glass) pinned = [...(ctx.state.pinned ?? pinned)];
      ctx.sounds.play("confirm");
      return;
    }
    layout = before;
    pinned = pinnedBefore;
    redraw(focusId);
    ctx.sounds.play("failure");
  };

  // Puts an app at a place in its shelf, as the look draws it, and the apps
  // between move along one to make room. False when there's no such place.
  const place = (id: string, to: number): boolean => {
    const shelf = shelfOf(id);
    const from = shelf.indexOf(id);
    if (from < 0 || to < 0 || to >= shelf.length || to === from) return false;
    const moved = [...shelf];
    moved.splice(from, 1);
    moved.splice(to, 0, id);
    // The shelf's apps take the places in home's order the shelf had, in
    // their new order, so the other shelf stays where it is.
    let next = 0;
    const order = ordered(shadow()).map((app) => (shelf.includes(app.id) ? moved[next++] : app.id));
    const result = reorder(layout, order, grid);
    if (!result) return false;
    layout = result;
    return true;
  };

  // Where up or down takes an app in Glass: the place under or over it in
  // the row above or below, or that row's last when it's shorter. Null in
  // Cinema, whose apps are one row, past the first or last row, and across
  // from the apps to the games.
  const across = (id: string, by: 1 | -1): number | null => {
    const tile = el.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    const row = tile?.closest(".glass-row");
    if (!tile || !row) return null;
    const rows = [...el.querySelectorAll(".glass-row:not(.glass-pinned)")];
    const target = rows[rows.indexOf(row) + by];
    if (!target) return null;
    const column = [...row.querySelectorAll(":scope > .tile")].indexOf(tile);
    const shelf = shelfOf(id);
    const there = [...target.querySelectorAll<HTMLElement>(":scope > .tile")];
    const apps = there.filter((one) => shelf.includes(one.dataset.id ?? ""));
    if (!apps.length) return null;
    const under = there[Math.min(column, there.length - 1)];
    const pick = apps.includes(under) ? under : apps[apps.length - 1];
    return shelf.indexOf(pick.dataset.id!);
  };

  // Glass's pinned row: an app swaps places with another across its edge.
  // The two trade places in home's order, and the one coming up takes the
  // other's place in the pinned row.
  const panel = () => el.querySelector<HTMLElement>(".glass-pinned");
  const firstRow = () => el.querySelector<HTMLElement>(".glass-list > .glass-row");
  const column = (tile: HTMLElement) => [...(tile.parentElement?.querySelectorAll(":scope > .tile") ?? [])].indexOf(tile);
  const swap = (down: string, up: string): boolean => {
    const order = ordered(shadow()).map((app) => (app.id === down ? up : app.id === up ? down : app.id));
    const result = reorder(layout, order, grid);
    if (!result) return false;
    layout = result;
    pinned = pinned.map((one) => (one === down ? up : one));
    return true;
  };
  const pinnedStep = (id: string, action: "left" | "right" | "up" | "down"): boolean | null => {
    if (!glass) return null;
    const at = pinned.indexOf(id);
    const tile = el.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    if (at >= 0) {
      if (action === "up") return false;
      if (action === "left" || action === "right") {
        const to = at + (action === "left" ? -1 : 1);
        if (to < 0 || to >= pinned.length) return false;
        pinned = [...pinned];
        [pinned[at], pinned[to]] = [pinned[to], pinned[at]];
        return true;
      }
      const there = [...(firstRow()?.querySelectorAll<HTMLElement>(":scope > .tile[data-id]") ?? [])];
      const under = there[Math.min(at, there.length - 1)];
      return Boolean(under?.dataset.id && swap(id, under.dataset.id));
    }
    // Up from the list's first row: into the pinned row.
    if (action !== "up" || !tile || tile.closest(".glass-row") !== firstRow()) return null;
    const c = column(tile);
    if (pinned.length < MOST_PINNED && c >= pinned.length) {
      pinned = [...pinned, id];
      return true;
    }
    const over = pinned[Math.min(c, pinned.length - 1)];
    return Boolean(over && panel() && swap(over, id));
  };

  const step = (id: string, action: "left" | "right" | "up" | "down") => {
    const done = pinnedStep(id, action);
    if (done !== null) {
      if (!done) ctx.sounds.play("failure");
      else {
        ctx.sounds.play("move");
        redraw(id);
      }
      return;
    }
    const at = shelfOf(id).indexOf(id);
    const to = action === "left" ? at - 1 : action === "right" ? at + 1 : across(id, action === "down" ? 1 : -1);
    if (to === null || !place(id, to)) {
      ctx.sounds.play("failure");
      return;
    }
    ctx.sounds.play("move");
    redraw(id);
  };

  const remove = (id: string) => {
    const order = pinned.includes(id) ? pinned : shelfOf(id);
    const at = order.indexOf(id);
    const before = layout;
    const pinnedBefore = pinned;
    layout = unpin(layout, id);
    pinned = pinned.filter((one) => one !== id);
    const near = order[at + 1] ?? order[at - 1];
    redraw(near);
    void save(before, id, pinnedBefore);
  };

  // A click is OK on what it lands on, as on home, so a mouse picks an app
  // up and puts it down too. Nothing on home opens while editing.
  el.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-id]");
      if (!tile) return;
      if (!held) ctx.focus.set(tile, false);
      view.act!("ok");
    },
    true,
  );

  const first = draw(focusOn);
  const view: View = {
    el,
    first,
    focused(target) {
      inner.focused?.(target);
    },
    act(action) {
      if (action === "home") return false;
      const id = ctx.focus.get()?.dataset.id;
      if (held) {
        if (action === "left" || action === "right" || action === "up" || action === "down") step(held.id, action);
        else if (action === "ok") {
          const before = held.before;
          const pinnedBefore = held.pinned;
          const put = held.id;
          held = null;
          redraw(put);
          // Moved from its details: home, with the focus where it went,
          // once it's kept.
          const done = same(before, layout) && same(pinnedBefore, pinned) ? (ctx.sounds.play("back"), Promise.resolve()) : save(before, put, pinnedBefore);
          if (moving) void done.then(() => ctx.home(put));
        } else if (action === "back") {
          const put = held.id;
          layout = held.before;
          pinned = held.pinned;
          held = null;
          redraw(put);
          ctx.sounds.play("back");
          if (moving) ctx.back();
        }
        return true;
      }
      if (action === "ok") {
        // Only an app is picked up. Nothing else on home opens while editing.
        if (id && layout.some((tile) => tile.id === id)) {
          held = { id, before: layout, pinned };
          redraw(id);
          ctx.sounds.play("select");
        }
        return true;
      }
      if (action === "remove" && id && layout.some((tile) => tile.id === id)) {
        remove(id);
        return true;
      }
      // Sizes are Terminal's: neither row look draws an app bigger.
      if (action === "plus" || action === "minus" || action === "info" || action === "edit" || action === "pin" || action === "quit") return true;
      // The arrows move the focus as on home, and Back leaves.
      return action === "back" ? false : (inner.act?.(action) ?? false);
    },
  };
  return view;
}
