// Holding OK opens details (ADR-084, track 16's T16.1), in a real Chromium
// (ADR-019, layer 4), on the daemon itself, with every switch on, as it
// ships. The TV is the launcher at 1920 × 1080 and the phone is the remote at
// 375 × 812. The screen daemon's end of the phone's stream is its own code
// (daemon/remote.ts), and where the box has the virtual input device, here
// each request presses the same real keys on the TV's page: a tap is Enter
// down and up at once, and a hold keeps it down for as long as it says.
//
// - a short OK on a tile opens the app, as the key comes up;
// - a held one opens the app's details, once, and never the app, in each
//   look's home and in Apps, from a keyboard and from the phone's remote;
// - OK anywhere else still acts as the key goes down, and once, however
//   long it's held;
// - a gamepad's Y still opens details;
// - details has Quit only while the app is open, and no tile names a key
//   for it.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { RemoteInput } from "../../../daemon/remote.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { rest, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
type Look = (typeof LOOKS)[number];
const KEY_NAMES: Record<string, string> = { i: "i", enter: "Enter", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", back: "Escape", home: "Home" };
// An app on every look's home, and one that's only in Apps.
const APP = "agentv.tube";

const dir = mkdtempSync(join(tmpdir(), "agentv-hold-ok-ui-"));
let browser: Browser;
let daemon: Daemon;
let input: RemoteInput;
let url = "";
let appsDir = "";
// The TV's page the phone's keys go to, and what the phone sent.
let screen: Page | null = null;
const sent: Record<string, unknown>[] = [];
const errors: string[] = [];

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until(check: () => Promise<boolean> | boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("it didn't happen in time");
    await sleep(20);
  }
}

// What the virtual input device does with a request (daemon/input.py), on
// the TV's page: a key is down and up at once, a hold stays down.
async function press(request: Record<string, unknown>): Promise<void> {
  sent.push(request);
  const name = KEY_NAMES[String(request.key ?? request.hold)];
  if (!screen || !name) return;
  await screen.keyboard.down(name);
  if (request.hold) {
    const ms = Number(request.ms);
    // A held key repeats, as it does from a real one.
    for (let waited = 0; waited < ms; waited += 100) {
      await sleep(Math.min(100, ms - waited));
      if (waited + 100 < ms) await screen.keyboard.down(name);
    }
  }
  await screen.keyboard.up(name);
}

before(async () => {
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  process.env.AGENTV_PASSWD = passwd;
  ({ daemon, url, apps: appsDir } = await startBox());
  // A page app, as an app or a game made on this TV is: a page in home's
  // own window.
  cpSync(join(import.meta.dirname, "../fixtures/apps/blocks"), join(appsDir, "agentv.blocks"), { recursive: true });
  const installed = JSON.parse(readFileSync(join(appsDir, "installed.json"), "utf8"));
  installed["agentv.blocks"] = { id: "agentv.blocks", name: "Blocks", version: "1.0.0", tier: "official", installedAt: "2026-10-27T12:00:00Z" };
  writeFileSync(join(appsDir, "installed.json"), JSON.stringify(installed, null, 2));
  await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "field" }) });
  input = new RemoteInput({ url: `${url}/api/remote`, send: press, log: () => {} });
  input.start();
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  input?.stop();
  await browser?.close();
  await daemon?.close();
  delete process.env.AGENTV_PASSWD;
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

async function useLook(look: Look): Promise<void> {
  const response = await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
  assert.equal(response.status, 200);
}

interface Tv {
  screenRequests: { cmd: string; app?: string }[];
  running: object[];
  pads: object[];
  agentvRunning(json: string): void;
  agentvLauncher: { go(route: string): void };
}

// The TV, with the screen daemon's binding stood in for: it keeps what was
// asked, and says which apps are open behind home.
async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: unknown[]; running: object[]; pads: object[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.running = [];
    w.pads = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify(request.cmd === "running" ? { ok: true, apps: w.running } : { ok: true })), 0);
    };
    // A gamepad, once a test puts one in.
    navigator.getGamepads = () => w.pads as unknown as Gamepad[];
  });
  await page.goto(`${url}/`);
  await page.waitForSelector("html[data-look] #page .focused");
  await rest(page);
  screen = page;
  return page;
}

const asked = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as Tv).screenRequests.filter((r) => r.cmd === c).map((r) => r.app), cmd);
const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as Tv).agentvLauncher.go(r), route);
const onDetails = (page: Page, id = APP) => page.waitForSelector(`.details-head`, { timeout: 3000 }).then(async () => assert.ok(await page.locator(".details .actions .button.focused").count(), `details of ${id} has the focus`));
// The mouse puts the focus on it. It leaves first, since a mouse that's
// already there doesn't move.
const focusOn = async (page: Page, selector: string) => {
  await page.waitForSelector(selector);
  await rest(page);
  await page.locator(selector).first().hover();
  await page.waitForSelector(`${selector}.focused`);
};

// Enter down, its repeats, and up after ms, as a keyboard or a USB remote
// sends a held key.
async function holdEnter(page: Page, ms: number, key = "Enter"): Promise<void> {
  await page.keyboard.down(key);
  for (let waited = 100; waited < ms; waited += 100) {
    await sleep(100);
    await page.keyboard.down(key);
  }
  await sleep(100);
  await page.keyboard.up(key);
}

// A paired phone with the d-pad on, which has the remote's OK button. Its
// buzz is kept, since a headless phone has none.
async function phone(dpad = true): Promise<Page> {
  await fetch(`${url}/api/phones/pair`, { method: "POST" });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  await page.addInitScript((on) => {
    if (on) localStorage.setItem("agentv-phone-dpad", "on");
    const w = window as unknown as { buzzed: unknown[] };
    w.buzzed = [];
    navigator.vibrate = (pattern) => {
      w.buzzed.push(pattern);
      return true;
    };
  }, dpad);
  await page.goto(`http://127.0.0.1:${daemon.lanPort}/#pair=${daemon.phones.secret()}`);
  await page.waitForSelector(dpad ? '.r2 [data-key="enter"]' : '.r2-surface[data-action="surface"]');
  return page;
}

// A finger on the phone's OK for ms, as real touches.
async function touchOk(hand: Page, ms: number): Promise<void> {
  const box = (await hand.locator('.r2 [data-key="enter"]').boundingBox())!;
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const cdp = await hand.context().newCDPSession(hand);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await sleep(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

for (const look of LOOKS) {
  test(`T16.1 in ${look}, a short OK on a tile opens the app, and holding OK opens its details, from a keyboard and from the phone's remote`, async () => {
    await useLook(look);
    const page = await tv();
    const tile = `#page [data-id="${APP}"]`;
    await focusOn(page, tile);

    // A short press: nothing as the key goes down, the app as it comes up.
    await page.keyboard.down("Enter");
    await sleep(150);
    assert.deepEqual(await asked(page, "open-app"), [], "a tile waits for the key to come up");
    await page.keyboard.up("Enter");
    await until(async () => (await asked(page, "open-app")).length === 1);
    assert.deepEqual(await asked(page, "open-app"), [APP]);
    assert.equal(await page.locator(".details-head").count(), 0);

    // Held, with the key's repeats: its details once the hold lands, while
    // the key is still down, and the app doesn't open, then or on the
    // release, though details opens with the focus on Open.
    await page.keyboard.down("Enter");
    for (let i = 0; i < 6; i++) {
      await sleep(100);
      await page.keyboard.down("Enter");
    }
    await onDetails(page);
    for (let i = 0; i < 3; i++) {
      await sleep(50);
      await page.keyboard.down("Enter");
    }
    await page.keyboard.up("Enter");
    await sleep(200);
    assert.deepEqual(await asked(page, "open-app"), [APP], "the hold opened nothing");
    assert.equal(await page.locator(".details-head").count(), 1);
    // The next press is a press again: OK on details' first button opens.
    await page.keyboard.press("Enter");
    await until(async () => (await asked(page, "open-app")).length === 2);

    // The number pad's Enter, as some remotes send, holds the same.
    await page.keyboard.press("Escape");
    await focusOn(page, tile);
    await holdEnter(page, 700, "NumpadEnter");
    await onDetails(page);
    await page.keyboard.press("Escape");
    await focusOn(page, tile);

    // The phone's remote. A tap on OK opens the app.
    const hand = await phone();
    const before = (await asked(page, "open-app")).length;
    sent.length = 0;
    await touchOk(hand, 80);
    await until(async () => (await asked(page, "open-app")).length === before + 1);
    assert.deepEqual(sent, [{ key: "enter" }]);
    assert.equal(await page.locator(".details-head").count(), 0);

    // A finger held on OK: the phone ticks as the hold lands and asks for
    // details, the TV opens them, and nothing more is sent as the finger
    // lifts. The phone knows from the TV that a tile has the focus.
    await until(async () => (await hand.locator(".r2-ok").count()) === 1 && (daemon as unknown as { tv: { details: boolean } }).tv.details);
    sent.length = 0;
    await hand.evaluate(() => ((window as unknown as { buzzed: unknown[] }).buzzed.length = 0));
    await touchOk(hand, 900);
    await onDetails(page);
    await until(() => sent.length === 1);
    assert.deepEqual(sent, [{ key: "i" }]);
    assert.deepEqual(await hand.evaluate(() => (window as unknown as { buzzed: unknown[] }).buzzed), [10, 20], "the press's own buzz, then one tick as the hold lands");
    await sleep(300);
    assert.equal(sent.length, 1);
    assert.equal((await asked(page, "open-app")).length, before + 1, "the hold opened nothing");
    assert.equal(await page.locator(".details-head").count(), 1);
    await hand.close();
    await page.close();
  });
}

test("T16.1 holding OK on an app in Apps opens its details, and OK anywhere else still acts as the key goes down", async () => {
  await useLook("glass");
  const page = await tv();
  await go(page, "apps");
  await page.waitForSelector(".apps-page");
  const tile = `.apps-page [data-id="${APP}"]`;
  await focusOn(page, tile);
  await holdEnter(page, 700);
  await onDetails(page);
  assert.deepEqual(await asked(page, "open-app"), []);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".apps-page");

  // A tile with no details, a button and the bar: down is enough.
  await focusOn(page, '.apps-page [data-action="add-app"]');
  await page.keyboard.down("Enter");
  await page.waitForSelector(".apps-page", { state: "detached", timeout: 500 });
  await page.keyboard.up("Enter");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".apps-page");

  await go(page, `details/${APP}`);
  await page.waitForSelector(".details-head");
  await page.keyboard.down("Enter");
  await until(async () => (await asked(page, "open-app")).length === 1, 500);
  await page.keyboard.up("Enter");
  await sleep(100);
  assert.deepEqual(await asked(page, "open-app"), [APP], "the release adds nothing");

  // Editing home, OK picks a tile up at once: a tile has no details there.
  await go(page, "home");
  await page.waitForSelector(`#page [data-id="${APP}"][data-details]`);
  await page.keyboard.press("e");
  await page.waitForSelector(`#page [data-id="${APP}"]:not([data-details])`);
  // The phone hears it too. The TV tells the daemon a moment after the
  // focus moves, and a TV page that loads next only tells it what changed,
  // so a page closed before then would leave the next test's phone thinking
  // a hold opens details.
  await until(() => !(daemon as unknown as { tv: { details: boolean } }).tv.details);
  await page.close();
});

test("T16.1 a TV page that has just loaded tells the phone its focus is on no tile, even when that's where a page starts", async () => {
  // What a page before it left behind: a tile in focus, where a hold opens
  // its details. Cinema's home starts on Play, which is a page's own start,
  // so it changes nothing on the page itself.
  await useLook("cinema");
  (daemon as unknown as { tv: { details: boolean } }).tv.details = true;
  const page = await tv();
  await page.waitForSelector('#page [data-action="cinema-play"].focused');
  await until(() => !(daemon as unknown as { tv: { details: boolean } }).tv.details);
  await page.close();
});

test("T16.1 OK held on something that isn't a tile is one OK, however long the key repeats: Cinema's Play, a button, and a digit on the PIN pad", async () => {
  // Cinema's home starts on Play, not on a tile.
  await useLook("cinema");
  const page = await tv();
  await page.waitForSelector('#page [data-action="cinema-play"].focused');
  const opened = () => page.evaluate(() => (window as unknown as Tv).screenRequests.filter((r) => r.cmd.startsWith("open")).length);
  await holdEnter(page, 700);
  await sleep(200);
  assert.equal(await opened(), 1, "a key held on Play opens once");
  // And from the phone, which knows the focus is on no tile: one OK as the
  // finger lifts. The phone learns it from the TV, so it opens once the TV
  // has said so, and not on what the page before it said.
  await until(() => !(daemon as unknown as { tv: { details: boolean } }).tv.details);
  const hand = await phone();
  sent.length = 0;
  await touchOk(hand, 900);
  await until(() => sent.length === 1);
  await sleep(300);
  assert.deepEqual(sent, [{ key: "enter" }]);
  assert.equal(await opened(), 2, "a finger held on the phone's OK opens once more");
  assert.equal(await page.locator(".details-head").count(), 0);
  await hand.close();

  // A button on a page.
  await go(page, `details/${APP}`);
  await page.waitForSelector(".details-head");
  const before = (await asked(page, "open-app")).length;
  await holdEnter(page, 700);
  await sleep(200);
  assert.equal((await asked(page, "open-app")).length, before + 1, "a key held on Open opens once");

  // The PIN pad: one digit.
  const send = async (method: string, path: string, body?: unknown, grant?: string) =>
    (await fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
  await send("PUT", "/api/pin", { pin: "4826" });
  try {
    await go(page, "settings/phones");
    await page.locator('[data-action="pair"]').click();
    await page.waitForSelector(".pin-pad .pin-key.focused");
    await holdEnter(page, 700);
    await sleep(200);
    assert.equal(await page.locator(".pin-box.filled").count(), 1, "a key held on a digit enters it once");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".pin-pad", { state: "detached" });
  } finally {
    const grant = (await send("POST", "/api/pin/check", { pin: "4826" })).grant;
    await send("DELETE", "/api/pin", undefined, grant);
  }
  await page.close();
});

// A finger held still on the phone's swipe pad for ms.
async function touchPad(hand: Page, ms: number): Promise<void> {
  const box = (await hand.locator('.r2-surface[data-action="surface"]').boundingBox())!;
  const cdp = await hand.context().newCDPSession(hand);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }] });
  await sleep(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test("a hold on the phone's swipe pad opens details only on an app's tile, on home and in Apps: in Settings, on a details page and with an app made on the TV in front it gives the pointer and presses nothing", async () => {
  await useLook("glass");
  const page = await tv();
  const hand = await phone(false);
  const hint = () => hand.locator(".r2-surface .r2-hint > span").last().textContent();
  const says = (what: string) => until(async () => (await hint()) === what);
  const pointerAndNothingSent = async (where: string) => {
    await says("Hold for the pointer");
    sent.length = 0;
    await touchPad(hand, 800);
    await hand.waitForSelector(".r2-pointer");
    await sleep(200);
    assert.deepEqual(sent, [], `${where}: the TV got no key`);
    await hand.locator('[data-action="pointer-done"]').click();
    await hand.waitForSelector('.r2-surface[data-action="surface"]');
  };

  // A tile on home, then one in Apps: details.
  for (const [route, tile] of [["home", `#page [data-id="${APP}"]`], ["apps", `.apps-page [data-id="${APP}"]`]] as const) {
    await go(page, route);
    await focusOn(page, tile);
    await says("Hold for details");
    sent.length = 0;
    await touchPad(hand, 800);
    await onDetails(page);
    assert.deepEqual(sent, [{ key: "i" }], route);
    assert.equal(await hand.locator(".r2-pointer").count(), 0);
    // On the details page, with the focus on Open: the pointer, and the
    // app doesn't open.
    await pointerAndNothingSent("a details page");
    assert.deepEqual(await asked(page, "open-app"), []);
    await page.keyboard.press("Escape");
  }

  // Settings, with the focus on a row: nothing is pressed.
  await go(page, "settings");
  await page.waitForSelector("#page .focused");
  const where = () => page.evaluate(() => `${location.hash} ${document.querySelector("#page .focused")?.textContent}`);
  const row = await where();
  await pointerAndNothingSent("Settings");
  assert.equal(await where(), row, "Settings is where it was");

  // An app made on the TV in front, which is a page in home's own window.
  // Opened from its tile, which had details a moment ago.
  await go(page, "home");
  await focusOn(page, `#page [data-id="${APP}"]`);
  await says("Hold for details");
  await go(page, "app/agentv.blocks");
  await page.waitForSelector(".page-app-view", { state: "attached" });
  await page.waitForSelector(".page-app.on iframe");
  await pointerAndNothingSent("an app made on the TV");
  await hand.close();
  await page.close();
});

test("a gamepad's Y still opens details, and its A still opens the app", async () => {
  await useLook("terminal");
  const page = await tv();
  await focusOn(page, `#page [data-id="${APP}"]`);
  const pad = (down: number | null) =>
    page.evaluate((index) => {
      const w = window as unknown as Tv;
      const first = w.pads.length === 0;
      w.pads = [{ axes: [0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === index })) }];
      if (first) window.dispatchEvent(new Event("gamepadconnected"));
    }, down);
  await pad(0);
  await until(async () => (await asked(page, "open-app")).length === 1);
  await pad(null);
  await sleep(50);
  await pad(3);
  await onDetails(page);
  assert.deepEqual(await asked(page, "open-app"), [APP]);
  await page.close();
});

for (const look of LOOKS) {
  test(`in ${look}, details has Quit only while the app is open, it closes it, and no tile names a key for it`, async () => {
    await useLook(look);
    const page = await tv();
    const tile = `#page [data-id="agentv.games"]`;
    await page.waitForSelector(tile);
    // Nothing is open: details has no Quit.
    await focusOn(page, tile);
    await holdEnter(page, 700);
    await onDetails(page, "agentv.games");
    assert.equal(await page.locator('.details [data-action="quit"]').count(), 0);
    await page.keyboard.press("Escape");
    await focusOn(page, tile);

    // The game is open behind home.
    await page.evaluate(() => (window as unknown as Tv).agentvRunning(JSON.stringify([{ id: "agentv.games", game: true, paused: false }])));
    await sleep(150);
    assert.equal(await page.locator(".tile-quit").count(), 0);
    const words = (await page.locator("#page").innerText()).toLowerCase();
    assert.ok(!/\bquit\b/.test(words), `home says nothing of quitting: ${words}`);
    if (look === "terminal") assert.equal(await page.locator(`${tile} .tile-state`).innerText(), "running");

    await focusOn(page, tile);
    await holdEnter(page, 700);
    await onDetails(page, "agentv.games");
    const quit = page.locator('.details .actions [data-action="quit"]');
    assert.equal(await quit.innerText(), look === "terminal" ? "quit" : "Quit");
    // Right after Open, and OK on it closes the app.
    assert.equal(await page.locator(".details .actions > *").nth(1).getAttribute("data-action"), "quit");
    await focusOn(page, '.details .actions [data-action="quit"]');
    await page.keyboard.press("Enter");
    await until(async () => (await asked(page, "quit")).length === 1);
    assert.deepEqual(await asked(page, "quit"), ["agentv.games"]);
    // The screen daemon says it's gone: so is the button, and the focus is
    // back on Open.
    await page.evaluate(() => (window as unknown as Tv).agentvRunning("[]"));
    await page.waitForSelector('.details [data-action="quit"]', { state: "detached" });
    await page.waitForSelector(".details .actions .button.primary.focused");
    await page.close();
  });
}
