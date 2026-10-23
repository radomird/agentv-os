// Edit mode (ADR-015, ADR-016): the viewer's home grid, where tiles move,
// change size and come off. With the keyboard, Enter picks a tile up, the
// arrows carry it and Enter puts it down; + and - step through the sizes its
// app lists, and Delete takes it off home. With a mouse, drag a tile, drag
// its corner, or click it for the size bar. Every change is saved as it
// happens, and the tiles it moves glide to their new cells.

import type { SizeChoice } from "../api.ts";
import { h } from "../dom.ts";
import { at, choices, COLUMNS, move, resize, ROWS, span, unpin, type Placed, type Size } from "../layout.ts";
import type { Ctx, View } from "../main.ts";
import { placeTile, tileFor } from "./home.ts";
import { bar } from "./parts.ts";

const BADGE: Record<Size, string> = { s: "1×1", m: "2×1", l: "2×2" };
const DRAG_FROM = 8;

interface Drag {
  id: string;
  el: HTMLElement;
  corner: boolean;
  startX: number;
  startY: number;
  // Which of the tile's cells the pointer took it by.
  grabX: number;
  grabY: number;
  started: boolean;
  next: Placed[] | null;
}

function same(a: Placed[], b: Placed[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function reduced(): boolean {
  return document.documentElement.classList.contains("reduce-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function edit(ctx: Ctx, focusOn?: string): View {
  let layout = ctx.state.layout.map((tile) => ({ ...tile }));
  let held: { id: string; before: Placed[] } | null = null;
  let drag: Drag | null = null;
  let picking = false;
  const tiles = new Map<string, HTMLElement>();
  const grid = h("div", { class: "grid editing" });
  const marker = h("div", { class: "drop" });
  const sizebar = h("div", { class: "sizebar" });

  function sizesOf(id: string): SizeChoice[] {
    if (id === ctx.state.appsTile) return [{ size: "s", label: "all apps" }];
    return ctx.state.apps.find((app) => app.id === id)?.sizes ?? [{ size: "s", label: "logo" }];
  }

  function nameOf(id: string): string {
    return id === ctx.state.appsTile ? "all apps" : (ctx.state.apps.find((app) => app.id === id)?.name.toLowerCase() ?? id);
  }

  function dress(el: HTMLElement, placed: Placed): void {
    el.querySelector(".badge")?.remove();
    el.querySelector(".corner")?.remove();
    el.append(h("span", { class: "badge" }, BADGE[placed.size]));
    if (sizesOf(placed.id).length > 1) el.append(h("span", { class: "corner", "aria-hidden": "true" }));
  }

  // Draws the layout, keeping the tiles that are already there so they can
  // glide from where they were to their new cells. from overrides where a
  // tile starts, for one put down after a drag.
  function draw(from = new Map<string, DOMRect>()): void {
    const before = new Map([...tiles].map(([id, el]) => [id, from.get(id) ?? el.getBoundingClientRect()]));
    for (const [id, el] of tiles) {
      if (!layout.some((tile) => tile.id === id)) {
        el.remove();
        tiles.delete(id);
      }
    }
    for (const placed of layout) {
      let el = tiles.get(placed.id);
      if (!el || !el.classList.contains(`size-${placed.size}`)) {
        const fresh = tileFor(ctx, placed, true);
        if (!fresh) continue;
        if (el) {
          // A new size draws the tile again; the focus stays on it.
          const focused = ctx.focus.get() === el;
          fresh.className = el.className.replace(/size-[sml]/, `size-${placed.size}`);
          el.replaceWith(fresh);
          if (focused) ctx.focus.set(fresh, false);
        } else grid.append(fresh);
        el = fresh;
        tiles.set(placed.id, el);
      }
      placeTile(el, placed);
      dress(el, placed);
      el.classList.toggle("held", held?.id === placed.id);
    }
    for (const empty of grid.querySelectorAll(".empty-cell")) empty.remove();
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLUMNS; x++) {
        if (at(layout, x, y)) continue;
        const empty = h("div", { class: "empty-cell" }, "empty");
        empty.style.gridColumn = String(x + 1);
        empty.style.gridRow = String(y + 1);
        grid.prepend(empty);
      }
    }
    // The ring goes to where the focused tile ends up, then the tiles glide.
    ctx.focus.refresh();
    if (!reduced()) {
      for (const [id, el] of tiles) {
        const was = before.get(id);
        if (!was || was.width === 0) continue;
        const now = el.getBoundingClientRect();
        const dx = was.left - now.left;
        const dy = was.top - now.top;
        const resized = Math.abs(was.width - now.width) > 2 || Math.abs(was.height - now.height) > 2;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !resized) continue;
        el.style.transition = "none";
        el.style.transformOrigin = "0 0";
        el.style.transform = `translate(${dx}px, ${dy}px)${resized ? ` scale(${was.width / now.width}, ${was.height / now.height})` : ""}`;
        void el.offsetWidth;
        el.style.transition = "";
        el.style.transform = "";
        el.addEventListener("transitionend", () => (el.style.transformOrigin = ""), { once: true });
      }
    }
    sizes();
  }

  // The size bar, under the tile being resized (or over it on the bottom
  // row): the app's own words for each size, "no room" for a size that
  // doesn't fit, and unpin.
  function sizes(): void {
    const el = ctx.focus.get();
    const id = el?.dataset.id;
    const placed = layout.find((tile) => tile.id === id);
    if (!el || !id || !placed || !picking || held || drag?.started) {
      sizebar.classList.remove("on");
      return;
    }
    const labels = new Map(sizesOf(id).map((choice) => [choice.size, choice.label]));
    const chips = choices(layout, id, [...labels.keys()]).map(({ size, room }) =>
      h(
        "button",
        {
          class: `chip${size === placed.size ? " current" : ""}${room ? "" : " no-room"}`,
          "data-size": size,
          disabled: !room,
          onclick: () => void setSize(id, size),
        },
        h("b", {}, size),
        ` · ${labels.get(size)}${room ? "" : " · no room"}`,
      ),
    );
    sizebar.replaceChildren(
      h("div", { class: "sizebar-head" }, h("span", {}, "size · ", h("span", { class: "sizebar-name" }, nameOf(id))), h("button", { class: "chip done", onclick: () => ctx.back() }, "esc done")),
      h(
        "div",
        { class: "sizebar-chips" },
        ...chips,
        id === ctx.state.appsTile ? null : h("button", { class: "chip unpin", onclick: () => void remove(id) }, "del unpin"),
      ),
    );
    // Where the tile ends up, not where it is while it glides there.
    const area = grid.getBoundingClientRect();
    const box = { left: area.left + el.offsetLeft, top: area.top + el.offsetTop, bottom: area.top + el.offsetTop + el.offsetHeight };
    const below = box.bottom + 16 + 150 < window.innerHeight - 60;
    sizebar.style.left = `${Math.min(Math.max(32, box.left), window.innerWidth - 32 - 920)}px`;
    sizebar.style.top = below ? `${box.bottom + 16}px` : "";
    sizebar.style.bottom = below ? "" : `${window.innerHeight - box.top + 16}px`;
    sizebar.classList.add("on");
  }

  // Keeps a change: on the screen at once, then on the box.
  async function commit(next: Placed[], sound: "confirm" | "success" = "confirm"): Promise<void> {
    const previous = layout;
    layout = next;
    draw();
    if (await ctx.saveLayout(layout)) {
      ctx.sounds.play(sound);
    } else {
      layout = previous;
      draw();
      ctx.sounds.play("failure");
    }
  }

  async function setSize(id: string, size: Size): Promise<void> {
    const next = resize(layout, id, size);
    if (!next) {
      ctx.sounds.play("failure");
      return;
    }
    if (!same(next, layout)) await commit(next);
  }

  // + and - step through the app's sizes, past any with no room.
  async function stepSize(direction: 1 | -1): Promise<void> {
    const id = ctx.focus.get()?.dataset.id;
    const placed = layout.find((tile) => tile.id === id);
    if (!id || !placed || held) return;
    picking = true;
    const order = sizesOf(id).map((choice) => choice.size);
    for (let i = order.indexOf(placed.size) + direction; i >= 0 && i < order.length; i += direction) {
      const next = resize(layout, id, order[i]);
      if (next) {
        await commit(next);
        return;
      }
    }
    sizes();
    ctx.sounds.play("failure");
  }

  async function remove(id: string): Promise<void> {
    if (id === ctx.state.appsTile) {
      ctx.toast("all apps stays on home");
      ctx.sounds.play("failure");
      return;
    }
    const gone = layout.find((tile) => tile.id === id);
    if (!gone) return;
    const previous = layout;
    layout = unpin(layout, id);
    picking = false;
    draw();
    // The focus goes to the nearest tile left.
    const nearest = [...layout].sort((a, b) => Math.abs(a.x - gone.x) + Math.abs(a.y - gone.y) - (Math.abs(b.x - gone.x) + Math.abs(b.y - gone.y)))[0];
    const el = nearest && tiles.get(nearest.id);
    if (el) ctx.focus.set(el, false);
    if (await ctx.saveLayout(layout)) {
      ctx.sounds.play("confirm");
    } else {
      layout = previous;
      draw();
      ctx.sounds.play("failure");
    }
  }

  // Carries the held tile one cell.
  function carry(dx: number, dy: number): void {
    const tile = held && layout.find((t) => t.id === held!.id);
    if (!tile) return;
    const { w, h: rows } = span(tile.size);
    const x = tile.x + dx;
    const y = tile.y + dy;
    if (x < 0 || y < 0 || x + w > COLUMNS || y + rows > ROWS) return;
    const next = move(layout, tile.id, x, y);
    if (!next || same(next, layout)) {
      ctx.sounds.play("failure");
      return;
    }
    layout = next;
    draw();
    ctx.sounds.play("move");
  }

  // The cell under a point on the screen.
  function cellAt(clientX: number, clientY: number): { x: number; y: number } {
    const box = grid.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const pad = parseFloat(style.paddingLeft);
    const gap = parseFloat(style.columnGap);
    const cellW = (box.width - pad * 2 - gap * (COLUMNS - 1)) / COLUMNS;
    const cellH = (box.height - pad * 2 - gap * (ROWS - 1)) / ROWS;
    const x = Math.floor((clientX - box.left - pad + gap / 2) / (cellW + gap));
    const y = Math.floor((clientY - box.top - pad + gap / 2) / (cellH + gap));
    return { x: Math.max(0, Math.min(COLUMNS - 1, x)), y: Math.max(0, Math.min(ROWS - 1, y)) };
  }

  function mark(placed: Placed | null, room: boolean): void {
    if (!placed) {
      marker.classList.remove("on");
      return;
    }
    placeTile(marker, placed);
    marker.textContent = room ? "moved here" : "no room";
    marker.classList.toggle("no-room", !room);
    marker.classList.add("on");
  }

  grid.addEventListener("pointerdown", (event) => {
    const el = (event.target as Element).closest<HTMLElement>(".tile");
    const id = el?.dataset.id;
    const placed = layout.find((tile) => tile.id === id);
    if (event.button !== 0 || !el || !id || !placed || held) return;
    const cell = cellAt(event.clientX, event.clientY);
    drag = {
      id,
      el,
      corner: (event.target as Element).closest(".corner") !== null,
      startX: event.clientX,
      startY: event.clientY,
      grabX: cell.x - placed.x,
      grabY: cell.y - placed.y,
      started: false,
      next: null,
    };
    grid.setPointerCapture(event.pointerId);
  });

  grid.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.started) {
      if (Math.hypot(dx, dy) < DRAG_FROM) return;
      drag.started = true;
      ctx.focus.set(drag.el, false);
      // The ring waits while the tile is in the hand.
      ctx.focus.hold();
      sizes();
    }
    const placed = layout.find((tile) => tile.id === drag!.id)!;
    const cell = cellAt(event.clientX, event.clientY);
    if (drag.corner) {
      // The corner: as many cells as it's pulled across, in the sizes the
      // app lists, the biggest that's no bigger than that.
      const wide = Math.abs(cell.x - placed.x) >= 1;
      const tall = Math.abs(cell.y - placed.y) >= 1;
      const wanted: Size = tall ? "l" : wide ? "m" : "s";
      const order: Size[] = ["s", "m", "l"];
      const allowed = sizesOf(placed.id).map((choice) => choice.size);
      const size = order.slice(0, order.indexOf(wanted) + 1).reverse().find((s) => allowed.includes(s)) ?? placed.size;
      drag.next = resize(layout, placed.id, size);
      const shown = { ...placed, size, x: Math.min(placed.x, COLUMNS - span(size).w), y: Math.min(placed.y, ROWS - span(size).h) };
      mark(size === placed.size ? null : shown, drag.next !== null);
    } else {
      drag.el.classList.add("dragging");
      drag.el.style.transition = "none";
      drag.el.style.transform = `translate(${dx}px, ${dy}px) rotate(-2deg)`;
      const { w, h: rows } = span(placed.size);
      const x = Math.max(0, Math.min(COLUMNS - w, cell.x - drag.grabX));
      const y = Math.max(0, Math.min(ROWS - rows, cell.y - drag.grabY));
      drag.next = move(layout, placed.id, x, y);
      mark(x === placed.x && y === placed.y ? null : { ...placed, x, y }, drag.next !== null);
    }
  });

  function finish(keep: boolean): void {
    const current = drag;
    drag = null;
    mark(null, true);
    if (!current) return;
    if (!current.started) {
      // A click: the tile and its size bar.
      ctx.focus.set(current.el, false);
      picking = true;
      sizes();
      return;
    }
    const from = new Map([[current.id, current.el.getBoundingClientRect()]]);
    current.el.classList.remove("dragging");
    current.el.style.transition = "none";
    current.el.style.transform = "";
    if (keep && current.next && !same(current.next, layout)) {
      const previous = layout;
      layout = current.next;
      draw(from);
      void ctx.saveLayout(layout).then((saved) => {
        ctx.sounds.play(saved ? "confirm" : "failure");
        if (!saved) {
          layout = previous;
          draw();
        }
      });
    } else {
      draw(from);
      if (keep && !current.next) ctx.sounds.play("failure");
    }
    // The ring comes back once the tile has landed.
    setTimeout(() => ctx.focus.release(), 220);
  }

  grid.addEventListener("pointerup", () => finish(true));
  grid.addEventListener("pointercancel", () => finish(false));
  // A click on the grid only picks a tile, which pointerup has done.
  grid.addEventListener(
    "click",
    (event) => {
      event.stopPropagation();
    },
    true,
  );

  grid.append(marker);
  const el = h(
    "div",
    { class: "screen" },
    grid,
    sizebar,
    bar(
      ctx,
      "edit home",
      `+/- size · del unpin · saved for ${ctx.state.viewer.name}`,
      [
        h("button", { class: "bar-link", "data-focus": true, "data-action": "done", onclick: () => ctx.back() }, "esc done"),
        h("span", { class: "bar-step" }, "drag with the mouse · or ←↑↓→ then ↵"),
      ],
    ),
  );
  draw();

  const reading = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
  return {
    el,
    first: tiles.get(focusOn ?? "") ?? tiles.get(reading[0]?.id ?? ""),
    busy: () => drag?.started === true,
    focused() {
      picking = false;
      sizes();
    },
    act(action) {
      const id = ctx.focus.get()?.dataset.id;
      if (action === "home") return false;
      if (held) {
        const moves: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
        if (action in moves) {
          carry(...moves[action]);
        } else if (action === "ok") {
          // Put it down.
          const before = held.before;
          held = null;
          draw();
          if (!same(before, layout)) {
            void ctx.saveLayout(layout).then((saved) => {
              ctx.sounds.play(saved ? "confirm" : "failure");
              if (!saved) {
                layout = before;
                draw();
              }
            });
          } else ctx.sounds.play("back");
        } else if (action === "back") {
          // Put it back where it was.
          layout = held.before;
          held = null;
          draw();
          ctx.sounds.play("back");
        }
        return true;
      }
      if (action === "ok" && id) {
        held = { id, before: layout };
        picking = false;
        draw();
        ctx.sounds.play("select");
        return true;
      }
      if (action === "plus" || action === "minus") {
        void stepSize(action === "plus" ? 1 : -1);
        return true;
      }
      if (action === "remove" && id) {
        void remove(id);
        return true;
      }
      // The rest (the arrows, back, Home) work as anywhere else.
      return action === "info" || action === "edit" || action === "pin";
    },
  };
}
