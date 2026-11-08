// The new phone remote (ADR-065, design page D4, track 8's T8.3) in a real
// Chromium at 375 × 812, on the daemon itself, with the screen daemon's end
// of the phone's stream stood in for by its own code (daemon/remote.ts):
// one remote screen with nothing labelled "home" twice, the keyboard by
// itself for a service page's field, typing that goes to the TV as it's
// typed with no redraw under it, the first load following the TV, the
// surface's swipes, tap and hold, a held Back, play and pause that say
// why when they can't, and the menu. With its switch off, the phone keeps
// the remote it had.

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

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const PHONE = { width: 375, height: 812 };
const dir = mkdtempSync(join(tmpdir(), "agentv-remote2-ui-"));
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
async function box(remote2: boolean): Promise<Box> {
  const { daemon, url, state } = await startBox();
  if (remote2) {
    writeFileSync(join(state, "features.json"), JSON.stringify({ remote2: true }));
    writeFileSync(join(state, "..", "channel"), "edge\n");
  }
  const made: Box = { daemon, url, phoneUrl: `http://127.0.0.1:${daemon.lanPort}`, keys: [], commands: [], typed: [], actions: [], playback: { ok: true, by: "page" }, input: null as unknown as RemoteInput };
  made.input = new RemoteInput({
    url: `${url}/api/remote`,
    send: async (request) => void made.keys.push(request),
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
  process.env.AGENTV_PASSWD = passwd;
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  for (const b of boxes) {
    b.input.stop();
    await b.daemon.close();
  }
  await browser?.close();
  delete process.env.AGENTV_PASSWD;
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

const context = (b: Box, body: object) => fetch(`${b.url}/api/tv/context`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// A paired phone, through the QR code's address.
async function phone(b: Box, ready = ".r2"): Promise<Page> {
  const { pairing } = await (await fetch(`${b.url}/api/phones/pair`, { method: "POST" })).json();
  const page = await browser.newPage({ viewport: PHONE, hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${b.phoneUrl}/?code=${pairing.code}`);
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
  assert.deepEqual(await hand.locator("#r2-sheet .r2-row span:not([class])").allTextContents(), ["edit home", "share", "apps", "settings", "click and buzz"]);
  await hand.close();
});

test("T8.3 the keyboard comes up by itself for a service page's field, and each change goes to the TV as it's typed, with nothing redrawn under it", async () => {
  const b = await box(true);
  const hand = await phone(b);
  await context(b, { front: "app", playing: false, appField: { kind: "search", label: "search", value: "", app: "agentv.tube" } });
  await hand.waitForSelector("#tv-text", { timeout: 1500 });
  assert.equal(await hand.locator(".r2-where").textContent(), "tube · search");
  assert.equal(await hand.locator(".r2-headline").textContent(), "search");
  assert.equal(await hand.locator("#tv-text").getAttribute("inputmode"), "search");
  assert.equal(await hand.evaluate(() => document.activeElement?.id), "tv-text", "the field has the focus, so the phone's keyboard opens");
  // The field is the same one all through, even as the TV changes under it.
  await hand.evaluate(() => ((document.getElementById("tv-text") as HTMLInputElement & { mark?: boolean }).mark = true));
  await hand.locator("#tv-text").pressSequentially("sintél", { delay: 40 });
  await context(b, { front: "app", playing: true, appField: { kind: "search", label: "search", value: "sintél", app: "agentv.tube" } });
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
  await context(b, { front: "app", playing: false, appField: { kind: "password", label: "password", app: "agentv.tube" } });
  // The first load follows the TV: the keyboard, not the surface.
  const hand = await phone(b, "#tv-text");
  assert.equal(await hand.locator("#tv-text").getAttribute("type"), "password");
  assert.equal(await hand.locator("#tv-text").getAttribute("autocomplete"), "current-password");
  assert.equal(await hand.locator(".r2-where").textContent(), "tube · sign in");
  assert.equal(await hand.locator(".r2-note").textContent(), "your password manager can fill it");
  await hand.locator('[data-action="keyboard-done"]').tap();
  await hand.waitForSelector(".r2-surface");
  await hand.close();
});

test("T8.3 the surface: a swipe moves the focus, a tap is OK, and a hold gives the pointer, which moves and clicks", async () => {
  const b = await box(true);
  const hand = await phone(b);
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
  // A hold: the pointer.
  await hand.mouse.move(cx, cy);
  await hand.mouse.down();
  await hand.waitForSelector(".r2-pointer", { timeout: 1500 });
  await hand.mouse.up();
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
  assert.deepEqual(await hand.locator(".r2-card-text > *").allTextContents(), ["sintel", "my tv · 7 min left"]);
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
    assert.notEqual(await hand.evaluate(() => getComputedStyle(document.querySelector(".r2-surface")!).borderRadius), "0px", "its surface is rounded");
  }
  // The looks' fonts come from the box over the phone's port.
  assert.equal((await fetch(`${b.phoneUrl}/launcher/fonts/manrope-latin-wght-normal.woff2`)).status, 200);
  assert.notEqual((await fetch(`${b.phoneUrl}/launcher/looks/looks.ts`)).status, 200, "and nothing else of the launcher's");
  await hand.close();
});
