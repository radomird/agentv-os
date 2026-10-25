// The setup hotspot in a real Chromium (ADR-019, layer 4; stage 4): the
// captive page at 390 × 844, as a phone that joined the hotspot opens it,
// picking the home Wi-Fi and typing its password, or a network that hides
// its name, and coming back to the reason when the password was wrong; and
// the welcome screen at 1920 × 1080, with the hotspot's QR code while it's
// on and the code that pairs the phone once the box is on the home Wi-Fi.
// The radio, NetworkManager, dnsmasq and the firewall are the image layer's
// and the NUC's.

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const errors: string[] = [];

before(async () => {
  ({ daemon, url, state, hotspot } = await startBox());
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

test("stage 4 the welcome screen shows the hotspot's QR code, then the code that pairs the phone on the home Wi-Fi", async () => {
  await fetch(`${url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: false }) });
  hotspotIs({ on: false, ssid: null, password: null });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  await page.waitForFunction(() => (window as unknown as { agentvWelcome?: boolean }).agentvWelcome === true);
  assert.equal(await page.locator("#line").innerText(), "TV setup starts here. It isn't built yet.", "with no hotspot, the welcome screen is as it was");
  assert.equal(await page.locator("#qr").isVisible(), false);

  hotspotIs({ on: true });
  await page.waitForFunction(() => /join AgenTV-3f9a with the password k7m2xpqr4n/.test(document.getElementById("line")?.textContent ?? ""), null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const qr = document.getElementById("qr") as HTMLImageElement;
    return !qr.hidden && qr.complete && qr.naturalWidth > 0;
  });
  assert.match((await page.locator("#qr").getAttribute("src")) ?? "", /^\/api\/hotspot\/qr/);

  hotspotIs({ on: false, joining: "home wi-fi" });
  await page.waitForFunction(() => document.getElementById("line")?.textContent === "Joining home wi-fi.", null, { timeout: 5000 });
  assert.equal(await page.locator("#qr").isVisible(), false);

  hotspotIs({ on: false, joined: { ssid: "home wi-fi", address: "127.0.0.1" } });
  await page.waitForFunction(() => /The TV is on home wi-fi\. Scan this with your phone to pair it\./.test(document.getElementById("line")?.textContent ?? ""), null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const qr = document.getElementById("qr") as HTMLImageElement;
    return !qr.hidden && /^\/api\/phones\/qr/.test(qr.getAttribute("src") ?? "") && qr.complete && qr.naturalWidth > 0;
  });
  const pairing = (await (await fetch(`${url}/api/phones`)).json()).pairing;
  assert.match(pairing.code, /^[A-Z2-9]{6}$/, "a pairing code is on show");

  // A phone pairs with it.
  const paired = await fetch(`http://127.0.0.1:${daemon.lanPort}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code, name: "iphone" }) });
  assert.equal(paired.status, 200);
  await page.waitForFunction(() => document.getElementById("line")?.textContent === "iphone is paired.", null, { timeout: 5000 });
  await page.close();
  await fetch(`${url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: true }) });
});
