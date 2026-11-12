// Restart and Shut down, in Settings' This TV, in a real Chromium (ADR-019,
// layer 4; ADR-033, S2.18): each choice asks first, Restart goes right after
// its question, Shut down counts down 10 seconds that Cancel stops and then
// asks the TV session to shut down, and neither is there on a child's
// profile or goes while an update runs. The box turning off is the image layer's and the NUC's.

import assert from "node:assert/strict";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { PHASE_1, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let updates = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url, updates } = await startBox(0, undefined, { features: PHASE_1 }));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

type Request = { cmd: string; what?: string; at: number };

// A TV whose screen daemon answers every request with ok and remembers it,
// with when, and the viewer as the daemon says, or a child. It says the box
// restarts to its boot menu unless told it can't, and takes as long to
// answer as window.screenDelay says, in ms.
async function tv(role: "adult" | "child" = "adult", at = url, bootMenu = true): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((can) => {
    const w = window as unknown as { screenRequests: Request[]; screenDelay?: number; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push({ ...request, at: Date.now() });
      const reply = request.cmd === "boot-menu" ? { ok: true, can } : { ok: true };
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify(reply)), w.screenDelay ?? 0);
    };
  }, bootMenu);
  if (role === "child") {
    await page.route(`${url}/api/home`, async (route) => {
      const reply = await route.fetch();
      const state = await reply.json();
      await route.fulfill({ response: reply, json: { ...state, viewer: { ...state.viewer, role: "child" } } });
    });
  }
  await page.goto(`${at}/`);
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
  await page.waitForSelector('.settings-panel[data-page="tv"]');
  assert.equal(await page.locator(".menu-item.open").innerText(), "this tv", "Restart and Shut down are rows in This TV");
  assert.match(await page.locator(".panel").innerText(), /restart\s+shut down/);
  // OK on the section goes into it, and OK on Restart asks.
  await page.keyboard.press("Enter");
  assert.equal(await focused(page), "restart");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".page.power");
  assert.equal(await headline(page), "restart?");
  assert.equal(await focused(page), "restart", "the choice has the focus, with Cancel beside it");
  assert.match(await page.locator(".check-actions").innerText(), /^restart\s+cancel$/);
  // Back is Cancel.
  await page.keyboard.press("Escape");
  await page.waitForSelector('.settings-panel[data-page="tv"]');
  // So is Cancel itself.
  await go(page, "power/restart");
  await page.waitForSelector(".page.power");
  await page.keyboard.press("ArrowRight");
  assert.equal(await focused(page), "cancel");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.settings-panel[data-page="tv"]');
  assert.deepEqual(await powered(page), [], "nothing restarts without its question answered");
  // Restart goes at once.
  await go(page, "power/restart");
  await page.waitForSelector(".page.power");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".page .headline")?.textContent === "Restarting…");
  assert.equal(await page.locator(".check-summary").innerText(), "", "the headline says it, and nothing under it");
  assert.deepEqual((await powered(page)).map((r) => r.what), ["restart"]);
  await page.close();
  assert.deepEqual(errors, []);
});

test("S2.18 Shut down counts down 10 seconds, which Cancel stops, then asks the TV session to shut down", async () => {
  const page = await tv();
  await go(page, "settings/power");
  await page.waitForSelector('.settings-panel[data-page="tv"]');
  await go(page, "power/shutdown");
  await page.waitForSelector(".page.power");
  assert.equal(await headline(page), "shut down?");
  assert.equal(await page.locator(".check-summary").innerText(), "apps close, and it turns off in 10 seconds");
  // The first countdown, stopped after 2 seconds with Cancel.
  await page.keyboard.press("Enter");
  await page.waitForSelector(".power-count:not(.hidden)");
  assert.equal(await page.locator(".power-count").innerText(), "10");
  assert.equal(await page.locator(".check-summary").innerText(), "shutting down in 10 seconds");
  assert.equal(await headline(page), "shutting down…");
  assert.equal(await focused(page), "cancel", "Cancel has the focus while it counts");
  // And the focus ring is on it, below the number, not where it was before.
  await page.waitForFunction(() => {
    const ring = document.getElementById("ring")!.getBoundingClientRect();
    const cancel = document.querySelector('[data-action="cancel"]')!.getBoundingClientRect();
    return Math.abs(ring.top - cancel.top) < 16 && Math.abs(ring.left - cancel.left) < 16;
  }, null, { timeout: 2000 });
  await page.waitForFunction(() => document.querySelector(".power-count")?.textContent === "8", null, { timeout: 4000 });
  await page.keyboard.press("Enter");
  await page.waitForSelector('.settings-panel[data-page="tv"]');
  // The second, to the end. A first one that kept counting would ask
  // before this one could.
  await go(page, "power/shutdown");
  await page.waitForSelector(".page.power");
  const started = Date.now();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".power-count")?.textContent === "1", null, { timeout: 12_000 });
  assert.match(await page.locator(".check-summary").innerText(), /^shutting down in 1 second$/);
  await page.waitForFunction(() => document.querySelector(".check-summary")?.textContent === "" && document.querySelector(".page .headline")?.textContent === "Shutting down…", null, { timeout: 4000 });
  const requests = await powered(page);
  assert.deepEqual(requests.map((r) => r.what), ["shutdown"], "one shut down, from the countdown that ran to the end");
  const after = (requests[0].at - started) / 1000;
  assert.ok(after >= 9.5 && after <= 11, `it asked ${after.toFixed(1)} s after Shut down was chosen`);
  await page.close();
  assert.deepEqual(errors, []);
});

test("S2.18 Power isn't on a child's profile or offered while an update runs, and an update stops a countdown", async () => {
  // A child's Settings has no Power, and its questions don't open.
  const child = await tv("child");
  await go(child, "settings/tv");
  await child.waitForSelector('.settings-panel[data-page="tv"]');
  assert.equal(await child.locator('.panel [data-action="restart"], .panel [data-action="shutdown"], .panel [data-action="sleep"]').count(), 0);
  await go(child, "power/shutdown");
  await child.waitForSelector(".grid .tile");
  assert.equal(await child.locator(".page.power").count(), 0);
  // Its stand-in for /api/home may still be answering; that's not this test's.
  await child.unrouteAll({ behavior: "ignoreErrors" });
  await child.close();

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
  assert.equal(await page.locator(".check-summary").innerText(), "an update started, so it stayed on");
  await go(page, "settings/power");
  await page.waitForSelector('.settings-panel[data-page="tv"]');
  await page.evaluate(() => document.querySelector<HTMLElement>('.panel [data-action="shutdown"]')!.click());
  await page.waitForFunction(() => [...document.querySelectorAll("#toasts .toast")].some((toast) => toast.textContent === "Not during an update"));
  assert.equal(await page.locator(".page.power").count(), 0, "its question doesn't open");
  rmSync(join(updates, "progress.json"));
  assert.deepEqual(await powered(page), []);
  await page.close();
  assert.deepEqual(errors, []);
});

test("T2.2 Settings → Power has restart to the boot menu, which asks first, then restarts to it", async () => {
  const page = await tv();
  await go(page, "settings/power");
  await page.waitForSelector('.settings-panel[data-page="tv"]');
  // The row shows once the box says it can.
  await page.waitForSelector('.panel [data-action="bootmenu"]:not(.hidden)');
  assert.match(await page.locator(".panel").innerText(), /restart\s+shut down\s+restart to the boot menu/);
  // OK on the section goes into it, and down twice is the boot menu's row.
  for (const [key, then] of [["Enter", "restart"], ["ArrowDown", "shutdown"], ["ArrowDown", "bootmenu"]]) {
    await page.keyboard.press(key);
    await page.waitForFunction((action) => document.querySelector(".focused")?.getAttribute("data-action") === action, then);
  }
  // Settings is drawn again in place when the daemon has news, here an
  // update. The row and the focus on it stay, while the box is asked again.
  await page.evaluate(() => ((window as unknown as { screenDelay: number }).screenDelay = 3000));
  const drawn = await page.$(".panel");
  write("status.json", { checked_at: new Date().toISOString(), ok: true, channel: "stable", agentv: { installed: "0.2.1-1", available: "0.3.0-1" }, omarchy: { installed: "4.5.0-3", available: "4.5.0-3" }, packages: 1, security: false });
  await page.waitForFunction((panel) => !panel?.isConnected, drawn);
  assert.equal(await page.locator('.panel [data-action="bootmenu"]').isVisible(), true, "the row is still there");
  assert.equal(await focused(page), "bootmenu");
  await page.evaluate(() => ((window as unknown as { screenDelay: number }).screenDelay = 0));
  rmSync(join(updates, "status.json"));
  // OK on it asks.
  await page.keyboard.press("Enter");
  await page.waitForSelector(".page.power");
  assert.equal(await headline(page), "restart to the boot menu?");
  assert.equal(await page.locator(".check-summary").innerText(), "you can pick an earlier backup there");
  assert.match(await page.locator(".check-actions").innerText(), /^restart\s+cancel$/);
  // Back is Cancel, and nothing restarts.
  await page.keyboard.press("Escape");
  await page.waitForSelector('.settings-panel[data-page="tv"]');
  assert.deepEqual(await powered(page), []);
  // Its question answered, it goes at once.
  await go(page, "power/bootmenu");
  await page.waitForSelector(".page.power");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".page .headline")?.textContent === "Restarting…");
  assert.deepEqual((await powered(page)).map((r) => r.what), ["bootmenu"]);
  await page.close();
  assert.deepEqual(errors, []);
});

test("T2.2 a box whose boot loader can't restart to its menu doesn't offer it", async () => {
  const page = await tv("adult", url, false);
  await go(page, "settings/power");
  await page.waitForSelector('.settings-panel[data-page="tv"]');
  await page.waitForFunction(() => (window as unknown as { screenRequests: Request[] }).screenRequests.some((r) => r.cmd === "boot-menu"));
  await page.waitForTimeout(200);
  assert.doesNotMatch(await page.locator(".panel").innerText(), /boot menu/);
  await page.close();
});

test("T13.2 Settings → Power has sleep beside the boot menu, off by default, and turned on it says what wakes the box", async () => {
  const page = await tv();
  await go(page, "settings/power");
  await page.waitForSelector('.settings-panel[data-page="tv"]');
  await page.waitForSelector('[data-action="bootmenu"]:not(.hidden)');
  const value = () => page.locator('[data-action="sleep"] .button-value').innerText();
  assert.match(await page.locator('[data-action="sleep"]').innerText(), /sleep after an hour off\s+off/);
  // Down from restart: shut down, the boot menu, then sleep.
  await page.keyboard.press("Enter");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  assert.equal(await focused(page), "sleep");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-action="sleep"] .button-value')?.textContent === "On");
  assert.equal(await focused(page), "sleep", "the focus stays on it");
  await page.waitForFunction(() => [...document.querySelectorAll("#toasts .toast")].some((toast) => toast.textContent === "Wake it with the power button or a keyboard. Your phone can't."));
  const saved = async () => ((await (await fetch(`${url}/api/home`)).json()) as { settings: { sleepWhenOff?: boolean } }).settings.sleepWhenOff;
  assert.equal(await saved(), true);
  // And off again.
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-action="sleep"] .button-value')?.textContent === "Off");
  assert.equal(await value(), "off");
  assert.equal(await saved(), false);
  await page.close();
  assert.deepEqual(errors, []);
});

test("About says what AgenTV is, as its public line does", async () => {
  const page = await tv();
  await go(page, "settings/about");
  await page.waitForSelector('.settings-panel[data-page="about"]');
  assert.match(await page.locator(".panel").innerText(), /the world's first open-source agentic tv os\. powered by omarchy\./);
  await page.close();
});
