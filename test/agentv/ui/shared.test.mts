// Shared to the TV on the TV itself (ADR-050, S5.10): the notice with Open
// and Not now, over home and never over what's playing, a photo full screen
// with its credit and "make it the background", a video in AgenTV's player,
// a link opened through the TV session, Apps → Shared, and a child's
// profile that takes shares only once an adult allows it.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { ROOT, rest, startBox } from "./box.mts";

const require = createRequire(join(process.env.AGENTV_UI_MODULES ?? join(ROOT, "node_modules"), "x.js"));
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const CLIP = readFileSync(join(ROOT, "test/agentv/fixtures/shared/clip.webm"));
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);
const PIN = "4826";

let browser: Browser;
let daemon: Daemon;
let url = "";
let lan = "";
let token = "";
const dir = mkdtempSync(join(tmpdir(), "agentv-shared-ui-"));

before(async () => {
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  process.env.AGENTV_PASSWD = passwd;
  ({ daemon, url } = await startBox());
  lan = `http://127.0.0.1:${daemon.lanPort}`;
  const code = (await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json()).pairing.code;
  token = (await (await fetch(`${lan}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "iphone" }) })).json()).token;
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  delete process.env.AGENTV_PASSWD;
  rmSync(dir, { recursive: true, force: true });
});

const post = async (path: string, body?: unknown, grant?: string) =>
  (await fetch(`${url}${path}`, { method: "POST", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })).json();

// What a phone sends, as the companion's Share page does.
async function share(kind: "link" | "photo" | "video", body: unknown, query = ""): Promise<{ status: number; data: any }> {
  const json = kind === "link";
  const response = await fetch(`${lan}/api/phone/share/${kind}${query}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": json ? "application/json" : kind === "photo" ? "image/jpeg" : "video/webm" },
    body: json ? JSON.stringify(body) : new Uint8Array(body as Buffer),
  });
  return { status: response.status, data: await response.json() };
}

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: unknown[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  await rest(page);
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const focused = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>(".focused")?.dataset.action ?? "");
const clear = async () => {
  for (const one of (await (await fetch(`${url}/api/shared`)).json()).shares) await fetch(`${url}/api/shared/${one.id}`, { method: "DELETE" });
};

test("S5.10 home drawn again under the notice leaves the notice the keys: OK is still Open", async () => {
  await clear();
  const page = await tv();
  try {
    await share("photo", JPEG, "?credit=photo%20by%20ana");
    await page.waitForSelector("#notice.on .notice-card");
    assert.equal(await focused(page), "share-open");
    // The TV session says an app is open behind home, which draws home again.
    await page.evaluate(() => ((document.querySelector(".grid") as unknown as { drawn?: boolean }).drawn = true));
    await page.evaluate(() => (window as unknown as { agentvRunning: (json: string) => void }).agentvRunning(JSON.stringify([{ id: "agentv.tube", game: false, paused: true }])));
    await page.waitForFunction(() => document.querySelector(".grid") && !(document.querySelector(".grid") as unknown as { drawn?: boolean }).drawn);
    assert.equal(await focused(page), "share-open", "Open still has the focus");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".shared-full img.shared-picture");
    // Back: home, with the focus on its tiles again.
    await page.keyboard.press("Escape");
    await page.waitForSelector(".grid .tile.focused");
  } finally {
    await page.close();
    await clear();
  }
});

test("S5.10 a share that came before the TV heard the daemon's events is asked about once it does", async () => {
  await clear();
  // Home's page loads, and its events come late, as on a busy box: the
  // share comes in between and its word is missed.
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  let late: () => void = () => {};
  const heard = new Promise<void>((resolve) => (late = resolve));
  await page.route("**/api/events", async (route) => {
    await heard;
    await route.continue();
  });
  try {
    await page.goto(`${url}/`);
    await page.waitForSelector(".grid .tile.focused");
    await share("photo", JPEG, "?credit=photo%20by%20ana");
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#notice.on").count(), 0, "nothing heard yet");
    late();
    await page.waitForSelector("#notice.on .notice-card", { timeout: 10_000 });
    assert.equal(await focused(page), "share-open");
  } finally {
    await page.close();
    await clear();
  }
});

test("S5.10 an answer to the notice holds, even when an older look at the shares comes back after it", async () => {
  await clear();
  const page = await tv();
  try {
    await share("photo", JPEG, "?credit=photo%20by%20ana");
    await page.waitForSelector("#notice.on .notice-card");
    // The next look at the shares is read now, while the photo waits, and
    // comes back late.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let read: () => void = () => {};
    const wasRead = new Promise<void>((resolve) => (read = resolve));
    let held = false;
    await page.route("**/api/shared", async (route) => {
      if (held || route.request().method() !== "GET") return route.continue();
      held = true;
      const reply = await route.fetch();
      read();
      await released;
      await route.fulfill({ response: reply });
    });
    // Away from home and back, which has the daemon say "shared" again.
    await post("/api/tv/context", { front: "app" });
    await post("/api/tv/context", { front: "home" });
    await wasRead;
    // Not now, then the old look comes back: the notice stays answered.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("notice")?.classList.contains("on"));
    release();
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#notice.on").count(), 0, "the answered photo isn't asked about again");
    assert.ok(await page.locator(".grid .tile.focused").isVisible());
  } finally {
    await page.close();
    await clear();
  }
});

test("S5.10 a photo waits for Open on the TV: Not now keeps it in Apps → Shared, and Open shows it full screen with its credit, to be the background", async () => {
  const page = await tv();
  try {
    const sent = await share("photo", JPEG, "?credit=photo%20by%20ana");
    assert.equal(sent.status, 200);
    await page.waitForSelector("#notice.on .notice-card");
    assert.equal(await page.locator(".notice-title").innerText(), "radomir on iphone sent a photo: photo by ana");
    assert.equal(await focused(page), "share-open", "Open has the focus");
    // Back is Not now: it's answered, and home has the focus again.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("notice")?.classList.contains("on"));
    assert.ok(await page.locator(".grid .tile.focused").isVisible());
    assert.equal((await (await fetch(`${url}/api/shared`)).json()).shares[0].answered, true);
    // Apps → Shared has it, the photo itself on its tile.
    await go(page, "apps");
    await page.waitForSelector(`.tile-shared[data-share="${sent.data.share.id}"] img.tile-shared-photo`);
    await page.locator(`.tile-shared[data-share="${sent.data.share.id}"]`).click();
    await page.waitForSelector(".shared-full img.shared-picture");
    assert.equal(await page.locator(".shared-line").innerText(), "photo by ana · radomir on iphone");
    const shown = await page.locator(".shared-picture").evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0);
    assert.ok(shown, "the photo is drawn");
    await page.locator('[data-action="shared-background"]').click();
    await page.waitForFunction(() => /background now/.test(document.getElementById("toasts")?.textContent ?? ""));
    const backgrounds = await (await fetch(`${url}/api/backgrounds`)).json();
    assert.equal(backgrounds.items.find((item: { id: string }) => item.id === backgrounds.current).credit.text, "photo by ana");
    // Back closes it.
    await page.keyboard.press("Escape");
    await page.waitForSelector(".tile-shared");
  } finally {
    await page.close();
    await clear();
  }
});

test("S5.10 a video never interrupts what's playing: it asks once nothing is, and Open plays it in AgenTV's player, where OK pauses it", async () => {
  const page = await tv();
  try {
    await post("/api/tv/context", { front: "app", playing: true });
    const sent = await share("video", CLIP, "?name=clip.webm");
    assert.equal(sent.data.waits, true);
    await page.waitForTimeout(600);
    assert.equal(await page.locator("#notice.on").count(), 0, "nothing over what's playing");
    // Home again with nothing playing: now it asks.
    await post("/api/tv/context", { front: "home", playing: false });
    await page.waitForSelector("#notice.on .notice-card");
    assert.equal(await page.locator(".notice-title").innerText(), "radomir on iphone sent a video: clip.webm");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".shared-full video.shared-video");
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>("video.shared-video");
      return Boolean(video && !video.paused && video.currentTime > 0.3);
    }, undefined, { timeout: 10_000 });
    // OK pauses it, and the player's line says so.
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>("video.shared-video")?.paused === true);
    await page.waitForSelector(".shared-player.shown");
    assert.match(await page.locator(".shared-player").innerText(), /clip\.webm · radomir on iphone[\s\S]*\d:\d\d \/ 0:0[56][\s\S]*paused/);
    // Right goes on 10 s, to the end of a short one.
    const at = await page.evaluate(() => document.querySelector<HTMLVideoElement>("video.shared-video")!.currentTime);
    await page.keyboard.press("ArrowRight");
    assert.ok((await page.evaluate(() => document.querySelector<HTMLVideoElement>("video.shared-video")!.currentTime)) > at);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("video.shared-video"));
  } finally {
    await page.close();
    await clear();
  }
});

test("S5.10 a link's Open goes to the TV session, which opens it in its app or a browser page of its own, and Delete in Apps → Shared takes it off", async () => {
  const page = await tv();
  try {
    const sent = await share("link", { url: "https://www.example.org/watch" });
    await page.waitForSelector("#notice.on .notice-card");
    assert.equal(await page.locator(".notice-title").innerText(), "radomir on iphone sent a link: example.org");
    await page.keyboard.press("Enter");
    await page.waitForFunction((id) => (window as unknown as { screenRequests: { cmd: string; share?: string }[] }).screenRequests.some((r) => r.cmd === "open-share" && r.share === id), sent.data.share.id);
    // In Apps → Shared, Delete takes it off.
    await go(page, "apps");
    const tile = page.locator(`.tile-shared[data-share="${sent.data.share.id}"]`);
    await tile.hover();
    await page.keyboard.press("Delete");
    await page.waitForFunction((id) => !document.querySelector(`.tile-shared[data-share="${id}"]`), sent.data.share.id);
    assert.deepEqual((await (await fetch(`${url}/api/shared`)).json()).shares, []);
  } finally {
    await page.close();
    await clear();
  }
});

test("S5.10 a child's profile takes what phones share only once an adult allows it in the profile, past the PIN", async () => {
  daemon.pin.set(PIN, undefined);
  const grant = (await post("/api/pin/check", { pin: PIN })).grant as string;
  const mila = (await post("/api/viewers", { name: "mila", role: "child" }, grant)).profile;
  const page = await tv();
  try {
    await go(page, `profile/${mila.id}`);
    await page.waitForSelector('[data-action="shares"]');
    assert.match(await page.locator('[data-action="shares"]').innerText(), /take what phones share\s*‹ no ›/);
    await page.locator('[data-action="shares"]').hover();
    await page.keyboard.press("ArrowRight");
    assert.match(await page.locator('[data-action="shares"]').innerText(), /‹ yes ›/);
    await page.locator('[data-action="save"]').click();
    // Saving a profile takes the PIN.
    await page.waitForSelector("#pin.on");
    for (const digit of PIN) await page.keyboard.press(digit);
    await page.waitForFunction(() => /mila is saved/.test(document.getElementById("toasts")?.textContent ?? ""));
    assert.deepEqual((await (await fetch(`${url}/api/shared`)).json()).allowed, [mila.id]);
    // An adult's profile isn't asked.
    await go(page, "profile/radomir");
    await page.waitForSelector('[data-action="save"]');
    assert.equal(await page.locator('[data-action="shares"]').isVisible(), false);
  } finally {
    await page.close();
    await fetch(`${url}/api/viewers/${mila.id}`, { method: "DELETE", headers: { "X-AgenTV-Grant": (await post("/api/pin/check", { pin: PIN })).grant } });
  }
});

test("S5.10 a shared link opens in the app that declares its site, if who's watching may open it, or else in the share browser", async () => {
  try {
    const tube = await share("link", { url: "https://tube.example/watch?v=1" });
    const other = await share("link", { url: "https://www.example.org/" });
    const target = async (id: string) => (await fetch(`${url}/api/shared/${id}/target`)).json();
    assert.deepEqual(await target(tube.data.share.id), { ok: true, url: "https://tube.example/watch?v=1", app: "agentv.tube" });
    assert.deepEqual(await target(other.data.share.id), { ok: true, url: "https://www.example.org/" });
    // A child's profile, allowed to take shares but not Tube: the share
    // browser, not the app.
    daemon.pin.set(PIN, undefined);
    const grant = (await post("/api/pin/check", { pin: PIN })).grant as string;
    const noa = (await post("/api/viewers", { name: "noa", role: "child", shares: true }, grant)).profile;
    await post("/api/viewer", { id: noa.id });
    const theirs = await share("link", { url: "https://tube.example/cartoons" });
    assert.equal(theirs.status, 200);
    assert.deepEqual(await target(theirs.data.share.id), { ok: true, url: "https://tube.example/cartoons" });
    // A photo has nowhere to open but its own page.
    const photo = await share("photo", JPEG);
    assert.equal((await fetch(`${url}/api/shared/${photo.data.share.id}/target`)).status, 400);
    await post("/api/viewer", { id: "radomir" }, (await post("/api/pin/check", { pin: PIN })).grant);
    await fetch(`${url}/api/viewers/${noa.id}`, { method: "DELETE", headers: { "X-AgenTV-Grant": (await post("/api/pin/check", { pin: PIN })).grant } });
  } finally {
    await clear();
  }
});
