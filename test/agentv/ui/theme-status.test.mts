// Themes in Settings, in a real Chromium (ADR-019, layer 4). A theme's status: once
// a theme is set, its row says it's on. Omarchy setting the theme takes a few
// seconds, and the TV draws Settings again meanwhile as its home state
// changes, so the row that says "Setting…" isn't the one on the screen when
// the answer comes. The one on the screen says it's on.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url } = await startBox(0, FIXTURES, { features: { looks: true } }));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

type Held = { screenRequests: { cmd: string; theme?: string }[]; answerTheme?: () => void };

// A TV whose screen daemon answers at once, but holds its answer to a theme
// until the test lets it go, as Omarchy takes a few seconds.
async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as Held & { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      const answer = () => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true }));
      if (request.cmd === "theme-set") w.answerTheme = answer;
      else setTimeout(answer, 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector("#page .focused");
  await rest(page);
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const status = (page: Page, id: string) => page.locator(`[data-action="theme-${id}"] .button-value`).innerText();

for (const where of ["theme", "look"] as const) {
  test(`a theme's row says it's on once it's set, when Settings was drawn again meanwhile${where === "look" ? ", and Appearance's Theme row names it" : ""}`, async () => {
    const page = await tv();
    try {
      await go(page, "settings/theme");
      await page.waitForSelector('[data-action="theme-gruvbox"]');
      const id = where === "theme" ? "gruvbox" : "nord";
      await page.locator(`[data-action="theme-${id}"]`).click();
      await page.waitForFunction(() => Boolean((window as unknown as Held).answerTheme));
      assert.match(await status(page, id), /Setting/i);
      // Settings drawn again while Omarchy works: on the theme's page, or
      // back on Appearance.
      await go(page, `settings/${where}`);
      await page.waitForSelector(`.settings-panel[data-page="${where}"]`);
      await page.evaluate(() => (window as unknown as Held).answerTheme!());
      if (where === "theme") {
        await page.waitForFunction((one) => !/Setting/i.test(document.querySelector(`[data-action="theme-${one}"] .button-value`)?.textContent ?? "Setting"), id, { timeout: 5000 });
        assert.match(await status(page, id), /on/i, "it says it's on");
      } else {
        await page.waitForFunction(() => /nord/i.test(document.querySelector('.settings-panel [data-action="theme"] .button-value')?.textContent ?? ""), null, { timeout: 5000 });
      }
    } finally {
      await page.close();
    }
  });
}

// Themes a level deeper (ADR-094): Appearance has a Theme row, and OK on it
// opens the list of themes. The background's rows are in Appearance itself,
// a few presses down, never behind the list. In each look.
for (const look of ["terminal", "glass", "cinema"]) {
  test(`${look}: the themes are a level under Appearance, and the background is in Appearance, not behind them`, async () => {
    await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
    const page = await tv();
    try {
      await go(page, "settings/look");
      await page.waitForSelector('.settings-panel[data-page="look"] [data-action="theme"]');
      assert.equal(await page.locator(".settings-panel .look-item").count(), 0, "no theme list in Appearance");
      const rows = await page.locator(".settings-panel [data-focus]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.action));
      assert.ok(rows.includes("background"), `Appearance has the background: ${rows.join(", ")}`);
      assert.ok(rows.indexOf("background") - rows.indexOf("theme") <= 3, `the background is a few rows past Theme: ${rows.join(", ")}`);
      await page.locator('.settings-panel [data-action="theme"]').hover();
      await page.keyboard.press("Enter");
      await page.waitForSelector('.settings-panel[data-page="theme"] .look-item');
      await page.keyboard.press("Escape");
      await page.waitForSelector('.settings-panel[data-page="look"]');
      await page.waitForFunction(() => document.querySelector(".focused")?.getAttribute("data-action") === "theme");
    } finally {
      await page.close();
    }
  });
}
