// Arrange home on the phone (ADR-015, S4.7, board 24): a miniature of the
// viewer's 4 × 3 grid. Tap a tile, then where it goes; its sizes and Unpin
// show while it's picked, and apps not on home can be pinned. Each change is
// kept by the box at once, and the TV follows within a second. The grid's
// rules are the TV's own, from the launcher's layout.ts.
//
// With the TV in Glass or Cinema, home is rows with no tile limit (ADR-103),
// and so is this: the apps in rows of six, then the games, as the TV draws
// them. Tap an app, then the place it goes, and the others move up one. In
// Terminal, the grid shows its 4 × 3, and says how many more are in Apps.
//
// Glass has its top row first, up to six apps or games, as the TV pins them.
// A tap on another app in the top row puts the picked one there, and a tap
// across its edge swaps the two. Top row adds the picked app to it, or
// takes it off.

import { choices, COLUMNS, GRID, HOME, inside, move, pin, reading, reorder, ROWS, span, unpin, resize, type Placed, type Size } from "../launcher/layout.ts";
import { glyph } from "../launcher/glyphs.ts";
import { api, h, prompt, toast, type Viewer } from "./lib.ts";
import { withPin } from "./pad.ts";

interface Home {
  viewer: Viewer;
  appsTile: string;
  apps: { id: string; name: string; category?: string; sizes: { size: Size; label: string }[] }[];
  layout: Placed[];
  // The TV's look, or null with the looks off.
  look?: string | null;
  // Glass's top row, in its order.
  pinned?: string[];
}

// Glass's rows, which the phone draws Cinema's apps in too, and the most
// its top row holds.
const PER_ROW = 6;

export async function arrange(root: HTMLElement): Promise<void> {
  let home: Home;
  try {
    home = await api<Home>("GET", "/api/phone/home");
  } catch (error) {
    toast((error as Error).message);
    return;
  }
  let picked: string | null = null;
  const name = (id: string) => id === home.appsTile ? "All apps" : (home.apps.find((app) => app.id === id)?.name ?? id);
  // Glass and Cinema draw home as rows. With the looks on, home has no tile
  // limit, in any look.
  const rows = () => home.look === "glass" || home.look === "cinema";
  const keptOn = () => (home.look ? HOME : GRID);
  const isGame = (id: string) => home.apps.find((app) => app.id === id)?.category === "games";
  const glass = () => home.look === "glass";
  const pinned = () => (glass() ? (home.pinned ?? []) : []);
  const isPinned = (id: string) => pinned().includes(id);

  const savePinned = async (next: string[]) => {
    try {
      const reply = await withPin("arranging a child's home", (grant) => api<{ pinned: string[] }>("PUT", "/api/phone/pinned", { pinned: next }, grant));
      if (!reply) return;
      home.pinned = reply.pinned;
      navigator.vibrate?.(8);
    } catch (error) {
      toast((error as Error).message);
    }
    draw();
  };

  // True once the box kept it.
  const save = async (next: Placed[] | null): Promise<boolean> => {
    let kept = false;
    if (!next) {
      toast("Home is full. Make room first.");
      return kept;
    }
    try {
      const reply = await withPin("arranging a child's home", (grant) => api<{ layout: Placed[] }>("PUT", "/api/phone/layout", { layout: next }, grant));
      if (reply) {
        home.layout = reply.layout;
        kept = true;
        navigator.vibrate?.(8);
      }
    } catch (error) {
      toast((error as Error).message);
    }
    draw();
    return kept;
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

  // Glass's top row: the picked app takes the tapped one's place in it, or
  // the two swap across its edge, each taking the other's place in home's
  // order too.
  const tapPinned = (moving: string, id: string) => {
    const top = pinned();
    if (isPinned(moving) && isPinned(id)) {
      const next = top.filter((one) => one !== moving);
      next.splice(top.indexOf(id), 0, moving);
      return void savePinned(next);
    }
    const [up, down] = isPinned(id) ? [moving, id] : [id, moving];
    const order = reading(home.layout).map((tile) => tile.id);
    const swapped = reorder(home.layout, order.map((one) => (one === up ? down : one === down ? up : one)), keptOn());
    const next = top.map((one) => (one === down ? up : one));
    void save(swapped).then((kept) => {
      if (kept) void savePinned(next);
    });
  };

  // In the row looks: a tap picks an app up, and a tap on another in its
  // shelf puts it there, the others moving up one.
  const tapRow = (id: string) => {
    if (picked === id) picked = null;
    else if (picked && (isPinned(picked) || isPinned(id))) {
      const moving = picked;
      picked = null;
      tapPinned(moving, id);
    } else if (picked && isGame(picked) === isGame(id)) {
      const order = reading(home.layout).map((tile) => tile.id);
      const shelf = order.filter((one) => isGame(one) === isGame(id) && one !== home.appsTile && !isPinned(one));
      const moved = shelf.filter((one) => one !== picked);
      moved.splice(shelf.indexOf(id), 0, picked);
      let next = 0;
      picked = null;
      void save(reorder(home.layout, order.map((one) => (shelf.includes(one) ? moved[next++] : one)), keptOn()));
    } else picked = id;
    draw();
  };

  const rowsOf = (ids: string[], top = false) => {
    const box = h("div", { class: `mini-rows${top ? " mini-pinned" : ""}` });
    for (const id of ids) box.append(h("button", { type: "button", class: `mini-tile${id === picked ? " picked" : ""}`, "data-id": id, onclick: () => tapRow(id) }, name(id)));
    // Room left in the top row: a tap there adds the picked app.
    if (top) {
      for (let at = ids.length; at < PER_ROW; at++) {
        box.append(
          h(
            "button",
            {
              type: "button",
              class: "mini-empty",
              "data-cell": `top-${at}`,
              onclick: () => {
                if (!picked) return;
                const id = picked;
                picked = null;
                void savePinned([...pinned().filter((one) => one !== id), id]);
              },
            },
            "Empty",
          ),
        );
      }
    }
    return box;
  };

  const draw = () => {
    if (rows()) return drawRows();
    const grid = h("div", { class: "mini-grid" });
    const covered = new Set<string>();
    // The grid shows the tiles that fit it; with the looks on, home can go
    // on past it, and those are in Apps on the TV.
    const past = home.layout.filter((tile) => !inside(tile, GRID) && tile.id !== home.appsTile).length;
    for (const tile of home.layout.filter((one) => inside(one, GRID))) {
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
        const el = h("button", { type: "button", class: "mini-empty", "data-cell": `${x},${y}`, onclick: () => tap(x, y) }, "Empty");
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
            h("p", { class: "label" }, `Size · ${name(picked)}`),
            ...(app
              ? choices(home.layout, picked, app.sizes.map((s) => s.size)).map(({ size, room }) =>
                  h(
                    "button",
                    { type: "button", class: `chip${current.size === size ? " on" : ""}`, "data-size": size, disabled: !room, onclick: () => void save(resize(home.layout, picked!, size)) },
                    `${size.toUpperCase()} ${app.sizes.find((s) => s.size === size)?.label ?? ""}${room ? "" : " · no room"}`,
                  ),
                )
              : []),
            picked !== home.appsTile
              ? h("button", { type: "button", class: "chip", "data-action": "unpin", onclick: () => ((picked = null), void save(unpin(home.layout, current.id))) }, glyph("minus", 14), h("span", {}, "Remove"))
              : null,
          )
        : null;
    const parts: (HTMLElement | null)[] = [
      prompt("tv home --edit"),
      h("h1", {}, "Edit home"),
      h("p", { class: "note" }, `For ${home.viewer.name}`),
      grid,
      past ? h("p", { class: "note", "data-past": String(past) }, `${past} more on home, in Apps on the TV`) : null,
      sizes,
      h("p", { class: "note" }, picked ? "Now tap where it goes" : "Tap a tile, then tap where it goes"),
      ...notOnHome(),
    ];
    root.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null));
  };

  // The apps not on home, each with Add.
  const notOnHome = () => {
    const off = home.apps.filter((a) => !home.layout.some((t) => t.id === a.id));
    return [
      off.length ? h("p", { class: "label" }, "# Not on home") : null,
      ...off.map((a) => h("div", { class: "off" }, h("span", {}, a.name), h("button", { type: "button", class: "chip", "data-pin": a.id, onclick: () => void save(pin(home.layout, a.id, "s", keptOn())) }, glyph("plus", 14), h("span", {}, "Add")))),
    ];
  };

  // Glass and Cinema: the apps in rows of six, then the games, in the
  // order the TV draws them. Neither draws an app bigger, so there are no
  // sizes here, only Remove.
  const drawRows = () => {
    const order = reading(home.layout)
      .map((tile) => tile.id)
      .filter((id) => id !== home.appsTile && home.apps.some((app) => app.id === id));
    const top = pinned().filter((id) => order.includes(id));
    const apps = order.filter((id) => !isGame(id) && !top.includes(id));
    const games = order.filter((id) => isGame(id) && !top.includes(id));
    const shelves = h(
      "div",
      { class: "mini-shelves" },
      ...(glass() ? [h("p", { class: "label" }, "# Top row"), rowsOf(top, true)] : []),
      ...(apps.length || !glass() ? [rowsOf(apps)] : []),
      ...(games.length ? [h("p", { class: "label" }, "# Games"), rowsOf(games)] : []),
    );
    const full = top.length >= PER_ROW;
    const topRow =
      picked && glass()
        ? h(
            "button",
            {
              type: "button",
              class: `chip${isPinned(picked) ? " on" : ""}`,
              "data-action": "top-row",
              disabled: !isPinned(picked) && full,
              onclick: () => {
                const id = picked!;
                picked = null;
                void savePinned(isPinned(id) ? top.filter((one) => one !== id) : [...top, id]);
              },
            },
            isPinned(picked) ? "Off the top row" : full ? "Top row · full" : "To the top row",
          )
        : null;
    const remove = picked
      ? h(
          "div",
          { class: "sizes" },
          h("p", { class: "label" }, name(picked)),
          topRow,
          h("button", { type: "button", class: "chip", "data-action": "unpin", onclick: () => { const id = picked!; picked = null; void save(unpin(home.layout, id)); } }, glyph("minus", 14), h("span", {}, "Remove")),
        )
      : null;
    const parts: (HTMLElement | null)[] = [
      prompt("tv home --edit"),
      h("h1", {}, "Edit home"),
      h("p", { class: "note" }, `For ${home.viewer.name}`),
      shelves,
      remove,
      h("p", { class: "note" }, picked ? "Now tap where it goes" : "Tap an app, then tap where it goes"),
      ...notOnHome(),
    ];
    root.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null));
  };
  draw();
}
