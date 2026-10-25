// Settings → Sound's output and its volume in a real Chromium (ADR-019, layer
// 4; ADR-017, S2.19): the output playing and its volume from the screen
// daemon, left and right to pick another output or change the volume, and
// the UI sounds' switch and volume beside them. What PipeWire does with them
// is layer 2's, the image layer's and the NUC's.

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

type Request = { cmd: string; output?: string; volume?: number };

// A TV with an HDMI output at 100% and an analog one, whose screen daemon
// keeps a level per output as audio.ts does, or one with no output at all.
async function tv(outputs = true): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((outputs) => {
    const list = outputs
      ? [
          { name: "hdmi", description: "LG TV (HDMI)", hdmi: true, connected: true },
          { name: "analog", description: "Built-in Audio Analog Stereo", hdmi: false, connected: null },
        ]
      : [];
    const levels: Record<string, number> = {};
    let output: string | null = outputs ? "hdmi" : null;
    const w = window as unknown as { audioRequests: Request[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.audioRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      let reply: object = { ok: true };
      if (request.cmd === "audio") {
        w.audioRequests.push(request);
        if (typeof request.output === "string") output = request.output;
        if (typeof request.volume === "number" && output) levels[output] = request.volume;
        reply = { ok: true, output, outputs: list, volume: output ? (levels[output] ?? 1) : null };
      }
      // A slow box answers later, when a test says so.
      const delay = request.cmd === "audio" ? ((window as unknown as { audioDelay?: number }).audioDelay ?? 0) : 0;
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify(reply)), delay);
    };
  }, outputs);
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const sent = (page: Page) => page.evaluate(() => (window as unknown as { audioRequests: Request[] }).audioRequests.filter((r) => r.output !== undefined || r.volume !== undefined));
const focused = (page: Page) => page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action") ?? document.querySelector(".focused")?.getAttribute("data-key"));
const row = (page: Page, action: string) => page.locator(`.panel [data-action="${action}"]`).innerText();

test("S2.19 Settings → Sound shows the output playing at 100%, and left and right change its volume, for that output", async () => {
  const page = await tv();
  await go(page, "settings/sound");
  await page.waitForSelector('.panel [data-action="output"]');
  assert.match(await row(page, "output"), /output\s+‹ lg tv \(hdmi\) ›/);
  assert.match(await row(page, "output-volume"), /output volume\s+100%/);
  assert.match(await page.locator('.menu-item[data-key="sound"]').innerText(), /sound\s+100% · ui sounds on/);
  assert.match(await page.locator(".panel").innerText(), /the tv's remote sets how loud it is/);
  // The UI sounds keep their own switch and volume, under the output's.
  assert.match(await row(page, "sound"), /ui sounds/);
  assert.match(await row(page, "volume"), /ui sounds volume/);

  await page.keyboard.press("Enter");
  assert.equal(await focused(page), "output");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(page), "output-volume");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => /95%/.test(document.querySelector('.panel [data-action="output-volume"]')?.textContent ?? ""));
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => /90%/.test(document.querySelector('.panel [data-action="output-volume"]')?.textContent ?? ""));
  assert.equal(await focused(page), "output-volume", "the focus stays on the volume");
  assert.deepEqual((await sent(page)).map((r) => r.volume), [0.95, 0.9]);
  assert.match(await page.locator('.menu-item[data-key="sound"]').innerText(), /90% · ui sounds on/);
  // Right goes back up, and never past 100%.
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => /100%/.test(document.querySelector('.panel [data-action="output-volume"]')?.textContent ?? ""));
  assert.ok((await sent(page)).every((r) => r.volume === undefined || r.volume <= 1));
  await page.close();
});

test("S2.19 presses quicker than the box's replies each go one step further, and never past 100%", async () => {
  const page = await tv();
  await go(page, "settings/sound");
  await page.waitForSelector('.panel [data-action="output"]');
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(page), "output-volume");
  await page.evaluate(() => ((window as unknown as { audioDelay: number }).audioDelay = 300));
  // Down from 100% three times, before the first reply.
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => /85%/.test(document.querySelector('.panel [data-action="output-volume"]')?.textContent ?? ""));
  assert.deepEqual((await sent(page)).map((r) => r.volume), [0.95, 0.9, 0.85]);
  // And up four times, which stops at 100%.
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => /100%/.test(document.querySelector('.panel [data-action="output-volume"]')?.textContent ?? ""));
  assert.deepEqual((await sent(page)).map((r) => r.volume), [0.95, 0.9, 0.85, 0.9, 0.95, 1]);
  await page.close();
});

test("S2.19 left and right on the output pick another one, which plays at its own level", async () => {
  const page = await tv();
  await go(page, "settings/sound");
  await page.waitForSelector('.panel [data-action="output"]');
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => /built-in audio analog stereo/.test(document.querySelector('.panel [data-action="output"]')?.textContent ?? ""));
  assert.equal(await focused(page), "output");
  assert.deepEqual((await sent(page)).map((r) => r.output), ["analog"]);
  assert.match(await row(page, "output-volume"), /100%/);
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => /lg tv/.test(document.querySelector('.panel [data-action="output"]')?.textContent ?? ""));
  await page.close();
});

test("S2.19 with no sound output, Settings → Sound says so and keeps the UI sounds' rows", async () => {
  const page = await tv(false);
  await go(page, "settings/sound");
  await page.waitForSelector('.panel [data-action="sound"]');
  await page.waitForFunction(() => /no sound output/.test(document.querySelector(".panel")?.textContent ?? ""));
  assert.equal(await page.locator('.panel [data-action="output"]').count(), 0);
  assert.match(await page.locator('.menu-item[data-key="sound"]').innerText(), /sound\s+ui sounds on/);
  await page.close();
});
