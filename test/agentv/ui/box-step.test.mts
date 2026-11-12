// The box check on the TV (design page D3's "4 Your box"), in a real
// Chromium: setup's box step after getting ready, the 4K test behind it, and
// Settings → About → this box, each with its switch off and on. The machine
// is the NUC8i5BEH on its 4K Panasonic, from its recorded readings, and a
// small box on a 1080p TV.

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { bothWays, machine, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
const errors: string[] = [];
const boxes: Daemon[] = [];

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  for (const daemon of boxes) await daemon.close();
  assert.deepEqual(errors, []);
});

async function box(features: Record<string, boolean>, name = "nuc8i5beh"): Promise<{ url: string; state: string }> {
  const started = await startBox(0, undefined, { features, box: { machine: machine(name) } });
  boxes.push(started.daemon);
  return started;
}

// Setup on getting ready, with the welcome screen finished.
function atReady(state: string): void {
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "ready", finished: { welcome: "2026-11-08T10:00:00Z" }, ready: { asked: null, update: "none", from: null, to: null } }));
}

async function tv(url: string, scale = 1): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  return page;
}

const route = (page: Page) => page.evaluate(() => (window as unknown as { agentvSetup: { route(): string } }).agentvSetup.route());
const rows = (page: Page) => page.locator(".box-row").evaluateAll((all) => all.map((row) => `${row.querySelector(".box-label")?.textContent}: ${row.querySelector(".box-value")?.textContent}`));

bothWays("boxcheck", "T3.2 getting ready goes on to your box, which says what the box is, and OK goes on to the location", async (on, options) => {
  const { url, state } = await box({ ...options.features, setup2: true });
  atReady(state);
  const page = await tv(url);
  try {
    await page.waitForFunction(() => (window as unknown as { agentvSetup?: object }).agentvSetup);
    const finished = await fetch(`${url}/api/setup/finish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: "ready" }) });
    assert.equal(finished.status, 200);
    if (!on) {
      await page.waitForFunction(() => (window as unknown as { agentvSetup: { route(): string } }).agentvSetup.route() === "country");
      assert.equal(await page.locator(".box-row").count(), 0, "no box step with the switch off");
      return;
    }
    await page.waitForSelector(".box-row");
    assert.equal(await route(page), "box");
    assert.equal(await page.locator(".setup-headline").getAttribute("aria-label"), "here's your box.");
    assert.equal(await page.locator(".setup-page .prompt").textContent(), "~ $ agentv box");
    assert.equal(await page.locator(".setup-line").textContent(), "nuc8i5beh · setup uses this from here on");
    assert.equal(await page.locator(".bar .bar-step").textContent(), "4 of 12 · your box");
    assert.deepEqual(await rows(page), [
      "tv: 4k tv · panasonic · 60 hz",
      "box: 4k not checked yet",
      "games: light games · intel iris plus 655",
      "space: 1.6 tb free",
      "network: wi-fi · 433 mbps",
    ]);
    assert.equal(await page.locator(".box-test").count(), 0, "a page drawn at 1080p doesn't run the 4K test");
    assert.equal(await page.locator(".focused").textContent(), "↵ ok");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as { agentvSetup: { route(): string } }).agentvSetup.route() === "country");
  } finally {
    await page.close();
  }
});

test("T3.2 on a 4K TV drawn at 4K, the 4K test runs behind the lines for five seconds, and the daemon keeps what it counted", async () => {
  const { url, state } = await box({ setup2: true, boxcheck: true });
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "box", finished: { welcome: "2026-11-08T10:00:00Z", ready: "2026-11-08T10:01:00Z" } }));
  const page = await tv(url, 2);
  try {
    await page.waitForSelector(".box-test");
    assert.equal(await page.locator('.box-row[data-row="box"] .box-value').textContent(), "checking 4k…");
    assert.equal(await page.locator(".box-test-tile").count(), 12);
    const size = await page.locator(".box-test-field").evaluate((canvas) => [(canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height]);
    assert.deepEqual(size, [3840, 2160], "the field is drawn at the TV's full resolution");
    await page.waitForSelector(".box-test", { state: "detached", timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('.box-row[data-row="box"] .box-value')?.textContent !== "checking 4k…");
    const smooth = await (await fetch(`${url}/api/box/smooth`)).json();
    assert.equal(smooth.needed, false, "kept, for this GPU");
    assert.deepEqual([smooth.result.gpu, smooth.result.width, smooth.result.height], ["8086:3ea5", 3840, 2160]);
    assert.ok(smooth.result.fps > 0);
    const said = await page.locator('.box-row[data-row="box"] .box-value').textContent();
    assert.equal(said, smooth.passed ? "keeps 4k smooth" : "smoother at 1080p", "the line says how it went");
    assert.equal((await (await fetch(`${url}/api/box`)).json()).verdicts.fourKSmooth, smooth.passed);
  } finally {
    await page.close();
  }
});

test("T3.2 OK during the 4K test stops it, and the box counts as not checked", async () => {
  const { url, state } = await box({ setup2: true, boxcheck: true });
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "box", finished: { welcome: "2026-11-08T10:00:00Z", ready: "2026-11-08T10:01:00Z" } }));
  const page = await tv(url, 2);
  try {
    await page.waitForSelector(".box-test");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as { agentvSetup: { route(): string } }).agentvSetup.route() === "country");
    await page.waitForSelector(".box-test", { state: "detached" });
    const smooth = await (await fetch(`${url}/api/box/smooth`)).json();
    assert.equal(smooth.result, null);
    assert.equal(smooth.needed, true);
  } finally {
    await page.close();
  }
});

test("T3.2 a box on a 1080p TV with little space says its CPU and memory, and that space is short", async () => {
  const { url, state } = await box({ setup2: true, boxcheck: true }, "amd-mini-pc");
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "box", finished: { welcome: "2026-11-08T10:00:00Z", ready: "2026-11-08T10:01:00Z" } }));
  const page = await tv(url, 2);
  try {
    await page.waitForSelector(".box-row");
    assert.deepEqual(await rows(page), ["tv: 1080p tv · sample · 60 hz", "box: amd ryzen 7 5700u · 16 gb", "games: light games · amd radeon", "space: only 20 gb free", "network: wi-fi"]);
    assert.equal(await page.locator(".box-test").count(), 0, "no 4K test without a 4K TV");
    assert.equal(await page.locator(".setup-line").textContent(), "azw · setup uses this from here on");
  } finally {
    await page.close();
  }
});

const go = (page: Page, where: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), where);

for (const looks of [false, true]) {
  bothWays("boxcheck", `T3.2 Settings → About has this box's lines${looks ? " in each look" : ""}`, async (on, options) => {
    const { url, state } = await box({ ...options.features, looks });
    const page = await tv(url);
    try {
      for (const look of looks ? ["terminal", "glass", "cinema"] : [null]) {
        if (look) {
          const set = await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
          assert.equal(set.status, 200, `the look is ${look}`);
          await page.reload();
        }
        await page.waitForFunction(() => (window as unknown as { agentvLauncher?: object }).agentvLauncher);
        await go(page, "settings/about");
        await page.waitForSelector('.settings-panel[data-page="about"]');
        if (!on) {
          await page.waitForTimeout(500);
          assert.equal(await page.locator(".box-row").count(), 0, "nothing of the box check with its switch off");
          continue;
        }
        await page.waitForSelector(".box-about .box-row");
        // Terminal writes it all in lower case, and Glass and Cinema in
        // sentence case, keeping names' own capitals.
        const title = (await page.locator(".box-about .panel-title").textContent()) ?? "";
        assert.equal(title.toLowerCase(), "this box · nuc8i5beh");
        assert.ok(look === "glass" || look === "cinema" ? title.endsWith("NUC8i5BEH") : title.endsWith("nuc8i5beh"), title);
        assert.equal((await rows(page))[0].toLowerCase(), "tv: 4k tv · panasonic · 60 hz");
        assert.equal((await page.locator('[data-action="box-check"]').textContent())?.toLowerCase(), "check 4k");
        // Nothing of the lines goes past the panel's right edge.
        const over = await page.locator(".box-about .box-row").evaluateAll((all) => {
          const panel = document.querySelector(".settings-panel")!.getBoundingClientRect();
          return all.filter((row) => row.getBoundingClientRect().right > panel.right + 1).length;
        });
        assert.equal(over, 0, `the lines fit the panel${look ? ` in ${look}` : ""}`);
      }
    } finally {
      await page.close();
      rmSync(join(state, "features.json"), { force: true });
    }
  });
}
