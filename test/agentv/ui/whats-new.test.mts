// New this week in a real Chromium (stage 8, S8.1, layer 4), on a stand-in
// for TMDB: a streaming household's home has it large, with this week's
// posters, each title's app under it and TMDB's and JustWatch's credit;
// choosing one asks the daemon to play it in its app; with no key yet the
// tile says where to add one; Settings → new this week takes the key with
// the phone's keyboard, shows the region and what each app is on TMDB; and
// Settings → About has TMDB's logo and notice. Kino and Lumen stand in for
// streaming services.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import type { TmdbGet } from "../../../daemon/tmdb.ts";
import { FIXTURES, ROOT, startBox, type Fixture } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
const errors: string[] = [];
const POSTER = readFileSync(join(ROOT, "test/agentv/fixtures/art/harbour.jpg"));

const pad = (n: number) => String(n).padStart(2, "0");
const day = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// What TMDB has this week on Kino and Lumen, by stand-in names.
const tmdb: TmdbGet = async (path) => {
  const q = new URL(path, "http://tmdb.invalid").searchParams;
  const on = q.get("with_watch_providers");
  const p = new URL(path, "http://tmdb.invalid").pathname;
  if (p === "/watch/providers/regions") return { ok: true, data: { results: [{ iso_3166_1: "NL", english_name: "Netherlands" }, { iso_3166_1: "NO", english_name: "Norway" }] } };
  if (p.startsWith("/watch/providers/")) return { ok: true, data: { results: [{ provider_id: 901, provider_name: "Kino" }, { provider_id: 902, provider_name: "Kino Kids" }, { provider_id: 903, provider_name: "Lumen" }] } };
  const film = (id: number, title: string, popularity: number) => ({ id, title, release_date: day(-2), popularity, poster_path: `/p${id}.jpg` });
  if (p === "/discover/movie" && q.has("with_release_type")) {
    if (on === "901|902") return { ok: true, data: { results: [film(1, "Night Train", 90), film(2, "Small Hours", 60)] } };
    if (on === "903") return { ok: true, data: { results: [film(3, "Glass Harbour", 80), film(4, "Paper Kites", 40), film(5, "Low Tide", 30)] } };
  }
  return { ok: true, data: { results: [] } };
};

const KINO: Fixture[] = [
  ...FIXTURES,
  { id: "local.kino", name: "Kino", tier: "local", category: "streaming", edit: (m) => ((m.tv.capabilities = ["launch", "playback"]), (m.tv.tiles = { s: "logo", m: "continue" }), (m.tv.homeUrl = "https://kino.example/"), (m.tv.origins = ["https://kino.example"]), (m.tv.setup = [])) },
  { id: "local.lumen", name: "Lumen", tier: "local", category: "streaming", edit: (m) => ((m.tv.capabilities = ["launch", "playback"]), (m.tv.tiles = { s: "logo", m: "continue" }), (m.tv.homeUrl = "https://lumen.example/"), (m.tv.origins = ["https://lumen.example"]), (m.tv.setup = [])) },
];

before(async () => {
  ({ daemon, url, state } = await startBox(0, KINO, { builtins: true, zone: "Europe/Amsterdam", tmdb }));
  // A household whose TV is for streaming (ADR-006).
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true, goal: "streaming" }));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

// The TV, with TMDB's posters served from a picture in this checkout, since
// a test never asks image.tmdb.org.
// The looks' switch, for a test of home as it was before them.
const looks = (on: boolean) => fetch(`${url}/api/features`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ looks: on }) });

async function tv(): Promise<{ page: Page; opened: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/\/api\/image\?app=agentv\.new/, (route) => route.fulfill({ status: 200, contentType: "image/jpeg", body: POSTER }));
  const opened: string[] = [];
  await page.route(`${url}/api/whats-new/open`, async (route) => {
    opened.push(route.request().postDataJSON().id);
    await route.fulfill({ json: { ok: true, said: null } });
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return { page, opened };
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const newTile = '.tile[data-id="agentv.new"]';

test("S8.1 with no TMDB key yet, a streaming household's home has New this week large, saying where to add one", async (t) => {
  // Home as it was before the looks, where the tile opens Settings → New
  // this week.
  await looks(false);
  t.after(() => looks(true));
  const { page } = await tv();
  try {
    const tile = page.locator(newTile);
    await tile.waitFor();
    assert.ok(await tile.evaluate((el) => el.classList.contains("size-l")), "it's large, as on the canvas");
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("add a tmdb key in settings → new this week"), newTile);
    await tile.click();
    await page.waitForSelector('.menu [data-key="tmdb"].open');
    await page.waitForFunction(() => document.querySelector(".settings-panel")?.textContent?.includes("no key yet"));
  } finally {
    await page.close();
  }
});

test("S8.1 Settings → new this week takes the key from the phone's keyboard, then shows the region and what each app is on TMDB", async () => {
  const { page } = await tv();
  try {
    await go(page, "settings/tmdb");
    await page.click('[data-action="tmdb-key"]');
    await page.waitForSelector('[data-action="tmdb-key-field"]');
    assert.equal(await page.getAttribute('[data-action="tmdb-key-field"]', "type"), "password", "the key isn't shown as it's typed");
    await page.fill('[data-action="tmdb-key-field"]', "eyJhbGciOiJIUzI1NiJ9.stand-in-token.signature");
    await page.click('[data-action="save"]');
    await page.waitForSelector('.menu [data-key="tmdb"].open');
    await page.waitForFunction(() => document.querySelector(".settings-panel")?.textContent?.includes("netherlands"));
    const panel = (await page.textContent(".settings-panel")) ?? "";
    assert.ok(panel.includes("kino: kino, kino kids"), panel);
    assert.ok(panel.includes("lumen: lumen"), panel);
    assert.ok(panel.includes("where to watch from justwatch"), panel);
    assert.ok(!panel.includes("stand-in-token"), "the key never comes back");
    // The region is the box's country (ADR-055), changed in Settings →
    // country, which "another country" opens.
    await page.click('[data-action="country"]');
    await page.waitForSelector(".country-picker");
  } finally {
    await page.close();
  }
});

test("S8.1 with a key, New this week shows this week's posters, each with its app, and TMDB's and JustWatch's credit; choosing one plays it", async () => {
  const { page, opened } = await tv();
  try {
    // Home draws again when the daemon says the week's titles changed, and a
    // redraw fills the tile afresh. So this waits for all four posters and
    // reads them in the same step, never between two draws.
    const seen = await page.waitForFunction((sel) => {
      const els = [...document.querySelectorAll(`${sel} .entry`)];
      const imgs = els.map((el) => el.querySelector("img"));
      if (els.length < 4 || !imgs.every((img) => img && img.naturalWidth > 0)) return null;
      const box = imgs[0]!.getBoundingClientRect();
      return {
        entries: els.map((el) => [el.querySelector(".entry-label")?.textContent, el.querySelector(".entry-caption")?.textContent]),
        poster: { w: box.width, h: box.height, loaded: true },
      };
    }, newTile);
    const { entries, poster } = (await seen.jsonValue()) as { entries: string[][]; poster: { w: number; h: number; loaded: boolean } };
    assert.deepEqual(entries, [
      ["night train", "kino"],
      ["glass harbour", "lumen"],
      ["small hours", "kino"],
      ["paper kites", "lumen"],
    ]);
    assert.equal(await page.textContent(`${newTile} .new-credit`), "From TMDB · where to watch from JustWatch");
    assert.ok(poster.loaded, "the poster loads through the daemon");
    assert.ok(Math.abs(poster.h / poster.w - 1.5) < 0.05, `posters are 2:3, ${JSON.stringify(poster)}`);
    await page.click(`${newTile} .entry >> nth=1`);
    assert.deepEqual(opened, ["tmdb:film:3"]);
    // For a look by eye, when asked for: AGENTV_UI_SHOTS names a folder.
    if (process.env.AGENTV_UI_SHOTS) await page.screenshot({ path: join(process.env.AGENTV_UI_SHOTS, "success-new-this-week.png") });
  } finally {
    await page.close();
  }
});

test("Settings → About has TMDB's logo, smaller than AgenTV's name, and its notice, and JustWatch's credit", async () => {
  const { page } = await tv();
  try {
    await go(page, "settings/about");
    await page.waitForSelector(".about-tmdb");
    const panel = (await page.textContent(".settings-panel")) ?? "";
    assert.ok(panel.includes("This product uses the TMDB API but is not endorsed or certified by TMDB."), panel);
    assert.ok(panel.includes("where to watch is from justwatch"), panel);
    const logo = await page.$eval(".about-tmdb", (img) => (img as HTMLImageElement).getBoundingClientRect().height);
    const name = await page.$eval(".settings-panel .panel-big", (el) => el.getBoundingClientRect().height);
    assert.ok(logo > 0 && logo < name, `the logo (${logo}px) is less prominent than agentv's name (${name}px)`);
  } finally {
    await page.close();
  }
});
