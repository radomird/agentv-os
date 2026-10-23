// The home screen's grid (ADR-015, ADR-016): 4 × 3 cells, and tiles that are
// small (1 × 1), medium (2 × 1) or large (2 × 2). The launcher uses these to
// edit a layout and the daemon to check one before it keeps it, so a layout
// on the box is always one the grid can draw.

export const COLUMNS = 4;
export const ROWS = 3;

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

function inside(tile: Placed): boolean {
  const { w, h } = SPAN[tile.size];
  return Number.isInteger(tile.x) && Number.isInteger(tile.y) && tile.x >= 0 && tile.y >= 0 && tile.x + w <= COLUMNS && tile.y + h <= ROWS;
}

// The tile at a cell, if any.
export function at(layout: Placed[], x: number, y: number): Placed | undefined {
  return layout.find((tile) => covers(tile, x, y));
}

// Why a layout isn't one the grid can draw, or null. sizes says which sizes
// each tile may take; a tile it doesn't know isn't allowed.
export function problem(layout: unknown, sizes: (id: string) => Size[] | undefined): string | null {
  if (!Array.isArray(layout)) return "a layout is a list of tiles";
  const seen = new Set<string>();
  for (const [i, tile] of (layout as Placed[]).entries()) {
    if (typeof tile !== "object" || tile === null || typeof tile.id !== "string") return "each tile has an id";
    if (seen.has(tile.id)) return `${tile.id} is on the grid twice`;
    seen.add(tile.id);
    const allowed = sizes(tile.id);
    if (!allowed) return `${tile.id} isn't an app on this box`;
    if (!SIZES.includes(tile.size) || !allowed.includes(tile.size)) return `${tile.id} can't be size ${String(tile.size)}`;
    if (!inside(tile)) return `${tile.id} doesn't fit on the grid there`;
    for (const other of (layout as Placed[]).slice(0, i)) {
      if (overlaps(tile, other)) return `${tile.id} overlaps ${other.id}`;
    }
  }
  return null;
}

// The first place, in reading order, where a tile of this size fits.
export function firstFree(layout: Placed[], size: Size, id = ""): { x: number; y: number } | null {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLUMNS; x++) {
      const tile = { id, x, y, size };
      if (inside(tile) && !layout.some((other) => overlaps(tile, other))) return { x, y };
    }
  }
  return null;
}

// Puts each displaced tile in the next free place in reading order. Null when
// one has nowhere to go.
function rehome(layout: Placed[], displaced: Placed[], first?: { x: number; y: number }): Placed[] | null {
  const result = [...layout];
  const order = [...displaced].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const [i, tile] of order.entries()) {
    // A swap: the one tile a move lands on goes where the moved tile was.
    if (i === 0 && first && order.length === 1) {
      const swapped = { ...tile, ...first };
      if (inside(swapped) && !result.some((other) => overlaps(swapped, other))) {
        result.push(swapped);
        continue;
      }
    }
    const place = firstFree(result, tile.size, tile.id);
    if (!place) return null;
    result.push({ ...tile, ...place });
  }
  return result;
}

// Pins id at the first place it fits, small unless said otherwise. Null when
// there's no room.
export function pin(layout: Placed[], id: string, size: Size = "s"): Placed[] | null {
  if (layout.some((tile) => tile.id === id)) return layout;
  const place = firstFree(layout, size, id);
  return place ? [...layout, { id, size, ...place }] : null;
}

export function unpin(layout: Placed[], id: string): Placed[] {
  return layout.filter((tile) => tile.id !== id);
}

// Where a tile of a new size goes: it grows right and down from where it is,
// or left and up at the edge of the grid (ADR-016).
function grown(tile: Placed, size: Size): Placed {
  const { w, h } = SPAN[size];
  return { ...tile, size, x: Math.min(tile.x, COLUMNS - w), y: Math.min(tile.y, ROWS - h) };
}

// The layout with id at a new size. The tiles it covers move to the next free
// cells in reading order. Null when one of them has no room, which the size
// pickers show as "no room".
export function resize(layout: Placed[], id: string, size: Size): Placed[] | null {
  const tile = layout.find((t) => t.id === id);
  if (!tile) return null;
  if (tile.size === size) return layout;
  const next = grown(tile, size);
  const rest = layout.filter((t) => t.id !== id);
  const displaced = rest.filter((t) => overlaps(next, t));
  const kept = rest.filter((t) => !overlaps(next, t));
  return rehome([...kept, next], displaced);
}

// The layout with id moved to x, y, kept on the grid. A tile it lands on
// swaps places with it when it fits there; otherwise the tiles it covers move
// to the next free cells in reading order. Null when one has no room.
export function move(layout: Placed[], id: string, x: number, y: number): Placed[] | null {
  const tile = layout.find((t) => t.id === id);
  if (!tile) return null;
  const { w, h } = SPAN[tile.size];
  const next = { ...tile, x: Math.max(0, Math.min(x, COLUMNS - w)), y: Math.max(0, Math.min(y, ROWS - h)) };
  if (next.x === tile.x && next.y === tile.y) return layout;
  const rest = layout.filter((t) => t.id !== id);
  const displaced = rest.filter((t) => overlaps(next, t));
  const kept = rest.filter((t) => !overlaps(next, t));
  return rehome([...kept, next], displaced, { x: tile.x, y: tile.y });
}

// The sizes a tile can take right now, and for each whether there's room.
export function choices(layout: Placed[], id: string, sizes: Size[]): { size: Size; room: boolean }[] {
  return sizes.map((size) => ({ size, room: resize(layout, id, size) !== null }));
}
