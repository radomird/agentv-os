// Games on home (D9), in a real Chromium (ADR-019, layer 4), on a box as it
// ships, with every switch on. In Glass and Cinema the games on home have a
// row of their own, named Games, right under the apps:
//
// - it holds Steam's stand-in and a game made on this TV, and neither is
//   among the apps;
// - with no game on home there's no row and no name;
// - the arrows reach it and come back, and the focus only moves when asked;
// - OK opens a game, and what opens an app's details opens a game's;
// - a game that's running says so where an open app says it's open;
// - the games keep the order they have on home;
// - at each size the row is all on the screen, and more games than fit
//   scroll into sight.
//
// Terminal's home is as it was, each game a tile of its own with "games" in
// its corner, and so is home with the switches off.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, PHASE_1, rest, startBox, type Fixture } from "./box.mts";
import { rendered, shortfalls } from "./legible.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

// Steam's stand-in is the fixtures' agentv.games, named Steam here. Snake is
// a game made on this TV, and the five after it are for a row with more
// games than fit.
const STEAM = "agentv.games";
const SNAKE = "local.snake";
const made = (id: string, name: string): Fixture => ({
  id,
  name,
  tier: "local",
  category: "games",
  edit: (m) => ((m.author = "you"), (m.tv.capabilities = ["launch"]), delete m.tv.tiles, (m.tv.homeUrl = "https://games.example/"), (m.tv.origins = ["https://games.example"]), (m.tv.setup = [])),
});
const MORE = ["Pong", "Maze", "Cards", "Quiz", "Golf"].map((name) => made(`local.${name.toLowerCase()}`, name));
const BOX: Fixture[] = [...FIXTURES.map((fixture) => (fixture.id === STEAM ? { ...fixture, name: "Steam" } : fixture)), made(SNAKE, "Snake"), ...MORE];

const SIZES = { larger: 1600, standard: 1920, more: 2400 } as const;
type Size = keyof typeof SIZES;
const ROWS = ["glass", "cinema"] as const;
type Look = (typeof ROWS)[number] | "terminal";
// The row, its name and the apps' row, in each look.
const PARTS = {
  glass: { games: ".glass-games", name: ".glass-shelf", apps: ".glass-row:not(.glass-games)", all: ".glass-games [data-id], .glass-games ~ .glass-row [data-id]" },
  cinema: { games: ".cinema-games", name: ".cinema-games-name", apps: ".cinema-row:not(.cinema-games):not(.cinema-posters)", all: ".cinema-games [data-id]" },
} as const;

let browser: Browser;
let daemon: Daemon;
let url = "";

before(async () => {
  ({ daemon, url } = await startBox(0, BOX));
  await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "field" }) });
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

async function useLook(look: Look, at = url): Promise<void> {
  const response = await fetch(`${at}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
  assert.equal(response.status, 200);
}

async function useTheme(theme: string): Promise<void> {
  await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) });
}

// Home with these apps on it, in this order, four a row on the grid.
async function onHome(ids: string[], at = url): Promise<void> {
  const layout = ids.map((id, i) => ({ id, x: i % 4, y: Math.floor(i / 4), size: "s" }));
  const response = await fetch(`${at}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout }) });
  assert.equal(response.status, 200);
}

// Two apps and two games, mixed, as someone might have pinned them.
const MIXED = ["agentv.sample", STEAM, "agentv.tube", SNAKE];

interface Open {
  id: string;
  game: boolean;
  paused: boolean;
}

// A TV at a size, with the screen daemon stood in for: it says which apps
// are open behind home.
async function tv(size: Size = "standard", open: Open[] = [], at = url): Promise<Page> {
  const width = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height: Math.round((width * 9) / 16) } });
  await page.addInitScript((apps) => {
    const w = window as unknown as { screenRequests: unknown[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify(request.cmd === "running" ? { ok: true, apps } : { ok: true })), 0);
    };
  }, open);
  await page.goto(`${at}/?size=${size}`);
  await page.waitForSelector("#page .focused");
  await rest(page);
  return page;
}

const ids = (page: Page, row: string) => page.$$eval(`${row} [data-id]`, (tiles) => tiles.map((tile) => (tile as HTMLElement).dataset.id));
const focused = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>("#page .focused")?.dataset.id ?? document.querySelector<HTMLElement>("#page .focused")?.dataset.action ?? "");

// Down from where home starts until the focus is on the Games row.
async function toGames(page: Page, look: (typeof ROWS)[number]): Promise<void> {
  for (let presses = 0; presses < 4; presses++) {
    if (await page.locator(`${PARTS[look].games} .focused`).count()) return;
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(250);
  }
  assert.equal(await page.locator(`${PARTS[look].games} .focused`).count(), 1, "down from the apps lands on Games");
}

// What of the Games row isn't all on the screen: its name, or the focused
// tile and what it says.
function offScreen(page: Page, look: (typeof ROWS)[number]): Promise<string[]> {
  return page.evaluate((parts) => {
    const found: string[] = [];
    const check = (el: Element | null, what: string) => {
      if (!el) return found.push(`${what} isn't there`);
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return found.push(`${what} has no size`);
      if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) found.push(`${what} is off the screen at ${Math.round(box.left)},${Math.round(box.top)} to ${Math.round(box.right)},${Math.round(box.bottom)} of ${innerWidth}×${innerHeight}`);
    };
    check(document.querySelector(parts.name), "the row's name");
    const tile = document.querySelector(`${parts.games} .focused`);
    check(tile, "the focused game");
    for (const part of tile?.querySelectorAll(".glass-label, .cinema-card-name, .cinema-card-state, .logo") ?? []) check(part, `the focused game's ${part.className}`);
    return found;
  }, PARTS[look]);
}

for (const look of ROWS) {
  const parts = PARTS[look];

  test(`${look}: the Games row sits right under the apps and holds the games, which aren't among the apps`, async () => {
    await useLook(look);
    await onHome(MIXED);
    const page = await tv();
    try {
      assert.deepEqual(await ids(page, parts.games), [STEAM, SNAKE], "the row holds Steam and the game made here");
      assert.deepEqual(await ids(page, parts.apps), ["agentv.sample", "agentv.tube"], "and neither is among the apps");
      assert.equal(await page.locator(parts.name).innerText(), "Games");
      assert.equal(await page.locator(parts.name).count(), 1, "one name, for one row");
      // Right under the apps: nothing between the two rows but the name.
      const order = await page.evaluate((p) => {
        const apps = document.querySelector(p.apps)!;
        const games = document.querySelector(p.games)!;
        const name = document.querySelector(p.name)!;
        const between: string[] = [];
        for (let el = apps.nextElementSibling; el && el !== games; el = el.nextElementSibling) between.push(el.className);
        return { between, sameParent: apps.parentElement === games.parentElement, below: games.getBoundingClientRect().top >= apps.getBoundingClientRect().bottom, named: name === games.previousElementSibling || games.contains(name) };
      }, parts);
      assert.ok(order.sameParent && order.below && order.named, JSON.stringify(order));
      assert.ok(order.between.every((name) => /cinema-games-name/.test(name)), `nothing else is between the apps and Games: ${order.between.join(", ")}`);
      // A game's tile is the same kind of element as an app's, so whatever
      // works on one works on the other.
      const kinds = await page.evaluate((p) => {
        const kind = (el: Element) => [el.tagName, [...el.classList].filter((name) => name !== "focused").sort().join(" "), el.getAttributeNames().filter((name) => name !== "class").sort().join(" ")].join(" | ");
        return [kind(document.querySelector(`${p.apps} [data-id="agentv.tube"]`)!), kind(document.querySelector(`${p.games} [data-id="local.snake"]`)!)];
      }, parts);
      assert.equal(kinds[1], kinds[0]);
    } finally {
      await page.close();
    }
  });

  test(`${look}: with no game on home there's no Games row`, async () => {
    await useLook(look);
    await onHome(["agentv.sample", "agentv.tube", "someone.radio"]);
    const page = await tv();
    try {
      assert.deepEqual(await ids(page, parts.apps), ["agentv.sample", "agentv.tube", "someone.radio"]);
      assert.equal(await page.locator(`${parts.games}, ${parts.name}`).count(), 0, "no row and no name");
      assert.ok(!/\bGames\b/.test(await page.locator("#page").innerText()), "nothing on home says Games");
    } finally {
      await page.close();
    }
  });

  test(`${look}: the arrows reach Games and come back, and the focus stays where it's put`, async () => {
    await useLook(look);
    await onHome(MIXED);
    const page = await tv();
    try {
      await toGames(page, look);
      assert.equal(await focused(page), STEAM, "down from the first app is the first game");
      assert.deepEqual(await offScreen(page, look), []);
      await page.keyboard.press("ArrowRight");
      assert.equal(await focused(page), SNAKE);
      // Nobody presses anything: the focus is still there.
      await page.waitForTimeout(700);
      assert.equal(await focused(page), SNAKE);
      await page.keyboard.press("ArrowLeft");
      assert.equal(await focused(page), STEAM);
      await page.keyboard.press("ArrowUp");
      assert.equal(await focused(page), "agentv.sample", "up goes back to the apps");
      await page.keyboard.press("ArrowDown");
      assert.equal(await focused(page), STEAM);
    } finally {
      await page.close();
    }
  });

  test(`${look}: OK opens a game, and its details open as an app's do`, async () => {
    await useLook(look);
    await onHome(MIXED);
    const page = await tv();
    try {
      await toGames(page, look);
      await page.keyboard.press("Enter");
      await page.waitForFunction((id) => (window as unknown as { screenRequests: { cmd: string; app?: string }[] }).screenRequests.some((r) => r.cmd === "open-app" && r.app === id), STEAM);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await page.waitForFunction((id) => (window as unknown as { screenRequests: { cmd: string; app?: string }[] }).screenRequests.some((r) => r.cmd === "open-app" && r.app === id), SNAKE);
      await page.keyboard.press("i");
      await page.waitForSelector(".details-head");
      assert.match(await page.locator("#page").innerText(), /snake/i);
      // Back is home, with its Games row.
      await page.keyboard.press("Escape");
      await page.waitForSelector(parts.games);
    } finally {
      await page.close();
    }
  });

  test(`${look}: a game that's running says so, where an open app says it's open`, async () => {
    await useLook(look);
    await onHome(MIXED);
    const page = await tv("standard", [
      { id: STEAM, game: true, paused: false },
      { id: "agentv.tube", game: false, paused: false },
    ]);
    // What a tile says about its app: under its name in Cinema, and under
    // the title at the top in Glass, once the tile has the focus.
    const says = async (id: string) => {
      if (look === "cinema") return (await page.locator(`[data-id="${id}"] .cinema-card-state`).count()) ? page.locator(`[data-id="${id}"] .cinema-card-state`).innerText() : "";
      await page.evaluate((id) => {
        const launcher = (window as unknown as { agentvLauncher: { focus: { set(el: HTMLElement): void } } }).agentvLauncher;
        launcher.focus.set(document.querySelector<HTMLElement>(`#page [data-id="${id}"]`)!);
      }, id);
      await page.waitForFunction((id) => document.querySelector(".glass-name")?.textContent === document.querySelector(`#page [data-id="${id}"]`)?.getAttribute("aria-label"), id);
      await page.waitForTimeout(150);
      return page.locator(".glass-line").innerText();
    };
    try {
      await page.waitForFunction((id) => (window as unknown as { screenRequests: { cmd: string }[] }).screenRequests.some((r) => r.cmd === "running") && document.querySelector(`#page [data-id="${id}"]`), STEAM);
      await page.waitForTimeout(300);
      assert.equal(await says(STEAM), "Running");
      assert.equal(await says("agentv.tube"), "Open");
      assert.equal(await says(SNAKE), "", "a game that isn't open says nothing");
      // The game closes: the tile stops saying so, and the focus is where it was.
      await toGames(page, look);
      const before = await focused(page);
      await page.evaluate(() => (window as unknown as { agentvRunning: (json: string) => void }).agentvRunning("[]"));
      await page.waitForTimeout(400);
      assert.equal(await focused(page), before, "the focus didn't move");
      assert.equal(await says(STEAM), "");
    } finally {
      await page.close();
    }
  });

  test(`${look}: the games keep the order they have on home`, async () => {
    await useLook(look);
    await onHome([SNAKE, "agentv.tube", STEAM, "agentv.sample"]);
    const page = await tv();
    try {
      assert.deepEqual(await ids(page, parts.games), [SNAKE, STEAM]);
      assert.deepEqual(await ids(page, parts.apps), ["agentv.tube", "agentv.sample"]);
    } finally {
      await page.close();
    }
  });

  for (const size of Object.keys(SIZES) as Size[]) {
    test(`${look} at ${size}: the Games row is all on the screen and reads clearly, dark and light, with more games than fit`, async () => {
      await useLook(look);
      const games = [STEAM, SNAKE, ...MORE.map((game) => game.id)];
      await onHome(["agentv.sample", "agentv.tube", "someone.radio", ...games]);
      const problems: string[] = [];
      for (const theme of ["tokyo-night", "catppuccin-latte"]) {
        await useTheme(theme);
        const page = await tv(size, [{ id: STEAM, game: true, paused: false }]);
        try {
          assert.deepEqual(await page.$$eval(parts.all, (tiles) => tiles.map((tile) => (tile as HTMLElement).dataset.id)), games, "every game is in Games");
          await toGames(page, look);
          await page.waitForTimeout(300);
          for (const one of await offScreen(page, look)) problems.push(`${theme}: ${one}`);
          for (const one of await shortfalls(page)) problems.push(`${theme}: "${one.text}" reads at ${one.ratio} of ${one.needs} (${one.color} on ${one.behind})`);
          // What a card says doesn't run over its logo.
          const over = await page.evaluate(() => {
            const found: string[] = [];
            for (const card of document.querySelectorAll(".cinema-games .cinema-card")) {
              const logo = card.querySelector(".logo")?.getBoundingClientRect();
              const name = card.querySelector(".cinema-card-name")?.getBoundingClientRect();
              if (logo && name && name.top < logo.bottom - 1) found.push(`${card.getAttribute("aria-label")}'s name starts at ${Math.round(name.top)}, over its logo, which ends at ${Math.round(logo.bottom)}`);
            }
            return found;
          });
          for (const one of over) problems.push(`${theme}: ${one}`);
          // Along the row and down it to the last game, each in sight once it has the focus.
          const seen = new Set<string>([await focused(page)]);
          for (const way of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowDown", "ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowRight"]) {
            await page.keyboard.press(way);
            await page.waitForTimeout(120);
            const at = await focused(page);
            if (!games.includes(at)) continue;
            seen.add(at);
            const box = await page.locator("#page .focused").boundingBox();
            const view = page.viewportSize()!;
            if (!box || box.x < -1 || box.y < -1 || box.x + box.width > view.width + 1 || box.y + box.height > view.height + 1) problems.push(`${theme}: ${at} has the focus out of sight`);
          }
          assert.deepEqual([...seen].sort(), [...games].sort(), "the arrows reach every game");
        } finally {
          await page.close();
        }
      }
      assert.deepEqual(problems, [], `${look} at ${size}:\n${problems.join("\n")}`);
    });
  }
}

// What Terminal's grid and phase 1's show: each app a tile in its place,
// with what it's for in its corner.
async function grid(page: Page): Promise<Record<string, string>> {
  return Object.fromEntries(await page.$$eval(".grid .tile[data-id]", (tiles) => tiles.map((tile) => [(tile as HTMLElement).dataset.id!, tile.querySelector(".tile-label")?.textContent ?? ""])));
}

test("terminal: home has no Games row, and each game is a tile of its own with games in its corner", async () => {
  await useLook("terminal");
  await onHome(MIXED);
  const page = await tv();
  try {
    assert.deepEqual(await grid(page), { "agentv.sample": "media", [STEAM]: "games", "agentv.tube": "streaming", [SNAKE]: "games" });
    assert.equal(await page.locator(".glass-games, .cinema-games, .glass-shelf, .cinema-games-name").count(), 0);
    // In their places on the grid, in the order they were pinned.
    const places = await page.$$eval(".grid .tile[data-id]", (tiles) => tiles.map((tile) => [(tile as HTMLElement).dataset.id, (tile as HTMLElement).style.gridColumn, (tile as HTMLElement).style.gridRow]));
    assert.deepEqual(places, MIXED.map((id, i) => [id, `${i + 1} / span 1`, "1 / span 1"]));
    await page.keyboard.press("ArrowRight");
    assert.equal(await focused(page), STEAM);
  } finally {
    await page.close();
  }
});

test("with the switches off, home is phase 1's grid, each game a tile of its own", async () => {
  const box = await startBox(0, BOX, { features: PHASE_1 });
  try {
    await onHome(MIXED, box.url);
    const page = await tv("standard", [], box.url);
    try {
      const tiles = await grid(page);
      assert.deepEqual([tiles["agentv.sample"], tiles[STEAM], tiles["agentv.tube"], tiles[SNAKE]], ["media", "games", "streaming", "games"]);
      assert.equal(await page.locator(".glass-games, .cinema-games, .glass-shelf, .cinema-games-name").count(), 0);
      assert.equal(await page.locator("html[data-look]").count(), 0, "no look at all");
    } finally {
      await page.close();
    }
  } finally {
    await box.daemon.close();
  }
});
