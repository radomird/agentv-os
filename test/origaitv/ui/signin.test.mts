// A tile that says Sign in, in a real Chromium (ADR-032, board 15): an app
// whose service wants a sign-in keeps its logo and says so, choosing it asks
// the screen daemon for origaiTV's sign-in screen instead of opening the app,
// and once the app is signed in, the tile is its usual self again.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { rest, startBox } from "./box.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
const errors: string[] = [];

const signedIn = (app: string, value: boolean) =>
  fetch(`${url}/api/apps/${app}/signed-in`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signedIn: value }) });

before(async () => {
  ({ daemon, url } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
  const layout = [
    { id: "origaitv.sample", x: 0, y: 0, size: "m" },
    { id: "origaitv.tube", x: 2, y: 0, size: "s" },
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
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: unknown[]; origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  await rest(page);
  return page;
}

const sample = '.grid .tile[data-id="origaitv.sample"]';

test("ADR-032 an app signed out says Sign in on its tile, with its logo, and choosing it asks for the sign-in screen", async () => {
  assert.equal((await signedIn("origaitv.sample", false)).status, 200);
  const page = await tv();
  await page.waitForSelector(`${sample} .tile-sign-in`);
  // Its tile() isn't drawn while it can't sign in to show anything.
  await page.waitForTimeout(300);
  const drawn = await page.$eval(sample, (el) => ({
    state: el.querySelector(".tile-state")?.textContent,
    logo: el.querySelector(".logo img")?.getAttribute("src"),
    content: el.classList.contains("has-content"),
  }));
  assert.deepEqual(drawn, { state: "Sign in", logo: "/api/apps/origaitv.sample/icon", content: false });
  assert.equal(await page.$eval('.grid .tile[data-id="origaitv.tube"] .tile-label', (el) => el.textContent), "streaming");
  await page.locator(sample).hover();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as unknown as { screenRequests: { cmd: string }[] }).screenRequests.some((r) => r.cmd === "sign-in"));
  const requests = await page.evaluate(() => (window as unknown as { screenRequests: { cmd: string; app?: string }[] }).screenRequests.filter((r) => r.app));
  assert.deepEqual(requests.map((r) => [r.cmd, r.app]), [["sign-in", "origaitv.sample"]]);
  await page.close();
});

test("once the app says it's signed in, home hears of it and the tile is its usual self", async () => {
  const page = await tv();
  await page.waitForSelector(`${sample} .tile-sign-in`);
  assert.equal((await signedIn("origaitv.sample", true)).status, 200);
  await page.waitForSelector(`${sample}.has-content`);
  assert.equal(await page.$(`${sample} .tile-sign-in`), null);
  await page.locator(sample).hover();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as unknown as { screenRequests: { cmd: string }[] }).screenRequests.some((r) => r.cmd === "open-app"));
  await page.close();
  assert.deepEqual(errors, []);
});
