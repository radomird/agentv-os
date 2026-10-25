// Settings → Power in a real Chromium (ADR-019, layer 4; ADR-033, S2.18):
// each choice asks first, Restart goes right after its question, Shut down
// counts down 10 seconds that Cancel stops and then asks the TV session to
// shut down, and Power isn't there on a kid's profile or while an update
// runs. The box turning off is the image layer's and the NUC's.

import assert from "node:assert/strict";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let updates = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url, updates } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

type Request = { cmd: string; what?: string; at: number };

// A TV whose screen daemon answers every request with ok and remembers it,
// with when, and the viewer as the daemon says, or a kid.
async function tv(role: "adult" | "kid" = "adult"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: Request[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push({ ...request, at: Date.now() });
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  if (role === "kid") {
    await page.route(`${url}/api/home`, async (route) => {
      const reply = await route.fetch();
      const state = await reply.json();
      await route.fulfill({ response: reply, json: { ...state, viewer: { ...state.viewer, role: "kid" } } });
    });
  }
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const powered = (page: Page) => page.evaluate(() => (window as unknown as { screenRequests: Request[] }).screenRequests.filter((r) => r.cmd === "power"));
const focused = (page: Page) => page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action") ?? document.querySelector(".focused")?.getAttribute("data-key"));
const headline = (page: Page) => page.locator(".page .headline").innerText();

function write(name: string, data: unknown): void {
  writeFileSync(join(updates, `${name}.next`), JSON.stringify(data));
  renameSync(join(updates, `${name}.next`), join(updates, name));
}

test("S2.18 Settings → Power asks first, Restart goes right after its question, and Back or Cancel stops it", async () => {
  const page = await tv();
  await go(page, "settings/power");
  await page.waitForSelector('.menu-item.open[data-key="power"]');
  assert.match(await page.locator('.menu-item[data-key="power"]').innerText(), /power\s+restart · shut down/);
  assert.match(await page.locator(".panel").innerText(), /restart →\s+shut down →/);
  // OK on the section goes into it, and OK on Restart asks.
  await page.keyboard.press("Enter");
  assert.equal(await focused(page), "restart");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".page.power");
  assert.equal(await headline(page), "restart the box?");
  assert.equal(await focused(page), "restart", "the choice has the focus, with Cancel beside it");
  assert.match(await page.locator(".check-actions").innerText(), /↵ restart\s+cancel/);
  // Back is Cancel.
  await page.keyboard.press("Escape");
  await page.waitForSelector('.menu-item.open[data-key="power"]');
  // So is Cancel itself.
  await go(page, "power/restart");
  await page.waitForSelector(".page.power");
  await page.keyboard.press("ArrowRight");
  assert.equal(await focused(page), "cancel");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.menu-item.open[data-key="power"]');
  assert.deepEqual(await powered(page), [], "nothing restarts without its question answered");
  // Restart goes at once.
  await go(page, "power/restart");
  await page.waitForSelector(".page.power");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".check-summary")?.textContent === "restarting now.");
  assert.deepEqual((await powered(page)).map((r) => r.what), ["restart"]);
  await page.close();
  assert.deepEqual(errors, []);
});

test("S2.18 Shut down counts down 10 seconds, which Cancel stops, then asks the TV session to shut down", async () => {
  const page = await tv();
  await go(page, "settings/power");
  await page.waitForSelector('.menu-item.open[data-key="power"]');
  await go(page, "power/shutdown");
  await page.waitForSelector(".page.power");
  assert.equal(await headline(page), "shut down the box?");
  assert.match(await page.locator(".check-summary").innerText(), /off 10 seconds after you choose/);
  // The first countdown, stopped after 2 seconds with Cancel.
  await page.keyboard.press("Enter");
  await page.waitForSelector(".power-count:not(.hidden)");
  assert.equal(await page.locator(".power-count").innerText(), "10");
  assert.equal(await page.locator(".check-summary").innerText(), "shutting down in 10 seconds.");
  assert.equal(await headline(page), "shutting down.");
  assert.equal(await focused(page), "cancel", "Cancel has the focus while it counts");
  // And the focus ring is on it, below the number, not where it was before.
  await page.waitForFunction(() => {
    const ring = document.getElementById("ring")!.getBoundingClientRect();
    const cancel = document.querySelector('[data-action="cancel"]')!.getBoundingClientRect();
    return Math.abs(ring.top - cancel.top) < 16 && Math.abs(ring.left - cancel.left) < 16;
  }, null, { timeout: 2000 });
  await page.waitForFunction(() => document.querySelector(".power-count")?.textContent === "8", null, { timeout: 4000 });
  await page.keyboard.press("Enter");
  await page.waitForSelector('.menu-item.open[data-key="power"]');
  // The second, to the end. A first one that kept counting would ask
  // before this one could.
  await go(page, "power/shutdown");
  await page.waitForSelector(".page.power");
  const started = Date.now();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".power-count")?.textContent === "1", null, { timeout: 12_000 });
  assert.match(await page.locator(".check-summary").innerText(), /shutting down in 1 second\./);
  await page.waitForFunction(() => document.querySelector(".check-summary")?.textContent === "shutting down now.", null, { timeout: 4000 });
  const requests = await powered(page);
  assert.deepEqual(requests.map((r) => r.what), ["shutdown"], "one shut down, from the countdown that ran to the end");
  const after = (requests[0].at - started) / 1000;
  assert.ok(after >= 9.5 && after <= 11, `it asked ${after.toFixed(1)} s after Shut down was chosen`);
  await page.close();
  assert.deepEqual(errors, []);
});

test("S2.18 Power isn't on a kid's profile or offered while an update runs, and an update stops a countdown", async () => {
  // A kid's Settings has no Power, and its questions don't open.
  const kid = await tv("kid");
  await go(kid, "settings");
  await kid.waitForSelector(".menu-item");
  assert.equal(await kid.locator('.menu-item[data-key="power"]').count(), 0);
  await go(kid, "power/shutdown");
  await kid.waitForSelector(".grid .tile");
  assert.equal(await kid.locator(".page.power").count(), 0);
  await kid.close();

  // A countdown stops when an install starts, and Power says why it's not
  // there while it runs.
  const page = await tv();
  await go(page, "power/shutdown");
  await page.waitForSelector(".page.power");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".power-count:not(.hidden)");
  const running = { state: "running", step: "packages", percent: 30, detail: "", at: new Date().toISOString(), from: { agentv: "0.2.1-1", omarchy: "4.0.6-1" }, to: { agentv: "0.3.0-1" } };
  write("progress.json", running);
  await page.waitForSelector("#updating.on");
  await page.waitForSelector(".power-count.hidden", { state: "attached", timeout: 3000 });
  assert.equal(await page.locator(".check-summary").innerText(), "it didn't shut down: an update started.");
  await go(page, "settings/power");
  await page.waitForSelector('.menu-item.open[data-key="power"]');
  assert.match(await page.locator(".panel").innerText(), /not while an update runs/);
  assert.equal(await page.locator('.panel [data-action="shutdown"]').count(), 0);
  rmSync(join(updates, "progress.json"));
  assert.deepEqual(await powered(page), []);
  await page.close();
  assert.deepEqual(errors, []);
});

test("About says what AgenTV is, as its public line does", async () => {
  const page = await tv();
  await go(page, "settings/about");
  await page.waitForSelector('.menu-item.open[data-key="about"]');
  assert.match(await page.locator(".panel").innerText(), /the world's first open-source agentic tv os\. powered by omarchy\./);
  await page.close();
});
