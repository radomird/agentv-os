// Page apps on home in a real Chromium (ADR-043): each full screen in a
// sandboxed frame on its own origin, with the remote, a gamepad, Back and
// Home as the kit has them, its storage, tile and notices, the photos
// through the TV session, and nothing else of the box's (S6.6, S6.7 and
// S6.8's parts here). Two probe apps record what reaches them.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Frame, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, ROOT, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let port = "";
let appsDir = "";

// A 2 × 2 PNG, as a photo from the NAS.
const PHOTO = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR42mNkYPj/n4GBgYGJAQoAAAkBAQBr6GWhAAAAAElFTkSuQmCC";

// A probe: it keeps everything that reaches it in window.log, keeps Back
// as many times as keepBacks says, and does what the test asks through
// window.probe.
function probe(id: string, name: string, tv: Record<string, unknown>, keepBacks: number | null): void {
  const dir = join(appsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id, name, version: "1.0.0", author: "agentv", license: "MIT",
    description: "A probe for the page runtime's checks", kinds: ["tv-app"], entryPoints: { page: "index.html" },
    tv: { contract: 2, category: "utility", runtime: "page", capabilities: ["launch"], ...tv },
  }));
  writeFileSync(join(dir, "index.html"), '<!doctype html><html><body><p id="say">probe</p><script src="/_agentv/kit.js"></script><script src="probe.js"></script></body></html>');
  writeFileSync(join(dir, "probe.js"), `
const kit = window.agentv;
window.log = [];
window.loads = (window.loads || 0) + 1;
kit.input.on((e) => window.log.push(["input", e.button, e.down, e.source, e.pad ?? null]));
kit.onPause(() => window.log.push(["pause"]));
kit.onResume(() => window.log.push(["resume"]));
let backs = ${keepBacks === null ? "null" : keepBacks};
if (backs !== null) kit.onBack(() => { window.log.push(["back"]); return backs-- > 0; });
window.probe = {
  call: async (what, ...args) => {
    const parts = what.split(".");
    const fn = parts.length === 2 ? kit[parts[0]][parts[1]] : kit[what];
    try { const value = await fn(...args); return value === undefined ? { ok: true } : { ok: true, value }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
  },
  photo: async (id) => {
    const src = await kit.photos.url(id, { width: 64 });
    const img = new Image();
    img.src = src;
    await img.decode();
    return { scheme: src.split(":")[0], width: img.naturalWidth };
  },
  reach: async (address) => { try { const r = await fetch(address); return "status " + r.status; } catch (e) { return "refused"; } },
  local: () => { try { localStorage.setItem("x", "1"); return "worked"; } catch (e) { return "refused"; } },
  home: () => { try { return window.parent.document.title; } catch (e) { return "refused"; } },
  leave: (address) => { location.href = address; },
};
kit.ready();
`);
  const installed = JSON.parse(readFileSync(join(appsDir, "installed.json"), "utf8"));
  installed[id] = { id, name, version: "1.0.0", tier: "official", installedAt: "2026-10-27T12:00:00Z" };
  writeFileSync(join(appsDir, "installed.json"), JSON.stringify(installed, null, 2));
}

before(async () => {
  let apps = "";
  ({ daemon, url, apps } = await startBox(0, FIXTURES));
  appsDir = apps;
  port = new URL(url).port;
  cpSync(join(ROOT, "test/agentv/fixtures/apps/blocks"), join(appsDir, "agentv.blocks"), { recursive: true });
  const installed = JSON.parse(readFileSync(join(appsDir, "installed.json"), "utf8"));
  installed["agentv.blocks"] = { id: "agentv.blocks", name: "Blocks", version: "1.0.0", tier: "official", installedAt: "2026-10-27T12:00:00Z" };
  writeFileSync(join(appsDir, "installed.json"), JSON.stringify(installed, null, 2));
  probe("agentv.probe", "Probe", { capabilities: ["launch", "tile"], media: ["photos"], notices: true, tiles: { s: "logo", m: "probe" } }, 1);
  probe("agentv.other", "Other", {}, null);
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

// The launcher, with a stand-in for the screen daemon that answers a page
// app's photos, and a gamepad the test holds.
async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(
    ({ photo }) => {
      if (window.top !== window) return;
      const w = window as unknown as Record<string, any>;
      w.screenRequests = [];
      w.agentvScreen = (json: string) => {
        const request = JSON.parse(json);
        w.screenRequests.push(request);
        let reply: object = { ok: true };
        if (request.cmd === "kit") {
          if (request.app !== "agentv.probe") reply = { ok: false, error: `${request.app} didn't declare what ${request.call} needs` };
          else if (request.call === "photos.sources") reply = { ok: true, value: [{ id: "abc", name: "nas/photos", kind: "share" }] };
          else if (request.call === "photos.image") reply = { ok: true, value: { type: "image/png", bytes: photo } };
          else reply = { ok: false, error: "not here" };
        }
        setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify(reply)), 0);
      };
      // A gamepad, held as the test says.
      w.pad = { index: 0, connected: true, buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] };
      w.padOn = false;
      Object.defineProperty(navigator, "getGamepads", { value: () => (w.padOn ? [w.pad] : []) });
    },
    { photo: PHOTO },
  );
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

// The app's frame, once its page has run: the probe's own script, or for
// Blocks the kit.
async function appFrame(page: Page, id: string): Promise<Frame> {
  const origin = `http://${id}.app.localhost:${port}`;
  const probes = id !== "agentv.blocks";
  for (let i = 0; i < 200; i++) {
    const frame = page.frames().find((f) => f.url().startsWith(origin));
    const ran = frame && (await frame.evaluate((probes) => Boolean(probes ? (window as any).probe : (window as any).agentv), probes).catch(() => false));
    if (ran) return frame!;
    await page.waitForTimeout(50);
  }
  throw new Error(`${id}'s frame didn't come`);
}

async function open(page: Page, id: string): Promise<Frame> {
  await page.evaluate((id) => (window as any).agentvPage(id), id);
  return appFrame(page, id);
}

const log = (frame: Frame) => frame.evaluate(() => (window as any).log as unknown[][]);
const clear = (frame: Frame) => frame.evaluate(() => void ((window as any).log.length = 0));

test("ADR-043 S6.6 a page app opens from its tile, full screen in its own sandboxed frame", async () => {
  const page = await tv();
  await page.click('.tile[data-id="agentv.blocks"]');
  const frame = await appFrame(page, "agentv.blocks");
  const box = await page.locator('.page-app.on iframe').boundingBox();
  assert.deepEqual(box, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(await page.getAttribute(".page-app.on iframe", "sandbox"), "allow-scripts");
  assert.equal(await frame.evaluate(() => origin), "null");
  assert.equal(await frame.evaluate(() => typeof (window as any).agentv.storage.get), "function");
  await page.waitForSelector(".page-app.on:not(.loading)");
  await page.close();
});

test("ADR-043 the remote's keys reach the app pressed and let go; Back and Home stay home's", async () => {
  const page = await tv();
  const frame = await open(page, "agentv.probe");
  await clear(frame);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter"); // a key held repeats; the app hears it once
  await page.keyboard.up("Enter");
  await page.waitForTimeout(100);
  assert.deepEqual(await log(frame), [
    ["input", "left", true, "remote", null],
    ["input", "left", false, "remote", null],
    ["input", "ok", true, "remote", null],
    ["input", "ok", false, "remote", null],
  ]);
  // The launcher didn't act on them as its own: home's focus didn't move.
  assert.equal(await page.evaluate(() => location.hash), "");
  await page.close();
});

test("ADR-043 S6.6 a gamepad's buttons and stick reach the app, and B is Back", async () => {
  const page = await tv();
  const frame = await open(page, "agentv.probe");
  await clear(frame);
  await page.evaluate(() => {
    const w = window as any;
    w.padOn = true;
    w.pad.buttons[0].pressed = true;
    w.pad.axes[0] = -0.9;
    w.agentvPadPoll();
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const w = window as any;
    w.pad.buttons[0].pressed = false;
    w.pad.axes[0] = 0;
    w.pad.buttons[2].pressed = true;
  });
  await page.waitForTimeout(100);
  const got = (await log(frame)).map((e) => e.slice(1, 4).join(" "));
  assert.deepEqual(got, ["ok true gamepad", "left true gamepad", "x true gamepad", "ok false gamepad", "left false gamepad"]);
  await page.evaluate(() => void ((window as any).padOn = false));
  await page.close();
});

test("ADR-043 Back goes to the app first, and leaves it when the app lets it go", async () => {
  const page = await tv();
  const frame = await open(page, "agentv.probe");
  await clear(frame);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  assert.deepEqual(await log(frame), [["back"]]);
  assert.equal(await page.locator(".page-app.on").count(), 1);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".page-app", { state: "detached" });
  assert.equal(await page.locator(".grid").count(), 1);
  await page.close();
});

test("ADR-043 a Back pressed while the app answers the one before still counts", async () => {
  const page = await tv();
  const frame = await open(page, "agentv.probe");
  await clear(frame);
  // The app busy for a moment, so its answer to the first Back comes after
  // the second press. It keeps the first and lets the second go.
  await frame.evaluate(() => void setTimeout(() => {
    const until = performance.now() + 150;
    while (performance.now() < until);
  }, 0));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".page-app", { state: "detached", timeout: 3000 });
  await page.close();
});

test("ADR-043 an app with no Back of its own is left on Back", async () => {
  const page = await tv();
  await open(page, "agentv.other");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".page-app", { state: "detached", timeout: 2000 });
  await page.close();
});

test("ADR-031 Home pauses a page app and keeps it; choosing it again resumes the same page", async () => {
  const page = await tv();
  const frame = await open(page, "agentv.probe");
  await clear(frame);
  await page.evaluate(() => (window as any).agentvHome());
  await page.waitForSelector(".grid");
  assert.equal(await page.locator(".page-app.on").count(), 0);
  assert.match(await page.locator('.tile[data-id="agentv.probe"] .tile-state').innerText(), /paused/);
  await page.click('.tile[data-id="agentv.probe"]');
  await page.waitForSelector(".page-app.on");
  assert.deepEqual(await log(frame), [["pause"], ["resume"]]);
  assert.equal(await frame.evaluate(() => (window as any).loads), 1);
  await page.close();
});

test("ADR-043 S6.8 a page app can't reach the daemon, the browser's storage, home or an undeclared origin", async () => {
  const page = await tv();
  const frame = await open(page, "agentv.probe");
  const reach = (address: string) => frame.evaluate((a) => (window as any).probe.reach(a), address);
  assert.equal(await reach(`http://127.0.0.1:${port}/api/home`), "refused");
  assert.equal(await reach(`http://localhost:${port}/api/key`), "refused");
  assert.equal(await reach(`http://agentv.other.app.localhost:${port}/probe.js`), "refused");
  assert.equal(await reach("https://elsewhere.example/"), "refused");
  assert.equal(await reach("/probe.js"), "status 200");
  assert.equal(await frame.evaluate(() => (window as any).probe.local()), "refused");
  assert.equal(await frame.evaluate(() => (window as any).probe.home()), "refused");
  await page.close();
});

test("ADR-043 S6.8 a page app's storage is its own, and a call it didn't declare fails", async () => {
  const page = await tv();
  const probeFrame = await open(page, "agentv.probe");
  const call = (frame: Frame, what: string, ...args: unknown[]) => frame.evaluate(({ what, args }) => (window as any).probe.call(what, ...args), { what, args });
  assert.deepEqual(await call(probeFrame, "storage.set", "best", 42), { ok: true });
  const other = await open(page, "agentv.other");
  assert.deepEqual(await call(other, "storage.get", "best"), { ok: true, value: null });
  const tile = await call(other, "tile.set", { headline: { label: "x" } });
  assert.equal(tile.ok, false);
  assert.match(tile.error, /didn't declare what tile\.set needs/);
  const photos = await call(other, "photos.sources");
  assert.equal(photos.ok, false);
  await page.close();
});

test("ADR-043 S6.8 a page that leaves its own page is closed", async () => {
  const page = await tv();
  const frame = await open(page, "agentv.other");
  await frame.evaluate((p) => (window as any).probe.leave(`http://agentv.probe.app.localhost:${p}/`), port).catch(() => {});
  await page.waitForSelector(".page-app", { state: "detached", timeout: 5000 });
  assert.match(await page.locator(".toast").last().innerText(), /tried to leave its page/);
  await page.close();
});

test("ADR-043 S6.6 S6.7 the kit: storage across opens, a tile on home, a notice, who's watching, the photos", async () => {
  const page = await tv();
  let frame = await open(page, "agentv.probe");
  const call = (what: string, ...args: unknown[]) => frame.evaluate(({ what, args }) => (window as any).probe.call(what, ...args), { what, args });
  assert.deepEqual(await call("storage.set", "scores", [300, 200]), { ok: true });
  const viewer = await call("viewer");
  assert.equal(viewer.value.role, "adult");
  assert.deepEqual(await call("tile.set", { headline: { label: "best", value: "300" } }), { ok: true });
  assert.deepEqual(await call("notify", "a new best"), { ok: true });
  await page.waitForSelector(".toast >> text=probe: a new best");
  const sources = await call("photos.sources");
  assert.deepEqual(sources.value, [{ id: "abc", name: "nas/photos", kind: "share" }]);
  assert.deepEqual(await frame.evaluate(() => (window as any).probe.photo("p1")), { scheme: "blob", width: 2 });
  // Closed with Back twice, then opened again: what it kept is there.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".page-app", { state: "detached" });
  frame = await open(page, "agentv.probe");
  assert.deepEqual(await call("storage.get", "scores"), { ok: true, value: [300, 200] });
  // Home shows the tile it set.
  await page.evaluate(() => (window as any).agentvHome());
  await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: [{ id: "agentv.probe", x: 0, y: 0, size: "m" }, { id: "apps", x: 3, y: 2, size: "s" }] }) });
  await page.waitForSelector('.tile[data-id="agentv.probe"] >> text=300');
  await page.close();
});
