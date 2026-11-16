// T22.1: Fit to screen (ADR-103) in a real Chromium. The margin round the
// picture is 3 percent to start with, at every size. Settings, Appearance's
// Fit to screen opens its page in each look, at each size: four corner marks
// where the margin puts the edge of what apps fill, the picture's size, and
// nothing cut off. Left and right change it, the TV takes it at once (here a
// stand-in screen daemon), and the marks follow, down to the whole screen.
// Home's own margin moves in by as much as the margin is over 3 percent, so
// it isn't margined twice. Setup shows the same screen right after the size,
// in Terminal's style.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";
import { cutOff } from "./fits.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
const SIZES = [
  { size: "larger", canvas: [1600, 900] },
  { size: "standard", canvas: [1920, 1080] },
  { size: "more", canvas: [2400, 1350] },
] as const;
// A 4K TV, which offers all three sizes.
const TV = { output: "HDMI-A-1", modes: ["3840x2160@60.00Hz", "1920x1080@60.00Hz"], live: { mode: "3840x2160@60", scale: 2 } };

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
let screenDaemon = true;
const errors: string[] = [];
// The reserved areas the stand-in screen daemon was asked to set.
const reserved: [number, number][] = [];

// The screen daemon's side: it takes each ask and says the TV runs at it,
// margin and all, as DisplayWatch does once Hyprland has it.
async function standInScreen(): Promise<void> {
  while (screenDaemon) {
    const said = (await (await fetch(`${url}/api/display/ask`).catch(() => null))?.json().catch(() => null)) as {
      ask?: { n: number; target: { mode: string; scale: number; reserved: [number, number] } } | null;
    } | null;
    const ask = said?.ask;
    if (!ask) continue;
    reserved.push(ask.target.reserved);
    await fetch(`${url}/api/display/ask/${ask.n}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, live: { mode: ask.target.mode, scale: ask.target.scale, reserved: ask.target.reserved } }),
    });
  }
}

before(async () => {
  ({ daemon, url, state } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", features: { looks: true, sizes: true } }));
  await fetch(`${url}/api/display/tv`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(TV) });
  void standInScreen();
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  screenDaemon = false;
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

async function put(body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/api/display`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 200, JSON.stringify(data).slice(0, 200));
  return data;
}

const display = async () => (await (await fetch(`${url}/api/display`)).json()) as { margin: number; inset: [number, number]; size: string };

// The margin the TV has kept, once the last step's save has landed: the
// page shows each step at once, and saves the last one after the one
// that's out.
async function kept(margin: number): Promise<number> {
  const end = Date.now() + 5000;
  let now = (await display()).margin;
  while (now !== margin && Date.now() < end) {
    await new Promise((done) => setTimeout(done, 100));
    now = (await display()).margin;
  }
  return now;
}

async function tv(canvas: readonly [number, number]): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: canvas[0], height: canvas[1] } });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector("#page .focused");
  await rest(page);
  return page;
}

// The page has slid in: no animation that ends is still running.
const settled = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity));

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go(r), route);

// Where each mark's outer corner is: left and top for the two on the left
// and the top, right and bottom for the others.
function marks(page: Page): Promise<Record<string, [number, number]>> {
  return page.$$eval(".fit-mark", (els) =>
    Object.fromEntries(
      els.map((el) => {
        const box = el.getBoundingClientRect();
        const corner = [...el.classList].find((name) => name !== "fit-mark")!;
        return [corner, [Math.round(corner.endsWith("left") ? box.left : innerWidth - box.right), Math.round(corner.startsWith("top") ? box.top : innerHeight - box.bottom)]];
      }),
    ),
  );
}

const everyMark = (x: number, y: number) => ({ "top-left": [x, y], "top-right": [x, y], "bottom-left": [x, y], "bottom-right": [x, y] });

for (const look of LOOKS) {
  test(`T22.1 Fit to screen in Settings, Appearance in ${look}: the corner marks at the margin at each size, nothing cut off, and left and right change it`, async () => {
    await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
    const problems: string[] = [];
    for (const { size, canvas } of SIZES) {
      await put({ size, margin: 3 });
      const page = await tv(canvas);
      try {
        await go(page, "settings/look");
        await page.waitForSelector('.settings-panel [data-action="fit"]');
        assert.match(await page.locator('.settings-panel [data-action="fit"]').innerText(), /^fit to screen\s+94%$/i);
        await page.locator('.settings-panel [data-action="fit"]').click();
        await page.waitForSelector(".fit-screen .fit-size.focused");
        await settled(page);
        await rest(page);
        const x = Math.round((canvas[0] * 3) / 100);
        const y = Math.round((canvas[1] * 3) / 100);
        assert.deepEqual(await marks(page), everyMark(x, y), `${look} at ${size}: 3 percent in from each edge`);
        for (const line of await cutOff(page, undefined, true)) problems.push(`${look} at ${size}: ${line}`);
        if (size !== "standard") continue;

        // Smaller: the TV takes it at once and the marks move in.
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("ArrowLeft");
        await page.waitForFunction(() => document.querySelector(".fit-value")?.textContent === "92%");
        assert.equal(await kept(4), 4);
        assert.deepEqual(reserved.at(-1), [77, 43], "the screen daemon is asked for the new margin");
        assert.deepEqual(await marks(page), everyMark(77, 43));
        // Bigger, all the way: no margin at all, and no further.
        for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() => document.querySelector(".fit-value")?.textContent === "Whole screen");
        assert.equal(await kept(0), 0);
        assert.deepEqual(await marks(page), everyMark(0, 0));
        assert.equal(await page.locator(".fit-size.biggest").count(), 1);
        // Done goes back to Appearance, on its row, which says so.
        await page.locator('[data-action="fit-done"]').click();
        await page.waitForSelector('.settings-panel [data-action="fit"].focused');
        assert.match(await page.locator('.settings-panel [data-action="fit"]').innerText(), /^fit to screen\s+whole screen$/i);
      } finally {
        await page.close();
      }
    }
    await put({ size: "standard", margin: 3 });
    assert.deepEqual(problems, []);
  });
}

test("T22.1 home's own margin follows Fit to screen's, only past the 3 percent it already allows for", async () => {
  const safe = (page: Page) =>
    page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.cssText = "position: absolute; left: var(--safe-x); top: var(--safe-y)";
      document.body.append(probe);
      const at = [parseFloat(getComputedStyle(probe).left), parseFloat(getComputedStyle(probe).top)];
      probe.remove();
      return at;
    });
  for (const look of LOOKS) {
    await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
    await put({ size: "standard", margin: 3 });
    const page = await tv([1920, 1080]);
    try {
      assert.deepEqual(await safe(page), [80, 60], `${look}: as before at 3 percent`);
      // What's cut off at 3 percent, once the tiles have what they show.
      await page.waitForTimeout(1500);
      // The words, not the classes, whose order the focus changes.
      const words = (lines: string[]) => lines.map((line) => /^"([^"]*)"/.exec(line)?.[1] ?? line);
      const before = words(await cutOff(page));
      // 6 percent: 115 by 65, which is 57 by 33 over the 3 percent.
      await put({ margin: 6 });
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--fit-over-x") === "57px");
      assert.deepEqual(await safe(page), [137, 93], `${look}: moved in by what's over 3 percent`);
      await page.waitForTimeout(1500);
      for (const line of words(await cutOff(page))) if (!before.includes(line)) assert.fail(`${look} at 6 percent: ${line}`);
      // None: home keeps its own.
      await put({ margin: 0 });
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--fit-x") === "0px");
      assert.deepEqual(await safe(page), [80, 60], `${look}: its own with no margin`);
    } finally {
      await page.close();
      await put({ margin: 3 });
    }
  }
});

test("T22.1 setup shows Fit to screen right after the size, in Terminal's style, and goes on to the theme", async () => {
  await put({ size: "standard", margin: 3 });
  await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look: "terminal" }) });
  const at = new Date().toISOString();
  const finished = Object.fromEntries(["welcome", "ready", "country", "ai", "people", "goal", "apps"].map((step) => [step, at]));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "look", finished, goal: "streaming" }));
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  try {
    await page.goto(`${url}/`);
    await page.waitForSelector(".setup-look .look-card.focused");
    // Glass, picked: on to Fit to screen, still in setup's own style.
    await page.locator('[data-action="look-glass"]').click();
    await page.waitForSelector(".setup-fit .fit-size.focused");
    await settled(page);
    assert.match(await page.locator(".setup-fit").innerText(), /can you see all four corners\?[\s\S]*overscan in your tv's picture menu/i);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.look), undefined, "setup never loads a look");
    assert.deepEqual(await marks(page), everyMark(58, 32));
    for (const line of await cutOff(page, ".setup-fit *", true)) assert.fail(line);
    // Smaller by one, then Continue: the theme, with the margin kept.
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => document.querySelector(".fit-value")?.textContent === "93%");
    assert.deepEqual(await marks(page), everyMark(67, 38));
    assert.equal(await kept(3.5), 3.5);
    await page.keyboard.press("Enter");
    await page.waitForFunction(async () => ((await (await fetch("/api/setup")).json()) as { setup: { step: string } }).setup.step === "theme");
    assert.equal((await display()).margin, 3.5);
  } finally {
    await page.close();
    writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true }));
    await put({ margin: 3 });
  }
});
