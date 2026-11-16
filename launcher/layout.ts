// The home screen's grid (ADR-015, ADR-016): 4 × 3 cells, and tiles that are
// small (1 × 1), medium (2 × 1) or large (2 × 2). The launcher uses these to
// edit a layout and the daemon to check one before it keeps it, so a layout
// on the box is always one the grid can draw. Terminal at more on screen has
// a 5 × 4 grid with a layout of its own (ADR-062, D6), so each of these takes
// the grid, 4 × 3 unless it says.
//
// With the looks on, home has no tile limit (ADR-103): a profile's layout is
// kept on HOME, Terminal's four columns with as many rows as it needs.
// Terminal's grid shows the tiles in its first three rows, and Glass and
// Cinema draw every tile in reading order, in rows that grow.

export const COLUMNS = 4;
export const ROWS = 3;

export interface Grid {
  columns: number;
  rows: number;
}

export const GRID: Grid = { columns: COLUMNS, rows: ROWS };
export const GRID_MORE: Grid = { columns: 5, rows: 4 };
// Only so a layout's numbers stay sane: 256 cells is more apps than a TV has.
export const MOST_ROWS = 64;
export const HOME: Grid = { columns: COLUMNS, rows: MOST_ROWS };

export type Size = "s" | "m" | "l";
export const SIZES: Size[] = ["s", "m", "l"];
const SPAN: Record<Size, { w: number; h: number }> = { s: { w: 1, h: 1 }, m: { w: 2, h: 1 }, l: { w: 2, h: 2 } };

export interface Placed {
  id: string;
  x: number;
  y: number;
  size: Size;
}

export function span(size: Size): { w: number; h: number } {
  return SPAN[size];
}

function covers(tile: Placed, x: number, y: number): boolean {
  const { w, h } = SPAN[tile.size];
  return x >= tile.x && x < tile.x + w && y >= tile.y && y < tile.y + h;
}

function overlaps(a: Placed, b: Placed): boolean {
  const sa = SPAN[a.size];
  const sb = SPAN[b.size];
  return a.x < b.x + sb.w && b.x < a.x + sa.w && a.y < b.y + sb.h && b.y < a.y + sa.h;
}

export function inside(tile: Placed, grid: Grid = GRID): boolean {
  const { w, h } = SPAN[tile.size];
  return Number.isInteger(tile.x) && Number.isInteger(tile.y) && tile.x >= 0 && tile.y >= 0 && tile.x + w <= grid.columns && tile.y + h <= grid.rows;
}

// The tiles a grid shows: those wholly inside it, as Terminal's 4 × 3 shows
// the first three rows of a layout kept on HOME.
export function shown(layout: Placed[], grid: Grid = GRID): Placed[] {
  return layout.filter((tile) => inside(tile, grid));
}

// The layout's tiles in reading order, the order the row looks draw.
export function reading(layout: Placed[]): Placed[] {
  return [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
}

// The tile at a cell, if any.
export function at(layout: Placed[], x: number, y: number): Placed | undefined {
  return layout.find((tile) => covers(tile, x, y));
}

// Why a layout isn't one the grid can draw, or null. sizes says which sizes
// each tile may take; a tile it doesn't know isn't allowed.
export function problem(layout: unknown, sizes: (id: string) => Size[] | undefined, grid: Grid = GRID): string | null {
  if (!Array.isArray(layout)) return "a layout is a list of tiles";
  const seen = new Set<string>();
  for (const [i, tile] of (layout as Placed[]).entries()) {
    if (typeof tile !== "object" || tile === null || typeof tile.id !== "string") return "each tile has an id";
    if (seen.has(tile.id)) return `${tile.id} is on the grid twice`;
    seen.add(tile.id);
    const allowed = sizes(tile.id);
    if (!allowed) return `${tile.id} isn't an app on this TV`;
    if (!SIZES.includes(tile.size) || !allowed.includes(tile.size)) return `${tile.id} can't be size ${String(tile.size)}`;
    if (!inside(tile, grid)) return `${tile.id} doesn't fit on the grid there`;
    for (const other of (layout as Placed[]).slice(0, i)) {
      if (overlaps(tile, other)) return `${tile.id} overlaps ${other.id}`;
    }
  }
  return null;
}

// The first place, in reading order, where a tile of this size fits.
export function firstFree(layout: Placed[], size: Size, id = "", grid: Grid = GRID): { x: number; y: number } | null {
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.columns; x++) {
      const tile = { id, x, y, size };
      if (inside(tile, grid) && !layout.some((other) => overlaps(tile, other))) return { x, y };
    }
  }
  return null;
}

// Puts each displaced tile in the next free place in reading order. Null when
// one has nowhere to go.
function rehome(layout: Placed[], displaced: Placed[], first?: { x: number; y: number }, grid: Grid = GRID): Placed[] | null {
  const result = [...layout];
  const order = [...displaced].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const [i, tile] of order.entries()) {
    // A swap: the one tile a move lands on goes where the moved tile was.
    if (i === 0 && first && order.length === 1) {
      const swapped = { ...tile, ...first };
      if (inside(swapped, grid) && !result.some((other) => overlaps(swapped, other))) {
        result.push(swapped);
        continue;
      }
    }
    const place = firstFree(result, tile.size, tile.id, grid);
    if (!place) return null;
    result.push({ ...tile, ...place });
  }
  return result;
}

// Pins id at the first place it fits, small unless said otherwise. Null when
// there's no room.
export function pin(layout: Placed[], id: string, size: Size = "s", grid: Grid = GRID): Placed[] | null {
  if (layout.some((tile) => tile.id === id)) return layout;
  const place = firstFree(layout, size, id, grid);
  return place ? [...layout, { id, size, ...place }] : null;
}

// The layout with these tiles in this reading order, for the row looks,
// which draw home in order: an app moved in Glass or Cinema. Tiles not named
// stay where they are. Where each named tile can take the place of the one
// that comes at its new spot, size for size, it does, so Terminal's grid
// keeps its shape. Otherwise the named tiles are laid out again around the
// others, in order, each at the first place after the one before where it
// fits. Null when a name isn't on the layout, or one has no room.
export function reorder(layout: Placed[], order: string[], grid: Grid = HOME): Placed[] | null {
  const moving = order.map((id) => layout.find((tile) => tile.id === id));
  if (moving.some((tile) => !tile) || new Set(order).size !== order.length) return null;
  const tiles = moving as Placed[];
  const slots = reading(tiles);
  const kept = layout.filter((tile) => !order.includes(tile.id));
  if (tiles.every((tile, i) => tile.size === slots[i].size)) {
    const placed = tiles.map((tile, i) => ({ ...tile, x: slots[i].x, y: slots[i].y }));
    return [...kept, ...placed];
  }
  const result = [...kept];
  let from = { x: slots[0]?.x ?? 0, y: slots[0]?.y ?? 0 };
  for (const tile of tiles) {
    const place = freeFrom(result, tile.size, from, grid);
    if (!place) return null;
    result.push({ ...tile, ...place });
    from = place;
  }
  return result;
}

// The first place at or after from, in reading order, where a tile of this
// size fits.
function freeFrom(layout: Placed[], size: Size, from: { x: number; y: number }, grid: Grid): { x: number; y: number } | null {
  for (let y = from.y; y < grid.rows; y++) {
    for (let x = y === from.y ? from.x : 0; x < grid.columns; x++) {
      const tile = { id: "", x, y, size };
      if (inside(tile, grid) && !layout.some((other) => overlaps(tile, other))) return { x, y };
    }
  }
  return null;
}

export function unpin(layout: Placed[], id: string): Placed[] {
  return layout.filter((tile) => tile.id !== id);
}

// Where a tile of a new size goes: it grows right and down from where it is,
// or left and up at the edge of the grid (ADR-016).
function grown(tile: Placed, size: Size, grid: Grid = GRID): Placed {
  const { w, h } = SPAN[size];
  return { ...tile, size, x: Math.min(tile.x, grid.columns - w), y: Math.min(tile.y, grid.rows - h) };
}

// The layout with id at a new size. The tiles it covers move to the next free
// cells in reading order. Null when one of them has no room, which the size
// pickers show as "no room".
export function resize(layout: Placed[], id: string, size: Size, grid: Grid = GRID): Placed[] | null {
  const tile = layout.find((t) => t.id === id);
  if (!tile) return null;
  if (tile.size === size) return layout;
  const next = grown(tile, size, grid);
  const rest = layout.filter((t) => t.id !== id);
  const displaced = rest.filter((t) => overlaps(next, t));
  const kept = rest.filter((t) => !overlaps(next, t));
  return rehome([...kept, next], displaced, undefined, grid);
}

// The layout with id moved to x, y, kept on the grid. A tile it lands on
// swaps places with it when it fits there; otherwise the tiles it covers move
// to the next free cells in reading order. Null when one has no room.
export function move(layout: Placed[], id: string, x: number, y: number, grid: Grid = GRID): Placed[] | null {
  const tile = layout.find((t) => t.id === id);
  if (!tile) return null;
  const { w, h } = SPAN[tile.size];
  const next = { ...tile, x: Math.max(0, Math.min(x, grid.columns - w)), y: Math.max(0, Math.min(y, grid.rows - h)) };
  if (next.x === tile.x && next.y === tile.y) return layout;
  const rest = layout.filter((t) => t.id !== id);
  const displaced = rest.filter((t) => overlaps(next, t));
  const kept = rest.filter((t) => !overlaps(next, t));
  return rehome([...kept, next], displaced, { x: tile.x, y: tile.y }, grid);
}

// The sizes a tile can take right now, and for each whether there's room.
export function choices(layout: Placed[], id: string, sizes: Size[], grid: Grid = GRID): { size: Size; room: boolean }[] {
  return sizes.map((size) => ({ size, room: resize(layout, id, size, grid) !== null }));
}
