// Arrange home on the phone (ADR-015, S4.7, board 24): a miniature of the
// viewer's 4 × 3 grid. Tap a tile, then where it goes; its sizes and Unpin
// show while it's picked, and apps not on home can be pinned. Each change is
// kept by the box at once, and the TV follows within a second. The grid's
// rules are the TV's own, from the launcher's layout.ts.

import { choices, COLUMNS, move, pin, ROWS, span, unpin, resize, type Placed, type Size } from "../launcher/layout.ts";
import { glyph } from "../launcher/glyphs.ts";
import { api, h, prompt, toast, type Viewer } from "./lib.ts";
import { withPin } from "./pad.ts";

interface Home {
  viewer: Viewer;
  appsTile: string;
  apps: { id: string; name: string; sizes: { size: Size; label: string }[] }[];
  layout: Placed[];
}

export async function arrange(root: HTMLElement): Promise<void> {
  let home: Home;
  try {
    home = await api<Home>("GET", "/api/phone/home");
  } catch (error) {
    toast(`${(error as Error).message}.`);
    return;
  }
  let picked: string | null = null;
  const name = (id: string) => (id === home.appsTile ? "all apps" : (home.apps.find((app) => app.id === id)?.name ?? id)).toLowerCase();

  const save = async (next: Placed[] | null) => {
    if (!next) {
      toast("there's no room for that on home.");
      return;
    }
    try {
      const reply = await withPin("arranging a kid's home", (grant) => api<{ layout: Placed[] }>("PUT", "/api/phone/layout", { layout: next }, grant));
      if (!reply) return;
      home.layout = reply.layout;
      navigator.vibrate?.(8);
    } catch (error) {
      toast(`${(error as Error).message}.`);
    }
    draw();
  };

  // A tile picked goes where the next tap is, and is let go of after.
  const tap = (x: number, y: number, id?: string) => {
    if (picked && id === picked) picked = null;
    else if (picked) {
      const moving = picked;
      picked = null;
      void save(move(home.layout, moving, x, y));
    } else if (id) picked = id;
    draw();
  };

  const draw = () => {
    const grid = h("div", { class: "mini-grid" });
    const covered = new Set<string>();
    for (const tile of home.layout) {
      const { w, h: rows } = span(tile.size);
      for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < rows; dy++) covered.add(`${tile.x + dx},${tile.y + dy}`);
      const el = h(
        "button",
        { type: "button", class: `mini-tile${tile.id === picked ? " picked" : ""}`, "data-id": tile.id, onclick: () => tap(tile.x, tile.y, tile.id) },
        name(tile.id),
      );
      el.style.gridColumn = `${tile.x + 1} / span ${w}`;
      el.style.gridRow = `${tile.y + 1} / span ${rows}`;
      grid.append(el);
    }
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLUMNS; x++) {
        if (covered.has(`${x},${y}`)) continue;
        const el = h("button", { type: "button", class: "mini-empty", "data-cell": `${x},${y}`, onclick: () => tap(x, y) }, "empty");
        el.style.gridColumn = `${x + 1}`;
        el.style.gridRow = `${y + 1}`;
        grid.append(el);
      }
    }
    const app = picked ? home.apps.find((a) => a.id === picked) : undefined;
    const current = picked ? home.layout.find((t) => t.id === picked) : undefined;
    const sizes =
      picked && current
        ? h(
            "div",
            { class: "sizes" },
            h("p", { class: "label" }, `size · ${name(picked)}`),
            ...(app
              ? choices(home.layout, picked, app.sizes.map((s) => s.size)).map(({ size, room }) =>
                  h(
                    "button",
                    { type: "button", class: `chip${current.size === size ? " on" : ""}`, "data-size": size, disabled: !room, onclick: () => void save(resize(home.layout, picked!, size)) },
                    `${size} ${app.sizes.find((s) => s.size === size)?.label ?? ""}${room ? "" : " · no room"}`,
                  ),
                )
              : []),
            picked !== home.appsTile
              ? h("button", { type: "button", class: "chip", "data-action": "unpin", onclick: () => ((picked = null), void save(unpin(home.layout, current.id))) }, glyph("minus", 14), h("span", {}, "unpin"))
              : null,
          )
        : null;
    const off = home.apps.filter((a) => !home.layout.some((t) => t.id === a.id));
    const parts: (HTMLElement | null)[] = [
      prompt("tv home --edit"),
      h("h1", {}, "arrange home"),
      h("p", { class: "note" }, `for ${home.viewer.name}`),
      grid,
      sizes,
      h("p", { class: "note" }, picked ? "now tap where it goes. the tv follows live." : "tap a tile, then where it goes. the tv follows live."),
      off.length ? h("p", { class: "label" }, "# not on home") : null,
      ...off.map((a) => h("div", { class: "off" }, h("span", {}, a.name.toLowerCase()), h("button", { type: "button", class: "chip", "data-pin": a.id, onclick: () => void save(pin(home.layout, a.id)) }, glyph("plus", 14), h("span", {}, "pin")))),
    ];
    root.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null));
  };
  draw();
}
