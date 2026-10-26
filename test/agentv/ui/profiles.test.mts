// Profiles on the TV in a real Chromium (ADR-019, layer 4; ADR-009, S4.2):
// Settings → Profiles lists who watches, a profile's page switches to it, a
// switch from anywhere shows within a second, a profile is added with a
// typed name and its role and colour, and a child's profile has only children's
// apps, with Settings, edit mode and the switch back to an adult past the
// PIN. An adult's profile locks from its page (ADR-034): its row shows a
// lock, switching to it asks for the PIN, and only it opens on the pad after
// the box starts.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
const errors: string[] = [];
const PIN = "4826";
const dir = mkdtempSync(join(tmpdir(), "agentv-profiles-ui-"));

before(async () => {
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  process.env.AGENTV_PASSWD = passwd;
  ({ daemon, url } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  delete process.env.AGENTV_PASSWD;
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

type Request = { cmd: string; app?: string };

// A TV whose screen daemon answers every request with ok and remembers it.
async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: Request[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true, apps: [] })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

async function send(method: string, path: string, body?: unknown, grant?: string) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as Record<string, any>;
}
const grant = async () => (await send("POST", "/api/pin/check", { pin: PIN })).grant as string;
const viewers = async () => (await send("GET", "/api/viewers")).viewers as { id: string; name: string; role: string }[];
const byName = async (name: string) => (await viewers()).find((v) => v.name === name)!;

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const focused = (page: Page) => page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action") ?? document.querySelector(".focused")?.getAttribute("data-key"));
const barName = (page: Page) => page.locator(".bar-right span").first().innerText();
const sent = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { screenRequests: Request[] }).screenRequests.filter((r) => r.cmd === c), cmd);

async function waitPad(page: Page, up: boolean): Promise<void> {
  await page.waitForFunction((want) => document.getElementById("pin")?.classList.contains("on") === want, up);
}
async function type(page: Page, digits: string): Promise<void> {
  for (const digit of digits) await page.keyboard.press(digit);
}

test("S4.2 Settings → Profiles lists who watches, and a profile's page switches to it within a second", async () => {
  await send("POST", "/api/viewers", { name: "ana", role: "adult" });
  const page = await tv();
  assert.equal(await barName(page), "radomir");
  await go(page, "settings/profiles");
  await page.waitForSelector('.menu-item.open[data-key="profiles"]');
  assert.match(await page.locator('.menu-item[data-key="profiles"]').innerText(), /profiles\s+2/);
  assert.match(await page.locator(".panel").innerText(), /who watches\?\s+r\s+radomir\s+watching\s+a\s+ana[\s\S]*add a profile/);
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  const ana = await byName("ana");
  assert.equal(await focused(page), `viewer-${ana.id}`);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".page.profile");
  assert.equal(await focused(page), "watch");
  assert.match(await page.locator(".page.profile .headline").innerText(), /^ana$/);
  const at = Date.now();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /watching now/.test(document.querySelector(".page.profile")?.textContent ?? ""));
  assert.ok(Date.now() - at < 1000, `the switch showed in ${Date.now() - at} ms`);
  assert.equal((await send("GET", "/api/viewer")).viewer.id, ana.id);
  // Back on home, it's ana's.
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector(".bar-right span")?.textContent === "ana");
  await send("POST", "/api/viewer", { id: "radomir" });
  await page.close();
});

test("S4.2 a switch from anywhere, as from the phone, shows on the TV within a second", async () => {
  const page = await tv();
  const ana = await byName("ana");
  const at = Date.now();
  await send("POST", "/api/viewer", { id: ana.id });
  await page.waitForFunction(() => document.querySelector(".bar-right span")?.textContent === "ana");
  const took = Date.now() - at;
  assert.ok(took < 1000, `the switch showed in ${took} ms`);
  await send("POST", "/api/viewer", { id: "radomir" });
  await page.waitForFunction(() => document.querySelector(".bar-right span")?.textContent === "radomir");
  await page.close();
});

test("S4.2 a profile is added on the TV: a typed name, then its role and colour with left and right", async () => {
  const page = await tv();
  await go(page, "profile/new");
  await page.waitForSelector(".page.profile");
  assert.equal(await focused(page), "name", "the name comes first");
  await page.keyboard.type("leo");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(page), "role");
  await page.keyboard.press("ArrowRight");
  assert.match(await page.locator('[data-action="role"]').innerText(), /‹ child ›/);
  // The colour starts on the next one no one has, and right goes on.
  assert.match(await page.locator('[data-action="avatar"]').innerText(), /‹ magenta ›/);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  assert.match(await page.locator('[data-action="avatar"]').innerText(), /‹ yellow ›/);
  assert.equal(await page.locator(".profile-head .avatar.avatar-yellow").innerText(), "l");
  // With no PIN, a child's profile can't be added, and the TV says why.
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => /needs an adult pin/.test(document.querySelector(".toast")?.textContent ?? ""));
  assert.equal((await viewers()).length, 2);

  // With one, it asks for it first.
  await send("PUT", "/api/pin", { pin: PIN });
  await page.locator('[data-action="save"]').click();
  await waitPad(page, true);
  assert.match(await page.locator("#pin").innerText(), /for changing profiles\./);
  await type(page, PIN);
  await waitPad(page, false);
  await page.waitForFunction(() => /leo is here now/.test(document.body.textContent ?? ""));
  const leo = await byName("leo");
  assert.deepEqual([leo.role, (leo as unknown as { avatar: string }).avatar], ["child", "yellow"]);
  await page.close();
});

test("S4.2 S4.5 on a child's profile: only children's apps, the apps children can't open closed, and adult things past the PIN", async () => {
  const page = await tv();
  // An app open behind home that children can't open.
  await page.evaluate(() => (window as unknown as { agentvRunning: (json: string) => void }).agentvRunning(JSON.stringify([{ id: "agentv.tube", game: false, paused: true }])));
  const leo = await byName("leo");
  await send("POST", "/api/viewer", { id: leo.id });
  await page.waitForFunction(() => document.querySelector(".bar-right span")?.textContent === "leo");
  await page.waitForFunction(() => (window as unknown as { screenRequests: Request[] }).screenRequests.some((r) => r.cmd === "quit"));
  assert.deepEqual((await sent(page, "quit")).map((r) => r.app), ["agentv.tube"]);
  assert.deepEqual(await page.locator(".grid .tile").evaluateAll((tiles) => tiles.map((t) => t.getAttribute("data-id"))), ["apps"]);

  // Edit mode and Settings ask for the PIN.
  await page.keyboard.press("e");
  await waitPad(page, true);
  assert.match(await page.locator("#pin").innerText(), /for editing home\./);
  await page.keyboard.press("Escape");
  await waitPad(page, false);
  await page.locator(".bar-link", { hasText: "settings" }).click();
  await waitPad(page, true);
  assert.match(await page.locator("#pin").innerText(), /for settings\./);
  await type(page, PIN);
  await waitPad(page, false);
  await page.waitForSelector(".page.settings");
  // Power isn't there on a child's profile, even past the PIN.
  assert.equal(await page.locator('.menu-item[data-key="power"]').count(), 0);
  // Back to an adult, in the same visit: the PIN already entered does.
  await go(page, `profile/radomir`);
  await page.waitForSelector('.page.profile [data-action="watch"]');
  await page.locator('[data-action="watch"]').click();
  await page.waitForFunction(() => /watching now/.test(document.querySelector(".page.profile")?.textContent ?? ""));
  assert.equal((await send("GET", "/api/viewer")).viewer.id, "radomir");
  assert.equal(await page.locator("#pin.on").count(), 0, "no second pad");
  await page.close();
});

test("S4.2 an adult ticks an app for children in its details, past the PIN", async () => {
  const page = await tv();
  await go(page, "details/agentv.sample");
  await page.waitForSelector('[data-action="children"]');
  assert.match(await page.locator('[data-action="children"]').innerText(), /for children\s+\[ \]/);
  await page.locator('[data-action="children"]').click();
  await waitPad(page, true);
  await type(page, PIN);
  await waitPad(page, false);
  await page.waitForFunction(() => /\[x\]/.test(document.querySelector('[data-action="children"]')?.textContent ?? ""));
  const leo = await byName("leo");
  await send("POST", "/api/viewer", { id: leo.id });
  await page.waitForFunction(() => document.querySelector('.grid .tile[data-id="agentv.sample"]') !== null);
  assert.equal(await page.locator('[data-action="children"]').count(), 0, "a child's details don't have it");
  await send("POST", "/api/viewer", { id: "radomir" }, await grant());
  await page.close();
});

test("ADR-034 an adult locks their profile on its page: a lock on its row, the PIN to switch to it, and the pad after the box starts", async () => {
  const ana = await byName("ana");
  await send("POST", "/api/viewer", { id: "radomir" }, await grant());
  const page = await tv();
  await go(page, `profile/${ana.id}`);
  await page.waitForSelector(".page.profile");
  assert.match(await page.locator('[data-action="lock"]').innerText(), /ask for the pin to open\s+‹ no ›/);
  await page.locator('[data-action="lock"]').click();
  assert.match(await page.locator('[data-action="lock"]').innerText(), /‹ yes ›/);
  await page.locator('[data-action="save"]').click();
  await waitPad(page, true);
  await type(page, PIN);
  await waitPad(page, false);
  await page.waitForFunction(() => /ana is saved/.test(document.body.textContent ?? ""));
  assert.equal(((await byName("ana")) as unknown as { locked: boolean }).locked, true);

  // Settings → Profiles shows the lock on her row, and only hers.
  await go(page, "settings/profiles");
  await page.waitForSelector(`.panel [data-action="viewer-${ana.id}"]`);
  assert.equal(await page.locator(`.panel [data-action="viewer-${ana.id}"] svg.glyph-lock`).count(), 1);
  assert.equal(await page.locator('.panel [data-action="viewer-radomir"] svg.glyph-lock').count(), 0);

  // Watching as ana asks for the PIN, from an adult's profile too.
  await go(page, `profile/${ana.id}`);
  await page.waitForSelector('.page.profile [data-action="watch"]');
  await page.locator('[data-action="watch"]').click();
  await waitPad(page, true);
  assert.match(await page.locator("#pin").innerText(), /for watching as ana\./);
  await type(page, PIN);
  await page.waitForFunction(() => /watching now/.test(document.querySelector(".page.profile")?.textContent ?? ""));
  assert.equal((await send("GET", "/api/viewer")).viewer.id, ana.id);

  // After the box starts again, a TV on ana's profile opens on the pad.
  daemon.pin.lock(false);
  const started = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  started.on("pageerror", (error) => errors.push(error.message));
  await started.goto(`${url}/`);
  await waitPad(started, true);
  assert.match(await started.locator("#pin").innerText(), /tv locked[\s\S]*enter the adult pin[\s\S]*ana's profile asks for it to open\./);
  await type(started, PIN);
  await waitPad(started, false);
  await started.close();

  // On radomir's, which doesn't ask, it opens on home.
  await send("POST", "/api/viewer", { id: "radomir" });
  daemon.pin.lock(false);
  const home = await tv();
  assert.equal(await home.evaluate(() => document.getElementById("pin")?.classList.contains("on") === true), false);
  await home.close();
  await send("PUT", `/api/viewers/${ana.id}`, { locked: false }, await grant());
  await page.close();
});
