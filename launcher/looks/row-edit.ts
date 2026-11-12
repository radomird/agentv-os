// Editing home in Glass and Cinema, where home is rows of apps rather than
// Terminal's grid (pages/edit.ts). It's the look's own home, with the same
// keys as Terminal's: OK picks the focused app up, left and right carry it
// along its row, OK puts it down and Back puts it back. Delete takes it off
// home. Neither look draws an app bigger at another size, so + and - do
// nothing here; sizes are Terminal's, and the phone's. Every change is saved as it happens, to the profile's one layout,
// with the moves Terminal's grid makes, so Terminal's home stays whole.

import { move, unpin, type Placed, type Size } from "../layout.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { shelves } from "./games.ts";
import { ordered } from "./glass/home.ts";
import { lookHome } from "./homes.ts";
import { currentGrid } from "./looks.ts";

function same(a: unknown[], b: unknown[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const HINT = "Editing home. Move with the arrows, then OK";

export function rowEdit(ctx: Ctx, focusOn?: string): View {
  const grid = currentGrid();
  let layout = ctx.state.layout.map((tile) => ({ ...tile }));
  let held: { id: string; before: Placed[] } | null = null;
  // Home as it is now in this edit: the look draws it from a layout of its
  // own, which is saved as each change is made.
  const shadow = (): Ctx => Object.create(ctx, { state: { value: { ...ctx.state, layout } } }) as Ctx;
  const el = h("div", { class: "row-edit" });
  let inner: View;

  const draw = (focusId?: string): HTMLElement | undefined => {
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
    el.replaceChildren(inner.el);
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
    const shelf = shelves(ordered(shadow()));
    const list = shelf.games.some((app) => app.id === id) ? shelf.games : shelf.apps;
    return list.map((app) => app.id);
  };

  const save = async (before: Placed[], focusId?: string) => {
    if (same(before, layout)) return;
    if (await ctx.saveLayout(layout)) {
      layout = ctx.state.layout.map((tile) => ({ ...tile }));
      ctx.sounds.play("confirm");
      return;
    }
    layout = before;
    redraw(focusId);
    ctx.sounds.play("failure");
  };

  // Every app on home in the order the look draws them.
  const all = (): string[] => {
    const shelf = shelves(ordered(shadow()));
    return [...shelf.apps, ...shelf.games].map((app) => app.id);
  };
  const fits = (id: string, size: Size) => (ctx.state.apps.find((app) => app.id === id)?.sizes.map((one) => one.size) ?? ["s"]).includes(size);

  // One step along the row: it swaps places with its neighbour, as a move
  // on Terminal's grid does. Where that would shuffle other apps too, as a
  // big tile can on Terminal's grid, the two trade places and sizes
  // instead, which leaves the rest where they were.
  const step = (id: string, by: number) => {
    const order = shelfOf(id);
    const at = order.indexOf(id);
    const other = layout.find((tile) => tile.id === order[at + by]);
    const mine = layout.find((tile) => tile.id === id);
    if (!other || !mine) {
      ctx.sounds.play("failure");
      return;
    }
    const before = layout;
    const wanted = all().map((one) => (one === id ? other.id : one === other.id ? id : one));
    const tries = [
      () => move(layout, id, other.x, other.y, grid),
      () =>
        fits(id, other.size) && fits(other.id, mine.size)
          ? layout.map((tile) => (tile.id === id ? { ...tile, x: other.x, y: other.y, size: other.size } : tile.id === other.id ? { ...tile, x: mine.x, y: mine.y, size: mine.size } : tile))
          : null,
    ];
    for (const attempt of tries) {
      const next = attempt();
      if (!next) continue;
      layout = next;
      if (same(all(), wanted)) {
        ctx.sounds.play("move");
        redraw(id);
        return;
      }
      layout = before;
    }
    ctx.sounds.play("failure");
  };

  const remove = (id: string) => {
    const order = shelfOf(id);
    const at = order.indexOf(id);
    const before = layout;
    layout = unpin(layout, id);
    const near = order[at + 1] ?? order[at - 1];
    redraw(near);
    void save(before, id);
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
        if (action === "left" || action === "right") step(held.id, action === "right" ? 1 : -1);
        else if (action === "ok") {
          const before = held.before;
          const put = held.id;
          held = null;
          redraw(put);
          if (same(before, layout)) ctx.sounds.play("back");
          else void save(before, put);
        } else if (action === "back") {
          const put = held.id;
          layout = held.before;
          held = null;
          redraw(put);
          ctx.sounds.play("back");
        }
        return true;
      }
      if (action === "ok") {
        // Only an app is picked up. Nothing else on home opens while editing.
        if (id && layout.some((tile) => tile.id === id)) {
          held = { id, before: layout };
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
