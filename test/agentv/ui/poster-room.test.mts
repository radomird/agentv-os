// The focus ring on New this week's posters, in a real Chromium (ADR-019,
// layer 4): in each look, at each size, in a dark theme and a light one, the
// ring on a poster has room around the poster and its two lines, the way
// other rows do, never touches the next poster, and is all on the screen.
// On New this week's page, and in Cinema's row of posters on home.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import type { TmdbGet } from "../../../daemon/tmdb.ts";
import { FIXTURES, ROOT, rest, startBox, type Fixture } from "./box.mts";
import { rendered } from "./legible.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
const SIZES = { larger: 1600, standard: 1920, more: 2400 } as const;
const THEMES = ["tokyo-night", "catppuccin-latte"];
// The least room between the ring and what it's around, on the canvas.
const ROOM = 12;

let browser: Browser;
let daemon: Daemon;
let url = "";
const errors: string[] = [];
const POSTER = readFileSync(join(ROOT, "test/agentv/fixtures/art/harbour.jpg"));

const day = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// This week on two stand-in apps, as whats-new.test.mts has it.
const tmdb: TmdbGet = async (path) => {
  const q = new URL(path, "http://tmdb.invalid").searchParams;
  const p = new URL(path, "http://tmdb.invalid").pathname;
  if (p === "/watch/providers/regions") return { ok: true, data: { results: [{ iso_3166_1: "NL", english_name: "Netherlands" }] } };
  if (p.startsWith("/watch/providers/")) return { ok: true, data: { results: [{ provider_id: 901, provider_name: "Kino" }, { provider_id: 903, provider_name: "Lumen" }] } };
  const film = (id: number, title: string) => ({ id, title, release_date: day(-2), popularity: 100 - id, poster_path: `/p${id}.jpg` });
  if (p === "/discover/movie" && q.has("with_release_type")) {
    if (q.get("with_watch_providers") === "901") return { ok: true, data: { results: [film(1, "Night Train"), film(2, "Small Hours")] } };
    if (q.get("with_watch_providers") === "903") return { ok: true, data: { results: [film(3, "Glass Harbour"), film(4, "Paper Kites"), film(5, "Low Tide")] } };
  }
  return { ok: true, data: { results: [] } };
};

const streaming = (host: string) => (m: Record<string, any>) => ((m.tv.capabilities = ["launch", "playback"]), (m.tv.tiles = { s: "logo", m: "continue" }), (m.tv.homeUrl = `https://${host}/`), (m.tv.origins = [`https://${host}`]), (m.tv.setup = []));
const APPS: Fixture[] = [
  ...FIXTURES,
  { id: "local.kino", name: "Kino", tier: "local", category: "streaming", edit: streaming("kino.example") },
  { id: "local.lumen", name: "Lumen", tier: "local", category: "streaming", edit: streaming("lumen.example") },
];

before(async () => {
  let state: string;
  ({ daemon, url, state } = await startBox(0, APPS, { builtins: true, zone: "Europe/Amsterdam", tmdb, features: { looks: true, discover: true } }));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true, goal: "streaming" }));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
  // A TMDB key, as the phone saves one.
  const page = await browser.newPage();
  await page.goto(`${url}/`);
  const saved = await page.evaluate(() => fetch("/api/tmdb-key", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "eyJhbGciOiJIUzI1NiJ9.stand-in-token.signature" }) }).then((r) => r.status));
  assert.equal(saved, 200);
  await page.close();
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

async function tv(size: keyof typeof SIZES): Promise<Page> {
  const width = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height: Math.round((width * 9) / 16) } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/\/api\/image\?app=agentv\.new/, (route) => route.fulfill({ status: 200, contentType: "image/jpeg", body: POSTER }));
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/?size=${size}`);
  await page.waitForSelector("html[data-look] #page .focused");
  await rest(page);
  return page;
}

// Where the ring is against the focused poster card, once nothing moves: the
// room on each side to the poster and its lines, whether it touches the next
// poster, and whether it's on the screen.
async function measure(page: Page): Promise<{ room: number[]; touches: boolean; onScreen: boolean }> {
  await page.waitForFunction(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5000 });
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(".poster-card.focused")!;
    const ring = document.getElementById("ring")!.getBoundingClientRect();
    const parts = [...card.querySelectorAll(".poster-image, .poster-title, .poster-caption")].map((el) => el.getBoundingClientRect());
    const left = Math.min(...parts.map((r) => r.left));
    const top = Math.min(...parts.map((r) => r.top));
    const right = Math.max(...parts.map((r) => r.right));
    const bottom = Math.max(...parts.map((r) => r.bottom));
    // The ring's own line is drawn inside its box.
    const line = parseFloat(getComputedStyle(document.getElementById("ring")!).borderTopWidth);
    const room = [left - ring.left, top - ring.top, ring.right - right, ring.bottom - bottom].map((n) => Math.round(n - line));
    const others = [...document.querySelectorAll(".poster-card:not(.focused) .poster-image")].map((el) => el.getBoundingClientRect());
    const touches = others.some((r) => r.left < ring.right && r.right > ring.left && r.top < ring.bottom && r.bottom > ring.top);
    const onScreen = ring.left >= 0 && ring.top >= 0 && ring.right <= innerWidth && ring.bottom <= innerHeight;
    return { room, touches, onScreen };
  });
}

for (const look of LOOKS) {
  test(`${look}: the ring on New this week's posters has room around the poster and its lines, at each size, dark and light`, async () => {
    await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
    const problems: string[] = [];
    for (const theme of THEMES) {
      assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200, `the theme ${theme} took`);
      for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
        const page = await tv(size);
        try {
          const where: [string, () => Promise<void>][] = [
            [
              "New this week",
              async () => {
                await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("new"));
                await page.waitForSelector(".new-week .poster-card.focused img", { timeout: 10_000 });
                await page.keyboard.press("ArrowRight");
                await page.waitForSelector('.poster-card.focused[data-action="new-1"]');
              },
            ],
          ];
          if (look === "cinema") {
            where.push([
              "home's row",
              async () => {
                await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("home"));
                await page.waitForSelector(".cinema-posters .poster-card img", { timeout: 10_000 });
                await page.evaluate(() => {
                  const card = document.querySelectorAll<HTMLElement>(".cinema-posters .poster-card")[1];
                  (window as unknown as { agentvLauncher: { focus: { set(el: HTMLElement, announce: boolean): void } } }).agentvLauncher.focus.set(card, false);
                });
                await page.waitForSelector('.cinema-posters .poster-card.focused[data-action="new-1"]');
              },
            ]);
          }
          for (const [name, open] of where) {
            await open();
            const { room, touches, onScreen } = await measure(page);
            if (Math.min(...room) < ROOM) problems.push(`${theme}, ${size}, ${name}: ${room.join(", ")} px of room (left, top, right, bottom)`);
            if (touches) problems.push(`${theme}, ${size}, ${name}: the ring touches the next poster`);
            if (!onScreen) problems.push(`${theme}, ${size}, ${name}: the ring is off the screen`);
          }
        } finally {
          await page.close();
        }
      }
    }
    assert.deepEqual(problems, []);
  });
}
