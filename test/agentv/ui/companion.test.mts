// The phone companion's whole page in a real Chromium at 390 × 844 (ADR-019,
// layer 4; stage 4), beside the TV at 1920 × 1080: who's watching, from the
// phone (S4.2); arrange home, with the TV following within a second (S4.7);
// the update notice and Install tonight (S4.8); the sign-in fields a phone's
// password manager fills (S4.9); and the TV unlocked from the phone, with
// the adult PIN on its pad (S4.5).

import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
let phoneUrl = "";
let updates = "";
const errors: string[] = [];
const remote: string[] = [];
let stopRemote = () => {};
const dir = mkdtempSync(join(tmpdir(), "agentv-companion-ui-"));
const PIN = "4826";

before(async () => {
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  process.env.AGENTV_PASSWD = passwd;
  ({ daemon, url, updates } = await startBox());
  phoneUrl = `http://127.0.0.1:${daemon.lanPort}`;
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
  const controller = new AbortController();
  stopRemote = () => controller.abort();
  const stream = await fetch(`${url}/api/remote`, { headers: { "X-AgenTV-Screen": "1" }, signal: controller.signal });
  void (async () => {
    for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
      for (const match of new TextDecoder().decode(chunk).matchAll(/data: (.*)/g)) remote.push(match[1]);
    }
  })().catch(() => {});
});

after(async () => {
  stopRemote();
  await browser?.close();
  await daemon?.close();
  delete process.env.AGENTV_PASSWD;
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

const post = async (path: string, body?: unknown, grant?: string) =>
  (await fetch(`${url}${path}`, { method: "POST", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })).json();

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

// A paired phone, through the QR code's address.
async function phone(): Promise<Page> {
  const { pairing } = await post("/api/phones/pair");
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${phoneUrl}/?code=${pairing.code}`);
  await page.waitForSelector(".dpad");
  return page;
}

async function until(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("it didn't happen in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the phone's buttons carry icons: the d-pad, the tabs, delete and enter", async () => {
  const hand = await phone();
  for (const key of ["up", "down", "left", "right", "back", "home", "playpause"]) {
    assert.equal(await hand.locator(`[data-key="${key}"] svg.glyph`).count(), 1, key);
  }
  assert.equal(await hand.locator(".tab svg.glyph").count(), 3);
  await hand.locator('[data-mode="type"]').tap();
  assert.equal(await hand.locator('[data-key="backspace"] svg.glyph-backspace').count(), 1);
  assert.equal(await hand.locator('[data-key="enter"] svg.glyph-enter').count(), 1);
  assert.equal(await hand.locator('[data-key="backspace"]').getAttribute("aria-label"), "delete");
  await hand.close();
});

test("S4.2 who's watching, from the phone: the TV follows within a second, and a child to an adult takes the PIN on the phone", async () => {
  await post("/api/viewers", { name: "ana", role: "adult" });
  const screen = await tv();
  const hand = await phone();
  await hand.locator('[data-action="who"]').tap();
  await hand.waitForSelector(".viewer");
  assert.match(await hand.locator(".typing").innerText(), /who's watching\?[\s\S]*radomir\s+watching[\s\S]*ana/);
  const ana = (await (await fetch(`${url}/api/viewers`)).json()).viewers.find((v: { name: string }) => v.name === "ana");
  const at = Date.now();
  await hand.locator(`[data-viewer="${ana.id}"]`).tap();
  await screen.waitForFunction(() => document.querySelector(".bar-right span")?.textContent === "ana");
  assert.ok(Date.now() - at < 1000, `the TV showed ana in ${Date.now() - at} ms`);
  await hand.waitForFunction(() => /ana/.test(document.querySelector(".who")?.textContent ?? ""));

  // A child's profile, then back to an adult: the phone asks for the PIN.
  await fetch(`${url}/api/pin`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: PIN }) });
  const grant = (await post("/api/pin/check", { pin: PIN })).grant;
  const child = (await post("/api/viewers", { name: "mila", role: "child" }, grant)).profile;
  await post("/api/viewer", { id: child.id });
  await hand.waitForFunction(() => /mila/.test(document.querySelector(".who")?.textContent ?? ""), undefined, { timeout: 5000 });
  await hand.locator('[data-action="who"]').tap();
  await hand.locator('[data-viewer="radomir"]').tap();
  await hand.waitForSelector(".overlay .pin-keys");
  assert.match(await hand.locator(".overlay").innerText(), /enter the adult pin[\s\S]*for watching as radomir\./);
  assert.equal(await hand.locator('.overlay [data-pin="delete"] svg.glyph-backspace').count(), 1);
  for (const digit of "0000") await hand.locator(`.overlay [data-pin="${digit}"]`).tap();
  await hand.waitForFunction(() => /that's not the pin\./.test(document.querySelector(".overlay")?.textContent ?? ""));
  for (const digit of PIN) await hand.locator(`.overlay [data-pin="${digit}"]`).tap();
  await screen.waitForFunction(() => document.querySelector(".bar-right span")?.textContent === "radomir");
  await screen.close();
  await hand.close();
});

test("ADR-034 the phone shows a lock on a locked profile, and switching to it takes the PIN", async () => {
  const ana = (await (await fetch(`${url}/api/viewers`)).json()).viewers.find((v: { name: string }) => v.name === "ana");
  const locking = await fetch(`${url}/api/viewers/${ana.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-AgenTV-Grant": (await post("/api/pin/check", { pin: PIN })).grant },
    body: JSON.stringify({ locked: true }),
  });
  assert.equal(locking.status, 200);
  const screen = await tv();
  const hand = await phone();
  await hand.locator('[data-action="who"]').tap();
  await hand.waitForSelector(".viewer");
  assert.equal(await hand.locator(`[data-viewer="${ana.id}"] svg.glyph-lock`).count(), 1);
  assert.equal(await hand.locator('[data-viewer="radomir"] svg.glyph-lock').count(), 0);
  assert.match(await hand.locator(".typing").innerText(), /or to a locked one, needs the adult pin/);
  await hand.locator(`[data-viewer="${ana.id}"]`).tap();
  await hand.waitForSelector(".overlay .pin-keys");
  assert.match(await hand.locator(".overlay").innerText(), /for watching as ana\./);
  for (const digit of PIN) await hand.locator(`.overlay [data-pin="${digit}"]`).tap();
  await screen.waitForFunction(() => document.querySelector(".bar-right span")?.textContent === "ana");
  await post("/api/viewer", { id: "radomir" });
  await fetch(`${url}/api/viewers/${ana.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-AgenTV-Grant": (await post("/api/pin/check", { pin: PIN })).grant },
    body: JSON.stringify({ locked: false }),
  });
  await screen.close();
  await hand.close();
});

test("S4.7 arrange home on the phone: tap a tile, then where it goes, and the TV follows within a second", async () => {
  const screen = await tv();
  const hand = await phone();
  await hand.locator('[data-mode="home"]').tap();
  await hand.waitForSelector(".mini-grid");
  assert.match(await hand.locator(".page").innerText(), /arrange home[\s\S]*for radomir/);
  const layout = (await (await fetch(`${url}/api/home`)).json()).layout as { id: string; x: number; y: number }[];
  const apps = layout.find((t) => t.id === "apps")!;
  const empty = await hand.locator(".mini-empty").first().getAttribute("data-cell");
  assert.ok(empty, "there's an empty cell to move to");
  const [x, y] = empty!.split(",").map(Number);
  const before = await screen.locator('.grid .tile[data-id="apps"]').boundingBox();
  await hand.locator('.mini-tile[data-id="apps"]').tap();
  assert.match(await hand.locator(".sizes").innerText(), /size · all apps/);
  const at = Date.now();
  await hand.locator(`.mini-empty[data-cell="${empty}"]`).tap();
  await until(async () => {
    const box = await screen.locator('.grid .tile[data-id="apps"]').boundingBox();
    return Boolean(box && before && (box.x !== before.x || box.y !== before.y));
  });
  assert.ok(Date.now() - at < 1000, `the TV followed in ${Date.now() - at} ms`);
  const moved = (await (await fetch(`${url}/api/home`)).json()).layout.find((t: { id: string }) => t.id === "apps");
  assert.deepEqual([moved.x, moved.y], [x, y]);
  assert.notDeepEqual([apps.x, apps.y], [x, y]);
  // Unpinning one, and pinning it back.
  const first = layout.find((t) => t.id !== "apps")!;
  await hand.locator(`.mini-tile[data-id="${first.id}"]`).tap();
  await hand.locator('[data-action="unpin"]').tap();
  await hand.waitForSelector(`[data-pin="${first.id}"]`);
  await until(async () => (await screen.locator(`.grid .tile[data-id="${first.id}"]`).count()) === 0);
  await hand.locator(`[data-pin="${first.id}"]`).tap();
  await until(async () => (await screen.locator(`.grid .tile[data-id="${first.id}"]`).count()) === 1);
  await screen.close();
  await hand.close();
});

test("S4.8 the phone shows the update notice the TV does, and Install tonight from the phone takes the PIN", async () => {
  const status = {
    checked_at: new Date().toISOString(),
    ok: true,
    channel: "stable",
    agentv: { installed: "0.2.1-1", available: "0.3.0-1" },
    omarchy: { installed: "4.0.6-1", available: "4.5.0-1" },
    packages: 46,
    security: false,
    notes: { agentv: ["tiles come in small, medium and large"], agentv_date: "2026-10-22", omarchy: [] },
  };
  writeFileSync(join(updates, "status.json.next"), JSON.stringify(status));
  renameSync(join(updates, "status.json.next"), join(updates, "status.json"));
  const hand = await phone();
  await hand.waitForSelector('[data-action="update"]');
  assert.match(await hand.locator('[data-action="update"]').innerText(), /agentv 0\.3\.0 is ready ›/);
  await hand.locator('[data-action="update"]').tap();
  await hand.waitForSelector('[data-action="tonight"]');
  assert.match(await hand.locator(".page").innerText(), /agentv 0\.3\.0 is ready[\s\S]*omarchy 4\.5\.0[\s\S]*\+ tiles come in small, medium and large[\s\S]*install tonight[\s\S]*install now with pin[\s\S]*later/);
  await hand.locator('[data-action="tonight"]').tap();
  await hand.waitForSelector(".overlay .pin-keys");
  for (const digit of PIN) await hand.locator(`.overlay [data-pin="${digit}"]`).tap();
  await hand.waitForFunction(() => /it installs tonight, between 2 and 5/.test(document.body.textContent ?? ""));
  const tonight = (await (await fetch(`${url}/api/updates`)).json()).tonight;
  assert.equal(tonight?.version, "0.3.0-1", "the TV's install tonight has it");
  await hand.close();
});

test("S4.9 on the TV's sign-in screen, the phone offers fields its password manager fills, and nothing keeps them", async () => {
  const hand = await phone();
  await hand.locator('[data-mode="type"]').tap();
  await hand.waitForSelector("#tv-text");
  await post("/api/sign-in-screen", { app: "agentv.tube", name: "Tube" });
  await hand.waitForSelector("form #password", { timeout: 6000 });
  assert.equal(await hand.locator("#username").getAttribute("autocomplete"), "username");
  assert.equal(await hand.locator("#password").getAttribute("autocomplete"), "current-password");
  assert.equal(await hand.locator("#password").getAttribute("type"), "password");
  assert.match(await hand.locator("form").innerText(), /signing in to tube on the tv/);
  remote.length = 0;
  await hand.locator("#username").fill("ana@example.org");
  await hand.locator("#password").fill("correct horse");
  await hand.locator('[data-action="sign-in"]').tap();
  await until(() => remote.length >= 4);
  assert.deepEqual(remote, ['{"text":"ana@example.org"}', '{"key":"tab"}', '{"text":"correct horse"}', '{"key":"enter"}']);
  assert.equal(await hand.locator("#password").inputValue(), "", "the phone forgets it once it's sent");
  await post("/api/sign-in-screen", { app: null });
  await hand.close();
});

test("S4.5 the TV locked: the phone says so, and its PIN pad unlocks it", async () => {
  const screen = await tv();
  const hand = await phone();
  await post("/api/pin/lock");
  await screen.waitForFunction(() => document.getElementById("pin")?.classList.contains("on") === true);
  await hand.waitForSelector('[data-action="unlock"]', { timeout: 6000 });
  assert.equal(await hand.locator('[data-action="unlock"] svg.glyph-lock').count(), 1);
  await hand.locator('[data-action="unlock"]').tap();
  for (const digit of PIN) await hand.locator(`.overlay [data-pin="${digit}"]`).tap();
  await screen.waitForFunction(() => document.getElementById("pin")?.classList.contains("on") === false);
  await hand.waitForFunction(() => !document.querySelector('[data-action="unlock"]'), undefined, { timeout: 6000 });
  await screen.close();
  await hand.close();
});
