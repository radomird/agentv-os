// The free medium continue tile on the home screen, in a real Chromium
// (ADR-016, S3.10): an app with playback and no tile() shows its newest rows
// from the ledger, how far in each is, and a click on one opens it there,
// while choosing the tile itself opens the app.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";

before(async () => {
  ({ daemon, url } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
  const post = (state: object) =>
    fetch(`${url}/api/ledger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app: "local.mytv", state }) });
  await post({ title: "Sintel", season: 2, episode: 4, position: 528, duration: 888, playing: false });
  await post({ title: "Spring", position: 324, duration: 464, playing: false });
  const layout = [
    { id: "local.mytv", x: 0, y: 0, size: "m" },
    { id: "agentv.tube", x: 2, y: 0, size: "s" },
    { id: "apps", x: 3, y: 0, size: "s" },
  ];
  await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout }) });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: unknown[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector('.tile[data-id="local.mytv"] .entry');
  return page;
}

const tile = '.grid .tile[data-id="local.mytv"]';

test("S3.10 an app with playback and no tile() shows a medium continue tile from the ledger", async () => {
  const page = await tv();
  const drawn = await page.$eval(tile, (el) => ({
    head: [el.querySelector(".tile-head-name")?.textContent, el.querySelector(".tile-head-label")?.textContent],
    entries: [...el.querySelectorAll(".entry")].map((entry) => [
      entry.querySelector(".entry-label")?.textContent,
      entry.querySelector(".entry-caption")?.textContent,
      entry.querySelector(".entry-progress")?.getAttribute("aria-label"),
      (entry.querySelector(".entry-progress-done") as HTMLElement | null)?.style.width,
    ]),
  }));
  assert.deepEqual(drawn.head, ["my tv", "continue"]);
  assert.deepEqual(drawn.entries, [
    ["Spring", "film · 3 min left", "watched 70 percent", "69.8%"],
    ["Sintel", "S2 E4 · 6 min left", "watched 59 percent", "59.5%"],
  ]);
  await page.close();
});

test("a click on an entry opens it in the app, and choosing the tile opens the app", async () => {
  const page = await tv();
  const opens = () =>
    page.evaluate(() => (window as unknown as { screenRequests: { cmd: string; app: string; item?: Record<string, unknown> }[] }).screenRequests.filter((r) => r.cmd === "open-app"));
  await page.locator(`${tile} .entry`).nth(1).click();
  await page.waitForFunction(() => (window as unknown as { screenRequests: { cmd: string }[] }).screenRequests.some((r) => r.cmd === "open-app"));
  const [opened] = await opens();
  assert.equal(opened.app, "local.mytv");
  assert.deepEqual({ ...opened.item, id: undefined }, { id: undefined, kind: "episode", title: "Sintel", season: 2, episode: 4 });
  await page.locator(tile).hover();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as unknown as { screenRequests: { cmd: string }[] }).screenRequests.filter((r) => r.cmd === "open-app").length > 1);
  const second = (await opens())[1];
  assert.deepEqual([second.app, second.item], ["local.mytv", undefined]);
  await page.close();
});
