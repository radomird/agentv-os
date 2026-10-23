// The home grid's rules (launcher/layout.ts): three sizes on a 4 × 3 grid, a
// tile that grows pushes the tiles it covers to the next free cells in
// reading order, and a size with no room can't be picked (S2.5, S2.6).

import assert from "node:assert/strict";
import { test } from "node:test";
import { choices, firstFree, move, pin, problem, resize, unpin, type Placed, type Size } from "../../../launcher/layout.ts";

const all: Size[] = ["s", "m", "l"];
const sizes = (id: string): Size[] | undefined => (id.startsWith("small.") ? ["s"] : id === "nowhere" ? undefined : all);

// The board 19 home: continue (l) top left, clock and weather small, two
// small apps under them, and two small tiles at the bottom.
function home(): Placed[] {
  return [
    { id: "app.continue", x: 0, y: 0, size: "l" },
    { id: "app.clock", x: 2, y: 0, size: "s" },
    { id: "app.weather", x: 3, y: 0, size: "s" },
    { id: "app.movies", x: 2, y: 1, size: "s" },
    { id: "app.music", x: 3, y: 1, size: "s" },
    { id: "app.jellyfin", x: 0, y: 2, size: "s" },
    { id: "apps", x: 1, y: 2, size: "s" },
  ];
}

function where(layout: Placed[] | null): Record<string, string> {
  assert.ok(layout, "expected a layout");
  return Object.fromEntries(layout.map((t) => [t.id, `${t.size}@${t.x},${t.y}`]));
}

test("a layout the grid can draw passes, and one it can't says why", () => {
  assert.equal(problem(home(), sizes), null);
  assert.match(String(problem([{ id: "app.a", x: 3, y: 0, size: "m" }], sizes)), /doesn't fit on the grid/);
  assert.match(String(problem([{ id: "app.a", x: 0, y: 2, size: "l" }], sizes)), /doesn't fit on the grid/);
  assert.match(String(problem([{ id: "app.a", x: 0, y: 0, size: "l" }, { id: "app.b", x: 1, y: 1, size: "s" }], sizes)), /overlaps/);
  assert.match(String(problem([{ id: "app.a", x: 0, y: 0, size: "s" }, { id: "app.a", x: 1, y: 0, size: "s" }], sizes)), /twice/);
  assert.match(String(problem([{ id: "small.a", x: 0, y: 0, size: "m" }], sizes)), /can't be size m/);
  assert.match(String(problem([{ id: "nowhere", x: 0, y: 0, size: "s" }], sizes)), /isn't an app on this box/);
  assert.match(String(problem([{ id: "app.a", x: 0.5, y: 0, size: "s" }], sizes)), /doesn't fit/);
  assert.match(String(problem({}, sizes)), /list of tiles/);
});

test("pinning takes the first free cell in reading order, and fails with no room", () => {
  assert.deepEqual(firstFree(home(), "s"), { x: 2, y: 2 });
  assert.deepEqual(firstFree(home(), "m"), { x: 2, y: 2 });
  assert.equal(firstFree(home(), "l"), null);
  assert.equal(where(pin(home(), "app.plex"))["app.plex"], "s@2,2");
  assert.equal(pin(home(), "app.plex", "l"), null);
  assert.equal(unpin(home(), "apps").length, 6);
});

test("S2.6 a tile that grows pushes the tiles it covers to the next free cells in reading order", () => {
  // Weather grows to medium at the right edge, so it grows left over the clock,
  // and the clock goes to the first free cell (board 23b).
  const after = where(resize(home(), "app.weather", "m"));
  assert.equal(after["app.weather"], "m@2,0");
  assert.equal(after["app.clock"], "s@2,2");
  assert.equal(problem(resize(home(), "app.weather", "m"), sizes), null);
});

test("S2.6 a tile grows right and down, or left and up at the edge", () => {
  const corner: Placed[] = [{ id: "app.a", x: 3, y: 2, size: "s" }];
  assert.equal(where(resize(corner, "app.a", "l"))["app.a"], "l@2,1");
  assert.equal(where(resize([{ id: "app.a", x: 1, y: 0, size: "s" }], "app.a", "l"))["app.a"], "l@1,0");
});

test("S2.6 a size with no room can't be picked", () => {
  // The music tile can't grow to large: the tiles it covers have nowhere to go.
  const full = pin(pin(home(), "app.plex")!, "app.immich")!;
  assert.equal(resize(full, "app.music", "l"), null);
  assert.deepEqual(choices(full, "app.music", all), [
    { size: "s", room: true },
    { size: "m", room: false },
    { size: "l", room: false },
  ]);
  // With two cells free, medium fits (movies moves down) but large doesn't.
  assert.deepEqual(choices(home(), "app.music", all).map((c) => c.room), [true, true, false]);
});

test("S2.5 a tile takes only the sizes its app lists", () => {
  const layout: Placed[] = [{ id: "small.only", x: 0, y: 0, size: "s" }];
  const grown = resize(layout, "small.only", "m");
  assert.ok(grown);
  assert.match(String(problem(grown, sizes)), /can't be size m/);
});

test("S2.4 a moved tile lands where it was dropped, and swaps with the tile it lands on", () => {
  const after = where(move(home(), "app.jellyfin", 3, 1));
  assert.equal(after["app.jellyfin"], "s@3,1");
  assert.equal(after["app.music"], "s@0,2");
  // A move off the grid is kept on it.
  assert.equal(where(move(home(), "app.continue", 3, 2))["app.continue"], "l@2,1");
  assert.equal(problem(move(home(), "app.continue", 3, 2), sizes), null);
  assert.deepEqual(move(home(), "app.music", 3, 1), home());
});
