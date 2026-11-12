// Where the TV is (ADR-055), in a real Chromium. Setup's country step
// starts on the country of the time zone the installer set, so it's one
// press of OK. Another country is typed on the phone's keyboard or picked
// with the arrows, and the time zone moves with it. A box in UTC goes
// straight to picking one. Settings → country changes the same setting
// later. The tz database's tables are the tests' few lines of them.

import assert from "node:assert/strict";
import { readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { PHASE_1, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url, state } = await startBox(0, undefined, { zone: "Europe/Oslo", features: PHASE_1 }));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

const zone = () => readlinkSync(process.env.AGENTV_LOCALTIME!).replace(/^.*zoneinfo\//, "");

// The box in a time zone, with no country picked yet.
function inZone(name: string): void {
  rmSync(process.env.AGENTV_LOCALTIME!, { force: true });
  symlinkSync(`/usr/share/zoneinfo/${name}`, process.env.AGENTV_LOCALTIME!);
  rmSync(join(state, "country.json"), { force: true });
}

// Setup on its country step, past the welcome screen and getting ready.
function atCountry(): void {
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "country", finished: { welcome: "2026-11-03T10:00:00Z", ready: "2026-11-03T10:01:00Z" } }));
}

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  return page;
}

const country = async () => (await (await fetch(`${url}/api/country`)).json()) as { code: string | null; picked: boolean; zone: string };
const headline = (page: Page) => page.locator(".setup-headline").getAttribute("aria-label");

test("ADR-055 setup's country step starts on the installer's time zone's country, and one press of OK confirms it", async () => {
  inZone("Europe/Oslo");
  atCountry();
  const page = await tv();
  try {
    await page.waitForSelector('[data-action="country-other"]');
    assert.equal(await headline(page), "Norway?");
    assert.equal(await page.locator(".setup-page .prompt").textContent(), "~ $ tv location");
    assert.match((await page.locator(".bar").textContent()) ?? "", /1\/6 location/);
    assert.deepEqual(await page.locator(".setup-page .button").allTextContents(), ["Yes", "Another location"]);
    assert.equal(await page.locator(".focused").getAttribute("data-action"), "continue");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".providers");
    const now = await country();
    assert.deepEqual([now.code, now.picked, now.zone], ["NO", true, "Europe/Oslo"]);
    assert.equal(zone(), "Europe/Oslo", "the time zone stays");
  } finally {
    await page.close();
  }
});

test("ADR-055 another country is typed on the phone's keyboard, and the time zone follows it", async () => {
  inZone("Europe/Oslo");
  atCountry();
  const page = await tv();
  try {
    await page.waitForSelector('[data-action="country-other"]');
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.locator(".focused").getAttribute("data-action"), "country-other");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".country-picker");
    assert.equal(await headline(page), "Pick your location");
    // The phone's keyboard types into the field, as on the box.
    await page.fill('[data-action="country-field"]', "unit");
    await page.waitForFunction(() => document.querySelectorAll(".country-list .country").length === 1);
    assert.equal(await page.locator(".country-list .country").first().textContent(), "United StatesUS");
    await page.click('.country-list [data-code="US"]');
    await page.waitForSelector(".providers");
    const now = await country();
    assert.deepEqual([now.code, now.picked, now.zone], ["US", true, "America/New_York"]);
    assert.equal(zone(), "America/New_York", "the zone most of its people live in (Q167)");
  } finally {
    await page.close();
  }
});

test("ADR-055 with the arrows: the picker opens around the box's country, and OK picks the one with the focus", async () => {
  inZone("Europe/Oslo");
  atCountry();
  const page = await tv();
  try {
    await page.waitForSelector('[data-action="country-other"]');
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".country-picker");
    // Two by four, around norway, which has the focus and says it's here.
    assert.deepEqual(await page.locator(".country-list .country").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.code)), ["JP", "NL", "NZ", "NO", "PT", "RS", "SJ", "US"]);
    assert.equal(await page.locator(".focused").getAttribute("data-code"), "NO");
    assert.match((await page.locator(".country.current").textContent()) ?? "", /^NorwayCurrent$/);
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.locator(".focused").getAttribute("data-code"), "RS");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".providers");
    assert.deepEqual([(await country()).code, zone()], ["RS", "Europe/Belgrade"]);
  } finally {
    await page.close();
  }
});

test("ADR-055 a box in UTC has no country to confirm, so the step starts on picking one", async () => {
  inZone("UTC");
  atCountry();
  const page = await tv();
  try {
    await page.waitForSelector(".country-picker");
    assert.equal(await page.locator('[data-action="country-other"]').count(), 0);
    assert.equal(await headline(page), "Pick your location");
    await page.fill('[data-action="country-field"]', "japan");
    await page.click('.country-list [data-code="JP"]');
    await page.waitForSelector(".providers");
    assert.deepEqual([(await country()).code, zone()], ["JP", "Asia/Tokyo"]);
  } finally {
    await page.close();
  }
});

test("ADR-055 Settings → country shows where the TV is and changes the same setting, the time zone with it", async () => {
  inZone("Europe/Oslo");
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true }));
  const page = await tv();
  try {
    await page.waitForSelector(".grid .tile.focused");
    await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("settings/country"));
    // It's the Location row in System, with where the TV is as its value.
    await page.waitForFunction(() => document.querySelector('.settings-panel [data-action="country"]')?.textContent === "LocationNorway");
    assert.equal(await page.locator(".menu-item.open").textContent(), "System");
    await page.click('[data-action="country"]');
    await page.waitForSelector(".country-picker");
    assert.equal(await page.locator(".page .headline").textContent(), "Pick your location");
    assert.equal(await page.locator(".page > .panel-note").textContent(), "It sets your clock and what's new");
    await page.fill('[data-action="country-field"]', "port");
    await page.click('.country-list [data-code="PT"]');
    await page.locator(".toast.ok", { hasText: "Location set to Portugal" }).waitFor();
    await page.waitForFunction(() => document.querySelector('.settings-panel [data-action="country"]')?.textContent === "LocationPortugal");
    assert.deepEqual([(await country()).code, zone()], ["PT", "Europe/Lisbon"]);
  } finally {
    await page.close();
  }
});
