// The adult PIN on the TV in a real Chromium (ADR-019, layer 4; ADR-009,
// S4.5): Settings → Adult PIN sets it on its pad, chosen twice, from the
// arrows or number keys; each adult action asks for it and is refused
// without it; the TV locked shows only the pad; and agentv-pin-check's ask
// on the TV hands back a grant. What the screen daemon and the daemon refuse
// on their own is layer 2's.

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
const PIN = "4826";

before(async () => {
  ({ daemon, url } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

type Request = { cmd: string; what?: string; grant?: string };

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
  return page;
}

async function home(page: Page): Promise<void> {
  await page.waitForSelector(".grid .tile.focused");
}

// The PIN set or taken off from the side, as the phone will.
function setPin(): void {
  if (daemon.pin.status().set) return;
  assert.equal(daemon.pin.set(PIN, undefined), null);
}
function removePin(): void {
  if (!daemon.pin.status().set) return;
  const checked = daemon.pin.check(PIN);
  assert.ok(checked.ok);
  assert.equal(daemon.pin.remove(checked.grant), null);
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const sent = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { screenRequests: Request[] }).screenRequests.filter((r) => r.cmd === c), cmd);
const focused = (page: Page) => page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action") ?? document.querySelector(".focused")?.getAttribute("data-key"));
const padUp = (page: Page) => page.evaluate(() => document.getElementById("pin")?.classList.contains("on") === true);
const padText = (page: Page) => page.locator("#pin").innerText();
const filled = (page: Page) => page.locator("#pin .pin-box.filled").count();

async function waitPad(page: Page, up: boolean): Promise<void> {
  await page.waitForFunction((want) => document.getElementById("pin")?.classList.contains("on") === want, up);
}

async function type(page: Page, digits: string): Promise<void> {
  for (const digit of digits) await page.keyboard.press(digit);
}

test("S4.5 Settings → Adult PIN sets a PIN on its pad, chosen twice, with the arrows or number keys", async () => {
  removePin();
  const page = await tv();
  await home(page);
  await go(page, "settings/pin");
  await page.waitForSelector('.menu-item.open[data-key="pin"]');
  assert.match(await page.locator('.menu-item[data-key="pin"]').innerText(), /adult pin\s+off/);
  assert.match(await page.locator(".panel").innerText(), /off[\s\S]*a child's profile needs one/);
  await page.keyboard.press("Enter");
  assert.equal(await focused(page), "set-pin");
  await page.keyboard.press("Enter");
  await waitPad(page, true);
  assert.match(await padText(page), /tv settings · pin[\s\S]*set an adult pin[\s\S]*4 digits, for settings, builds and the desktop/);
  assert.equal(await focused(page), "1", "the pad starts on 1");

  // The remote's arrows and OK: 4 is under 1.
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(page), "4");
  await page.keyboard.press("Enter");
  assert.equal(await filled(page), 1);
  // Number keys type it, and Backspace takes one off rather than going back.
  await type(page, "8");
  await page.keyboard.press("Backspace");
  assert.equal(await filled(page), 1);
  assert.equal(await padUp(page), true);
  await type(page, "826");
  // The second pad: a different PIN is refused and cleared, the same one is
  // kept.
  await page.waitForFunction(() => /the same pin again/.test(document.getElementById("pin")?.textContent ?? ""));
  assert.equal(await filled(page), 0);
  await type(page, "4827");
  await page.waitForFunction(() => /that's not the same pin\./.test(document.getElementById("pin")?.textContent ?? ""));
  assert.equal(await filled(page), 0);
  assert.equal(daemon.pin.status().set, false);
  await type(page, PIN);
  await waitPad(page, false);
  assert.equal(daemon.pin.status().set, true);
  await page.waitForFunction(() => /adult pin\s*on/.test(document.querySelector('.menu-item[data-key="pin"]')?.textContent ?? ""));
  assert.match(await page.locator(".toast").last().innerText(), /the pin is set/);
  assert.match(await page.locator('.menu-item[data-key="desktop"]').innerText(), /omarchy desktop\s+\[pin\]/);
  await page.close();
});

test("S4.5 each adult action asks for the PIN on its pad, and nothing goes without it", async () => {
  setPin();
  const page = await tv();
  await home(page);
  // Omarchy's desktop: Back cancels the pad, and nothing is asked of the TV.
  await go(page, "settings/desktop");
  await page.waitForSelector('.menu-item.open[data-key="desktop"]');
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await waitPad(page, true);
  assert.match(await padText(page), /enter the adult pin[\s\S]*for omarchy's desktop\./);
  await page.keyboard.press("Escape");
  await waitPad(page, false);
  assert.deepEqual(await sent(page, "desktop"), []);
  assert.equal(await focused(page), "desktop", "the focus is back where it was");

  // A wrong PIN says so and stays; the right one goes ahead with its grant.
  await page.keyboard.press("Enter");
  await waitPad(page, true);
  await type(page, "0000");
  await page.waitForFunction(() => /that's not the pin\./.test(document.getElementById("pin")?.textContent ?? ""));
  assert.equal(await padUp(page), true);
  await type(page, PIN);
  await waitPad(page, false);
  const [desktop] = await sent(page, "desktop");
  assert.ok(desktop?.grant && daemon.pin.allows(desktop.grant), "the desktop gets a grant the daemon gave");

  // The rest of this visit to Settings uses the same grant: Power doesn't
  // ask again.
  await go(page, "settings/power");
  await page.waitForSelector('.menu-item.open[data-key="power"]');
  assert.match(await page.locator('.menu-item[data-key="power"]').innerText(), /power\s+\[pin\]/);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".page.power");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as unknown as { screenRequests: Request[] }).screenRequests.some((r) => r.cmd === "power"));
  assert.equal((await sent(page, "power"))[0].grant, desktop.grant);

  // Home ends the visit: Settings asks again next time.
  await page.keyboard.press("Home");
  await home(page);
  await go(page, "settings/desktop");
  await page.waitForSelector('.panel [data-action="desktop"]');
  await page.locator('.panel [data-action="desktop"]').click();
  await waitPad(page, true);
  await page.keyboard.press("Escape");
  await waitPad(page, false);
  assert.equal((await sent(page, "desktop")).length, 1);
  await page.close();
});

test("S4.5 the TV locked shows only the pad until the PIN, from Settings → Adult PIN and at start", async () => {
  setPin();
  const page = await tv();
  await home(page);
  await go(page, "settings/pin");
  await page.waitForSelector('.panel [data-action="lock"]');
  await page.locator('.panel [data-action="lock"]').click();
  await waitPad(page, true);
  assert.match(await padText(page), /tv locked[\s\S]*enter the adult pin[\s\S]*the tv is locked\./);
  // Back and Home don't get past it.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Home");
  assert.equal(await padUp(page), true);
  assert.equal(daemon.pin.status().locked, true);

  // A page loaded while it's locked starts on the pad.
  const fresh = await tv();
  await waitPad(fresh, true);
  await type(fresh, PIN);
  await waitPad(fresh, false);
  await home(fresh);
  assert.equal(daemon.pin.status().locked, false);
  // The other TV page hears it's unlocked, and its pad goes.
  await waitPad(page, false);
  await fresh.close();
  await page.close();
});

test("S4.5 agentv-pin-check's ask on the TV brings up the pad each time, and its grant is for that action alone", async () => {
  setPin();
  const page = await tv();
  await home(page);
  const ask = (action: string) => page.evaluate((a) => (window as unknown as { agentvLauncher: { askPin(action: string): Promise<{ grant: string | null }> } }).agentvLauncher.askPin(a), action);
  const asked = ask("desktop");
  await waitPad(page, true);
  assert.match(await padText(page), /for omarchy's desktop\./);
  await type(page, PIN);
  const { grant } = await asked;
  assert.ok(grant && daemon.pin.allows(grant));
  // Asked again, it asks again.
  const again = ask("power");
  await waitPad(page, true);
  assert.match(await padText(page), /for restarting or shutting down\./);
  await page.keyboard.press("Escape");
  assert.equal((await again).grant, null);
  // Nor does it stand in for Settings: Omarchy's desktop there asks.
  await go(page, "settings/desktop");
  await page.waitForSelector('.panel [data-action="desktop"]');
  await page.locator('.panel [data-action="desktop"]').click();
  await waitPad(page, true);
  await page.keyboard.press("Escape");
  await waitPad(page, false);
  assert.deepEqual(await sent(page, "desktop"), []);

  // Asked while the TV is locked, the lock comes first, then the ask: the
  // PIN that unlocks the TV doesn't also open the desktop.
  await page.keyboard.press("Home");
  await fetch(`${url}/api/pin/lock`, { method: "POST" });
  await page.waitForFunction(() => /tv locked/.test(document.getElementById("pin")?.textContent ?? ""));
  const locked = ask("desktop");
  await type(page, PIN);
  await page.waitForFunction(() => /for omarchy's desktop\./.test(document.getElementById("pin")?.textContent ?? ""));
  await type(page, PIN);
  const unlocked = await locked;
  assert.ok(unlocked.grant && daemon.pin.allows(unlocked.grant));
  await page.close();
});

test("S4.5 changing the PIN needs the one before, and so does taking it off", async () => {
  setPin();
  const page = await tv();
  await home(page);
  await go(page, "settings/pin");
  await page.waitForSelector('.panel [data-action="set-pin"]');
  assert.match(await page.locator(".panel").innerText(), /on[\s\S]*change the pin →[\s\S]*lock the tv now[\s\S]*take the pin off/);
  await page.locator('.panel [data-action="set-pin"]').click();
  await waitPad(page, true);
  assert.match(await padText(page), /for changing the pin\./);
  await type(page, PIN);
  await page.waitForFunction(() => /choose a new pin/.test(document.getElementById("pin")?.textContent ?? ""));
  await type(page, "1357");
  await page.waitForFunction(() => /the same pin again/.test(document.getElementById("pin")?.textContent ?? ""));
  await type(page, "1357");
  await waitPad(page, false);
  assert.equal(daemon.pin.check(PIN).ok, false);
  assert.equal(daemon.pin.check("1357").ok, true);

  // Taking it off, in a new visit, asks for the new one.
  await page.keyboard.press("Home");
  await home(page);
  await go(page, "settings/pin");
  await page.waitForSelector('.panel [data-action="remove-pin"]');
  await page.locator('.panel [data-action="remove-pin"]').click();
  await waitPad(page, true);
  await type(page, "1357");
  await waitPad(page, false);
  await page.waitForFunction(() => /adult pin\s*off/.test(document.querySelector('.menu-item[data-key="pin"]')?.textContent ?? ""));
  assert.equal(daemon.pin.status().set, false);
  await page.close();
});
