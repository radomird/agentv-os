// The built-in Clock and Weather on the home screen, in a real Chromium
// (ADR-019, layer 4), on a box in Amsterdam whose forecast comes from a
// stand-in for MET Norway with a recorded reply: the weather's scene from
// MET's symbol and the wind (S3.8), its medium and large sizes (S3.9), the
// clock that ticks on home, and what choosing each one opens.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";
import { startMet, type Met } from "./met.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let met: Met;
let url = "";
const errors: string[] = [];

before(async () => {
  met = await startMet();
  ({ daemon, url } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", forecast: met.url }));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  met?.close();
});

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  await rest(page);
  return page;
}

async function setWeather(size: "s" | "m" | "l"): Promise<void> {
  const home = await (await fetch(`${url}/api/home`)).json();
  const layout = [
    { id: "agentv.weather", x: 0, y: 0, size },
    { id: "agentv.clock", x: 2, y: 0, size: "m" },
    { id: "apps", x: 3, y: 2, size: "s" },
  ];
  const response = await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout }) });
  assert.equal(response.status, 200, `${home.viewer.id}'s layout is saved`);
}

const tile = '.grid .tile[data-id="agentv.weather"]';

test("S3.8 the small weather tile draws MET's condition as its scene, with the temperature and the day's high and low", async () => {
  const page = await tv();
  await page.waitForSelector(`${tile} .pixel`);
  const drawn = await page.$eval(tile, (el) => ({
    head: el.querySelector(".tile-head-name")?.textContent,
    place: el.querySelector(".tile-head-label")?.textContent,
    scene: el.querySelector(".tile-now .pixel")?.getAttribute("aria-label"),
    value: el.querySelector(".headline-value")?.textContent,
    caption: el.querySelector(".headline-caption")?.textContent,
    foot: el.querySelector(".entry-caption")?.textContent,
  }));
  assert.equal(drawn.head, "weather");
  assert.equal(drawn.place, "amsterdam");
  // MET said partly cloudy with 11.2 m/s of wind: windy.
  assert.equal(drawn.scene, "windy");
  assert.equal(drawn.value, "12°");
  assert.equal(drawn.caption, "windy");
  assert.match(drawn.foot ?? "", /^h -?\d+° · l -?\d+°$/);
  // Its colours are the theme's.
  const colours = await page.$eval(`${tile} .pixel path`, (path) => [getComputedStyle(path).fill, getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim()]);
  assert.equal(colours[0], "rgb(169, 177, 214)");
  assert.equal(colours[1], "#a9b1d6");
  await page.close();
});

test("the ten weather scenes are in the launcher's own pixel set", async () => {
  const page = await tv();
  const found = await page.evaluate(async () => {
    // The page's own module, as the launcher loads it.
    const path = "/launcher/pixels.ts";
    const { pixel } = (await import(path)) as typeof import("../../../launcher/pixels.ts");
    const names = ["clear", "clear-night", "partly-cloudy", "cloudy", "rain", "heavy-rain", "snow", "thunderstorm", "wind", "fog"];
    return names.map((name) => pixel(name, 100)?.getAttribute("aria-label") ?? null);
  });
  assert.deepEqual(found, ["clear", "clear night", "partly cloudy", "cloudy", "rain", "heavy rain", "snow", "thunderstorm", "windy", "fog"]);
  await page.close();
});

test("S3.9 the medium weather tile shows today and tomorrow, and the large one now and seven days", async () => {
  await setWeather("m");
  let page = await tv();
  await page.waitForSelector(`${tile} .entry .pixel`);
  const medium = await page.$$eval(`${tile} .entry`, (els) =>
    els.map((el) => [el.querySelector(".entry-label")?.textContent, el.querySelector(".pixel")?.getAttribute("aria-label"), el.querySelector(".entry-value")?.textContent]),
  );
  assert.equal(medium.length, 2);
  assert.deepEqual(medium[0], ["today", "windy", "12°"]);
  assert.equal(medium[1][0], "tomorrow");
  await page.close();

  await setWeather("l");
  page = await tv();
  await page.waitForSelector(`${tile} .entry .pixel`);
  const large = await page.$eval(tile, (el) => ({
    place: el.querySelector(".tile-head-label")?.textContent,
    scene: el.querySelector(".tile-now .pixel")?.getAttribute("aria-label"),
    days: [...el.querySelectorAll(".entry")].map((entry) => entry.querySelector(".entry-label")?.textContent),
    icons: el.querySelectorAll(".entry .pixel").length,
  }));
  assert.equal(large.place, "amsterdam · 7 days");
  assert.equal(large.scene, "windy");
  assert.equal(large.days.length, 7);
  assert.equal(large.days[0], "today");
  assert.ok(large.days.slice(1).every((day) => /^(mon|tue|wed|thu|fri|sat|sun)$/.test(day ?? "")));
  assert.equal(large.icons, 7);
  // Nothing spills out of the tile.
  const spill = await page.$eval(tile, (el) => {
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll("*")].some((child) => {
      const r = child.getBoundingClientRect();
      return r.width > 0 && (r.right > box.right + 1 || r.bottom > box.bottom + 1);
    });
  });
  assert.equal(spill, false);
  await page.close();
});

test("the clock ticks on home, and choosing it opens the ambient screen", async () => {
  const page = await tv();
  const clock = '.grid .tile[data-id="agentv.clock"]';
  await page.waitForSelector(`${clock} .clock-time`);
  const shown = await page.$eval(clock, (el) => [el.querySelector(".clock-time")?.textContent, el.querySelector(".tile-head-label")?.textContent]);
  assert.match(shown[0] ?? "", /^\d\d:\d\d$/);
  // Medium: the box's own city along the top.
  assert.equal(shown[1], "amsterdam");
  await page.locator(clock).hover();
  await page.keyboard.press("Enter");
  await page.waitForSelector("#ambient.on");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => !document.getElementById("ambient")?.classList.contains("on"));
  await page.close();
});

test("choosing Weather opens Settings → Weather, where left and right pick another city", async () => {
  const page = await tv();
  await page.locator(tile).hover();
  await page.keyboard.press("Enter");
  await page.waitForSelector('.menu-item.open[data-key="weather"]');
  await page.waitForFunction(() => document.querySelector(".panel-big")?.textContent === "amsterdam");
  await page.locator('[data-action="city"]').hover();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".panel-big")?.textContent === "belgrade");
  assert.equal((await (await fetch(`${url}/api/tile/agentv.weather/s`)).json()).tile.headline.label, "belgrade");
  await page.locator('[data-action="own-city"]').click();
  await page.waitForFunction(() => document.querySelector(".panel-big")?.textContent === "amsterdam");
  await page.close();
});

test("Weather's details say it's built in and whose data it shows", async () => {
  const page = await tv();
  await page.locator(tile).hover();
  await page.keyboard.press("i");
  await page.waitForSelector(".details-head");
  const text = await page.$eval(".details", (el) => el.textContent ?? "");
  assert.match(text, /built in/);
  assert.match(text, /weather data from met norway, under cc by 4\.0/);
  assert.equal(await page.$(".owner"), null);
  await page.close();
});

test("the built-ins leave nothing in the console", () => {
  assert.deepEqual(errors, []);
});
