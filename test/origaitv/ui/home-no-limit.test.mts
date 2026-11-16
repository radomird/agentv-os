// Home with no tile limit (T20.1, layer 4). With the looks on, a profile's
// home holds every app it's given: Glass draws them in rows of six that grow,
// Cinema in its row of apps, and Terminal's grid shows its first 12 cells and
// says how many more Apps has. An app added from its details opens home with
// the focus on it, wherever it went. Move in its details picks it up, the
// arrows carry it, in four directions in Glass, across the pinned row's edge
// too, and OK puts it down and shows it on home. The phone's Edit home draws
// Glass and Cinema as rows, with Glass's top row first.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, beforeEach, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox, type Fixture } from "./box.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const SIZES = { larger: 1600, standard: 1920, more: 2400 } as const;

// Twelve more apps, made from the sample app: 17 in all, one of them a game.
const plain = (host: string) => (m: Record<string, any>) => ((m.tv.capabilities = ["launch"]), delete m.tv.tiles, (m.tv.homeUrl = `https://${host}.example/`), (m.tv.origins = [`https://${host}.example`]), (m.tv.setup = []));
const MORE: Fixture[] = ["Atlas", "Birch", "Cove", "Dune", "Ember", "Fjord", "Grove", "Harbour", "Inlet", "Juniper", "Kestrel", "Lumen"].map((name) => ({
  id: `local.${name.toLowerCase()}`,
  name,
  tier: "local",
  category: "media",
  edit: plain(name.toLowerCase()),
}));
const APPS = [...FIXTURES, ...MORE];
const GAME = "origaitv.games";
// Home in this order: 13 apps, past Terminal's 12 cells, then the game. Two
// apps, Kestrel and Lumen, aren't on home.
const ON_HOME = [...FIXTURES.map((f) => f.id).filter((id) => id !== GAME), ...MORE.slice(0, 9).map((f) => f.id), GAME];
const placed = (ids: string[]) => ids.map((id, i) => ({ id, x: i % 4, y: Math.floor(i / 4), size: "s" }));

let browser: Browser;
let daemon: Daemon;
let url = "";
let phoneUrl = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url } = await startBox(0, APPS, { features: { looks: true, remote2: false } }));
  phoneUrl = `http://127.0.0.1:${daemon.lanPort}`;
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

type Tile = { id: string; x: number; y: number; size: string };
const layout = async (): Promise<Tile[]> => (await (await fetch(`${url}/api/home`)).json()).layout;
const order = async () => (await layout()).sort((a, b) => a.y - b.y || a.x - b.x).map((tile) => tile.id);
async function setLayout(ids: string[]): Promise<void> {
  const response = await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: placed(ids) }) });
  assert.equal(response.status, 200, await response.text());
}
const useLook = (look: string) => fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });

// Glass's pinned row: the first six apps, as on a home that never pinned.
const PINNED = ON_HOME.slice(0, 6);
const pinned = async (): Promise<string[]> => (await (await fetch(`${url}/api/home`)).json()).pinned;
beforeEach(async () => {
  await setLayout(ON_HOME);
  assert.equal((await fetch(`${url}/api/pinned`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: PINNED }) })).status, 200);
});

async function tv(size: keyof typeof SIZES = "standard"): Promise<Page> {
  const width = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height: Math.round((width * 9) / 16) } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/?size=${size}`);
  await page.waitForSelector("html[data-look] #page .focused");
  await rest(page);
  return page;
}

type Launcher = { origaitvLauncher: { go(route: string): void; focus: { get(): HTMLElement | undefined } } };
const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as Launcher).origaitvLauncher.go(r), route);
const focused = (page: Page) => page.evaluate(() => (window as unknown as Launcher).origaitvLauncher.focus.get()?.dataset.id);
const drawn = (page: Page, selector: string) => page.locator(selector).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.id));

// Whether an element is all on the screen, once it has stopped moving.
async function onScreen(page: Page, selector: string): Promise<boolean> {
  await page.waitForTimeout(300);
  return page.evaluate((selector) => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
  }, selector);
}

// An app's details, and OK on one of its buttons.
async function inDetails(page: Page, id: string, action: string): Promise<void> {
  await go(page, `details/${id}`);
  await page.waitForSelector(`.details [data-action="${action}"]`);
  await page.click(`.details [data-action="${action}"]`);
}

// Where each look draws the apps on home: in Glass, the pinned row, the
// list's rows of apps and Games, not the apps that aren't on home.
const ROWS = { glass: ':is(.glass-pinned, .glass-list > .glass-row, [data-section="games"] .glass-row) [data-id]', cinema: ".cinema-row [data-id]" } as const;

for (const look of ["glass", "cinema"] as const) {
  test(`T20.1 ${look}: home draws all 14 apps, past 12, and one added from its details opens home with the focus on it, at each size`, async () => {
    await useLook(look);
    for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
      await setLayout(ON_HOME);
      const page = await tv(size);
      try {
        const ids = await drawn(page, ROWS[look]);
        assert.deepEqual([...ids].sort(), [...ON_HOME].sort(), `${size}: every app on home is drawn`);
        if (look === "glass") assert.deepEqual(await page.locator('.glass-pinned, .glass-list > .glass-row, [data-section="games"] .glass-row').evaluateAll((rows) => rows.map((row) => row.querySelectorAll("[data-id]").length)), [6, 6, 1, 1], `${size}: the pinned row, rows of six, then the game's`);
        await inDetails(page, "local.kestrel", "home");
        await page.waitForSelector(`#page ${ROWS[look].replace(" [data-id]", "")} [data-id="local.kestrel"].focused`);
        assert.equal(await focused(page), "local.kestrel", `${size}: the focus is on it`);
        assert.ok(await onScreen(page, '[data-id="local.kestrel"].focused'), `${size}: it's on the screen`);
        assert.ok((await order()).includes("local.kestrel"), `${size}: it's kept on home`);
      } finally {
        await page.close();
      }
    }
  });
}

test("T20.1 terminal: the grid shows its first 12 cells and says Apps has the rest, and an app added past them says so", async () => {
  await useLook("terminal");
  const page = await tv();
  try {
    assert.equal(await page.locator(".grid .tile[data-id]").count(), 12);
    assert.equal(await page.locator(".bar-viewer").textContent(), "2 more in Apps");
    // Apps has every app on home.
    await go(page, "apps");
    await page.waitForSelector('.apps-page [data-id="local.inlet"]');
    await inDetails(page, "local.kestrel", "home");
    await page.waitForSelector(".grid .tile.focused");
    assert.match(await page.locator("#toasts").innerText(), /Home's grid is full, so Kestrel is in Apps/i);
    assert.ok((await order()).includes("local.kestrel"));
    assert.equal(await page.locator(".bar-viewer").textContent(), "3 more in Apps");
  } finally {
    await page.close();
  }
});

test("T20.1 terminal: editing the grid keeps the apps past it", async () => {
  await useLook("terminal");
  const page = await tv();
  try {
    await page.keyboard.press("e");
    await page.waitForSelector(".grid.editing .tile.focused");
    // The first app, one cell to the right, and put down.
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector(".grid.editing .held"));
    await page.waitForTimeout(300);
    const now = await order();
    assert.deepEqual([...now].sort(), [...ON_HOME].sort(), "every app is still on home");
    assert.deepEqual(now.slice(0, 2), [ON_HOME[1], ON_HOME[0]], "the two traded places");
  } finally {
    await page.close();
  }
});

test("T20.1 glass: Move in an app's details carries it in four directions, across the pinned row's edge too, and OK shows it on home", async () => {
  await useLook("glass");
  const page = await tv();
  const at = async () => (await order()).filter((id) => id !== GAME);
  const apps = ON_HOME.filter((id) => id !== GAME);
  try {
    // Atlas is the pinned row's fifth. Under it in the list is Grove.
    const atlas = "local.atlas";
    assert.equal(PINNED.indexOf(atlas), 4);
    await inDetails(page, atlas, "move");
    await page.waitForSelector(`.row-edit .glass-pinned .held[data-id="${atlas}"]`);
    // Left and right along the pinned row, down into the list, where it and
    // Grove swap, and up again: where it started.
    await page.keyboard.press("ArrowLeft");
    await page.waitForSelector(`.row-edit .glass-pinned [data-id="${atlas}"]:nth-child(4)`);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.waitForSelector(`.row-edit .glass-list .held[data-id="${atlas}"]`);
    assert.ok(await page.locator('.row-edit .glass-pinned [data-id="local.grove"]').count(), "Grove came up");
    await page.keyboard.press("ArrowUp");
    await page.waitForSelector(`.row-edit .glass-pinned .held[data-id="${atlas}"]`);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`.glass-home:not(.editing) [data-id="${atlas}"].focused`);
    assert.equal(await focused(page), atlas, "home has the focus on it");
    assert.deepEqual(await at(), apps, "home's order is as it was");
    assert.deepEqual(await pinned(), PINNED, "and so is the pinned row");
    // Down then OK: Atlas and Grove are kept swapped, and home opens with
    // the list up, on Atlas.
    await inDetails(page, atlas, "move");
    await page.waitForSelector(`.row-edit .held[data-id="${atlas}"]`);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForSelector(`.glass-home.list:not(.editing) .glass-list [data-id="${atlas}"].focused`);
    const swapped = apps.map((id) => (id === atlas ? "local.grove" : id === "local.grove" ? atlas : id));
    assert.deepEqual(await at(), swapped);
    assert.deepEqual(await pinned(), PINNED.map((id) => (id === atlas ? "local.grove" : id)));
    // In the list: down to the row under, then down again, where the game's
    // row is, which an app doesn't go to.
    await inDetails(page, atlas, "move");
    await page.waitForSelector(`.row-edit .held[data-id="${atlas}"]`);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForSelector(`.glass-home:not(.editing) [data-id="${atlas}"].focused`);
    assert.equal((await at()).indexOf(atlas), 12, "the list's last row of apps, not the game's");
    assert.equal((await order()).at(-1), GAME);
  } finally {
    await page.close();
  }
});

test("T20.1 cinema: Move in an app's details carries it along the row of apps, and Back puts it back", async () => {
  await useLook("cinema");
  const page = await tv();
  try {
    await inDetails(page, "origaitv.tube", "move");
    await page.waitForSelector('.row-edit .held[data-id="origaitv.tube"]');
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    await page.waitForSelector('.details [data-action="move"]');
    assert.deepEqual(await order(), ON_HOME, "Back put it back");
    await page.click('.details [data-action="move"]');
    await page.waitForSelector('.row-edit .held[data-id="origaitv.tube"]');
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.cinema-home:not(.editing) [data-id="origaitv.tube"].focused');
    assert.equal((await order()).indexOf("origaitv.tube"), 2, "one along, and up went nowhere");
  } finally {
    await page.close();
  }
});

test("T20.1 the phone's Edit home draws Glass's top row, then rows of six, then the games, and a tap moves an app there", async () => {
  await useLook("glass");
  await fetch(`${url}/api/phones/pair`, { method: "POST" });
  const hand = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  hand.on("pageerror", (error) => errors.push(error.message));
  const until = async (check: () => Promise<boolean>) => {
    const end = Date.now() + 3000;
    while (!(await check()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  };
  try {
    await hand.goto(`${phoneUrl}/#pair=${daemon.phones.secret()}`);
    await hand.waitForSelector(".dpad");
    await hand.locator('[data-mode="home"]').tap();
    await hand.waitForSelector(".mini-rows");
    assert.equal(await hand.locator(".mini-grid").count(), 0, "not Terminal's grid");
    const rows = await hand.locator(".mini-rows").evaluateAll((all) => all.map((row) => [...row.querySelectorAll<HTMLElement>("[data-id]")].map((el) => el.dataset.id)));
    const list = ON_HOME.filter((id) => id !== GAME && !PINNED.includes(id));
    assert.deepEqual(rows, [PINNED, list, [GAME]]);
    assert.ok(await hand.locator(".mini-rows.mini-pinned").count(), "the top row is first, in its panel");
    assert.equal(await hand.locator(".mini-rows").nth(1).evaluate((row) => getComputedStyle(row).gridTemplateColumns.split(" ").length), 6);
    // Birch to where Tube is, in the top row: only its order changes.
    await hand.locator('.mini-tile[data-id="local.birch"]').tap();
    assert.match(await hand.locator(".sizes").innerText(), /Birch/);
    await hand.locator('.mini-tile[data-id="origaitv.tube"]').tap();
    await hand.waitForFunction(() => !document.querySelector(".mini-tile.picked"));
    const top = ["origaitv.sample", "local.birch", ...PINNED.slice(1, 5)];
    await until(async () => JSON.stringify(await pinned()) === JSON.stringify(top));
    assert.deepEqual(await pinned(), top);
    assert.deepEqual(await order(), ON_HOME, "home's order is as it was");
    // Cove, in the list, onto Tube: the two swap across the edge.
    await hand.locator('.mini-tile[data-id="local.cove"]').tap();
    await hand.locator('.mini-tile[data-id="origaitv.tube"]').tap();
    const swapped = top.map((id) => (id === "origaitv.tube" ? "local.cove" : id));
    await until(async () => JSON.stringify(await pinned()) === JSON.stringify(swapped));
    assert.deepEqual(await pinned(), swapped);
    assert.deepEqual(await order(), ON_HOME.map((id) => (id === "origaitv.tube" ? "local.cove" : id === "local.cove" ? "origaitv.tube" : id)));
    await hand.waitForSelector('.mini-pinned .mini-tile[data-id="local.cove"]');
    // The top row is full: another can't go on it from here.
    await hand.locator('.mini-tile[data-id="local.inlet"]').tap();
    assert.ok(await hand.locator('[data-action="top-row"]').isDisabled(), "Top row is full");
    // Off it, and the room left takes another.
    await hand.locator('.mini-tile[data-id="local.inlet"]').tap();
    await hand.locator('.mini-tile[data-id="local.cove"]').tap();
    await hand.locator('[data-action="top-row"]').tap();
    await until(async () => !(await pinned()).includes("local.cove"));
    await hand.locator('.mini-tile[data-id="local.inlet"]').tap();
    await hand.locator('[data-cell="top-5"]').tap();
    await until(async () => (await pinned()).includes("local.inlet"));
    assert.deepEqual(await pinned(), [...swapped.filter((id) => id !== "local.cove"), "local.inlet"]);
    // An app not on home goes on with Add, past 12.
    await hand.locator('[data-pin="local.lumen"]').tap();
    await hand.waitForSelector('.mini-rows .mini-tile[data-id="local.lumen"]');
    assert.ok((await order()).includes("local.lumen"));
  } finally {
    await hand.close();
  }
});
