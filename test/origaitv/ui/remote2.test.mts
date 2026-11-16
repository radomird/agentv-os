// The new phone remote (ADR-065, design page D4, track 8's T8.3) in a real
// Chromium at 375 × 812, on the daemon itself, with the screen daemon's end
// of the phone's stream stood in for by its own code (daemon/remote.ts):
// one remote screen with nothing labelled "home" twice, the keyboard by
// itself for a service page's field, typing that goes to the TV as it's
// typed with no redraw under it, the first load following the TV, the
// surface's swipes, tap and hold, a held Back, play and pause that say
// why when they can't, and the menu. With its switch off, the phone keeps
// the remote it had. In Glass it's the clickpad (D13, T21.1): a round pad
// whose edge is the arrows, and round keys under it.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { RemoteInput } from "../../../daemon/remote.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const PHONE = { width: 375, height: 812 };
// A larger phone, for the clickpad.
const BIG_PHONE = { width: 430, height: 932 };
const dir = mkdtempSync(join(tmpdir(), "origaitv-remote2-ui-"));
let browser: Browser;
const errors: string[] = [];

interface Box {
  daemon: Daemon;
  url: string;
  phoneUrl: string;
  // What reached the screen daemon's end: keys, commands, and the asks.
  keys: Record<string, unknown>[];
  commands: string[];
  typed: string[];
  actions: string[];
  playback: { ok: boolean; why?: string; by?: string };
  input: RemoteInput;
}
const boxes: Box[] = [];

// A box with the new remote's switch on or off, and the screen daemon's end
// of the phone's stream.
async function box(remote2: boolean, look?: "glass" | "cinema"): Promise<Box> {
  const { daemon, url } = await startBox(0, undefined, { features: { remote2, looks: look !== undefined } });
  if (look) await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
  const made: Box = { daemon, url, phoneUrl: `http://127.0.0.1:${daemon.lanPort}`, keys: [], commands: [], typed: [], actions: [], playback: { ok: true, by: "page" }, input: null as unknown as RemoteInput };
  made.input = new RemoteInput({
    url: `${url}/api/remote`,
    send: async (request) => void made.keys.push(request),
    // Two fingers' scroll as it reaches the screen daemon: how far, and from
    // where.
    wheel: async (dx, dy, at) => void made.keys.push({ wheel: [dx, dy], ...(at === "pointer" ? { at } : {}) }),
    command: async (cmd) => void made.commands.push(cmd),
    ask: async (ask) => {
      if (ask.kind === "text") {
        made.typed.push(ask.value);
        return { ok: true, by: "page" };
      }
      if (ask.kind === "done") {
        made.keys.push({ key: "enter" });
        return { ok: true, by: "page" };
      }
      made.actions.push(ask.action);
      return made.playback;
    },
    log: () => {},
  });
  made.input.start();
  boxes.push(made);
  return made;
}

before(async () => {
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  process.env.ORIGAITV_PASSWD = passwd;
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  for (const b of boxes) {
    b.input.stop();
    await b.daemon.close();
  }
  await browser?.close();
  delete process.env.ORIGAITV_PASSWD;
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

async function until(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("it didn't happen in time");
    await new Promise((done) => setTimeout(done, 20));
  }
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

const context = (b: Box, body: object) => fetch(`${b.url}/api/tv/context`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// A paired phone, through the QR code's address.
async function phone(b: Box, ready = ".r2", viewport = PHONE): Promise<Page> {
  await fetch(`${b.url}/api/phones/pair`, { method: "POST" });
  const page = await browser.newPage({ viewport, hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${b.phoneUrl}/#pair=${b.daemon.phones.secret()}`);
  await page.waitForSelector(ready);
  return page;
}

for (const on of [false, true]) {
  test(`T8.3 the phone's remote with remote2 ${on ? "on: one remote screen" : "off: the remote it had, tabs and all"}`, async () => {
    const b = await box(on);
    const hand = await phone(b, on ? ".r2" : ".dpad");
    assert.equal(await hand.locator(".tabs").count(), on ? 0 : 1);
    assert.equal(await hand.locator(".r2").count(), on ? 1 : 0);
    await hand.close();
  });
}

test("T8.3 at 375 × 812 the remote is one screen: the surface, Back, Home and play in one row, Ask under them, and nothing labelled home twice", async () => {
  const b = await box(true);
  const hand = await phone(b);
  for (const selector of [".r2-top", ".r2-surface", '[data-key="back"]', '[data-key="home"]', '[data-action="playpause"]', ".r2-ask", ".r2-notice"]) {
    const found = await hand.locator(selector).boundingBox();
    assert.ok(found && found.y >= 0 && found.y + found.height <= PHONE.height, `${selector} is on the screen`);
  }
  const row = await Promise.all(['[data-key="back"]', '[data-key="home"]', '[data-action="playpause"]'].map((s) => hand.locator(s).boundingBox()));
  assert.ok(row.every((r) => r && Math.abs(r.y - row[0]!.y) < 1), "back, home and play sit in one row");
  assert.equal(await hand.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight), true, "nothing scrolls");
  // Nothing on the screen or in the menu is called home but Home itself.
  await hand.locator('[data-action="menu"]').tap();
  await hand.waitForSelector("#r2-sheet .r2-row");
  const homes = await hand.evaluate(() =>
    [...document.querySelectorAll("button")].filter((el) => {
      const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().toLowerCase();
      return name === "home";
    }).length,
  );
  assert.equal(homes, 1);
  assert.deepEqual(await hand.locator("#r2-sheet .r2-row span:not([class])").allTextContents(), ["Edit home", "Send to TV", "Apps", "Settings", "Click and buzz"]);
  await hand.close();
});

test("T8.3 the keyboard comes up by itself for a service page's field, and each change goes to the TV as it's typed, with nothing redrawn under it", async () => {
  const b = await box(true);
  const hand = await phone(b);
  await context(b, { front: "app", playing: false, appField: { kind: "search", label: "search", value: "", app: "origaitv.tube" } });
  await hand.waitForSelector("#tv-text", { timeout: 1500 });
  assert.equal(await hand.locator(".r2-where").textContent(), "Tube · search");
  assert.equal(await hand.locator(".r2-headline").textContent(), "search");
  assert.equal(await hand.locator("#tv-text").getAttribute("inputmode"), "search");
  assert.equal(await hand.evaluate(() => document.activeElement?.id), "tv-text", "the field has the focus, so the phone's keyboard opens");
  // The field is the same one all through, even as the TV changes under it.
  await hand.evaluate(() => ((document.getElementById("tv-text") as HTMLInputElement & { mark?: boolean }).mark = true));
  await hand.locator("#tv-text").pressSequentially("sintél", { delay: 40 });
  await context(b, { front: "app", playing: true, appField: { kind: "search", label: "search", value: "sintél", app: "origaitv.tube" } });
  await hand.locator("#tv-text").pressSequentially(" ж", { delay: 40 });
  await until(() => b.typed.at(-1) === "sintél ж");
  assert.ok(b.typed.length >= 4, `each change went: ${b.typed.length}`);
  assert.equal(await hand.evaluate(() => (document.getElementById("tv-text") as HTMLInputElement & { mark?: boolean }).mark), true, "nothing redrew the field");
  // Enter is the keyboard's own key, and goes to the TV's field.
  await hand.locator("#tv-text").press("Enter");
  await until(() => JSON.stringify(b.keys.at(-1)) === JSON.stringify({ key: "enter" }));
  // The field goes on the TV: the remote again.
  await context(b, { front: "app", playing: false });
  await hand.waitForSelector(".r2-surface", { timeout: 1500 });
  await hand.close();
});

test("T8.3 a password's field is the phone's password field, for its password manager, and done puts the keyboard away", async () => {
  const b = await box(true);
  await context(b, { front: "app", playing: false, appField: { kind: "password", label: "password", app: "origaitv.tube" } });
  // The first load follows the TV: the keyboard, not the surface.
  const hand = await phone(b, "#tv-text");
  assert.equal(await hand.locator("#tv-text").getAttribute("type"), "password");
  assert.equal(await hand.locator("#tv-text").getAttribute("autocomplete"), "current-password");
  assert.equal(await hand.locator(".r2-where").textContent(), "Tube · sign in");
  assert.equal(await hand.locator(".r2-note").textContent(), "Your password manager can fill it");
  await hand.locator('[data-action="keyboard-done"]').tap();
  await hand.waitForSelector(".r2-surface");
  await hand.close();
});

test("T8.3 the surface: a swipe moves the focus, a tap is OK, and a hold opens details on an app's tile and gives the pointer everywhere else, which moves and clicks", async () => {
  const b = await box(true);
  const hand = await phone(b);
  const hint = () => hand.locator('.r2-surface [data-hint="hold"]').textContent();
  const label = () => hand.locator(".r2-surface").getAttribute("aria-label");
  const area = (await hand.locator(".r2-surface").boundingBox())!;
  const cx = area.x + area.width / 2;
  const cy = area.y + area.height / 2;
  const from = b.keys.length;
  await hand.mouse.move(cx, cy);
  await hand.mouse.down();
  await hand.mouse.move(cx + 60, cy, { steps: 6 });
  await hand.mouse.up();
  await hand.mouse.move(cx, cy);
  await hand.mouse.down();
  await hand.mouse.move(cx, cy + 100, { steps: 8 });
  await hand.mouse.up();
  await hand.mouse.click(cx, cy);
  await until(() => b.keys.length >= from + 4);
  assert.deepEqual(b.keys.slice(from), [{ key: "right" }, { key: "down" }, { key: "down" }, { key: "enter" }]);
  // A hold with an app's tile focused on home: the key that opens its
  // details, sent while the finger is still down, and no pointer and no tap
  // as it lifts. The hint says so.
  const held = async () => {
    const at = b.keys.length;
    await hand.mouse.move(cx, cy);
    await hand.mouse.down();
    await wait(800);
    const down = b.keys.slice(at);
    await hand.mouse.up();
    await wait(300);
    return { down, all: b.keys.slice(at), pointer: await hand.locator(".r2-pointer").count() };
  };
  await context(b, { front: "home", screen: "home", details: true });
  await until(async () => (await hint()) === "Hold for details");
  assert.equal(await label(), "Swipe to move, tap for OK, hold for details, two fingers to scroll");
  assert.deepEqual(await held(), { down: [{ key: "i" }], all: [{ key: "i" }], pointer: 0 });
  await context(b, { screen: "menu" });
  await wait(150);
  assert.equal(await hint(), "Hold for details");
  assert.deepEqual(await held(), { down: [{ key: "i" }], all: [{ key: "i" }], pointer: 0 }, "a tile in Apps has details too");
  // Two fingers aren't a hold, and the first one's timer goes with it: they
  // scroll, with no step, no OK and nothing held (ADR-103).
  {
    const cdp = await hand.context().newCDPSession(hand);
    const at = b.keys.length;
    const one = { x: Math.round(cx), y: Math.round(cy), id: 1 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [one] });
    await wait(100);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [one, { x: one.x + 30, y: one.y, id: 2 }] });
    await wait(100);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...one, x: one.x + 60 }, { x: one.x + 30, y: one.y, id: 2 }] });
    await wait(700);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await wait(200);
    const sent = b.keys.slice(at);
    assert.ok(sent.length > 0 && sent.every((k) => Array.isArray(k.wheel) && k.at === undefined), `only the wheel: ${JSON.stringify(sent)}`);
    assert.ok(sent.every((k) => (k.wheel as number[])[1] === 0), "sideways only");
    assert.equal(sent.reduce((sum, k) => sum + (k.wheel as number[])[0], 0), -90, `the fingers' middle went 30 to the right, and the page with it, three times over on the TV: ${JSON.stringify(sent)}`);
    await cdp.detach();
  }
  // Home's other screens, where the focus is on no tile: Settings on a row,
  // a details page, an app made on the TV. The hint says the pointer, and a
  // hold gives it and sends the TV nothing.
  await context(b, { screen: "menu", details: false });
  await until(async () => (await hint()) === "Hold for the pointer");
  {
    const at = b.keys.length;
    await hand.mouse.move(cx, cy);
    await hand.mouse.down();
    await hand.waitForSelector(".r2-pointer", { timeout: 1500 });
    await hand.mouse.up();
    await wait(200);
    assert.deepEqual(b.keys.slice(at), [], "a still finger is not a press");
    await hand.locator('[data-action="pointer-done"]').click();
    await hand.waitForSelector('.r2-surface[data-action="surface"]');
  }
  // A hold with an app in front: the pointer, as it was, and nothing sent.
  await context(b, { front: "app", screen: "home", playing: false });
  await until(async () => (await hint()) === "Hold for the pointer");
  assert.equal(await label(), "Swipe to move, tap for OK, hold for the pointer, two fingers to scroll");
  const sent = b.keys.length;
  await hand.mouse.move(cx, cy);
  await hand.mouse.down();
  await hand.waitForSelector(".r2-pointer", { timeout: 1500 });
  await hand.mouse.up();
  assert.equal(b.keys.length, sent, "the TV gets no held OK over an app");
  const pad = (await hand.locator(".r2-pointer").boundingBox())!;
  await hand.mouse.move(pad.x + 100, pad.y + 200);
  await hand.mouse.down();
  await hand.mouse.move(pad.x + 140, pad.y + 220, { steps: 4 });
  await hand.mouse.up();
  await until(() => b.keys.some((k) => Array.isArray(k.move)));
  await hand.mouse.click(pad.x + 100, pad.y + 200);
  await until(() => b.keys.some((k) => k.click === "left"));
  await hand.locator('[data-action="pointer-done"]').click();
  await hand.waitForSelector('.r2-surface[data-action="surface"]');
  // The d-pad switch puts buttons on it instead, and remembers.
  await hand.locator('[data-action="dpad"]').click();
  await hand.locator('.r2-dpad [data-key="up"]').click();
  await until(() => JSON.stringify(b.keys.at(-1)) === JSON.stringify({ key: "up" }));
  await hand.reload();
  await hand.waitForSelector(".r2-dpad");
  await hand.close();
});

test("T21.1 two fingers on the pad scroll the page in front, down, up and sideways, with the page following the fingers as on a phone, and from the pointer in pointer mode", async () => {
  const b = await box(true);
  const hand = await phone(b);
  const cdp = await hand.context().newCDPSession(hand);
  const drag = async (dx: number, dy: number) => {
    const area = (await hand.locator(".r2-surface").boundingBox())!;
    const x = Math.round(area.x + area.width / 2 - 30);
    const y = Math.round(area.y + area.height / 2 - 40);
    const at = b.keys.length;
    const two = (by: number) => [
      { x: x + Math.round(dx * by), y: y + Math.round(dy * by), id: 1 },
      { x: x + 60 + Math.round(dx * by), y: y + Math.round(dy * by), id: 2 },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: two(0) });
    for (let step = 1; step <= 5; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: two(step / 5) });
      await wait(20);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await wait(150);
    return b.keys.slice(at);
  };
  const total = (sent: Record<string, unknown>[]) => sent.reduce((sum, k) => [sum[0] + (k.wheel as number[])[0], sum[1] + (k.wheel as number[])[1]], [0, 0]);
  // The page follows the fingers, as on the phone: down brings down what's
  // above, so the page scrolls up.
  let sent = await drag(0, 40);
  assert.ok(sent.length > 0 && sent.every((k) => Array.isArray(k.wheel) && k.at === undefined), JSON.stringify(sent));
  assert.deepEqual(total(sent), [0, -120], "three times the fingers' way, up the page");
  sent = await drag(0, -40);
  assert.deepEqual(total(sent), [0, 120], "and down it");
  sent = await drag(-30, 0);
  assert.deepEqual(total(sent), [90, 0], "and sideways");
  assert.equal(await hand.locator(".r2-pointer").count(), 0, "two fingers held still a while aren't a hold");
  // The pointer: from where it is, as on a laptop.
  await context(b, { front: "app", screen: "home", playing: false });
  const area = (await hand.locator(".r2-surface").boundingBox())!;
  await hand.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await hand.mouse.down();
  await hand.waitForSelector(".r2-pointer", { timeout: 1500 });
  await hand.mouse.up();
  const moves = b.keys.length;
  sent = await drag(0, 40);
  assert.ok(sent.length > 0 && sent.every((k) => Array.isArray(k.wheel) && k.at === "pointer"), JSON.stringify(sent));
  assert.deepEqual(total(sent), [0, -120]);
  assert.ok(!b.keys.slice(moves).some((k) => k.move || k.click), "two fingers don't move the pointer or click");
  await cdp.detach();
  await hand.close();
});

test("T8.3 a tap on Back goes back, and held, the phone sends the hold that goes home", async () => {
  const b = await box(true);
  const hand = await phone(b);
  const back = (await hand.locator('[data-key="back"]').boundingBox())!;
  const from = b.keys.length;
  await hand.mouse.click(back.x + back.width / 2, back.y + back.height / 2);
  await hand.mouse.move(back.x + back.width / 2, back.y + back.height / 2);
  await hand.mouse.down();
  await until(() => b.keys.length >= from + 2, 2000);
  await hand.mouse.up();
  assert.deepEqual(b.keys.slice(from), [{ key: "back" }, { hold: "back", ms: 1100 }]);
  await hand.close();
});

// A finger on the d-pad's OK, and off it again: real touches.
async function fingers(hand: Page): Promise<{ down(count?: number): Promise<void>; up(): Promise<void> }> {
  const box = (await hand.locator('.r2 [data-key="enter"]').boundingBox())!;
  const point = (dx: number) => ({ x: Math.round(box.x + box.width / 2 + dx), y: Math.round(box.y + box.height / 2), id: dx });
  const cdp = await hand.context().newCDPSession(hand);
  return {
    down: async (count = 1) => void (await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(0), point(20)].slice(0, count) })),
    up: async () => void (await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })),
  };
}

test("the d-pad's OK asks for details only on an app's tile: anywhere else a long press is one OK as the finger lifts, and its fill is the button's size", async () => {
  const b = await box(true);
  const hand = await phone(b);
  await hand.locator('[data-action="dpad"]').click();
  await hand.waitForSelector('.r2-dpad [data-key="enter"]');
  const ok = await fingers(hand);
  const long = async () => {
    const from = b.keys.length;
    await ok.down();
    await wait(800);
    const while_ = b.keys.slice(from);
    const filling = await hand.locator(".r2-ok.holding").count();
    await ok.up();
    await wait(300);
    return { down: while_, all: b.keys.slice(from), filling };
  };
  // A tile focused on home: details, as the finger is still down, and the
  // button shows it's being held.
  await context(b, { front: "home", screen: "home", details: true });
  await wait(150);
  assert.deepEqual(await long(), { down: [{ key: "i" }], all: [{ key: "i" }], filling: 1 });
  await context(b, { screen: "menu" });
  assert.deepEqual((await long()).all, [{ key: "i" }], "a tile in Apps has details too");
  // The fill is the button's, not the whole pad's.
  const sizes = await hand.evaluate(() => {
    const button = document.querySelector(".r2-ok")!;
    const fill = getComputedStyle(button, "::before");
    return { button: [button.clientWidth, button.clientHeight], fill: [parseFloat(fill.width), parseFloat(fill.height)], clipped: getComputedStyle(button).overflow };
  });
  assert.deepEqual(sizes.fill, sizes.button);
  assert.equal(sizes.clipped, "hidden");
  // A finger that slides off OK takes the press back: nothing as it lifts
  // out there, and no hold either.
  {
    const box = (await hand.locator(".r2-ok").boundingBox())!;
    const on = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), id: 1 };
    const out = { ...on, y: Math.round(box.y + box.height + 60) };
    const cdp = await hand.context().newCDPSession(hand);
    for (const ms of [100, 900]) {
      const from = b.keys.length;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [on] });
      await wait(100);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [out] });
      await wait(ms);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await wait(200);
      assert.deepEqual(b.keys.slice(from), [], `slid off and lifted after ${ms} ms`);
    }
    await cdp.detach();
  }
  // Anything else in front: nothing while the finger is down, and one OK
  // as it lifts.
  const others: [string, object, object][] = [
    ["an app", { front: "app", playing: false }, { front: "home" }],
    ["the screen saver", { screen: "ambient" }, { screen: "home" }],
    ["Settings", { screen: "menu", details: false }, { screen: "home", details: true }],
  ];
  for (const [what, there, gone] of others) {
    await context(b, there);
    await wait(150);
    assert.deepEqual(await long(), { down: [], all: [{ key: "enter" }], filling: 0 }, `with ${what} in front`);
    await context(b, gone);
    await wait(150);
  }
  assert.deepEqual((await long()).all, [{ key: "i" }], "and back on a tile, details again");
  await hand.close();
});

test("the d-pad's OK counts one press: a redraw under a quick tap still sends the tap and no hold after it, and a second finger adds nothing", async () => {
  const b = await box(true);
  const hand = await phone(b);
  await hand.locator('[data-action="dpad"]').click();
  await hand.waitForSelector('.r2-dpad [data-key="enter"]');
  const ok = await fingers(hand);
  // Something starts playing while the finger is down, so the remote
  // draws itself again with what's playing, and the button is a new one.
  await fetch(`${b.url}/api/ledger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app: "local.mytv", state: { title: "Sintel", position: 480, duration: 888, playing: true } }) });
  let from = b.keys.length;
  await hand.evaluate(() => document.querySelector('.r2 [data-key="enter"]')!.setAttribute("data-first", ""));
  await ok.down();
  await context(b, { playing: true });
  await hand.waitForSelector(".r2-card");
  assert.equal(await hand.locator("[data-first]").count(), 0, "the button was drawn again");
  await ok.up();
  await wait(900);
  assert.deepEqual(b.keys.slice(from), [{ key: "enter" }]);

  // Two fingers on OK, held on a tile: one ask for details.
  await context(b, { front: "home", screen: "home", details: true, playing: false });
  await wait(150);
  from = b.keys.length;
  const two = await fingers(hand);
  await two.down(1);
  await wait(100);
  await two.down(2);
  await wait(1000);
  await two.up();
  await wait(300);
  assert.deepEqual(b.keys.slice(from), [{ key: "i" }]);
  await hand.close();
});

test("T8.3 play asks the box, and the notice line says why when nothing plays; what's playing shows with next", async () => {
  const b = await box(true);
  const hand = await phone(b);
  b.playback = { ok: false, why: "nothing is playing" };
  await hand.locator('[data-action="playpause"]').tap();
  await until(async () => (await hand.locator(".r2-notice-text").textContent()) === "nothing is playing");
  // Playing: the button says pause, and the card says what, with next.
  b.playback = { ok: true, by: "page" };
  await fetch(`${b.url}/api/ledger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app: "local.mytv", state: { title: "Sintel", position: 480, duration: 888, playing: true } }) });
  await context(b, { front: "app", playing: true });
  await until(async () => (await hand.locator('[data-action="playpause"]').getAttribute("data-state")) === "pause");
  await hand.waitForSelector(".r2-card");
  assert.deepEqual(await hand.locator(".r2-card-text > *").allTextContents(), ["Sintel", "My TV · 7 min left"]);
  await hand.locator('[data-action="next"]').tap();
  await until(() => b.actions.at(-1) === "next");
  assert.deepEqual(b.actions, ["toggle", "next"]);
  await hand.close();
});

test("T8.3 the menu: who's watching, Apps on the TV, and Settings brings home in front first", async () => {
  const b = await box(true);
  const hand = await phone(b);
  await hand.locator('[data-action="who"]').tap();
  await hand.waitForSelector("#r2-sheet .r2-viewer.on");
  await hand.locator('#r2-sheet [data-action="apps"]').tap();
  await until(() => b.commands.includes("apps"));
  await hand.waitForSelector("#r2-sheet", { state: "detached" });
  await hand.locator('[data-action="menu"]').tap();
  await hand.locator('#r2-sheet [data-action="settings"]').tap();
  await until(() => b.commands.includes("settings"));
  // Edit home is its own page, with a way back.
  await hand.locator('[data-action="menu"]').tap();
  await hand.locator('#r2-sheet [data-action="edit-home"]').tap();
  await hand.waitForSelector(".mini-grid");
  await hand.locator('[data-action="to-remote"]').tap();
  await hand.waitForSelector(".r2-surface");
  await hand.close();
});

// --- Glass's clickpad (D13) --------------------------------------------------

// Where a finger goes on the clickpad: its middle, or a dot on its edge.
async function spots(hand: Page): Promise<Record<"middle" | "up" | "down" | "left" | "right", { x: number; y: number }>> {
  const pad = (await hand.locator(".cp-pad").boundingBox())!;
  const at = (x: number, y: number) => ({ x: Math.round(pad.x + pad.width * x), y: Math.round(pad.y + pad.height * y) });
  return { middle: at(0.5, 0.5), up: at(0.5, 0.1), down: at(0.5, 0.9), left: at(0.1, 0.5), right: at(0.9, 0.5) };
}

for (const viewport of [PHONE, BIG_PHONE]) {
  test(`T21.1 at ${viewport.width} × ${viewport.height} Glass's remote is the clickpad: a round pad, Back and Home then play and Ask in two columns under its sides, and no d-pad switch`, async () => {
    const b = await box(true, "glass");
    const hand = await phone(b, ".cp-pad", viewport);
    assert.equal(await hand.locator('.r2[data-shape="clickpad"]').count(), 1);
    const pad = (await hand.locator(".cp-pad").boundingBox())!;
    assert.ok(Math.abs(pad.width - pad.height) < 1 && pad.width >= 260, `the pad is round and big: ${pad.width} × ${pad.height}`);
    assert.equal(await hand.evaluate(() => getComputedStyle(document.querySelector(".cp-pad")!).borderRadius), "50%");
    const keys = await hand.locator(".cp-key").evaluateAll((all) => all.map((key) => ({ name: key.textContent, label: key.getAttribute("aria-label"), box: key.querySelector(".cp-round")!.getBoundingClientRect().toJSON() as DOMRect })));
    assert.deepEqual(keys.map((key) => key.name), ["Back", "Home", "Play", "Ask"]);
    assert.deepEqual(keys.map((key) => key.label), ["Back, hold for home", "Home", "Play or pause", "Ask"]);
    const [back, home, play, ask] = keys.map((key) => key.box);
    assert.ok(Math.abs(back.y - home.y) < 1 && Math.abs(play.y - ask.y) < 1 && play.y > back.y + back.height, "Back and Home in a row, play and Ask under them");
    assert.ok(Math.abs(back.x - play.x) < 1 && Math.abs(home.x - ask.x) < 1, "in two columns");
    const middle = pad.x + pad.width / 2;
    assert.ok(back.x >= pad.x && back.x + back.width < middle && home.x > middle && home.x + home.width <= pad.x + pad.width, "under the pad's two sides");
    assert.ok(back.y > pad.y + pad.height, "under the pad");
    assert.equal(await hand.locator('.cp-key[data-key="home"] .icon-tv').count(), 1, "Home has a TV on it");
    for (const selector of [".r2-top", ".cp-pad", ".cp-key.ask", ".r2-notice"]) {
      const found = (await hand.locator(selector).boundingBox())!;
      assert.ok(found.y >= 0 && found.y + found.height <= viewport.height, `${selector} is on the screen`);
    }
    assert.equal(await hand.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight), true, "nothing scrolls");
    // The edge is the d-pad: no switch for one, no surface and no wide Ask.
    assert.equal(await hand.locator('[data-action="dpad"], .r2-surface, .r2-ask').count(), 0);
    assert.equal(await hand.locator(".cp-pad").getAttribute("aria-label"), "Swipe to move, tap for OK, press the edge for the arrows, hold for the pointer, two fingers to scroll");
    // A d-pad switched on in another look leaves Glass's clickpad as it is.
    await hand.evaluate(() => localStorage.setItem("origaitv-phone-dpad", "on"));
    await hand.reload();
    await hand.waitForSelector(".cp-pad");
    assert.equal(await hand.locator(".r2-dpad").count(), 0);
    await hand.close();
  });
}

test("T21.1 Cinema keeps its remote: the surface, the d-pad switch and Ask under the keys", async () => {
  const b = await box(true, "cinema");
  const hand = await phone(b, ".r2-surface");
  assert.equal(await hand.locator(".cp-pad, .cp-key").count(), 0);
  assert.equal(await hand.locator('[data-action="dpad"]').count(), 1);
  assert.equal(await hand.locator(".r2-ask").count(), 1);
  await hand.close();
});

test("T21.1 the clickpad's edge: a press on a side is its arrow as it lifts, with that quarter lit, held it repeats until it lifts, and a swipe from the edge is a swipe", async () => {
  const b = await box(true, "glass");
  const hand = await phone(b, ".cp-pad");
  const at = await spots(hand);
  for (const side of ["up", "down", "left", "right"] as const) {
    const from = b.keys.length;
    await hand.mouse.move(at[side].x, at[side].y);
    await hand.mouse.down();
    await hand.waitForSelector(`.cp-pad[data-edge="${side}"] .cp-arrow.${side}`, { state: "visible" });
    assert.equal(await hand.locator(`.cp-dot.${side}`).isVisible(), false, "its arrow shows where its dot was");
    assert.deepEqual(b.keys.slice(from), [], "nothing yet: it could still be a swipe");
    await hand.mouse.up();
    await until(() => b.keys.length > from);
    await wait(100);
    assert.deepEqual(b.keys.slice(from), [{ key: side }]);
    await until(async () => (await hand.locator(".cp-pad").getAttribute("data-edge")) === null);
  }
  // Held, it repeats while the finger stays, and stops as it lifts.
  {
    const from = b.keys.length;
    await hand.mouse.move(at.right.x, at.right.y);
    await hand.mouse.down();
    await wait(1100);
    const held = b.keys.length - from;
    await hand.mouse.up();
    await wait(400);
    assert.ok(held >= 4, `it repeated: ${held}`);
    assert.equal(b.keys.length - from, held, "and nothing more once it lifted");
    assert.ok(b.keys.slice(from).every((k) => k.key === "right"));
    assert.equal(await hand.locator(".cp-pad").getAttribute("data-edge"), null);
  }
  // A finger that starts on the left edge and swipes right is a swipe.
  {
    const from = b.keys.length;
    await hand.mouse.move(at.left.x, at.left.y);
    await hand.mouse.down();
    await hand.mouse.move(at.left.x + 100, at.left.y, { steps: 8 });
    await hand.mouse.up();
    await wait(200);
    assert.deepEqual(b.keys.slice(from), [{ key: "right" }, { key: "right" }]);
  }
  // A tap in the middle is OK, and the middle shows it.
  {
    const from = b.keys.length;
    await hand.mouse.click(at.middle.x, at.middle.y);
    await until(() => b.keys.length > from);
    assert.deepEqual(b.keys.slice(from), [{ key: "enter" }]);
  }
  await hand.close();
});

test("T21.1 a hold in the clickpad's middle opens details on an app's tile and gives the round pointer elsewhere, with Pointer and Done above it; held Back goes home", async () => {
  const b = await box(true, "glass");
  const hand = await phone(b, ".cp-pad");
  const at = await spots(hand);
  const hold = async (spot: { x: number; y: number }) => {
    const from = b.keys.length;
    await hand.mouse.move(spot.x, spot.y);
    await hand.mouse.down();
    await wait(800);
    await hand.mouse.up();
    await wait(200);
    return b.keys.slice(from);
  };
  await context(b, { front: "home", screen: "home", details: true });
  await until(async () => (await hand.locator('.cp-pad [data-hint="hold"]').textContent()) === "Hold for details");
  assert.equal(await hand.locator(".cp-pad").getAttribute("aria-label"), "Swipe to move, tap for OK, press the edge for the arrows, hold for details, two fingers to scroll");
  assert.deepEqual(await hold(at.middle), [{ key: "i" }]);
  assert.equal(await hand.locator(".cp-pad.pointer").count(), 0);
  // A hold on the edge is its arrow, again and again, never the pointer.
  await context(b, { screen: "menu", details: false });
  await until(async () => (await hand.locator('.cp-pad [data-hint="hold"]').textContent()) === "Hold for the pointer");
  const edge = await hold(at.down);
  assert.ok(edge.length >= 2 && edge.every((k) => k.key === "down"), JSON.stringify(edge));
  assert.equal(await hand.locator(".cp-pad.pointer").count(), 0);
  // In the middle, the pointer: the whole round pad, Pointer and Done above.
  assert.deepEqual(await hold(at.middle), [], "a still finger is not a press");
  await hand.waitForSelector('.cp-pad.pointer[data-action="trackpad"]');
  const top = (await hand.locator(".cp-pointer-top").boundingBox())!;
  const pad = (await hand.locator(".cp-pad").boundingBox())!;
  assert.ok(top.y + top.height <= pad.y, "Pointer and Done sit above the pad");
  assert.deepEqual(await hand.locator(".cp-pointer-top .r2-chip, .cp-pointer-top .r2-done").allTextContents(), ["Pointer", "Done"]);
  const middle = { x: Math.round(pad.x + pad.width / 2), y: Math.round(pad.y + pad.height / 2) };
  await hand.mouse.move(middle.x, middle.y);
  await hand.mouse.down();
  await hand.mouse.move(middle.x + 40, middle.y + 20, { steps: 4 });
  await hand.mouse.up();
  await until(() => b.keys.some((k) => Array.isArray(k.move)));
  await hand.mouse.click(middle.x, middle.y);
  await until(() => b.keys.some((k) => k.click === "left"));
  await hand.locator('[data-action="pointer-done"]').click();
  await hand.waitForSelector('.cp-pad[data-action="clickpad"]');
  // Back: a tap goes back, and held, the phone sends the hold.
  const back = (await hand.locator('.cp-key[data-key="back"]').boundingBox())!;
  const from = b.keys.length;
  await hand.mouse.click(back.x + back.width / 2, back.y + back.height / 2);
  await hand.mouse.move(back.x + back.width / 2, back.y + back.height / 2);
  await hand.mouse.down();
  await until(() => b.keys.length >= from + 2, 2000);
  await hand.mouse.up();
  assert.deepEqual(b.keys.slice(from), [{ key: "back" }, { hold: "back", ms: 1100 }]);
  // Play asks the box, and says pause while something plays.
  await hand.locator('.cp-key[data-action="playpause"]').tap();
  await until(() => b.actions.at(-1) === "toggle");
  await context(b, { front: "app", playing: true });
  await until(async () => (await hand.locator('.cp-key[data-action="playpause"]').textContent()) === "Pause");
  await hand.close();
});

test("T21.1 two fingers on the clickpad scroll the page in front, from its middle or its edge, with no arrow, and from the pointer in pointer mode", async () => {
  const b = await box(true, "glass");
  const hand = await phone(b, ".cp-pad");
  const cdp = await hand.context().newCDPSession(hand);
  const drag = async (x: number, y: number, dy: number) => {
    const from = b.keys.length;
    const two = (by: number) => [
      { x, y: y + Math.round(dy * by), id: 1 },
      { x: x + 40, y: y + Math.round(dy * by), id: 2 },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: two(0) });
    for (let step = 1; step <= 5; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: two(step / 5) });
      await wait(20);
    }
    await wait(600);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await wait(150);
    return b.keys.slice(from);
  };
  const total = (sent: Record<string, unknown>[]) => sent.reduce((sum, k) => sum + (k.wheel as number[])[1], 0);
  const at = await spots(hand);
  for (const [where, spot] of [["middle", { x: at.middle.x - 20, y: at.middle.y - 20 }], ["edge", { x: at.left.x, y: at.left.y - 20 }]] as const) {
    const sent = await drag(spot.x, spot.y, 40);
    assert.ok(sent.length > 0 && sent.every((k) => Array.isArray(k.wheel) && k.at === undefined), `${where}: only the wheel: ${JSON.stringify(sent)}`);
    assert.equal(total(sent), -120, `${where}: three times the fingers' way, and the page with them`);
  }
  assert.equal(await hand.locator(".cp-pad").getAttribute("data-edge"), null, "the edge isn't left lit");
  await hand.mouse.move(at.middle.x, at.middle.y);
  await hand.mouse.down();
  await hand.waitForSelector(".cp-pad.pointer", { timeout: 1500 });
  await hand.mouse.up();
  const sent = await drag(at.middle.x - 20, at.middle.y - 20, -40);
  assert.ok(sent.length > 0 && sent.every((k) => Array.isArray(k.wheel) && k.at === "pointer"), JSON.stringify(sent));
  assert.equal(total(sent), 120);
  await cdp.detach();
  await hand.close();
});

test("T8.3 the remote follows the TV's look: Glass and Cinema with the looks on, Terminal with them off", async () => {
  const b = await box(true);
  const state = join(String((b.daemon as unknown as { options: { state: string } }).options.state));
  const hand = await phone(b);
  const look = () => hand.evaluate(() => document.body.dataset.look);
  assert.equal(await look(), "terminal", "with the looks off, the phone is Terminal");
  writeFileSync(join(state, "features.json"), JSON.stringify({ remote2: true, looks: true }));
  for (const [id, font] of [["glass", "Manrope"], ["cinema", "Instrument Sans"]] as const) {
    await fetch(`${b.url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look: id }) });
    await context(b, { screen: "home" });
    await until(async () => (await look()) === id, 5000);
    assert.match(await hand.evaluate(() => getComputedStyle(document.querySelector(".r2")!).fontFamily), new RegExp(font));
    const pad = id === "glass" ? ".cp-pad" : ".r2-surface";
    await hand.waitForSelector(pad);
    assert.notEqual(await hand.evaluate((pad) => getComputedStyle(document.querySelector(pad)!).borderRadius, pad), "0px", "its pad is rounded");
  }
  // The looks' fonts come from the box over the phone's port.
  assert.equal((await fetch(`${b.phoneUrl}/launcher/fonts/manrope-latin-wght-normal.woff2`)).status, 200);
  assert.notEqual((await fetch(`${b.phoneUrl}/launcher/looks/looks.ts`)).status, 200, "and nothing else of the launcher's");
  await hand.close();
});
