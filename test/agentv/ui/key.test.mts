// Settings → AI in a real Chromium (ADR-019, layer 4; S4.6): which provider
// has a key, a key typed into a field that doesn't show it, the provider
// picked with left and right, and the PIN first once there is one. The move
// to root's file is layer 2's (key-test.sh, key-store-test.sh) and the image
// layer's.

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
const KEY = `sk-proj-${"e".repeat(40)}`;

before(async () => {
  ({ daemon, url } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

// A TV whose daemon keeps a key the way agentv-key-store would, and
// remembers what it was sent.
async function tv(): Promise<{ page: Page; puts: { body: { provider: string; key: string }; grant?: string }[] }> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const puts: { body: { provider: string; key: string }; grant?: string }[] = [];
  let state = { set: false, provider: null as string | null };
  await page.route(`${url}/api/key`, async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = request.postDataJSON();
      puts.push({ body, grant: request.headers()["x-agentv-grant"] });
      state = { set: true, provider: body.provider };
    }
    await route.fulfill({ json: { ok: true, ...state } });
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return { page, puts };
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const focused = (page: Page) => page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action") ?? document.querySelector(".focused")?.getAttribute("data-key"));

test("S4.6 Settings → AI takes a key in a field that doesn't show it, for the provider picked", async () => {
  const { page, puts } = await tv();
  await go(page, "settings/ai");
  await page.waitForFunction(() => /no key/.test(document.querySelector('.menu-item[data-key="ai"]')?.textContent ?? ""));
  assert.match(await page.locator(".panel").innerText(), /no key yet[\s\S]*using your plan instead comes with tv setup/);
  await page.keyboard.press("Enter");
  assert.equal(await focused(page), "add-key");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.page [data-action="provider"]');
  assert.match(await page.locator('[data-action="provider"]').innerText(), /‹ claude ›/);
  await page.keyboard.press("ArrowRight");
  assert.match(await page.locator('[data-action="provider"]').innerText(), /‹ chatgpt ›/);
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(page), "key");
  assert.equal(await page.locator('[data-action="key"]').getAttribute("type"), "password", "the key isn't shown on the TV");
  await page.keyboard.type(KEY);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /the key for chatgpt is kept/.test(document.body.textContent ?? ""));
  assert.deepEqual(puts, [{ body: { provider: "chatgpt", key: KEY }, grant: undefined }]);
  await page.waitForSelector('.menu-item.open[data-key="ai"]');
  assert.match(await page.locator('.menu-item[data-key="ai"]').innerText(), /ai\s+chatgpt/);
  assert.match(await page.locator(".panel").innerText(), /chatgpt[\s\S]*never shown again[\s\S]*replace the key →[\s\S]*take the key off/);
  assert.ok(!(await page.content()).includes(KEY), "nothing on the page has it after");
  await page.close();
});

test("S4.6 S4.5 with a PIN set, the key is past it", async () => {
  assert.equal(daemon.pin.set("4826", undefined), null);
  const { page, puts } = await tv();
  await go(page, "key");
  await page.waitForSelector('.page [data-action="key"]');
  await page.locator('[data-action="key"]').fill(KEY);
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.getElementById("pin")?.classList.contains("on") === true);
  assert.match(await page.locator("#pin").innerText(), /for the ai key\./);
  for (const digit of "4826") await page.keyboard.press(digit);
  await page.waitForFunction(() => /the key for claude is kept/.test(document.body.textContent ?? ""));
  assert.equal(puts.length, 1);
  assert.ok(puts[0].grant && daemon.pin.allows(puts[0].grant), "it carries the grant");
  await page.close();
});
