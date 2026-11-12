// The desktop's first password on the TV, in a real Chromium, with setup's
// own switch on. A box set up from the USB stick has no password anyone
// knows, so the first switch to Omarchy's desktop from Settings asks for
// one, typed twice on the phone's keyboard into password fields, past the
// PIN, and then switches. After that, it changes on the desktop. The test
// plays root's part on the password's socket, as the box plays it for keys:
// it takes the line, marks the account note and says it's set.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
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
let state = "";
let rootSide: Server;
const errors: string[] = [];
const handed: { password: string; grant: string }[] = [];
const PIN = "4826";
// A throwaway password, made up here.
const PASSWORD = `tv test ${process.pid}`;

type Request = { cmd: string; grant?: string };

const marker = () => join(state, "..", "account.json");
const note = (known: boolean) => writeFileSync(marker(), JSON.stringify({ name: "agentv", passwordKnown: known }) + "\n");
const switchOn = (on: boolean) => writeFileSync(join(state, "features.json"), JSON.stringify({ setup2: on }));

before(async () => {
  ({ daemon, url, state } = await startBox(0, undefined, { features: { setup2: true } }));
  mkdirSync(join(state, ".."), { recursive: true });
  rootSide = createServer((connection) => {
    let line = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      line += chunk;
      if (!line.includes("\n")) return;
      handed.push(JSON.parse(line));
      note(true);
      connection.end('{"ok":true}\n');
    });
  });
  await new Promise<void>((done) => rootSide.listen(join(state, "..", "password.sock"), done));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  rootSide?.close();
  await daemon?.close();
  rmSync(join(state, "features.json"), { force: true });
  assert.deepEqual(errors, []);
});

// A TV whose screen daemon answers every request with ok and remembers it.
async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
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
  await page.waitForFunction(() => (window as unknown as { agentvLauncher?: unknown }).agentvLauncher !== undefined);
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const sent = (page: Page) => page.evaluate(() => (window as unknown as { screenRequests: Request[] }).screenRequests.filter((r) => r.cmd === "desktop"));
const lastToast = (text: RegExp) => (page: Page) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector(".toast:last-of-type")?.textContent ?? ""), text.source);

// Settings → Omarchy desktop, once the panel knows about the password.
async function desktopPanel(page: Page, line: RegExp | null): Promise<void> {
  await go(page, "settings/desktop");
  await page.waitForSelector('.settings-panel[data-page="desktop"]');
  await page.waitForSelector('[data-action="desktop"]');
  if (line) {
    await page.waitForSelector('[data-note="desktop-password"]');
    assert.match(await page.locator('[data-note="desktop-password"]').innerText(), line);
  } else {
    // Long enough for the ask to have come back.
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-note="desktop-password"]').count(), 0);
    // The page's one line is then how to come back.
    assert.equal(await page.locator(".settings-panel .panel-note").innerText(), "super + ctrl + home brings you back");
  }
  assert.equal(await page.locator(".settings-panel .panel-note").count(), 1, "one line, and only one");
}

test("Q225 the first switch to Omarchy's desktop asks for a password, typed twice, sets it, then switches", async () => {
  switchOn(true);
  note(false);
  handed.length = 0;
  const page = await tv();
  try {
    await desktopPanel(page, /^the first time, you set a password on your phone$/);
    await page.locator('[data-action="desktop"]').click();
    await page.waitForSelector(".desktop-password");
    assert.deepEqual(await sent(page), [], "nothing switches before the password");
    assert.equal(await page.locator('.desktop-password input[type="password"]').count(), 2, "two password fields, which the phone keeps to itself");
    assert.equal(await page.locator(".focused").getAttribute("data-action"), "password");

    // Two that don't match, and one that's too short, go nowhere.
    await page.fill('[data-action="password"]', PASSWORD);
    await page.fill('[data-action="password-again"]', `${PASSWORD}!`);
    await page.locator('[data-action="set-password"]').click();
    await lastToast(/Those don't match/)(page);
    await page.fill('[data-action="password"]', "short");
    await page.fill('[data-action="password-again"]', "short");
    await page.locator('[data-action="set-password"]').click();
    await lastToast(/8 characters or more/)(page);
    assert.equal(handed.length, 0);

    // The same twice: with no PIN, it goes to root as it is, then the TV
    // switches.
    await page.fill('[data-action="password"]', PASSWORD);
    await page.fill('[data-action="password-again"]', PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as { screenRequests: Request[] }).screenRequests.some((r) => r.cmd === "desktop"));
    assert.deepEqual(handed, [{ password: PASSWORD, grant: "" }]);
    assert.equal((await sent(page)).length, 1);
  } finally {
    await page.close();
  }

  // The next switch goes straight there, and the page no longer says a
  // password comes first.
  const again = await tv();
  try {
    await desktopPanel(again, null);
    await again.locator('[data-action="desktop"]').click();
    await again.waitForFunction(() => (window as unknown as { screenRequests: Request[] }).screenRequests.some((r) => r.cmd === "desktop"));
    assert.equal(await again.locator(".desktop-password").count(), 0);
    assert.equal(handed.length, 1, "nothing more for root");
  } finally {
    await again.close();
  }
});

test("Q225 with the adult PIN on, setting it asks for the PIN, and root and the switch get the grant", async () => {
  switchOn(true);
  note(false);
  handed.length = 0;
  assert.equal(daemon.pin.set(PIN, undefined), null);
  const page = await tv();
  try {
    await desktopPanel(page, /the first time/);
    await page.locator('[data-action="desktop"]').click();
    await page.waitForSelector(".desktop-password");
    await page.fill('[data-action="password"]', PASSWORD);
    await page.fill('[data-action="password-again"]', PASSWORD);
    await page.locator('[data-action="set-password"]').click();
    await page.waitForFunction(() => document.getElementById("pin")?.classList.contains("on") === true);
    assert.equal(handed.length, 0, "nothing goes before the PIN");
    for (const digit of PIN) await page.keyboard.press(digit);
    await page.waitForFunction(() => (window as unknown as { screenRequests: Request[] }).screenRequests.some((r) => r.cmd === "desktop"));
    assert.equal(handed.length, 1);
    assert.ok(daemon.pin.allows(handed[0].grant), "root gets a grant the daemon allows");
    assert.equal((await sent(page))[0].grant, handed[0].grant, "and the switch goes with the same one");
  } finally {
    await page.close();
    const checked = daemon.pin.check(PIN);
    assert.ok(checked.ok);
    assert.equal(daemon.pin.remove((checked as { grant: string }).grant), null);
  }
});

test("with setup's own switch off, or on a box installed through Omarchy's installer, the switch goes straight there", async () => {
  for (const [on, noted] of [
    [false, true],
    [true, false],
  ]) {
    switchOn(on);
    if (noted) note(false);
    else rmSync(marker(), { force: true });
    handed.length = 0;
    const page = await tv();
    try {
      await desktopPanel(page, null);
      await page.locator('[data-action="desktop"]').click();
      await page.waitForFunction(() => (window as unknown as { screenRequests: Request[] }).screenRequests.some((r) => r.cmd === "desktop"));
      assert.equal(await page.locator(".desktop-password").count(), 0, `switch ${on ? "on" : "off"}, note ${noted ? "there" : "not there"}`);
      assert.equal(handed.length, 0);
    } finally {
      await page.close();
    }
  }
});
