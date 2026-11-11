// A name in a toast keeps its own capitals, in a real Chromium (ADR-019,
// layer 4), in each look. Glass and Cinema go over the words on screen and
// write "tv" as "TV", which is right for a word and wrong for a network
// called "tv-room" or a controller called "tv pad". The daemon's answers
// for the network and the controllers are stood in for on the page, so
// there's a network and a controller with such a name.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { rest, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
const NETWORK = "tv-room";
const PAD = "tv pad";

let browser: Browser;
let daemon: Daemon;
let url = "";

before(async () => {
  ({ daemon, url } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  const json = (body: object, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  // On a cable, with one open network nearby, which won't be joined.
  const online = { ok: true, online: true, via: "cable", name: null, wifi: true, looking: false, joining: null, problem: null, hotspot: null, change: true };
  await page.route("**/api/network", (route) => route.fulfill(json(online)));
  await page.route("**/api/network/scan", (route) => route.fulfill(json(online)));
  await page.route("**/api/network/networks", (route) => route.fulfill(json({ ok: true, networks: [{ ssid: NETWORK, signal: 80, secure: false }] })));
  await page.route("**/api/network/join", (route) => route.fulfill(json({ ok: false, error: "failed" }, 400)));
  // One controller nearby, which pairs and then is removed.
  const pad = (paired: boolean) => ({ ok: true, bluetooth: "on", looking: true, controllers: [{ id: "pad", name: PAD, paired, connected: paired }], usb: [] });
  let paired = false;
  await page.route("**/api/controllers/look", (route) => route.fulfill(json(pad(paired))));
  await page.route("**/api/controllers/pair", (route) => route.fulfill(json(pad((paired = true)))));
  await page.route("**/api/controllers/pad", (route) => route.fulfill(json(pad((paired = false)))));
  await page.goto(`${url}/`);
  await page.waitForSelector("#page .focused");
  await rest(page);
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const toasts = (page: Page) => page.$$eval("#toasts .toast", (all) => all.map((toast) => toast.textContent));

for (const look of LOOKS) {
  test(`in ${look}, a toast with a network's or a controller's name in it shows the name as it is`, async () => {
    assert.equal((await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) })).status, 200);
    const said = (text: string) => (look === "terminal" ? text.toLowerCase() : text);
    const page = await tv();
    try {
      await go(page, "settings/network");
      await page.locator(`.panel [data-ssid="${NETWORK}"]`).click();
      await page.waitForSelector("#toasts .toast.fail");
      await go(page, "settings/controllers");
      await page.locator('.panel [data-action="controller-pad"][data-controller="nearby"]').click();
      await page.waitForSelector('.panel [data-action="controller-pad"][data-controller="paired"]');
      await page.locator('.panel [data-action="controller-pad"]').click();
      await page.waitForSelector('.panel [data-action="controller-pad"][data-controller="nearby"]');
      // Long enough for the look to have gone over the words.
      await page.waitForTimeout(200);
      assert.deepEqual(await toasts(page), [said("Couldn't join %s. Try again.").replace("%s", NETWORK), `${said("Paired")} ${PAD}`, `${said("Removed")} ${PAD}`]);
    } finally {
      await page.close();
    }
  });
}
