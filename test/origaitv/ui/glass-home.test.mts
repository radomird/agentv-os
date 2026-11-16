// Glass's home as it was signed off (T20.1, layer 4). At rest it's the top
// shelf and the pinned row, in its frosted panel, with nothing under it, and
// the name of the pinned app in focus stays inside the screen's margin, even
// when that margin grows. Down from the pinned row, or Apps in the bar,
// brings the list up: the pinned row goes to the top and the list's first
// row comes in right under it. Down through the list to Games keeps the row
// above in view, and rows that went up under the pinned row fade. Back takes
// home back to rest. The list ends with Not on home and Add an app, as Apps
// did. Top row in an app's details pins it, six at most, and the daemon
// keeps the pinned row per profile.

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
// 13 apps and the game on home. The first six apps are pinned on a home
// that never pinned any; the other seven are the list's two rows.
const ON_HOME = [...FIXTURES.map((f) => f.id).filter((id) => id !== GAME), ...MORE.slice(0, 9).map((f) => f.id), GAME];
const PINNED = ON_HOME.slice(0, 6);
const placed = (ids: string[]) => ids.map((id, i) => ({ id, x: i % 4, y: Math.floor(i / 4), size: "s" }));

let browser: Browser;
let daemon: Daemon;
let url = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url } = await startBox(0, APPS, { features: { looks: true } }));
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
  assert.equal((await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look: "glass" }) })).status, 200);
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

const put = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const pinned = async (): Promise<string[]> => (await (await fetch(`${url}/api/home`)).json()).pinned;

beforeEach(async () => {
  const response = await put("/api/layout", { layout: placed(ON_HOME) });
  assert.equal(response.status, 200, await response.text());
  assert.equal((await put("/api/pinned", { pinned: PINNED })).status, 200);
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
  await page.waitForSelector("html[data-look] .glass-home .focused");
  await rest(page);
  return page;
}

type Launcher = { origaitvLauncher: { go(route: string): void; focus: { get(): HTMLElement | undefined } } };
const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as Launcher).origaitvLauncher.go(r), route);
const focused = (page: Page) => page.evaluate(() => (window as unknown as Launcher).origaitvLauncher.focus.get()?.dataset.id ?? (window as unknown as Launcher).origaitvLauncher.focus.get()?.dataset.action);
// Once the list has stopped moving, and anything fading has faded.
const settle = (page: Page) => page.waitForFunction(() => !document.querySelector(".glass-home.moving") && document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5000 });

// Where things are on the screen, in its pixels.
async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => (el ? el.getBoundingClientRect().toJSON() : null);
    const root = document.documentElement;
    const zoom = Number(root.style.zoom) || 1;
    const list = document.querySelector(".glass-list")!;
    const shown = (el: Element) => getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0.01;
    const focused = document.querySelector(".focused");
    return {
      height: innerHeight,
      zoom,
      safeY: parseFloat(getComputedStyle(root).getPropertyValue("--safe-y")) * zoom,
      stuck: parseFloat(getComputedStyle(document.querySelector(".glass-pinned")!).top) * zoom,
      rest: document.querySelector(".glass-home")!.classList.contains("rest"),
      panel: rect(document.querySelector(".glass-pinned")),
      label: rect(document.querySelector(".glass-pinned .focused .glass-label")),
      listShown: shown(list),
      // Each of the list's rows, and whether it can be seen.
      rows: [...list.querySelectorAll<HTMLElement>(".glass-row")].map((row) => ({ ...row.getBoundingClientRect().toJSON(), gone: row.classList.contains("gone"), focused: Boolean(row.querySelector(".focused")), section: row.closest<HTMLElement>("[data-section]")?.dataset.section ?? "apps" })),
      cards: rect(document.querySelector(".glass-cards")),
      focusedRect: rect(focused),
    };
  });
}

test("T20.1 glass at rest: the shelf and the pinned row, nothing under it, and the focused app's name inside the margin, at each size", async () => {
  for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
    const page = await tv(size);
    try {
      await settle(page);
      const pinnedIds = await page.locator(".glass-pinned [data-id]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.id));
      assert.deepEqual(pinnedIds, PINNED, `${size}: the pinned row, in its order`);
      assert.equal(await focused(page), PINNED[0], `${size}: the focus starts on the pinned row`);
      const at = await measure(page);
      assert.ok(at.rest, `${size}: home is at rest`);
      assert.ok(!at.listShown, `${size}: the list isn't shown`);
      assert.ok(at.panel!.bottom <= at.height - at.safeY, `${size}: the pinned row is inside the margin (${at.panel!.bottom} of ${at.height})`);
      assert.ok(at.label, `${size}: the focused app's name shows`);
      assert.ok(at.label!.bottom <= at.height - at.safeY + 0.5, `${size}: its name is inside the margin (${Math.round(at.label!.bottom)} of ${at.height - at.safeY})`);
      // Nothing is drawn under the pinned row: whatever is at the screen's
      // bottom edge, under it, is the page's own background.
      for (const x of [0.1, 0.5, 0.9]) {
        const under = await page.evaluate(([x, y]) => document.elementsFromPoint(innerWidth * x, y).some((el) => el.closest(".glass-list")), [x, (at.panel!.bottom + at.height) / 2]);
        assert.equal(under, false, `${size}: nothing of the list under the pinned row`);
      }
      // A wider margin, as Fit to screen sets: the row and its name move up
      // with it.
      await page.evaluate(() => document.documentElement.style.setProperty("--safe-y", "110px"));
      await page.waitForTimeout(100);
      const wide = await measure(page);
      assert.ok(wide.label!.bottom <= wide.height - wide.safeY + 0.5, `${size}: with a wider margin, its name is still inside it (${Math.round(wide.label!.bottom)} of ${wide.height - wide.safeY})`);
    } finally {
      await page.close();
    }
  }
});

test("T20.1 glass: down brings the list up under the pinned row, down to Games keeps the row above in view, and Back goes back to rest, at each size", async () => {
  for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
    const page = await tv(size);
    try {
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowDown");
      await settle(page);
      assert.equal(await focused(page), "local.dune", `${size}: the app under it, in the list's first row`);
      let at = await measure(page);
      assert.ok(!at.rest && at.listShown, `${size}: the list is up`);
      assert.ok(Math.abs(at.panel!.top - at.stuck) < 2, `${size}: the pinned row is at the top (${at.panel!.top})`);
      assert.ok(at.rows[0].top >= at.panel!.bottom, `${size}: the first row is under it`);
      assert.ok(at.rows[0].bottom <= at.height, `${size}: and on the screen`);
      assert.ok(!at.cards || at.cards.bottom <= at.panel!.top + 1, `${size}: the shelf's cards went up and away`);
      // Down to the game, in its own row under Games.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await settle(page);
      assert.equal(await focused(page), GAME, `${size}: down twice reaches Games`);
      at = await measure(page);
      const games = at.rows.findIndex((row) => row.focused);
      assert.equal(at.rows[games].section, "games");
      const above = at.rows[games - 1];
      assert.ok(above.top >= at.panel!.bottom - 1 && !above.gone, `${size}: the row above Games is in view under the pinned row`);
      assert.ok(at.rows[games].bottom <= at.height, `${size}: Games is on the screen`);
      // Rows that went up under the pinned row fade.
      for (const row of at.rows.filter((one) => one.top < at.panel!.bottom - 1)) assert.ok(row.gone, `${size}: a row under the pinned row fades`);
      // Back: home at rest again, on the pinned row.
      await page.keyboard.press("Escape");
      await settle(page);
      at = await measure(page);
      assert.ok(at.rest && !at.listShown, `${size}: Back took the list away`);
      assert.ok(PINNED.includes((await focused(page))!), `${size}: the focus is on the pinned row`);
      assert.ok(at.panel!.bottom <= at.height - at.safeY, `${size}: the pinned row is back at the bottom`);
      // Up from the list's first row goes back to rest too.
      await page.keyboard.press("ArrowDown");
      await settle(page);
      await page.keyboard.press("ArrowUp");
      await settle(page);
      assert.ok((await measure(page)).rest, `${size}: up from the first row`);
    } finally {
      await page.close();
    }
  }
});

test("T20.1 glass: Apps in the bar brings the list up, from home and from another page, and the list ends with Add an app", async () => {
  const page = await tv();
  try {
    await page.click('.glass-bar [data-action="bar-apps"]');
    await settle(page);
    let at = await measure(page);
    assert.ok(!at.rest && at.listShown, "Apps on home brings the list up");
    assert.equal(await focused(page), "local.cove", "on the list's first app");
    // From Settings, Apps opens home with the list up.
    await go(page, "settings");
    await page.waitForSelector('[data-action="bar-apps"]');
    await page.click('[data-action="bar-apps"]');
    await page.waitForSelector(".glass-home.list .glass-list .focused");
    await settle(page);
    at = await measure(page);
    assert.ok(Math.abs(at.panel!.top - at.stuck) < 2, "the pinned row is at the top");
    // What Apps had is here: every app not on home, then Add an app.
    const off = await page.locator('[data-section="off"] [data-focus]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.id ?? (el as HTMLElement).dataset.action));
    assert.deepEqual(off, ["local.juniper", "local.kestrel", "local.lumen", "add-app"]);
    const last = await page.locator(".glass-list [data-focus]").last().getAttribute("data-action");
    assert.equal(last, "add-app", "the list ends with Add an app");
    // Down and down again reach it, and it's on the screen.
    for (let i = 0; i < 8 && (await focused(page)) !== "add-app"; i++) {
      await page.keyboard.press(i < 5 ? "ArrowDown" : "ArrowRight");
      await page.waitForTimeout(120);
    }
    assert.equal(await focused(page), "add-app");
    await settle(page);
    at = await measure(page);
    assert.ok(at.focusedRect!.bottom <= at.height && at.focusedRect!.top >= at.panel!.bottom, "Add an app is on the screen, under the pinned row");
    // Back goes to home at rest, not back to Settings.
    await page.keyboard.press("Escape");
    await settle(page);
    assert.ok((await measure(page)).rest);
  } finally {
    await page.close();
  }
});

test("T20.1 glass: with the list up, an app opening behind home keeps the list and the focus, the tile says it's open, and Home goes back to rest", async () => {
  const page = await tv();
  try {
    await page.keyboard.press("ArrowDown");
    await settle(page);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
    assert.equal(await focused(page), "local.inlet");
    // Inlet opens behind home: home draws again, as it does for any change.
    await page.evaluate(() => (window as unknown as { origaitvRunning: (json: string) => void }).origaitvRunning(JSON.stringify([{ id: "local.inlet", game: false, paused: false }])));
    await page.waitForFunction(() => /Open/.test(document.querySelector('.glass-list [data-id="local.inlet"] .glass-label')?.textContent ?? ""));
    await settle(page);
    const at = await measure(page);
    assert.ok(!at.rest && at.listShown, "the list is still up");
    assert.equal(await focused(page), "local.inlet", "on the same app");
    assert.ok(at.focusedRect!.top >= at.panel!.bottom && at.focusedRect!.bottom <= at.height, "which is on the screen");
    // Back from its details comes back to it, in the list.
    await page.keyboard.press("i");
    await page.waitForSelector(".details-head");
    await page.keyboard.press("Escape");
    await page.waitForSelector('.glass-home.list .glass-list [data-id="local.inlet"].focused');
    // From another page, Home is home at rest.
    await go(page, "settings");
    await page.waitForSelector('[data-action="bar-settings"].on, .settings');
    await page.keyboard.press("Home");
    await page.waitForSelector(".glass-home.rest");
    assert.ok(PINNED.includes((await focused(page))!), "on the pinned row");
  } finally {
    await page.close();
  }
});

test("T20.1 glass: Top row in an app's details pins it, up to six, and takes it off again", async () => {
  // Five pinned: one place free.
  assert.equal((await put("/api/pinned", { pinned: PINNED.slice(0, 5) })).status, 200);
  const page = await tv();
  try {
    await go(page, "details/local.cove");
    await page.waitForSelector('.details [data-action="top-row"]');
    assert.match(await page.locator('.details [data-action="top-row"]').innerText(), /Top row/);
    await page.click('.details [data-action="top-row"]');
    await page.waitForFunction(() => (document.querySelector('.details [data-action="top-row"] .button-value')?.childElementCount ?? 0) > 0);
    assert.deepEqual(await pinned(), [...PINNED.slice(0, 5), "local.cove"]);
    // Full: another isn't pinned, and the toast says why.
    await go(page, "details/local.dune");
    await page.waitForSelector('.details [data-action="top-row"]');
    await page.click('.details [data-action="top-row"]');
    await page.waitForSelector("#toasts .toast");
    assert.match(await page.locator("#toasts").innerText(), /The top row holds 6 apps/);
    assert.deepEqual(await pinned(), [...PINNED.slice(0, 5), "local.cove"]);
    // Off again, and home shows the pinned row as kept.
    await go(page, "details/local.cove");
    await page.waitForSelector('.details [data-action="top-row"]');
    await page.click('.details [data-action="top-row"]');
    await page.waitForFunction(() => document.querySelector('.details [data-action="top-row"] .button-value')?.childElementCount === 0);
    assert.deepEqual(await pinned(), PINNED.slice(0, 5));
    await go(page, "home");
    await page.waitForSelector(".glass-home");
    assert.deepEqual(await page.locator(".glass-pinned [data-id]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.id)), PINNED.slice(0, 5));
    // An app that isn't on home has no Top row.
    await go(page, "details/local.kestrel");
    await page.waitForSelector('.details [data-action="home"]');
    assert.equal(await page.locator('.details [data-action="top-row"]').count(), 0);
  } finally {
    await page.close();
  }
});

test("T20.1 glass: the daemon keeps six pinned at most, each on home, and an app taken off home leaves the pinned row", async () => {
  assert.equal((await put("/api/pinned", { pinned: [...PINNED, "local.cove"] })).status, 400, "seven");
  assert.equal((await put("/api/pinned", { pinned: ["local.kestrel"] })).status, 400, "not on home");
  assert.equal((await put("/api/pinned", { pinned: ["local.cove", "local.cove"] })).status, 400, "twice");
  assert.equal((await put("/api/pinned", { pinned: "local.cove" })).status, 400, "not a list");
  assert.deepEqual(await pinned(), PINNED, "unchanged");
  assert.equal((await put("/api/pinned", { pinned: [GAME, "local.inlet"] })).status, 200, "a game can be pinned");
  assert.deepEqual(await pinned(), [GAME, "local.inlet"]);
  // Taken off home, an app leaves the pinned row too.
  assert.equal((await put("/api/layout", { layout: placed(ON_HOME.filter((id) => id !== "local.inlet")) })).status, 200);
  assert.deepEqual(await pinned(), [GAME]);
});
