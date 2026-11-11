// What's loading says so, and comes without being asked twice (T17.1), in
// a real Chromium on the daemon itself, with a stand-in for MET Norway.
//
// Home draws within seconds of a start, often before the TV is online. So
// in each look, dark and light: with the forecast unreachable as home first
// draws, Weather's tile shows the one shared loading mark, and once the
// forecast can be reached the tile has it with home never left. With the
// forecast there from the start, it's on home's first draw. Weather's own
// page waits the same way, a look's preview never does, and with reduce
// motion the mark keeps still.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { FIXTURES, rest, startBox } from "./box.mts";
import { rendered } from "./legible.mts";
import { startMet } from "./met.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
// One dark theme and one light one, as Omarchy ships them.
const THEMES = ["tokyo-night", "catppuccin-latte"] as const;
const WEATHER = '.tile[data-id="agentv.weather"]';

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(() => browser?.close());

// A box in a look and a theme, with its forecast from a stand-in that can't
// be reached yet when down is set.
async function box(look: string, theme: string, down: boolean) {
  const met = await startMet();
  met.down(down);
  const { daemon, url } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", forecast: met.url });
  const put = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await put("/api/look", { look })).status, 200);
  assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200);
  const errors: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const close = async () => {
    await page.close();
    await daemon.close();
    met.close();
  };
  return { met, url, page, errors, close, daemon };
}

async function home(page: Page, url: string): Promise<void> {
  await page.goto(`${url}/`);
  await page.waitForSelector("[data-focus].focused");
  await rest(page);
}

// The mark on Weather's tile, once it has faded in: where it is, its
// colour, and the colour of the tile behind it.
async function mark(page: Page): Promise<{ inside: boolean; busy: boolean; label: string | null; colour: string; behind: string; blocks: number }> {
  await page.waitForFunction((selector) => {
    const found = document.querySelector(`${selector} .loading-mark`);
    return found !== null && getComputedStyle(found).opacity === "1";
  }, WEATHER);
  return page.evaluate((selector) => {
    const tile = document.querySelector<HTMLElement>(selector)!;
    const found = tile.querySelector<HTMLElement>(".loading-mark")!;
    const block = found.querySelector<HTMLElement>("i")!;
    const [a, b] = [found.getBoundingClientRect(), tile.getBoundingClientRect()];
    return {
      inside: a.width > 0 && a.height > 0 && a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom,
      busy: found.parentElement!.getAttribute("aria-busy") === "true",
      label: found.getAttribute("aria-label"),
      colour: getComputedStyle(block).backgroundColor,
      behind: getComputedStyle(tile).backgroundColor,
      blocks: found.querySelectorAll("i").length,
    };
  }, WEATHER);
}

for (const look of LOOKS) {
  for (const theme of THEMES) {
    test(`T17.1 in ${look}, ${theme}: Weather says it's loading while its forecast can't be reached, and has it without home being left`, async () => {
      const { met, url, page, errors, close } = await box(look, theme, true);
      try {
        await home(page, url);
        const found = await mark(page);
        assert.ok(found.inside, "the mark is drawn inside Weather's tile");
        assert.ok(found.busy, "what holds the mark says it's busy");
        assert.equal(found.label, "Loading");
        assert.equal(found.blocks, 3);
        assert.notEqual(found.colour, found.behind, "the mark stands out from the tile");
        assert.doesNotMatch(await page.locator(WEATHER).innerText(), /°/, "no forecast yet");
        // The TV comes online. Nothing is pressed, and home isn't left.
        met.down(false);
        await page.waitForFunction((selector) => /12°/.test(document.querySelector<HTMLElement>(selector)?.innerText ?? ""), WEATHER, { timeout: 10_000 });
        // Home draws again with the forecast, and no tile is left waiting.
        await page.waitForFunction(() => document.querySelector(".loading-mark") === null, null, { timeout: 5_000 });
        assert.ok(await page.evaluate(() => document.body.classList.contains("on-home")), "home is still what's on");
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    });
  }

  test(`T17.1 in ${look}: Weather has its forecast on home's first draw, with no mark left on it`, async () => {
    const { met, url, page, errors, close } = await box(look, "tokyo-night", false);
    try {
      await home(page, url);
      await page.waitForFunction((selector) => /12°/.test(document.querySelector<HTMLElement>(selector)?.innerText ?? ""), WEATHER, { timeout: 10_000 });
      await page.waitForFunction((selector) => document.querySelector(`${selector} .loading-mark`) === null, WEATHER, { timeout: 5_000 });
      // Asked for once at each size home shows, never in a loop.
      const asked = met.seen.length;
      await page.waitForTimeout(1500);
      assert.equal(met.seen.length, asked, "a tile that has its content isn't asked for again");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });

  test(`T17.1 in ${look}: Weather's page says it's loading, then shows the week`, async () => {
    const { met, url, page, close } = await box(look, "tokyo-night", true);
    try {
      await home(page, url);
      await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("weather"));
      await page.waitForSelector(".forecast-week.is-loading .loading-mark");
      assert.equal(await page.locator(".forecast-day").count(), 0);
      met.down(false);
      await page.waitForSelector(".forecast-day", { timeout: 10_000 });
      assert.equal(await page.locator(".forecast-day").count(), 7);
      await page.waitForFunction(() => document.querySelector(".forecast-week .loading-mark") === null, null, { timeout: 5_000 });
    } finally {
      await close();
    }
  });
}

test("T17.1 a look's preview never says it's loading, and reduce motion keeps the mark still", async () => {
  const { url, page, close } = await box("glass", "tokyo-night", true);
  try {
    // A preview is home as a picture: it isn't waiting on anything.
    await page.goto(`${url}/?preview&look=glass`);
    await page.waitForSelector(WEATHER);
    await page.waitForTimeout(800);
    assert.equal(await page.locator(".loading-mark").count(), 0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await home(page, url);
    await page.waitForSelector(`${WEATHER} .loading-mark i`);
    assert.equal(await page.locator(`${WEATHER} .loading-mark i`).first().evaluate((el) => getComputedStyle(el).animationName), "none");
  } finally {
    await close();
  }
});

test("in Glass, a card that was waiting when the TV's daemon started over still gets its forecast", async () => {
  const { met, url, page, errors, close, daemon } = await box("glass", "tokyo-night", true);
  try {
    await home(page, url);
    await mark(page);
    // Past the draw home does about two seconds after it loads, which would
    // ask for the card again whatever happened to it.
    await page.waitForTimeout(2500);
    // A daemon that started over while the card waited no longer knows the
    // card was waiting, so it won't say "tiles" when the forecast comes.
    // Here it forgets what waits, which comes to the same for home.
    (daemon.home as unknown as { waiting: Pick<Set<string>, "add" | "delete"> }).waiting = { add: () => new Set<string>(), delete: () => false };
    met.down(false);
    await page.waitForFunction((selector) => /12°/.test(document.querySelector<HTMLElement>(selector)?.innerText ?? ""), WEATHER, { timeout: 12_000 });
    assert.ok(await page.evaluate(() => document.body.classList.contains("on-home")), "home is still what's on");
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("nothing is asked for again while the idle screen is up or the TV is off, and it's asked for at once when someone's back", async () => {
  const { url, page, errors, close } = await box("terminal", "tokyo-night", true);
  try {
    const asks: number[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/tile/agentv.weather/")) asks.push(Date.now());
    });
    await home(page, url);
    await mark(page);
    // Home draws once more about two seconds after it loads, and a draw
    // asks for each tile once. This is about the asking again, so it waits
    // for that draw to be over.
    await page.waitForTimeout(2500);
    const since = (at: number) => asks.filter((asked) => asked >= at).length;
    const tell = (name: "agentvAmbient" | "agentvTv", value: boolean | string) =>
      page.evaluate(([fn, arg]) => (window as unknown as Record<string, (value: unknown) => void>)[fn as string](arg), [name, value] as const);

    // An ask lands within a second of someone being back, whatever the
    // loop's next wait was.
    const asked = async (at: number) => {
      for (const end = Date.now() + 1500; Date.now() < end && since(at) === 0; ) await page.waitForTimeout(50);
      return since(at);
    };

    // The idle screen: the asking stops. Left running, it would ask again
    // within four seconds this early.
    await tell("agentvAmbient", true);
    await page.waitForTimeout(500);
    let quiet = Date.now();
    await page.waitForTimeout(5000);
    assert.equal(since(quiet), 0, "nothing is asked for behind the idle screen");
    // A key ends it: asked for at once.
    let back = Date.now();
    await tell("agentvAmbient", false);
    assert.ok((await asked(back)) >= 1, "asked for as the idle screen ends");

    // The TV off, right away, with the loop's next ask still seconds off:
    // the same.
    await tell("agentvTv", "off");
    await page.waitForTimeout(500);
    quiet = Date.now();
    await page.waitForTimeout(5000);
    assert.equal(since(quiet), 0, "nothing is asked for with the TV off");
    back = Date.now();
    await tell("agentvTv", "on");
    assert.ok((await asked(back)) >= 1, "asked for as the TV comes back on");
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});
