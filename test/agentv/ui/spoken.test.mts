// Settings → Sound's spoken answers in a real Chromium (stage 8, layer 4):
// the switch, on by default, and a line saying which voice says the TV's
// answers: the provider's own, Piper on the box, or none when Piper isn't
// there.
// Turning it off says the TV only shows them. What the voices sound like is
// the NUC's.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

// A TV whose daemon says which voice it has.
async function tv(voice: object): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${url}/api/voice`, (route) => route.fulfill({ json: { ok: true, spoken: true, provider: null, last: null, ...voice } }));
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("settings/sound"));
  await page.waitForSelector('[data-action="spoken"]');
  return page;
}

const panel = (page: Page) => page.textContent(".settings-panel").then((text) => text ?? "");

test("Settings → Sound has spoken answers on, and says the provider's own voice says them", async () => {
  const page = await tv({ by: "provider", provider: "gemini", own: "missing" });
  try {
    // The row's value says it's on, and whose voice it is.
    await page.waitForFunction(() => document.querySelector('[data-action="spoken"] .button-value')?.textContent === "Gemini's voice");
    assert.equal(await page.textContent('[data-action="spoken"] span'), "Speak answers");
  } finally {
    await page.close();
  }
});

// Settings draws again on many of the daemon's events. Drawn again while
// the first draw's ask for the voice waited, the second draw's answer is
// the same voice the first one already kept, and its line still shows.
test("Settings drawn again while it asks for the voice still shows which voice says the answers", async () => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const held: (() => void)[] = [];
  await page.route(`${url}/api/voice`, async (route) => {
    await new Promise<void>((resolve) => held.push(resolve));
    await route.fulfill({ json: { ok: true, spoken: true, provider: "gemini", last: null, by: "provider", own: "missing" } });
  });
  try {
    await page.goto(`${url}/`);
    await page.waitForSelector(".grid .tile.focused");
    const go = () => page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("settings/sound"));
    await go();
    await page.waitForSelector('[data-action="spoken"]');
    await go();
    for (let tries = 0; held.length < 2 && tries < 250; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(held.length, 2, "each draw asked for the voice");
    held[0]();
    await new Promise((resolve) => setTimeout(resolve, 200));
    held[1]();
    await page.waitForFunction(() => document.querySelector(".settings-panel")?.textContent?.includes("Gemini's voice"), undefined, { timeout: 5000 });
  } finally {
    await page.close();
  }
});

test("a voice that's known only once the focus is in the panel still shows, and the focus stays put", async () => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${url}/api/voice`, async (route) => {
    await held;
    await route.fulfill({ json: { ok: true, spoken: true, provider: "gemini", last: null, by: "provider", own: "missing" } });
  });
  try {
    await page.goto(`${url}/`);
    await page.waitForSelector(".grid .tile.focused");
    await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("settings/sound"));
    await page.waitForSelector('[data-action="spoken"]');
    await page.keyboard.press("ArrowRight");
    const focused = () => page.evaluate(() => document.querySelector(".settings-panel .focused")?.getAttribute("data-action") ?? null);
    const before = await focused();
    assert.ok(before, "the focus is on a control in the panel");
    release();
    await page.waitForFunction(() => document.querySelector(".settings-panel")?.textContent?.includes("Gemini's voice"));
    assert.equal(await focused(), before);
  } finally {
    await page.close();
  }
});

test("with no voice of the provider's, it says the TV's own voice says them", async () => {
  const page = await tv({ by: "own", own: "ready" });
  try {
    await page.waitForFunction(() => document.querySelector(".settings-panel")?.textContent?.includes("Built-in voice"));
    assert.equal(await page.locator('[data-action="spoken"]').count(), 1);
  } finally {
    await page.close();
  }
});

test("T17.1 a TV with no voice has no voice rows in Settings → Sound: no spoken answers switch and no line about a voice, and the rest of Sound stays", async () => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${url}/api/voice`, (route) => route.fulfill({ json: { ok: true, spoken: true, provider: null, last: null, by: null, own: "missing" } }));
  try {
    await page.goto(`${url}/`);
    await page.waitForSelector(".grid .tile.focused");
    await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("settings/sound"));
    await page.waitForSelector('[data-action="sound"]');
    // The voice's answer comes a moment after the page: the rows go then.
    await page.waitForFunction(() => document.querySelector('[data-action="spoken"]') === null, null, { timeout: 5_000 });
    assert.equal(await page.locator('[data-note="voice"]').count(), 0);
    assert.doesNotMatch(await panel(page), /speak|spoken|voice|piper/i);
    assert.equal(await page.locator('[data-action="sound"]').count(), 1, "ui sounds keeps its switch");
    assert.equal(await page.locator('[data-action="volume"]').count(), 1);
    // Opened again, with the answer known from the start: still no rows.
    await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("home"));
    await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("settings/sound"));
    await page.waitForSelector('[data-action="sound"]');
    assert.equal(await page.locator('[data-action="spoken"]').count(), 0);
    assert.doesNotMatch(await panel(page), /speak|spoken|voice|piper/i);
  } finally {
    await page.close();
  }
});

test("turning spoken answers off keeps it off, and says the TV only shows them", async () => {
  const page = await tv({ by: "own", own: "ready" });
  try {
    await page.click('[data-action="spoken"]');
    await page.waitForFunction(() => document.querySelector('[data-action="spoken"] .button-value')?.textContent === "Off");
    assert.doesNotMatch(await panel(page), /voice/i, "off, the row's value says only that");
    assert.equal((await daemon.home.settings()).spoken, false, "the daemon keeps it");
    await page.click('[data-action="spoken"]');
    await page.waitForFunction(() => document.querySelector('[data-action="spoken"] .button-value')?.textContent === "Built-in voice");
  } finally {
    await page.close();
  }
});

// Settings changed elsewhere ask the page for home again. An answer that
// left before this page saved a setting, and came after, doesn't put the
// old setting back.
test("an answer about home from before a switch is turned off doesn't turn it back on", async () => {
  const page = await tv({ by: "own", own: "ready" });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let asked = false;
  let fulfilled: () => void = () => {};
  const done = new Promise<void>((resolve) => (fulfilled = resolve));
  await page.route(`${url}/api/home`, async (route) => {
    if (asked) return route.continue();
    asked = true;
    const answer = await route.fetch();
    await held;
    await route.fulfill({ response: answer });
    fulfilled();
  });
  try {
    // A change from somewhere else, such as the phone: the page asks for home.
    await fetch(`${url}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spoken: true }) });
    for (let tries = 0; !asked && tries < 250; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(asked, "the page asked for home");
    await page.click('[data-action="spoken"]');
    await page.waitForFunction(() => document.querySelector('[data-action="spoken"] .button-value')?.textContent === "Off");
    await page.waitForTimeout(300);
    release();
    await done;
    await page.waitForTimeout(300);
    assert.equal(await page.textContent('[data-action="spoken"] .button-value'), "Off");
    assert.equal((await daemon.home.settings()).spoken, false);
    await page.click('[data-action="spoken"]');
    await page.waitForFunction(() => document.querySelector('[data-action="spoken"] .button-value')?.textContent === "Built-in voice");
  } finally {
    await page.close();
  }
});
