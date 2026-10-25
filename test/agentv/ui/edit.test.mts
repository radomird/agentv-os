// Edit mode in a real Chromium (ADR-019, layer 4), on a box of its own with
// more apps than fit on the grid: a dragged tile lands where it was dropped
// and stays there when the daemon starts again (S2.4), a tile takes only the
// sizes its app lists, with + and -, its corner or the size bar (S2.5), and
// the tiles it covers move on, while a size with no room can't be picked
// (S2.6).

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, beforeEach, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, ROOT, startBox, type Fixture } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

// Four more apps that only come small, so the grid can be filled up.
const EXTRA: Fixture[] = [1, 2, 3, 4].map((n) => ({
  id: `agentv.extra${n}`,
  name: `Extra ${n}`,
  tier: "official",
  category: "utility",
  edit: (m) => ((m.tv.capabilities = ["launch"]), delete m.tv.tiles, (m.tv.homeUrl = "https://extra.example/"), (m.tv.origins = ["https://extra.example"]), (m.tv.setup = [])),
}));

// Where every tile starts: all small, in the first two rows.
const START = [
  { id: "agentv.sample", x: 0, y: 0, size: "s" },
  { id: "agentv.tube", x: 1, y: 0, size: "s" },
  { id: "someone.radio", x: 2, y: 0, size: "s" },
  { id: "local.mytv", x: 3, y: 0, size: "s" },
  { id: "agentv.games", x: 0, y: 1, size: "s" },
  { id: "apps", x: 1, y: 1, size: "s" },
];

let browser: Browser;
let daemon: Daemon;
let url = "";
let apps = "";
let state = "";

before(async () => {
  ({ daemon, url, apps, state } = await startBox(0, [...FIXTURES, ...EXTRA]));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

async function layout(): Promise<Record<string, string>> {
  const tiles: { id: string; x: number; y: number; size: string }[] = (await (await fetch(`${url}/api/home`)).json()).layout;
  return Object.fromEntries(tiles.map((t) => [t.id, `${t.size}@${t.x},${t.y}`]));
}

async function setLayout(tiles: { id: string; x: number; y: number; size: string }[]): Promise<void> {
  const response = await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: tiles }) });
  assert.equal(response.status, 200, await response.text());
}

beforeEach(() => setLayout(START));

// Home at 1080p, in edit mode.
async function editing(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  await page.keyboard.press("e");
  await page.waitForSelector(".grid.editing .tile.focused");
  return page;
}

function tile(page: Page, id: string) {
  return page.locator(`.grid [data-id="${id}"]`);
}

// The middle of a grid cell on the screen: 32 px padding, 16 px gaps, and
// the bar's 60 px off the bottom.
function cell(x: number, y: number): { x: number; y: number } {
  const w = (1920 - 64 - 48) / 4;
  const h = (1080 - 60 - 64 - 32) / 3;
  return { x: 32 + x * (w + 16) + w / 2, y: 32 + y * (h + 16) + h / 2 };
}

async function played(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { agentvLauncher: { sounds: { log: { sound: string }[] } } }).agentvLauncher.sounds.log.map((entry) => entry.sound),
  );
}

test("S2.4 a tile dragged with the mouse lands where it was dropped", async () => {
  const page = await editing();
  const from = await tile(page, "agentv.games").boundingBox();
  assert.ok(from);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  const to = cell(3, 2);
  await page.mouse.move(to.x, to.y, { steps: 12 });
  assert.equal(await page.locator(".drop.on").innerText(), "moved here");
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal((await layout())["agentv.games"], "s@3,2");
  // It's on the screen where it was dropped, too.
  const landed = await tile(page, "agentv.games").boundingBox();
  assert.ok(landed && Math.abs(landed.x + landed.width / 2 - to.x) < 4 && Math.abs(landed.y + landed.height / 2 - to.y) < 4);
  // Dropped on another tile, the two swap.
  const radio = await tile(page, "someone.radio").boundingBox();
  assert.ok(radio);
  await page.mouse.move(radio.x + radio.width / 2, radio.y + radio.height / 2);
  await page.mouse.down();
  const sample = cell(0, 0);
  await page.mouse.move(sample.x, sample.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await layout();
  assert.equal(after["someone.radio"], "s@0,0");
  assert.equal(after["agentv.sample"], "s@2,0");
  await page.close();
});

test("S2.4 on a 720p TV, a dragged tile lands in the cell it was dropped on too", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  await page.keyboard.press("e");
  await page.waitForSelector(".grid.editing .tile.focused");
  const from = await tile(page, "agentv.games").boundingBox();
  assert.ok(from);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  const to = cell(2, 2);
  await page.mouse.move((to.x * 2) / 3, (to.y * 2) / 3, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal((await layout())["agentv.games"], "s@2,2");
  const landed = await tile(page, "agentv.games").boundingBox();
  assert.ok(landed && Math.abs(landed.x + landed.width / 2 - (to.x * 2) / 3) < 4 && Math.abs(landed.y + landed.height / 2 - (to.y * 2) / 3) < 4);
  await page.close();
});

test("S2.4 the layout stays as it was left when the daemon starts again", async () => {
  await setLayout([...START.slice(0, 4), { id: "agentv.games", x: 3, y: 2, size: "s" }, { id: "apps", x: 0, y: 2, size: "s" }]);
  await daemon.close();
  daemon = new Daemon({ root: ROOT, state, apps, port: 0, builtins: null, log: () => {} });
  url = `http://127.0.0.1:${await daemon.listen()}`;
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  const games = await tile(page, "agentv.games").boundingBox();
  const at = cell(3, 2);
  assert.ok(games && Math.abs(games.x + games.width / 2 - at.x) < 4 && Math.abs(games.y + games.height / 2 - at.y) < 4);
  assert.equal((await layout())["apps"], "s@0,2");
  await page.close();
});

test("S2.4 with the keyboard: Enter picks a tile up, the arrows carry it, Enter puts it down", async () => {
  const page = await editing();
  await tile(page, "agentv.games").hover();
  await page.keyboard.press("Enter");
  assert.ok(await tile(page, "agentv.games").evaluate((el) => el.classList.contains("held")));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  // Nothing's saved until it's put down.
  assert.equal((await layout())["agentv.games"], "s@0,1");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  assert.equal((await layout())["agentv.games"], "s@2,2");
  // Esc puts a tile back where it was.
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.querySelector(".held")), null);
  assert.equal((await layout())["agentv.games"], "s@2,2");
  // Esc again leaves edit mode for home.
  await page.keyboard.press("Escape");
  await page.waitForSelector(".grid:not(.editing)");
  await page.close();
});

test("S2.5 + and - step only through the sizes an app lists", async () => {
  const page = await editing();
  // Tube comes only small.
  await tile(page, "agentv.tube").hover();
  await page.keyboard.press("+");
  await page.waitForTimeout(150);
  assert.equal((await layout())["agentv.tube"], "s@1,0");
  assert.equal((await played(page)).at(-1), "failure");
  // My TV comes small and medium.
  await tile(page, "local.mytv").hover();
  await page.keyboard.press("+");
  await page.waitForTimeout(150);
  assert.equal((await layout())["local.mytv"], "m@2,0");
  await page.keyboard.press("+");
  await page.waitForTimeout(150);
  assert.equal((await layout())["local.mytv"], "m@2,0");
  await page.keyboard.press("-");
  await page.waitForTimeout(150);
  assert.equal((await layout())["local.mytv"], "s@2,0");
  // Sample comes in all three.
  await tile(page, "agentv.sample").hover();
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await page.waitForTimeout(200);
  assert.equal((await layout())["agentv.sample"], "l@0,0");
  await page.close();
});

test("S2.5 the size bar shows the app's own words for each size, and its corner resizes", async () => {
  const page = await editing();
  await tile(page, "local.mytv").click();
  await page.waitForSelector(".sizebar.on");
  assert.deepEqual(await page.locator(".sizebar .chip[data-size]").allTextContents(), ["s · logo", "m · continue"]);
  await page.locator('.sizebar .chip[data-size="m"]').click();
  await page.waitForTimeout(200);
  assert.equal((await layout())["local.mytv"], "m@2,0");
  // Tube has one size, so no corner.
  assert.equal(await tile(page, "agentv.tube").locator(".corner").count(), 0);
  // Sample's corner, pulled down and right, makes it large.
  const corner = await tile(page, "agentv.sample").locator(".corner").boundingBox();
  assert.ok(corner);
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  const to = cell(1, 1);
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal((await layout())["agentv.sample"], "l@0,0");
  await page.close();
});

test("S2.6 the tiles a bigger tile covers move to the next free cells", async () => {
  const page = await editing();
  await tile(page, "agentv.sample").hover();
  await page.keyboard.press("+");
  await page.waitForTimeout(200);
  // Sample grows right over Tube, which goes to the first free cell.
  let now = await layout();
  assert.equal(now["agentv.sample"], "m@0,0");
  assert.equal(now["agentv.tube"], "s@2,1");
  await page.keyboard.press("+");
  await page.waitForTimeout(200);
  now = await layout();
  assert.equal(now["agentv.sample"], "l@0,0");
  assert.equal(now["agentv.games"], "s@3,1");
  assert.equal(now["apps"], "s@0,2");
  await page.close();
});

test("S2.6 a size with no room can't be picked", async () => {
  // A full grid: My TV can't grow, because the tile it covers has nowhere to go.
  await setLayout([
    { id: "agentv.sample", x: 0, y: 0, size: "l" },
    { id: "agentv.tube", x: 2, y: 0, size: "s" },
    { id: "someone.radio", x: 3, y: 0, size: "s" },
    { id: "agentv.games", x: 2, y: 1, size: "s" },
    { id: "agentv.extra1", x: 3, y: 1, size: "s" },
    { id: "agentv.extra2", x: 0, y: 2, size: "s" },
    { id: "agentv.extra3", x: 1, y: 2, size: "s" },
    { id: "apps", x: 2, y: 2, size: "s" },
    { id: "local.mytv", x: 3, y: 2, size: "s" },
  ]);
  const page = await editing();
  await tile(page, "local.mytv").click();
  await page.waitForSelector(".sizebar.on");
  const medium = page.locator('.sizebar .chip[data-size="m"]');
  assert.equal(await medium.textContent(), "m · continue · no room");
  assert.ok(await medium.isDisabled());
  await page.keyboard.press("+");
  await page.waitForTimeout(150);
  assert.equal((await layout())["local.mytv"], "s@3,2");
  assert.equal((await played(page)).at(-1), "failure");
  // Dragging its corner shows no room, and changes nothing.
  const corner = await tile(page, "local.mytv").locator(".corner").boundingBox();
  assert.ok(corner);
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  const to = cell(2, 2);
  await page.mouse.move(to.x, to.y, { steps: 10 });
  assert.equal(await page.locator(".drop.on").innerText(), "no room");
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert.equal((await layout())["local.mytv"], "s@3,2");
  await page.close();
});

test("Delete takes a tile off home, and all apps stays", async () => {
  const page = await editing();
  await tile(page, "someone.radio").hover();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);
  assert.equal((await layout())["someone.radio"], undefined);
  assert.ok(await page.evaluate(() => document.querySelector(".focused")?.classList.contains("tile")));
  await tile(page, "apps").hover();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);
  assert.equal((await layout())["apps"], "s@1,1");
  await page.close();
});

test("Apps: p puts an app on home and takes it off, and e edits home", async () => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  await page.locator('.bar-link:has-text("apps")').click();
  await page.waitForSelector(".row .tile");
  await page.locator('.row [data-id="agentv.extra1"]').hover();
  await page.keyboard.press("p");
  // It moves to the row of apps on home, and keeps the focus.
  await page.waitForFunction(() => document.querySelectorAll(".row")[0]?.querySelector('[data-id="agentv.extra1"].focused'));
  assert.equal((await layout())["agentv.extra1"], "s@2,1");
  await page.keyboard.press("p");
  await page.waitForFunction(() => document.querySelectorAll(".row")[1]?.querySelector('[data-id="agentv.extra1"].focused'));
  assert.equal((await layout())["agentv.extra1"], undefined);
  await page.keyboard.press("e");
  await page.waitForSelector(".grid.editing");
  await page.close();
});

test("edit mode moves only transform and opacity, and has no console errors", async () => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  await page.keyboard.press("e");
  await page.waitForSelector(".grid.editing");
  for (const key of ["+", "ArrowRight", "Enter", "ArrowDown", "Enter", "-", "Escape"]) await page.keyboard.press(key);
  const moving = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      const durations = style.transitionDuration.split(",").map((d) => parseFloat(d));
      style.transitionProperty.split(",").forEach((property, i) => {
        if (!["transform", "opacity", "none"].includes(property.trim()) && (durations[i] ?? durations[0]) > 0) bad.push(`${el.className}: ${property}`);
      });
    }
    return bad;
  });
  assert.deepEqual(moving, []);
  await page.waitForTimeout(300);
  assert.deepEqual(errors, []);
  await page.close();
});
