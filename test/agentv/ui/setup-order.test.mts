// Setup's 12 steps on the TV (ADR-071), in a real Chromium. With setup's own
// switch on, every screen's status bar counts where setup is as a row of 12
// blocks and "n of 12", in the TV's safe area, and never lists the steps
// ahead. With the switch off, it's phase 1's bar, as it was.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { ORDER } from "../../../daemon/setup.ts";
import { startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
const errors: string[] = [];
const tools = mkdtempSync(join(tmpdir(), "agentv-setup-order-"));
const path = process.env.PATH;

before(async () => {
  writeFileSync(join(tools, "qrencode"), `#!/bin/bash\necho '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21"><rect width="21" height="21"/></svg>'\n`);
  chmodSync(join(tools, "qrencode"), 0o755);
  process.env.PATH = `${tools}:${path}`;
  const wired = { eth0: [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:01", internal: false, cidr: "192.168.1.20/24" }] };
  // Setup's own switch on, and the looks' and the box check's, so every step
  // shows. That puts the box on edge.
  ({ daemon, url, state } = await startBox(0, undefined, { interfaces: () => wired, zone: "Europe/Amsterdam", features: { setup2: true, looks: true, boxcheck: true } }));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  process.env.PATH = path;
  rmSync(tools, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

function switches(on: boolean): void {
  writeFileSync(join(state, "features.json"), JSON.stringify({ setup2: on, looks: on, boxcheck: on }));
}

// Setup on a step, with every step before it finished.
function at(step: string): void {
  const before = ORDER.slice(0, ORDER.findIndex((entry) => entry.step === step));
  const finished = Object.fromEntries(before.map((entry, i) => [entry.step, `2026-11-05T10:0${i}:00Z`]));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step, finished, goal: "streaming", ready: { asked: null, update: "none", from: null, to: null } }));
}

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  await page.waitForSelector(".bar .bar-step");
  return page;
}

test("T7.1 each screen's status bar says its step of setup's 12, as blocks and \"n of 12\", in setup's order", async () => {
  switches(true);
  const seen: string[] = [];
  for (const entry of ORDER) {
    at(entry.step);
    const page = await tv();
    try {
      await page.waitForFunction((step) => (window as unknown as { agentvSetup: { route(): string } }).agentvSetup.route().split("/")[0] === step, entry.step);
      const step = await page.locator(".bar .bar-step").textContent();
      assert.equal(step, `${entry.n} of 12 · ${entry.name}`, entry.step);
      assert.equal(await page.locator(".bar .bar-block").count(), 12, `${entry.step}: a block for each of the 12`);
      assert.equal(await page.locator(".bar .bar-block.done").count(), entry.n, `${entry.step}: the steps done and this one filled`);
      assert.equal(await page.locator(".bar .bar-blocks").getAttribute("aria-label"), `step ${entry.n} of 12`);
      seen.push(step ?? "");
    } finally {
      await page.close();
    }
  }
  // The numbers only go up as setup goes on.
  const numbers = seen.map((text) => Number(text.split(" ")[0]));
  assert.deepEqual(numbers, [3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11]);
});

test("T7.1 the counted bar sits in the TV's safe area, 60 px up and 80 px in, with its text at 23 px or more", async () => {
  switches(true);
  at("goal");
  const page = await tv();
  try {
    const box = (await page.locator(".bar").boundingBox())!;
    assert.deepEqual([box.x, box.x + box.width, box.y + box.height], [80, 1840, 1020]);
    for (const part of [".bar-mode", ".bar-step", ".bar-info", ".bar-clock"]) {
      const size = await page.locator(`.bar ${part}`).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      assert.ok(size >= 23, `${part} is ${size} px`);
    }
    // The player sits above the bar, not over it.
    const player = (await page.locator(".player").boundingBox())!;
    assert.ok(player.y + player.height <= box.y, "the soundtrack's player clears the bar");
  } finally {
    await page.close();
  }
});

test("T7.1 no setup screen lists the steps ahead: the bar's blocks are the only count", async () => {
  switches(true);
  for (const step of ["ready", "country", "goal"]) {
    at(step);
    const page = await tv();
    try {
      const text = (await page.locator(".setup-page").innerText()).toLowerCase();
      for (const later of ["who watches", "theme and background", "of 12"]) assert.ok(!text.includes(later), `${step} says "${later}"`);
    } finally {
      await page.close();
    }
  }
});

test("with setup's own switch off, the bar is phase 1's, with no blocks", async () => {
  switches(false);
  at("country");
  const page = await tv();
  try {
    assert.equal(await page.locator(".bar .bar-step").textContent(), "1/6 country");
    assert.equal(await page.locator(".bar .bar-block").count(), 0);
    assert.equal(await page.locator(".bar.counted").count(), 0);
  } finally {
    await page.close();
    rmSync(join(state, "features.json"), { force: true });
  }
});

test("the goal says the pick only sets up the first home, and OK on a card picks it and moves on", async () => {
  switches(true);
  at("goal");
  const page = await tv();
  try {
    await page.waitForSelector(".goal-cards");
    assert.equal(await page.locator(".setup-headline").getAttribute("aria-label"), "what's it for, mostly?");
    assert.equal(await page.locator(".setup-line").textContent(), "this only sets up your first home. you can still use everything.");
    assert.deepEqual(await page.locator(".goal-card-name").allTextContents(), ["streaming", "music", "media", "gaming"]);
    assert.equal(await page.locator('[data-action="continue"]').count(), 0, "no continue after one pick");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator(".focused").getAttribute("data-goal"), "media");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".bar .bar-step")?.textContent === "9 of 12 · apps");
    assert.equal((await (await fetch(`${url}/api/setup`)).json()).setup.goal, "media");
  } finally {
    await page.close();
  }
});

test("with the box check on, gaming says what to expect on this box", async () => {
  writeFileSync(join(state, "features.json"), JSON.stringify({ setup2: true, looks: true, boxcheck: true }));
  at("goal");
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  // The box check's answer, as its route will give it.
  await page.route("**/api/box", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ verdicts: { fourK: true, fourKSmooth: true, games: "light", spaceLow: false } }) }));
  try {
    await page.goto(`${url}/`);
    await page.waitForSelector(".goal-cards");
    assert.equal(await page.locator('[data-goal="gaming"] .goal-card-note').textContent(), "light games on this box");
  } finally {
    await page.close();
    switches(true);
  }
});
