// The built-in Music app in a real Chromium (ADR-017, S3.6): its tiles on
// home, its page with the albums, playlists and a search, an album, and the
// sources with a NAS share to add. The library and the player live in the
// TV session, so a stand-in for the screen daemon answers each music request
// here, the way daemon/music.ts does on the box.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, startBox } from "./box.mts";
import { startMet, type Met } from "./met.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let met: Met;
let url = "";
const errors: string[] = [];

// A 1 × 1 grey PNG, as a cover.
const COVER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaGj4DwAEhgKAyd9xGQAAAABJRU5ErkJggg==";

// What the screen daemon's MusicApp answers, for two albums from two sources.
const LIBRARY = {
  albums: [
    { id: "a1", title: "Night Shift", artist: "Pixel Band", year: "2025", cover: true, tracks: ["t1", "t2", "t3"] },
    { id: "a2", title: "Test Tones", artist: "AgenTV", year: "2026", cover: false, tracks: ["t4", "t5", "t6"] },
  ],
  playlists: [{ id: "p1", name: "evening", tracks: ["t1", "t4"] }],
  tracks: {
    a1: [
      { id: "t1", title: "Dusk", artist: "Pixel Band", number: 1, duration: 61 },
      { id: "t2", title: "Midnight", artist: "Pixel Band", number: 2, duration: 125 },
      { id: "t3", title: "Dawn", artist: "Pixel Band", number: 3, duration: 3 },
    ],
  },
  now: { title: "Midnight", artist: "Pixel Band", album: "Night Shift", albumId: "a1", position: 30, duration: 120, playing: true, index: 1, count: 3 },
  sources: [
    { id: "folder:/home/omarchy/Music", kind: "folder", name: "music", path: "/home/omarchy/Music", available: true },
    { id: "usb:/dev/sdb1", kind: "usb", name: "STICK", path: "/run/media/omarchy/STICK", available: true },
    { id: "share:smb://nas/music", kind: "share", name: "nas/music", path: null, available: false },
  ],
};

before(async () => {
  met = await startMet();
  ({ daemon, url } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", forecast: met.url }));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  met?.close();
});

async function setLayout(size: "s" | "m" | "l"): Promise<void> {
  const layout = [
    { id: "agentv.music", x: 0, y: 0, size },
    { id: "apps", x: 3, y: 2, size: "s" },
  ];
  const response = await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout }) });
  assert.equal(response.status, 200);
}

// The launcher with a stand-in for the screen daemon. playing: whether
// something plays now.
async function tv(playing = true): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ({ library, cover, playing }) => {
      type Request = { id: number; cmd: string; op?: string; key?: string; q?: string; uri?: string };
      const w = window as unknown as { screenRequests: Request[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
      w.screenRequests = [];
      const answer = (request: Request): object => {
        if (request.cmd !== "music") return { ok: true };
        switch (request.op) {
          case "library":
            return { ok: true, albums: library.albums, playlists: library.playlists };
          case "album": {
            const album = library.albums.find((item) => item.id === request.key);
            return album ? { ok: true, album: { ...album, cover: album.cover ? "a1.jpg" : null }, tracks: (library.tracks as Record<string, unknown[]>)[album.id] ?? [] } : { ok: false, error: "that album isn't in the library" };
          }
          case "cover":
            return { ok: true, cover: request.key === "a1" ? cover : null };
          case "search": {
            const q = String(request.q).toLowerCase();
            const albums = library.albums.filter((album) => album.title.toLowerCase().includes(q));
            return { ok: true, results: albums.map((album) => ({ kind: "album", id: album.id, title: album.title, subtitle: album.artist })) };
          }
          case "now":
            return { ok: true, now: playing ? library.now : null };
          case "recent":
            return { ok: true, albums: library.albums.map(({ id, title, artist }) => ({ id, title, artist })) };
          case "sources":
            return { ok: true, sources: library.sources };
          case "play":
            return { ok: true, playing: { kind: "album", key: request.key, title: "Night Shift", tracks: 3 } };
          case "add-share":
            return String(request.uri).startsWith("smb://") ? { ok: true } : { ok: false, error: "a share is smb:// or nfs://" };
          default:
            return { ok: true };
        }
      };
      w.agentvScreen = (json: string) => {
        const request = JSON.parse(json) as Request;
        w.screenRequests.push(request);
        setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify(answer(request))), 0);
      };
    },
    { library: LIBRARY, cover: COVER, playing },
  );
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

function requests(page: Page, op: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(
    (op) => (window as unknown as { screenRequests: { cmd: string; op?: string }[] }).screenRequests.filter((r) => r.cmd === "music" && r.op === op),
    op,
  );
}

const tile = '.grid .tile[data-id="agentv.music"]';

test("Music comes with AgenTV and waits in apps; choosing it opens its page, not a window", async () => {
  const home = await (await fetch(`${url}/api/home`)).json();
  assert.ok(!home.layout.some((placed: { id: string }) => placed.id === "agentv.music"));
  await setLayout("s");
  const page = await tv();
  await page.locator(tile).hover();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".page.music .album-tile");
  const opens = await page.evaluate(() => (window as unknown as { screenRequests: { cmd: string }[] }).screenRequests.filter((r) => r.cmd === "open-app"));
  assert.deepEqual(opens, []);
  await page.close();
});

test("S3.6 the medium tile shows what's playing, with its cover and how far in it is", async () => {
  await setLayout("m");
  const page = await tv();
  await page.waitForSelector(`${tile} .tile-now img`);
  const drawn = await page.$eval(tile, (el) => ({
    label: el.querySelector(".tile-head-label")?.textContent,
    title: el.querySelector(".music-title")?.textContent,
    caption: el.querySelector(".tile-now .headline-caption")?.textContent,
    done: (el.querySelector(".entry-progress-done") as HTMLElement | null)?.style.width,
    entries: el.querySelectorAll(".entry").length,
  }));
  assert.deepEqual(drawn, { label: "now playing", title: "midnight", caption: "pixel band · night shift", done: "25%", entries: 0 });
  await page.close();
});

test("the large tile adds the albums played last, and with nothing playing it says what played", async () => {
  await setLayout("l");
  const page = await tv(false);
  await page.waitForSelector(`${tile} .entry`);
  const drawn = await page.$eval(tile, (el) => ({
    label: el.querySelector(".tile-head-label")?.textContent,
    now: el.querySelector(".tile-now") !== null,
    entries: [...el.querySelectorAll(".entry-label")].map((entry) => entry.textContent),
  }));
  assert.deepEqual(drawn, { label: "played last", now: false, entries: ["night shift", "test tones"] });
  await page.close();
});

test("S3.6 the page lists the albums with their covers and the playlists, and a playlist plays", async () => {
  await setLayout("s");
  const page = await tv();
  await page.locator(tile).hover();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".page.music .album-tile img");
  const albums = await page.$$eval(".page.music .album-tile", (tiles) =>
    tiles.map((el) => [el.querySelector(".album-title")?.textContent, el.querySelector(".album-artist")?.textContent, el.querySelector("img") !== null]),
  );
  assert.deepEqual(albums, [
    ["night shift", "pixel band", true],
    ["test tones", "agentv", false],
  ]);
  // An album with no cover isn't asked for one.
  assert.deepEqual((await requests(page, "cover")).map((r) => r.key), ["a1"]);
  // The search box has the focus first, and typing goes into it.
  assert.deepEqual(await page.evaluate(() => [document.querySelector(".focused")?.classList.contains("music-search"), document.activeElement?.classList.contains("music-search")]), [true, true]);
  await page.locator(".playlists-head:not(.hidden)").waitFor();
  await page.getByRole("button", { name: /evening/ }).click();
  await page.waitForFunction(() => (window as unknown as { screenRequests: { op?: string }[] }).screenRequests.some((r) => r.op === "play"));
  const [played] = await requests(page, "play");
  assert.deepEqual([played.kind, played.key], ["playlist", "p1"]);
  await page.close();
});

test("S3.6 typing on the remote's keyboard searches, and a result plays", async () => {
  await setLayout("s");
  const page = await tv();
  await page.locator(tile).hover();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".page.music .album-tile");
  // The focus starts in the search box. Left and right move in the text
  // instead of moving the focus away, and down leaves it.
  await page.keyboard.type("night");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("music-search") && document.activeElement.classList.contains("focused")), true);
  await page.waitForSelector(".music-result");
  assert.deepEqual((await requests(page, "search")).at(-1)?.q, "night");
  assert.equal(await page.locator(".music-result").first().textContent(), "album · night shiftpixel band");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement === document.body && document.querySelector(".focused")?.classList.contains("music-result")), true);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as unknown as { screenRequests: { op?: string }[] }).screenRequests.some((r) => r.op === "play"));
  const [played] = await requests(page, "play");
  assert.deepEqual([played.kind, played.key], ["album", "a1"]);
  await page.close();
});

test("an album's page plays it from the top or from a track, and what's playing shows on top", async () => {
  await setLayout("s");
  const page = await tv();
  await page.locator(tile).hover();
  await page.keyboard.press("Enter");
  await page.locator('.album-tile[data-album="a1"]').click();
  await page.waitForSelector(".album-page .track");
  await page.waitForSelector(".now-playing:not(.hidden)");
  const drawn = await page.$eval(".album-page", (el) => ({
    headline: el.querySelector(".headline")?.textContent,
    maker: el.querySelector(".maker")?.textContent,
    tracks: [...el.querySelectorAll(".track")].map((track) => track.textContent),
    focused: document.querySelector(".focused")?.getAttribute("data-action"),
    now: document.querySelector(".now-playing:not(.hidden) .now-text")?.textContent,
  }));
  assert.deepEqual(drawn, {
    headline: "night shift",
    maker: "pixel band · 2025 · 3 tracks",
    tracks: ["01  dusk1:01", "02  midnight2:05", "03  dawn0:03"],
    focused: "play",
    now: "midnight · pixel band · 0:30 / 2:00",
  });
  await page.keyboard.press("Enter");
  await page.locator(".track").nth(2).click();
  await page.waitForFunction(() => (window as unknown as { screenRequests: { op?: string }[] }).screenRequests.filter((r) => r.op === "play").length === 2);
  const plays = (await requests(page, "play")).map((r) => [r.kind, r.key, r.from]);
  assert.deepEqual(plays, [
    ["album", "a1", undefined],
    ["album", "a1", 2],
  ]);
  await page.close();
});

test("S3.6 the sources page lists the folder, the USB stick and the share, and adds a share with its password", async () => {
  await setLayout("s");
  const page = await tv();
  await page.locator(tile).hover();
  await page.keyboard.press("Enter");
  await page.locator('[data-action="sources"]').click();
  await page.waitForSelector(".sources .source");
  const listed = await page.$$eval(".sources .source", (rows) => rows.map((row) => row.textContent));
  assert.deepEqual(listed, ["folder · musicready", "usb · STICKready", "share · nas/musicnot there"]);
  await page.fill('[aria-label="a share\'s address"]', "smb://radomir@nas/music");
  await page.fill('[aria-label="the share\'s password"]', "hunter2");
  await page.locator('[data-action="add-share"]').click();
  await page.waitForFunction(() => (window as unknown as { screenRequests: { op?: string }[] }).screenRequests.some((r) => r.op === "add-share"));
  const [added] = await requests(page, "add-share");
  assert.deepEqual([added.uri, added.password], ["smb://radomir@nas/music", "hunter2"]);
  // The password isn't left on the page.
  await page.waitForSelector(".sources .source");
  assert.equal(await page.inputValue('[aria-label="the share\'s password"]'), "");
  await page.close();
});

test("the music pages keep to the launcher's content policy", () => {
  assert.deepEqual(errors, []);
});
