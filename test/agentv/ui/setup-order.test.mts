// Setup's 12 steps on the TV (ADR-071), in a real Chromium. With setup's own
// switch on, every screen's status bar counts where setup is as a row of 12
// blocks and "n of 12", in the TV's safe area, and never lists the steps
// ahead. With the switch off, it's phase 1's bar, as it was.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("Q226 theme and background are one screen: home in each theme, the backgrounds under it, and OK on one finishes setup", async () => {
  switches(true);
  at("theme");
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  // A look's preview is drawn once: no frame opens a stream of events, so a
  // row of them can't use up the browser's connections to the box.
  let streams = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/events") && request.frame() !== page.mainFrame()) streams++;
  });
  await page.goto(`${url}/`);
  try {
    await page.waitForSelector(".theme2 .tb-theme.focused");
    assert.equal(await page.locator(".setup-headline").getAttribute("aria-label"), "pick a theme.");
    assert.equal(await page.locator('[data-action="continue"]').count(), 0, "no continue or done");
    const frames = page.locator(".tb-theme iframe");
    assert.ok((await frames.count()) >= 2, "a preview for each theme");
    const first = await page.locator(".tb-theme").first().getAttribute("data-theme");
    assert.match((await frames.first().getAttribute("src")) ?? "", new RegExp(`^/\\?preview&look=\\w+&size=\\w+&theme=${first}$`));
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLIFrameElement>(".tb-theme iframe")].some((frame) => frame.contentDocument?.querySelector("[data-id]")));
    assert.deepEqual(await page.locator(".tb-back").evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.background)), ["theme", "photos", "folder", "made"]);
    assert.equal(await page.locator(".tb-back.picked").getAttribute("data-background"), "theme", "the theme's own is the default");

    // Down to the theme's own background, and OK finishes setup.
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.locator(".focused").getAttribute("data-background"), "theme");
    await page.keyboard.press("Enter");
    await page.waitForFunction(async () => (await (await fetch("/api/setup")).json()).setup?.done === true);
    assert.equal(streams, 0);
  } finally {
    await page.close();
  }
});

test("Q226 who watches is one headline and the row, with no adult pin switch, and done at the row's end moves on", async () => {
  switches(true);
  at("people");
  const page = await tv();
  try {
    await page.waitForSelector(".people2 .person.done.focused");
    assert.equal(await page.locator(".setup-headline").getAttribute("aria-label"), "who watches?");
    assert.equal(await page.locator(".pin-switch, .pin-line").count(), 0, "the PIN is asked for when a child is added");
    assert.equal(await page.locator('[data-action="continue"]').count(), 0, "no continue under the row");
    assert.equal(await page.locator(".people > :last-child").getAttribute("data-action"), "done");
    assert.equal(await page.locator(".setup-page p").count(), 0, "no line of text");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as { agentvSetup: { route(): string } }).agentvSetup.route() === "goal");
  } finally {
    await page.close();
  }
});

const route = (page: Page) => page.evaluate(() => (window as unknown as { agentvSetup: { route(): string } }).agentvSetup.route());

test("Q226 getting ready is one headline, one line and one bar, and moves on by itself once it's up to date", async () => {
  switches(true);
  at("ready");
  let page = await tv();
  try {
    await page.waitForSelector(".ready2 .ready-bar .blocks");
    assert.equal(await page.locator(".setup-headline").getAttribute("aria-label"), "getting ready.");
    assert.equal(await page.locator(".setup-page .prompt").textContent(), "~ $ agentv update");
    assert.match((await page.locator(".setup-line").textContent()) ?? "", /is up to date$/);
    assert.equal(await page.locator(".ready-list, [data-action='continue']").count(), 0, "no checklist and no continue");
    await page.waitForFunction(() => (window as unknown as { agentvSetup: { route(): string } }).agentvSetup.route() !== "ready");
  } finally {
    await page.close();
  }

  // Back to it later, it waits for OK instead of moving on by itself.
  at("ready");
  const later = JSON.parse(readFileSync(join(state, "setup.json"), "utf8"));
  later.finished.ready = "2026-11-05T10:05:00Z";
  writeFileSync(join(state, "setup.json"), JSON.stringify(later));
  page = await tv();
  try {
    await page.waitForSelector(".ready2 .ready-bar .blocks");
    await page.waitForTimeout(2500);
    assert.equal(await route(page), "ready");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as { agentvSetup: { route(): string } }).agentvSetup.route() !== "ready");
  } finally {
    await page.close();
  }
});

test("Q226 the welcome screen is hi., one line and the code, with no keyboard button, and Enter still carries on", async () => {
  switches(true);
  at("welcome");
  const page = await tv();
  try {
    await page.waitForSelector(".welcome2 .qr[src]");
    assert.equal(await page.locator(".welcome2 .welcome-line").textContent(), "scan the code with your phone to pair it.");
    assert.equal(await page.locator("[data-action='enter']").count(), 0, "no use a keyboard instead");
    assert.ok(!(await page.locator(".setup-page").innerText()).includes("keyboard"));
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as { agentvSetup: { route(): string } }).agentvSetup.route() === "ready");
  } finally {
    await page.close();
    switches(false);
  }
});
