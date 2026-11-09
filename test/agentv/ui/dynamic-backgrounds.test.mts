// Omarchy's dynamic backgrounds on home (ADR-064, T6.1), in a real Chromium:
// a stand-in theme's video background loops behind home, muted, and stops
// when an app comes in front; its intro plays once and ends on its still. Both
// only with the dynamicbg switch on, only where the box decodes the codec in
// hardware, and never with reduce motion or Omarchy's intros off. The TV
// session's side is stood in for by its own video server, serving the two
// stand-in videos from where they are.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { VideoServer } from "../../../daemon/theme-videos.ts";
import { ROOT, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const FIXTURES = join(ROOT, "test/agentv/fixtures/videos");
const LOOP = join(FIXTURES, "loop.webm");
const INTRO = join(FIXTURES, "intro.webm");
const LOOP_STILL = readFileSync(join(FIXTURES, "loop-still.jpg"));
const INTRO_STILL = readFileSync(join(FIXTURES, "intro-still.jpg"));
const pictureId = (body: Buffer) => createHash("sha256").update(body).digest("hex").slice(0, 16);
// A video's id is the TV session's own.
const LOOP_ID = "10000000000000aa";
const INTRO_ID = "10000000000000bb";
const STILL_ID = pictureId(INTRO_STILL);
const POSTER_ID = pictureId(LOOP_STILL);

let browser: Browser;
let daemon: Daemon;
let url = "";
let channel = "";
const videos = new VideoServer();
let serve = "";

before(async () => {
  let state: string;
  ({ daemon, url, state } = await startBox());
  // An edge box, which can turn the switch on.
  channel = join(state, "..", "channel");
  writeFileSync(channel, "edge\n");
  serve = await videos.listen();
  videos.offer(
    new Map([
      [LOOP_ID, { path: LOOP, type: "video/webm" as const }],
      [INTRO_ID, { path: INTRO, type: "video/webm" as const }],
    ]),
  );
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER, args: ["--autoplay-policy=no-user-gesture-required"] });
});

after(async () => {
  await browser?.close();
  await videos.close();
  await daemon?.close();
});

async function dynamic(on: boolean): Promise<void> {
  const answer = await fetch(`${url}/api/features`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "dynamicbg", on }) });
  assert.equal(answer.status, 200);
}

// What the TV session hands over for a stand-in Nord: its own video
// background first, then a picture with its intro, and which one Omarchy
// shows, whether its intros are on, and the intro that's due.
async function theme(current: "loop" | "still", introDue: string | null, intros = true): Promise<void> {
  const files = [
    { id: LOOP_ID, type: "video/webm", video: { codec: "vp9", width: 320, height: 180, poster: { id: POSTER_ID, type: "image/jpeg" } } },
    { id: STILL_ID, type: "image/jpeg", intro: { id: INTRO_ID, type: "video/webm", codec: "vp9", width: 320, height: 180 } },
  ];
  const put = await fetch(`${url}/api/backgrounds/theme`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme: "nord", current: current === "loop" ? LOOP_ID : STILL_ID, files, intros, introDue, serve }),
  });
  const { need } = (await put.json()) as { need: string[] };
  for (const id of need) await fetch(`${url}/api/backgrounds/theme/${id}`, { method: "POST", body: new Uint8Array(id === POSTER_ID ? LOOP_STILL : INTRO_STILL) });
  await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "theme" }) });
}

// A TV at 1080p, with the box check stood in for: the codecs its GPU
// decodes, or no check at all.
async function tv(options: { decode?: string[] | null; reducedMotion?: "reduce" | "no-preference" } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: options.reducedMotion ?? "no-preference" });
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  const decode = options.decode === undefined ? ["h264", "hevc", "vp9"] : options.decode;
  await page.route("**/api/box", (route) =>
    decode === null ? route.fulfill({ status: 404, json: { ok: false, error: "not found" } }) : route.fulfill({ json: { gpu: { vendor: "intel", name: "Iris Plus 655", decode } } }),
  );
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

type Status = { id: string | null; moving: "loop" | "intro" | null; playing: boolean };
const status = (page: Page) => page.evaluate(() => (window as unknown as { agentvLauncher: { backdrop: { status(): Status } } }).agentvLauncher.backdrop.status());
const front = (page: Page, app: boolean) => page.evaluate((on) => (window as unknown as { agentvFront: (app: boolean) => void }).agentvFront(on), app);

// Until the backdrop's video has gone back to its start at least once.
function loops(page: Page): Promise<unknown> {
  return page.waitForFunction(
    () => {
      const w = window as unknown as { lastTime?: number; looped?: boolean };
      const video = document.querySelector<HTMLVideoElement>("#backdrop video.backdrop-video");
      if (!video) return false;
      if (w.lastTime !== undefined && video.currentTime + 0.05 < w.lastTime) w.looped = true;
      w.lastTime = video.currentTime;
      return w.looped === true;
    },
    null,
    { polling: 50, timeout: 10_000 },
  );
}

async function introShown(): Promise<{ due: string; how: string; why: string | null } | null> {
  return (await (await fetch(`${url}/api/backgrounds`)).json()).theme.introShown;
}

test("T6.1 with the switch off, home keeps to stills: no video background and no intro", async () => {
  await dynamic(false);
  await theme("loop", "00000000000000000000000000000001");
  const page = await tv();
  try {
    await page.waitForSelector(`#backdrop img[data-id="${STILL_ID}"]`, { timeout: 5000 });
    await page.waitForTimeout(800);
    assert.equal(await page.locator("#backdrop video").count(), 0, "nothing moves");
    assert.equal(await introShown(), null, "and the intro is still due for when the switch is on");
  } finally {
    await page.close();
  }
});

test("T6.1 a video background loops behind home, muted, and stops while an app is in front, another page is up or the ambient screen is on", async () => {
  await dynamic(true);
  await theme("loop", null);
  const page = await tv();
  try {
    const video = page.locator("#backdrop video.backdrop-video");
    await video.waitFor({ timeout: 5000 });
    assert.deepEqual(
      await video.evaluate((el: HTMLVideoElement) => [el.muted, el.loop, el.getAttribute("src"), el.getAttribute("poster")]),
      [true, true, `/api/backgrounds/video/${LOOP_ID}`, `/api/backgrounds/${POSTER_ID}`],
    );
    assert.equal(await page.locator(`#backdrop img[data-id="${LOOP_ID}"]`).count(), 1, "its still is under it");
    await loops(page);

    // An app comes in front, then home again.
    await front(page, true);
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>("#backdrop video")?.paused === true);
    const at = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    await page.waitForTimeout(500);
    assert.equal(await video.evaluate((el: HTMLVideoElement) => el.currentTime), at, "paused under the app");
    await front(page, false);
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>("#backdrop video")?.paused === false);

    // Settings covers home: paused there too, and playing again after.
    await page.locator('.bar-link:has-text("settings")').click();
    await page.waitForSelector(".menu");
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>("#backdrop video")?.paused === true);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".grid .tile.focused");
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>("#backdrop video")?.paused === false);

    // The ambient screen loops it too, and home's own waits under it.
    await page.evaluate(() => (window as unknown as { agentvAmbient: (on: boolean) => void }).agentvAmbient(true));
    await page.waitForSelector("#ambient.on video.ambient-picture.on", { timeout: 5000 });
    assert.equal(await page.locator("#ambient video.ambient-picture").evaluate((el: HTMLVideoElement) => [el.muted, el.loop].join()), "true,true");
    assert.equal((await status(page)).playing, false, "home's is paused under the ambient screen");
    await page.evaluate(() => (window as unknown as { agentvAmbient: (on: boolean) => void }).agentvAmbient(false));
    assert.equal(await page.locator("#ambient video").count(), 0, "the ambient screen's video goes with it");
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>("#backdrop video")?.paused === false);
  } finally {
    await page.close();
  }
});

test("T6.1 a video background stays still without hardware decoding for its codec, without a box check, and with reduce motion or Omarchy's intros off", async () => {
  await dynamic(true);
  await theme("loop", null);
  for (const [why, options] of [
    ["the box decodes h264 only, and this is vp9", { decode: ["h264"] }],
    ["the box has no check yet", { decode: null }],
    ["reduce motion", { reducedMotion: "reduce" as const }],
  ] as const) {
    const page = await tv(options);
    try {
      await page.waitForSelector(`#backdrop img[data-id="${LOOP_ID}"][src="/api/backgrounds/${POSTER_ID}"]`, { timeout: 5000 });
      await page.waitForTimeout(500);
      assert.equal(await page.locator("#backdrop video").count(), 0, why);
    } finally {
      await page.close();
    }
  }
  await theme("loop", null, false);
  const page = await tv();
  try {
    await page.waitForSelector(`#backdrop img[data-id="${LOOP_ID}"]`, { timeout: 5000 });
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#backdrop video").count(), 0, "Omarchy's intros off");
  } finally {
    await page.close();
  }
});

test("T6.1 an intro plays once, muted, and ends on its still; it plays again only when another is due", async () => {
  await dynamic(true);
  const due = "00000000000000000000000000000002";
  await theme("still", due);
  const page = await tv();
  try {
    const intro = page.locator("#backdrop video.backdrop-intro");
    await intro.waitFor({ timeout: 5000 });
    assert.deepEqual(await intro.evaluate((el: HTMLVideoElement) => [el.muted, el.loop, el.getAttribute("src")]), [true, false, `/api/backgrounds/video/${INTRO_ID}`]);
    assert.equal(await page.locator(`#backdrop img[data-id="${STILL_ID}"]`).evaluate((el) => getComputedStyle(el).opacity), "0", "the still waits under it");
    // It ends, and the still is there.
    await page.waitForSelector("#backdrop video", { state: "detached", timeout: 10_000 });
    assert.equal(await page.locator(`#backdrop img[data-id="${STILL_ID}"]`).evaluate((el) => getComputedStyle(el).opacity), "1");
    assert.deepEqual(await introShown(), { due, how: "played", why: null }, "the daemon heard it played");

    // Home loading again doesn't play it again.
    await page.reload();
    await page.waitForSelector(".grid .tile.focused");
    await page.waitForSelector(`#backdrop img[data-id="${STILL_ID}"]`);
    await page.waitForTimeout(800);
    assert.equal(await page.locator("#backdrop video").count(), 0);

    // Another theme picked, and back: due again, so it plays again.
    const next = "00000000000000000000000000000003";
    await theme("still", next);
    await page.locator("#backdrop video.backdrop-intro").waitFor({ timeout: 5000 });
    await page.waitForSelector("#backdrop video", { state: "detached", timeout: 10_000 });
    assert.deepEqual(await introShown(), { due: next, how: "played", why: null });
  } finally {
    await page.close();
  }
});

test("T6.1 an intro due while an app is in front waits for home, and with Omarchy's intros off home shows the still and says why", async () => {
  await dynamic(true);
  await theme("still", null);
  const page = await tv();
  try {
    await page.waitForSelector(`#backdrop img[data-id="${STILL_ID}"]`);
    await front(page, true);
    const due = "00000000000000000000000000000004";
    await theme("still", due);
    await page.waitForTimeout(1000);
    assert.equal(await page.locator("#backdrop video").count(), 0, "not under the app");
    await front(page, false);
    await page.locator("#backdrop video.backdrop-intro").waitFor({ timeout: 5000 });
    // An app in front partway through: the intro ends there, on its still.
    await front(page, true);
    await page.waitForSelector("#backdrop video", { state: "detached", timeout: 5000 });
    await front(page, false);
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#backdrop video").count(), 0, "it isn't due any more");

    const off = "00000000000000000000000000000005";
    await theme("still", off, false);
    await page.waitForFunction(async (token) => (await (await fetch("/api/backgrounds")).json()).theme.introShown?.due === token, off, { timeout: 5000 });
    assert.deepEqual(await introShown(), { due: off, how: "still", why: "intros-off" });
    assert.equal(await page.locator("#backdrop video").count(), 0);
  } finally {
    await page.close();
  }
});
