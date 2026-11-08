// Setup's location step with setup's own switch on (design page D3), in a
// real Chromium. It starts on the country of the phone's own time zone, as
// a stand-in phone on the captive page sends it, and one press confirms it.
// A country whose time zones differ asks which one, unless the phone's zone
// is in it. With no phone and a box in UTC, it starts on a pick. The tz
// database's tables are the tests' few lines of them.

import assert from "node:assert/strict";
import { readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let captive = "";
let state = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url, state } = await startBox(0, undefined, { zone: "UTC", features: { setup2: true } }));
  captive = `http://127.0.0.1:${daemon.setupPort}`;
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

const zone = () => readlinkSync(process.env.AGENTV_LOCALTIME!).replace(/^.*zoneinfo\//, "");

// Setup on its location step with its own switch on, past getting ready,
// on a box in a time zone with no country picked and no phone's zone yet.
function atLocation(boxZone = "UTC"): void {
  rmSync(process.env.AGENTV_LOCALTIME!, { force: true });
  symlinkSync(`/usr/share/zoneinfo/${boxZone}`, process.env.AGENTV_LOCALTIME!);
  rmSync(join(state, "country.json"), { force: true });
  writeFileSync(join(state, "features.json"), JSON.stringify({ setup2: true }));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "country", finished: { welcome: "2026-11-05T10:00:00Z", ready: "2026-11-05T10:01:00Z" } }));
}

// A phone that joined the setup hotspot: its captive page sends its zone.
async function phoneIn(phoneZone: string): Promise<void> {
  const sent = await fetch(`${captive}/api/setup/zone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ zone: phoneZone }) });
  assert.equal(sent.status, 200);
}

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  return page;
}

const headline = (page: Page) => page.locator(".setup-headline").getAttribute("aria-label");
const country = async () => (await (await fetch(`${url}/api/country`)).json()) as { code: string | null; zone: string };

test("T7.1 the location step starts on the country of a stand-in phone's time zone, and one press of OK confirms it", async () => {
  atLocation();
  await phoneIn("Europe/Amsterdam");
  const page = await tv();
  try {
    await page.waitForSelector('[data-action="country-other"]');
    assert.equal(await headline(page), "the netherlands?");
    assert.equal(await page.locator(".setup-page .prompt").textContent(), "~ $ agentv location");
    assert.match((await page.locator(".setup-line").textContent()) ?? "", /^from your phone's time zone · \d\d:\d\d in amsterdam$/);
    assert.equal(await page.locator(".bar .bar-step").textContent(), "5 of 12 · location");
    assert.equal(await page.locator(".focused").getAttribute("data-action"), "continue");
    assert.equal(await page.locator(".focused").textContent(), "↵ yes");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".providers");
    assert.deepEqual([(await country()).code, zone()], ["NL", "Europe/Amsterdam"]);
  } finally {
    await page.close();
  }
});

test("T7.1 a country with several time zones asks which one, each with its city and the time there", async () => {
  atLocation();
  await phoneIn("Europe/Amsterdam");
  const page = await tv();
  try {
    await page.waitForSelector('[data-action="country-other"]');
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator(".focused").getAttribute("data-action"), "country-other");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".country-picker");
    assert.equal(await headline(page), "pick the country.");
    await page.fill('[data-action="country-field"]', "unit");
    await page.waitForFunction(() => document.querySelectorAll(".country-list .country").length === 1);
    await page.click('.country-list [data-code="US"]');
    await page.waitForSelector(".zones");
    assert.equal(await headline(page), "which time zone?");
    assert.equal(await page.locator(".setup-line").textContent(), "the united states has six");
    assert.deepEqual(await page.locator(".zone .zone-name").allTextContents(), ["eastern", "central", "mountain", "mountain", "pacific", "hawaii-aleutian"]);
    assert.match((await page.locator('.zone[data-zone="America/Phoenix"] .zone-where').textContent()) ?? "", /^phoenix · \d\d:\d\d$/);
    assert.equal(await page.locator(".bar .bar-step").textContent(), "5 of 12 · location");
    assert.equal(zone(), "UTC", "nothing moves before a zone is picked");
    await page.locator('.zone[data-zone="America/Phoenix"]').click();
    await page.waitForSelector(".providers");
    assert.deepEqual([(await country()).code, zone()], ["US", "America/Phoenix"]);
  } finally {
    await page.close();
  }
});

test("T7.1 no question when the phone's zone is in the country, or the country keeps one clock", async () => {
  atLocation();
  await phoneIn("America/Chicago");
  let page = await tv();
  try {
    await page.waitForSelector('[data-action="country-other"]');
    assert.equal(await headline(page), "the united states?");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".providers");
    assert.deepEqual([(await country()).code, zone()], ["US", "America/Chicago"]);
  } finally {
    await page.close();
  }

  atLocation();
  await phoneIn("Europe/Amsterdam");
  page = await tv();
  try {
    await page.waitForSelector('[data-action="country-other"]');
    await page.locator('[data-action="country-other"]').click();
    await page.fill('[data-action="country-field"]', "germ");
    await page.waitForFunction(() => document.querySelectorAll(".country-list .country").length === 1);
    await page.click('.country-list [data-code="DE"]');
    await page.waitForSelector(".providers");
    assert.deepEqual([(await country()).code, zone()], ["DE", "Europe/Berlin"], "Germany's zones keep one clock");
    assert.equal(await page.locator(".zones").count(), 0);
  } finally {
    await page.close();
  }
});

test("T7.1 with no phone and a box in UTC, the step starts on a pick, and a phone's zone arriving later takes over", async () => {
  atLocation();
  let page = await tv();
  try {
    await page.waitForSelector(".country-picker");
    assert.equal(await headline(page), "pick the country.");
    assert.equal(await page.locator(".setup-line").textContent(), "type it on your phone, or move with the arrows");
  } finally {
    await page.close();
  }

  // A box that has a zone of its own starts there, and the phone's zone
  // takes over when it comes.
  atLocation("Europe/Oslo");
  page = await tv();
  try {
    await page.waitForSelector('[data-action="country-other"]');
    assert.equal(await headline(page), "norway?");
    assert.match((await page.locator(".setup-line").textContent()) ?? "", /^from this box's time zone · \d\d:\d\d in oslo$/);
    await phoneIn("Europe/Amsterdam");
    await page.waitForFunction(() => document.querySelector(".setup-headline")?.getAttribute("aria-label") === "the netherlands?");
    assert.match((await page.locator(".setup-line").textContent()) ?? "", /in amsterdam$/);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".providers");
    assert.deepEqual([(await country()).code, zone()], ["NL", "Europe/Amsterdam"]);
  } finally {
    await page.close();
    rmSync(join(state, "features.json"), { force: true });
  }
});

test("T7.1 the captive page and the companion send the phone's own time zone, and the step starts on its country", async () => {
  atLocation();
  // A phone in Chicago joins the setup hotspot: its captive page sends it.
  const captivePhone = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: "America/Chicago", hasTouch: true });
  captivePhone.on("pageerror", (error) => errors.push(error.message));
  try {
    await captivePhone.goto(`${captive}/`);
    for (let i = 0; i < 50 && (await (await fetch(`${url}/api/setup/location`)).json()).phoneZone !== "America/Chicago"; i++) await captivePhone.waitForTimeout(100);
    assert.equal((await (await fetch(`${url}/api/setup/location`)).json()).start?.called, "the united states");
  } finally {
    await captivePhone.close();
  }
  // A phone in Amsterdam pairs with the companion: it sends its own.
  const code = (await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json()).pairing.code;
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: "Europe/Amsterdam", hasTouch: true });
  phone.on("pageerror", (error) => errors.push(error.message));
  try {
    await phone.goto(`http://127.0.0.1:${daemon.lanPort}/?code=${code}`);
    for (let i = 0; i < 50 && (await (await fetch(`${url}/api/setup/location`)).json()).phoneZone !== "Europe/Amsterdam"; i++) await phone.waitForTimeout(100);
    assert.equal((await (await fetch(`${url}/api/setup/location`)).json()).start?.called, "the netherlands");
  } finally {
    await phone.close();
  }
});
