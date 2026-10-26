// TV setup in a real Chromium (ADR-019, layer 4; stages 4 and 5): the
// captive page at 390 × 844, as a phone that joined the setup hotspot opens
// it, picking the home Wi-Fi and typing its password, or a network that hides
// its name, and coming back to the reason when the password was wrong; then
// the setup screens on the TV at 1920 × 1080: the welcome screen with the
// hotspot's QR code and then the code that pairs the phone, the keyboard's
// way onto the Wi-Fi, getting ready bringing the box up to date first and
// picking up at the same step after the page loads again (S5.6), what the
// TV is for, and home once setup is done, with the motion rules (ADR-024).
// The radio, NetworkManager, dnsmasq, the firewall and the update itself are
// the image layer's and the NUC's, and so is qrencode: a stand-in draws the
// QR codes here, and a stand-in screen daemon takes the update's requests.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let state = "";
let hotspot = "";
let captive = "";
let updates = "";
let online = true;
const errors: string[] = [];
const tools = mkdtempSync(join(tmpdir(), "agentv-setup-ui-"));
const path = process.env.PATH;

before(async () => {
  writeFileSync(join(tools, "qrencode"), `#!/bin/bash\necho '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21"><rect width="21" height="21"/></svg>'\n`);
  chmodSync(join(tools, "qrencode"), 0o755);
  process.env.PATH = `${tools}:${path}`;
  const wired = { eth0: [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:01", internal: false, cidr: "192.168.1.20/24" }] };
  ({ daemon, url, state, hotspot, updates } = await startBox(0, undefined, { interfaces: () => (online ? wired : {}) }));
  captive = `http://127.0.0.1:${daemon.setupPort}`;
  writeFileSync(
    join(hotspot, "networks.json"),
    JSON.stringify([
      { ssid: "home wi-fi", signal: 82, secure: true },
      { ssid: "cafe", signal: 61, secure: false },
      { ssid: "neighbours", signal: 30, secure: true },
    ]),
  );
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  process.env.PATH = path;
  rmSync(tools, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

const drop = () => join(state, "hotspot-drop", "request.json");
function hotspotIs(fields: Record<string, unknown>): void {
  writeFileSync(join(hotspot, "state.json"), JSON.stringify({ on: false, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", ...fields }));
}

async function phone(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${captive}/`);
  return page;
}

test("stage 4 the captive page lists the networks the box saw, and the one picked goes to the box with its password", async () => {
  hotspotIs({ on: true });
  const page = await phone();
  await page.waitForSelector("button.network");
  assert.equal(await page.locator("h1").innerText(), "pick your wi-fi");
  assert.deepEqual(await page.locator("button.network").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-ssid"))), ["home wi-fi", "cafe", "neighbours"]);
  assert.match(await page.locator('button.network[data-ssid="home wi-fi"]').innerText(), /home wi-fi[\s\S]*█/);
  assert.equal(await page.locator('button.network[data-ssid="home wi-fi"] .glyph-lock').count(), 1, "a network with a password shows the lock");
  assert.equal(await page.locator('button.network[data-ssid="cafe"] .glyph-lock').count(), 0);

  await page.locator('button.network[data-ssid="home wi-fi"]').tap();
  await page.waitForSelector('input[type="password"]');
  assert.match(await page.locator("h1").innerText(), /home wi-fi/);
  assert.ok(await page.locator('input[type="password"]').evaluate((field) => field === document.activeElement), "the password field takes the keyboard");
  // Too short is the phone's to say.
  await page.locator('input[type="password"]').fill("short");
  await page.locator('[data-action="join"]').tap();
  await page.waitForFunction(() => /at least 8 characters/.test(document.getElementById("toast")?.textContent ?? ""));
  assert.ok(!existsSync(drop()));

  await page.locator('input[type="password"]').fill("correct horse");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /joining home wi-fi/.test(document.querySelector("h1")?.textContent ?? ""));
  assert.match(await page.locator(".page").innerText(), /scan the new code on the tv/);
  assert.deepEqual(JSON.parse(readFileSync(drop(), "utf8")), { join: { ssid: "home wi-fi", password: "correct horse", hidden: false } });
  rmSync(drop());

  // The password was wrong: the hotspot comes back, and so does the reason.
  hotspotIs({ on: true, error: "that password didn't work for home wi-fi" });
  await page.waitForFunction(() => /that password didn't work for home wi-fi/.test(document.querySelector(".note.bad")?.textContent ?? ""), null, { timeout: 5000 });
  assert.equal(await page.locator("h1").innerText(), "pick your wi-fi");
  await page.close();
});

test("stage 4 an open network needs no password, and one that hides its name is typed in", async () => {
  hotspotIs({ on: true });
  const page = await phone();
  await page.waitForSelector("button.network");
  await page.locator('button.network[data-ssid="cafe"]').tap();
  await page.waitForSelector('[data-action="join"]');
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await page.locator('[data-action="join"]').tap();
  await page.waitForFunction(() => /joining cafe/.test(document.querySelector("h1")?.textContent ?? ""));
  assert.deepEqual(JSON.parse(readFileSync(drop(), "utf8")), { join: { ssid: "cafe", password: "", hidden: false } });
  rmSync(drop());

  await page.goto(`${captive}/`);
  await page.waitForSelector("button.network");
  await page.locator('button[data-ssid=""]').tap();
  await page.waitForSelector('input[aria-label="the network\'s name"]');
  assert.equal(await page.locator("h1").innerText(), "another network");
  await page.locator('input[aria-label="the network\'s name"]').fill("attic");
  await page.locator('input[type="password"]').fill("upstairs1");
  await page.locator('[data-action="join"]').tap();
  await page.waitForFunction(() => /joining attic/.test(document.querySelector("h1")?.textContent ?? ""));
  assert.deepEqual(JSON.parse(readFileSync(drop(), "utf8")), { join: { ssid: "attic", password: "upstairs1", hidden: true } });
  rmSync(drop());
  await page.close();
});

// --- The setup screens on the TV (stage 5) ------------------------------------

const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// Setup from the start, with no hotspot, nothing about updates, and online.
async function fresh(): Promise<void> {
  await post("/api/setup", { done: false });
  hotspotIs({ on: false, ssid: null, password: null });
  for (const file of ["status.json", "progress.json"]) rmSync(join(updates, file), { force: true });
  online = true;
}

// The TV's page, with a stand-in for the screen daemon that takes its
// requests, as the home screen's window has it on the box.
async function tv(options: { reducedMotion?: "reduce" } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: options.reducedMotion });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: { cmd: string }[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForFunction(() => (window as unknown as { agentvWelcome?: boolean }).agentvWelcome === true);
  return page;
}

function requested(page: Page, cmd: string): Promise<unknown> {
  return page.waitForFunction((c) => (window as unknown as { screenRequests: { cmd: string }[] }).screenRequests.some((r) => r.cmd === c), cmd, { timeout: 10_000 });
}

const textOf = (page: Page, selector: string) => page.locator(selector).innerText();

test("stage 4 the welcome screen shows the hotspot's QR code, then the code that pairs the phone on the home Wi-Fi, and a phone that pairs moves setup on", async () => {
  await fresh();
  const page = await tv();
  await page.waitForSelector(".welcome");
  assert.equal(await textOf(page, ".prompt"), "~ $ tv setup");
  assert.equal(await page.locator("svg.hi").getAttribute("aria-label"), "hi.");
  await page.waitForFunction(() => /scan the code with your phone to pair it/.test(document.querySelector(".welcome-line")?.textContent ?? ""), null, { timeout: 5000 });

  hotspotIs({ on: true });
  await page.waitForFunction(() => document.querySelector(".welcome-line")?.textContent === "scan the code with your phone.", null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const qr = document.querySelector(".welcome-qr .qr") as HTMLImageElement;
    return /^\/api\/hotspot\/qr/.test(qr.getAttribute("src") ?? "") && qr.complete && qr.naturalWidth > 0;
  });
  assert.equal(await textOf(page, ".qr-label"), "wifi AgenTV-3f9a · password k7m2xpqr4n");
  assert.match(await textOf(page, ".bar"), /setup[\s\S]*1\/6 connect[\s\S]*wifi hotspot · phone waiting/);

  hotspotIs({ on: true, error: "that password didn't work for home wi-fi" });
  await page.waitForFunction(() => /that password didn't work for home wi-fi\. scan the code to try again\./.test(document.querySelector(".welcome-line")?.textContent ?? ""), null, { timeout: 5000 });

  hotspotIs({ on: false, joining: "home wi-fi" });
  await page.waitForFunction(() => document.querySelector(".welcome-line")?.textContent === "joining home wi-fi.", null, { timeout: 5000 });
  assert.ok(await page.locator(".welcome-qr.away").count(), "no QR code while it joins");

  hotspotIs({ on: false, joined: { ssid: "home wi-fi", address: "127.0.0.1" } });
  await page.waitForFunction(() => document.querySelector(".welcome-line")?.textContent === "scan the code with your phone to pair it.", null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const qr = document.querySelector(".welcome-qr .qr") as HTMLImageElement;
    return /^\/api\/phones\/qr/.test(qr.getAttribute("src") ?? "") && qr.complete && qr.naturalWidth > 0;
  });
  const pairing = (await (await fetch(`${url}/api/phones`)).json()).pairing;
  assert.match(pairing.code, /^[A-Z2-9]{6}$/, "a pairing code is on show");
  assert.equal(await textOf(page, ".qr-label"), `code ${pairing.code}`);

  // A phone pairs with it, and setup moves on to getting ready.
  const paired = await fetch(`http://127.0.0.1:${daemon.lanPort}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code, name: "iphone" }) });
  assert.equal(paired.status, 200);
  await page.waitForFunction(() => document.querySelector(".welcome-line")?.textContent === "iphone is paired.", null, { timeout: 5000 });
  await page.waitForSelector(".ready-list", { timeout: 5000 });
  const setup = (await (await fetch(`${url}/api/setup`)).json()).setup;
  assert.deepEqual([setup.step, setup.keyboard], ["ready", false]);
  await page.close();
});

test("the keyboard's way: Enter with no network lists the Wi-Fi the box saw, and the one picked joins with its password typed on the TV", async () => {
  await fresh();
  online = false;
  hotspotIs({ on: true });
  const page = await tv();
  await page.waitForSelector(".welcome");
  assert.match(await textOf(page, ".enter"), /↵ enter[\s\S]*(use a keyboard instead|carry on)/);
  await page.keyboard.press("Enter");
  await page.waitForSelector("button.network");
  assert.equal(await page.locator(".setup-headline").getAttribute("aria-label"), "pick your wi-fi.");
  assert.deepEqual(await page.locator("button.network").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-ssid"))), ["home wi-fi", "cafe", "neighbours", ""]);
  await page.keyboard.press("Enter");
  await page.waitForSelector('input[type="password"].focused');
  await page.keyboard.type("correct horse");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".welcome");
  assert.deepEqual(JSON.parse(readFileSync(drop(), "utf8")), { join: { ssid: "home wi-fi", password: "correct horse", hidden: false } });
  rmSync(drop());
  // Esc from the list goes back to the welcome screen.
  await page.keyboard.press("Enter");
  await page.waitForSelector("button.network");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".welcome");
  await page.close();
});

test("S5.6 an answer about setup's step that left before Enter moved setup on doesn't take the TV back", async () => {
  await fresh();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: { cmd: string }[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  // The page's first look passes. Each one after it, until Enter, gets the
  // daemon's answer at once and keeps it back: the welcome screen's next
  // look, and the one the event stream asks for as it opens.
  let looks = 0;
  let holding = true;
  const held: (() => Promise<void>)[] = [];
  await page.route("**/api/setup", async (route) => {
    if (route.request().method() !== "GET" || ++looks === 1 || !holding) return route.continue();
    const response = await route.fetch();
    held.push(() => route.fulfill({ response }));
  });
  await page.goto(`${url}/`);
  await page.waitForFunction(() => (window as unknown as { agentvWelcome?: boolean }).agentvWelcome === true);
  while (held.length < 2) await page.waitForTimeout(50);
  holding = false;
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ready-list");
  // Any way back to the welcome screen from here, even for a moment.
  await page.evaluate(() => {
    const w = window as unknown as { wentBack: boolean };
    w.wentBack = false;
    new MutationObserver(() => {
      if (document.querySelector(".welcome")) w.wentBack = true;
    }).observe(document.getElementById("page")!, { childList: true });
  });
  for (const answer of held) await answer();
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => (window as unknown as { wentBack: boolean }).wentBack), false, "the old answers don't take the TV back to the welcome screen");
  assert.equal(await page.locator(".ready-list").count(), 1, "still getting ready");
  await requested(page, "update-check");
  await page.close();
});

test("a key held with Super, Ctrl or Alt is a shortcut, not the remote: Omarchy's Super+Return does nothing on the welcome screen", async () => {
  await fresh();
  const page = await tv();
  await page.waitForSelector(".welcome");
  for (const keys of ["Meta+Enter", "Control+Enter", "Alt+Enter"]) await page.keyboard.press(keys);
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".welcome").count(), 1);
  assert.equal((await (await fetch(`${url}/api/setup`)).json()).setup.step, "welcome");
  await page.close();
});

test("S5.6 getting ready asks for the update check, installs the newer release with the TV's own install, and carries on once it's in", async () => {
  await fresh();
  const page = await tv();
  await page.waitForSelector(".welcome");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ready-list");
  assert.equal(await page.locator(".setup-headline").getAttribute("aria-label"), "getting ready.");
  await requested(page, "update-check");
  assert.match(await textOf(page, ".ready-list"), /\[x\] ethernet[\s\S]*\[x\] paired · iphone[\s\S]*\[>\] checking for a newer agentv/);
  assert.match(await textOf(page, ".bar"), /1\/6 getting ready/);

  // Back waits while the box brings itself up to date.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".ready-list").count(), 1);

  writeFileSync(join(updates, "status.json"), JSON.stringify({ checked_at: now(), ok: true, channel: "stable", agentv: { installed: "0.2.1-1", available: "0.3.0-1" }, omarchy: { installed: "4.0.6-1", available: null }, packages: 3, security: false, notes: { agentv: [], agentv_date: null, omarchy: [] } }));
  await requested(page, "update-install");
  const install = await page.evaluate(() => (window as unknown as { screenRequests: { cmd: string; grant?: string }[] }).screenRequests.find((r) => r.cmd === "update-install"));
  assert.equal(install?.grant, "", "a new box has no PIN to ask for");
  writeFileSync(join(updates, "progress.json"), JSON.stringify({ state: "running", step: "packages", percent: 62, detail: "3 of 5", at: now(), from: { agentv: "0.2.1-1", omarchy: "4.0.6-1" }, to: { agentv: "0.3.0-1" } }));
  await page.waitForFunction(() => /\[>\] agentv 0\.2\.1 → 0\.3\.0/.test(document.querySelector(".ready-list")?.textContent ?? ""), null, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector(".blocks")?.getAttribute("aria-label") === "62 percent", null, { timeout: 5000 });

  // The install restarts AgenTV, and the page loads again from the new
  // release: it's still getting ready, and sees the update in.
  await page.reload();
  await page.waitForSelector(".ready-list");
  writeFileSync(join(updates, "progress.json"), JSON.stringify({ state: "done", step: "restart", percent: 100, detail: "", at: now(), from: { agentv: "0.2.1-1", omarchy: "4.0.6-1" }, to: { agentv: "0.3.0-1" } }));
  await page.waitForFunction(() => document.querySelector(".ready-line")?.textContent === "up to date. on we go.", null, { timeout: 10_000 });
  assert.match(await textOf(page, ".ready-list"), /\[x\] agentv 0\.3\.0/);
  // Then on, by itself.
  await page.waitForSelector(".goals", { timeout: 5000 });
  const setup = (await (await fetch(`${url}/api/setup`)).json()).setup;
  assert.deepEqual([setup.step, setup.ready.update, setup.ready.from, setup.ready.to], ["goal", "done", "0.2.1-1", "0.3.0-1"]);
  await page.close();
});

test("S5.6 getting ready that loads again with the update in already moves on by itself, as on the box after AgenTV restarts", async () => {
  await fresh();
  await post("/api/setup/finish", { step: "welcome" });
  // The page before the restart saw the update in and said so, then went.
  await post("/api/setup/ready", { update: "checking" });
  await post("/api/setup/ready", { update: "done", from: "0.2.1-1", to: "0.3.0-1" });
  const page = await tv();
  await page.waitForFunction(() => document.querySelector(".ready-line")?.textContent === "up to date. on we go.", null, { timeout: 10_000 });
  await page.waitForSelector(".goals", { timeout: 5000 });
  await page.close();
});

test("getting ready carries on with the version it has when there's nothing newer, and when the check doesn't work", async () => {
  await fresh();
  const page = await tv();
  await page.keyboard.press("Enter");
  await requested(page, "update-check");
  writeFileSync(join(updates, "status.json"), JSON.stringify({ checked_at: now(), ok: true, channel: "stable", waiting: true, agentv: { installed: "0.2.1-1", available: "0.3.0-1" }, omarchy: { installed: "4.0.6-1", available: null }, packages: 0, security: false, notes: { agentv: [], agentv_date: null, omarchy: [] } }));
  await page.waitForFunction(() => document.querySelector(".ready-line")?.textContent === "already up to date.", null, { timeout: 10_000 });
  assert.match(await textOf(page, ".ready-list"), /\[x\] agentv 0\.2\.1 · up to date/, "an update the nightly run hasn't passed waits");
  await page.waitForSelector(".goals", { timeout: 5000 });
  await page.close();

  await fresh();
  const again = await tv();
  await again.keyboard.press("Enter");
  await requested(again, "update-check");
  writeFileSync(join(updates, "status.json"), JSON.stringify({ checked_at: now(), ok: false, channel: "stable", agentv: { installed: "0.2.1-1", available: null }, omarchy: { installed: null, available: null }, packages: 0, security: false, notes: { agentv: [], agentv_date: null, omarchy: [] } }));
  await again.waitForFunction(() => /couldn't update/.test(document.querySelector(".ready-line")?.textContent ?? ""), null, { timeout: 10_000 });
  assert.match(await textOf(again, ".ready-list"), /\[!\] agentv 0\.2\.1 · couldn't update/);
  // Enter carries on at once.
  await again.keyboard.press("Enter");
  await again.waitForSelector(".goals", { timeout: 5000 });
  await again.close();
});

test("S5.6 setup picks up at the same step after the page loads again, as after a restart", async () => {
  await fresh();
  await post("/api/setup/finish", { step: "welcome" });
  await post("/api/setup/ready", { update: "none" });
  await post("/api/setup/finish", { step: "ready" });
  const page = await tv();
  await page.waitForSelector(".goals");
  await page.reload();
  await page.waitForSelector(".goals");
  assert.equal((await (await fetch(`${url}/health`)).json()).setup_step, "goal");
  // Back goes to getting ready, which is finished, and it stays there:
  // continue goes on.
  await page.keyboard.press("Escape");
  await page.waitForSelector(".ready-list");
  await page.waitForTimeout(3000);
  assert.equal(await page.locator(".goals").count(), 0, "back to getting ready later doesn't move on by itself");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".goals");
  await page.close();
});

test("what the tv is for: OK on one picks it, setup is done, and home takes over", async () => {
  await fresh();
  await post("/api/setup/finish", { step: "welcome" });
  await post("/api/setup/ready", { update: "none" });
  await post("/api/setup/finish", { step: "ready" });
  const page = await tv();
  await page.waitForSelector(".goals");
  assert.equal(await page.locator(".setup-headline").getAttribute("aria-label"), "pick one.");
  assert.deepEqual(await page.locator(".goal .goal-name").allInnerTexts(), ["streaming", "music", "photos", "gaming"]);
  assert.equal(await page.locator(".goal.focused").getAttribute("data-goal"), "streaming");
  assert.match(await textOf(page, ".bar"), /4\/6 goal[\s\S]*←↑↓→ move · ↵ pick/);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator(".goal.focused").getAttribute("data-goal"), "gaming");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".grid .tile", { timeout: 10_000 });
  const setup = (await (await fetch(`${url}/api/setup`)).json()).setup;
  assert.deepEqual([setup.done, setup.goal], [true, "gaming"]);
  await page.close();
});

test("setup's motion only moves transform and opacity, headings type out, and reduce motion makes them fades (ADR-024)", async () => {
  const check = (page: Page) =>
    page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll("*")) {
        const style = getComputedStyle(el);
        const durations = style.transitionDuration.split(",");
        style.transitionProperty.split(",").forEach((property, i) => {
          const p = property.trim();
          if (!["transform", "opacity", "none"].includes(p) && parseFloat(durations[i] ?? durations[0]) > 0) bad.push(`${el.tagName}.${el.className}: ${p}`);
        });
      }
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSKeyframesRule) {
            for (const frame of rule.cssRules) {
              const style = (frame as CSSKeyframeRule).style;
              for (let i = 0; i < style.length; i++) if (!["transform", "opacity"].includes(style[i])) bad.push(`@keyframes ${rule.name}: ${style[i]}`);
            }
          }
        }
      }
      return bad;
    });
  await fresh();
  const page = await tv();
  await page.waitForSelector(".welcome");
  assert.deepEqual(await check(page), []);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ready-list");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".setup-screen")!).animationName), "page-forward");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".setup-screen")!).animationDuration), "0.32s", "setup's steps take the slow token");
  assert.deepEqual(await check(page), []);
  // The heading types out: part of it is still to come right after it shows.
  await post("/api/setup/ready", { update: "none" });
  await post("/api/setup/finish", { step: "ready" });
  await page.waitForSelector(".goals");
  await page.waitForFunction(() => document.querySelector(".setup-headline")?.textContent === "pick one.", null, { timeout: 2000 });
  assert.deepEqual(await check(page), []);
  await page.close();

  await fresh();
  const still = await tv({ reducedMotion: "reduce" });
  await still.waitForSelector(".welcome");
  await still.keyboard.press("Enter");
  await still.waitForSelector(".ready-list");
  assert.equal(await still.evaluate(() => getComputedStyle(document.querySelector(".setup-screen")!).animationName), "fade-in");
  assert.equal(await still.evaluate(() => document.querySelector(".setup-headline")?.textContent), "getting ready.", "no typing");
  await still.close();
  await post("/api/setup", { done: true });
});

test("the phone's remote says which setup step the TV is on", async () => {
  await fresh();
  await post("/api/setup/finish", { step: "welcome" });
  const code = (await (await post("/api/phones/pair", {})).json()).pairing.code;
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  phone.on("pageerror", (error) => errors.push(error.message));
  await phone.goto(`http://127.0.0.1:${daemon.lanPort}/?code=${code}`);
  await phone.waitForSelector(".setup-step");
  assert.equal(await phone.locator(".setup-step").innerText(), "tv setup · 1/6 getting ready");
  await post("/api/setup", { done: true });
  await phone.waitForFunction(() => !document.querySelector(".setup-step"), null, { timeout: 30_000 });
  await phone.close();
});
