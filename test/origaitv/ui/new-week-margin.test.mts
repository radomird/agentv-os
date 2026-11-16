// New this week keeps its margin (T20.1, layer 4): in each look and at each
// size, going right along the posters to the last one and back moves only
// the row of posters. The page never slides sideways, so the headline stays
// at its margin, and the last poster comes into view inside the safe area.
// With more posters than fit: eight, on two stand-in apps.

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

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
const SIZES = { larger: 1600, standard: 1920, more: 2400 } as const;
// New this week's tile sends up to eight titles: more than fit at the
// larger and standard sizes.
const COUNT = 8;

let browser: Browser;
let daemon: Daemon;
let url = "";
const errors: string[] = [];
const POSTER = readFileSync(join(ROOT, "test/origaitv/fixtures/art/harbour.jpg"));

const day = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// Eight new films this week, four on each stand-in app.
const tmdb: TmdbGet = async (path) => {
  const q = new URL(path, "http://tmdb.invalid").searchParams;
  const p = new URL(path, "http://tmdb.invalid").pathname;
  if (p === "/watch/providers/regions") return { ok: true, data: { results: [{ iso_3166_1: "NL", english_name: "Netherlands" }] } };
  if (p.startsWith("/watch/providers/")) return { ok: true, data: { results: [{ provider_id: 901, provider_name: "Kino" }, { provider_id: 903, provider_name: "Lumen" }] } };
  const film = (id: number) => ({ id, title: `Film ${id}`, release_date: day(-2), popularity: 100 - id, poster_path: `/p${id}.jpg` });
  if (p === "/discover/movie" && q.has("with_release_type")) {
    const from = q.get("with_watch_providers") === "901" ? 1 : q.get("with_watch_providers") === "903" ? COUNT / 2 + 1 : 0;
    if (from) return { ok: true, data: { results: Array.from({ length: COUNT / 2 }, (_, i) => film(from + i)) } };
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
  ({ daemon, url, state } = await startBox(0, APPS, { builtins: true, zone: "Europe/Amsterdam", tmdb, features: { looks: true, sizes: true, discover: true } }));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true, goal: "streaming" }));
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
  const page = await browser.newPage();
  await page.goto(`${url}/`);
  const saved = await page.evaluate(() => fetch("/api/tmdb-key", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "eyJhbGciOiJIUzI1NiJ9.stand-in-token.signature" }) }).then((r) => r.status));
  assert.equal(saved, 200);
  await page.close();
  assert.equal((await fetch(`${url}/api/theme?name=tokyo-night`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered("tokyo-night") })).status, 200);
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
  await page.route(/\/api\/image\?app=origaitv\.new/, (route) => route.fulfill({ status: 200, contentType: "image/jpeg", body: POSTER }));
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/?size=${size}`);
  await page.waitForSelector("html[data-look] #page .focused");
  await rest(page);
  return page;
}

interface Seen {
  headline: number; // the headline's left edge, on the canvas
  margin: number; // the look's safe margin, on the canvas
  slid: string[]; // anything other than the row that scrolled sideways
  focused: string | undefined;
  inside: boolean; // the focused poster is inside the safe area
}

// Where things are once nothing moves.
async function seen(page: Page): Promise<Seen> {
  await page.waitForFunction(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5000 });
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    const zoom = Number(document.documentElement.style.zoom) || 1;
    const headline = document.querySelector(".new-week .headline")!.getBoundingClientRect().left / zoom;
    // The look's --safe-x as it resolves: Fit to screen adds to it with calc().
    const probe = document.createElement("div");
    probe.style.cssText = "position: absolute; left: var(--safe-x)";
    document.body.append(probe);
    const margin = parseFloat(getComputedStyle(probe).left) || 0;
    probe.remove();
    const row = document.querySelector(".new-week .poster-row")!;
    const slid: string[] = [];
    const scrolled = (el: Element | null) => el && el !== row && el.scrollLeft !== 0;
    if (scrolled(document.scrollingElement)) slid.push("the document");
    for (let el = row.parentElement; el; el = el.parentElement) if (scrolled(el)) slid.push(el.id ? `#${el.id}` : el.classList.length ? `.${[...el.classList].join(".")}` : el.tagName.toLowerCase());
    // The focused poster, where it is before its lift.
    const card = document.querySelector<HTMLElement>(".poster-card.focused");
    const box = card?.querySelector(".poster-image")?.getBoundingClientRect();
    const transform = card ? getComputedStyle(card).transform : "none";
    const lift = transform === "none" ? 1 : new DOMMatrixReadOnly(transform).a;
    const middle = box ? (box.left + box.right) / 2 : 0;
    const half = box ? box.width / lift / 2 : 0;
    const width = innerWidth / zoom;
    const inside = box ? (middle - half) / zoom >= margin - 1 && (middle + half) / zoom <= width - margin + 1 : false;
    return { headline, margin, slid, focused: card?.dataset.action, inside };
  });
}

for (const look of LOOKS) {
  test(`T20.1 ${look}: New this week's headline stays at its margin, right to the last poster and back, at each size`, async () => {
    await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
    const problems: string[] = [];
    for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
      const page = await tv(size);
      try {
        await page.evaluate(() => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go("new"));
        await page.waitForSelector(`.new-week .poster-card[data-action="new-${COUNT - 1}"] img`, { state: "attached", timeout: 10_000 });
        await page.waitForSelector('.new-week .poster-card.focused[data-action="new-0"]');
        const start = await seen(page);
        if (Math.abs(start.headline - start.margin) > 1) problems.push(`${size}: the headline starts at ${start.headline} px, not at the margin's ${start.margin}`);
        for (let n = 1; n < COUNT; n++) {
          await page.keyboard.press("ArrowRight");
          await page.waitForSelector(`.poster-card.focused[data-action="new-${n}"]`);
        }
        const end = await seen(page);
        if (Math.abs(end.headline - start.headline) > 1) problems.push(`${size}: on the last poster the headline moved from ${start.headline} to ${end.headline} px`);
        if (end.slid.length) problems.push(`${size}: on the last poster ${end.slid.join(", ")} scrolled sideways`);
        if (!end.inside) problems.push(`${size}: the last poster isn't inside the safe area`);
        for (let n = COUNT - 2; n >= 0; n--) {
          await page.keyboard.press("ArrowLeft");
          await page.waitForSelector(`.poster-card.focused[data-action="new-${n}"]`);
        }
        const back = await seen(page);
        if (Math.abs(back.headline - start.headline) > 1) problems.push(`${size}: back on the first poster the headline is at ${back.headline} px, not ${start.headline}`);
        if (back.slid.length) problems.push(`${size}: back on the first poster ${back.slid.join(", ")} is still scrolled`);
        if (!back.inside) problems.push(`${size}: back on the first poster it isn't inside the safe area`);
      } finally {
        await page.close();
      }
    }
    assert.deepEqual(problems, []);
  });
}
