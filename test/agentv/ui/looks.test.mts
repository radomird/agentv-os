// Home's three looks (ADR-063), in a real Chromium (ADR-019, layer 4), with
// the looks switch on. Each look draws home and the built-in apps itself, in
// the Omarchy theme's colours, at each of the three sizes (ADR-062):
//
// - T5.1: home, Apps, Settings, the built-in apps and the ambient screen in
//   each look, in a dark and a light theme, at each size, with nothing cut
//   off or off the screen and every piece of text readable;
// - T5.2: there's no all apps tile, and Apps is one press from home;
// - T5.3: setup's look step frames each look's preview, and the preview is
//   home itself in the same look, theme and size, to the pixel.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";
import { rendered, shortfalls } from "./legible.mts";
import { startMet, type Met } from "./met.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

export const LOOKS = ["terminal", "glass", "cinema"] as const;
type Look = (typeof LOOKS)[number];
const SIZES = { larger: 1600, standard: 1920, more: 2400 } as const;
type Size = keyof typeof SIZES;
// A dark theme and a light one: Omarchy's default and its lightest.
const THEMES = ["tokyo-night", "catppuccin-latte"];

let browser: Browser;
let daemon: Daemon;
let met: Met;
let url = "";
let state = "";

before(async () => {
  met = await startMet();
  ({ daemon, url, state } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", forecast: met.url, features: { looks: true, discover: true } }));
  // The theme's own colour behind home, as with no background picked.
  await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "field" }) });
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  met?.close();
});

async function useLook(look: Look): Promise<void> {
  const response = await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
  assert.equal(response.status, 200);
}

async function useTheme(theme: string): Promise<void> {
  await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) });
}

// A TV at a size, as the box's display gives it: the size's canvas, at a
// scale of 1. The screen daemon's binding is stood in for.
// What went wrong on the pages, for the checks that look at every screen.
const errors: string[] = [];

async function tv(size: Size = "standard"): Promise<Page> {
  const width = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height: Math.round((width * 9) / 16) } });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: unknown[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/?size=${size}`);
  await page.waitForSelector("html[data-look] #page .focused");
  await rest(page);
  return page;
}

function go(page: Page, route: string): Promise<void> {
  return page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
}

// Waits until nothing on the page is still moving, other than what moves for
// good. A page slides in as it opens, and on a busy machine the slide can
// start late, as when Themes and backgrounds loads its three previews.
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5000 });
}

// What's cut off or off the screen: an element outside the canvas, or one
// that clips what's in it, other than text that ends in an ellipsis and
// rows that scroll (data-scroll).
function overflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : ""} "${(el.textContent ?? "").trim().slice(0, 30)}"`;
    // The ambient screen covers the page, so it's all there is to see.
    const shown = document.querySelector("#ambient.on") ? "#ambient.on *" : "#page *";
    for (const el of document.querySelectorAll<HTMLElement>(shown)) {
      // Pictures and what's drawn only to look at, such as Glass's backdrop
      // bleeding past the edges for its blur, aren't cut off.
      if (el.closest("svg, [aria-hidden='true']") || el.matches("svg")) continue;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || style.visibility !== "visible" || Number(style.opacity) === 0) continue;
      // A row or a page that scrolls has more than the screen on purpose.
      const scrolls = el.parentElement?.closest("[data-scroll]");
      if (!scrolls && (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1)) {
        found.push(`${name(el)} is off the screen at ${Math.round(box.left)},${Math.round(box.top)} to ${Math.round(box.right)},${Math.round(box.bottom)}`);
        continue;
      }
      const clips = style.overflowX !== "visible" || style.overflowY !== "visible";
      // Text that ends in an ellipsis, on one line or a few, is cut on purpose.
      const clamped = style.textOverflow === "ellipsis" || (style.webkitLineClamp !== "none" && style.webkitLineClamp !== "");
      if (!clips || el.hasAttribute("data-scroll") || clamped || el instanceof HTMLImageElement) continue;
      if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) {
        found.push(`${name(el)} cuts off what's in it: ${el.scrollWidth}×${el.scrollHeight} in ${el.clientWidth}×${el.clientHeight}`);
      }
    }
    return found;
  });
}

// Home with each built-in on it, and a few apps: Clock pinned, Weather at
// medium, Music and New this week.
async function builtinsOnHome(): Promise<void> {
  const layout = [
    { id: "agentv.weather", x: 0, y: 0, size: "m" },
    { id: "agentv.clock", x: 2, y: 0, size: "s" },
    { id: "agentv.sample", x: 3, y: 0, size: "s" },
    { id: "agentv.music", x: 0, y: 1, size: "m" },
    { id: "agentv.tube", x: 2, y: 1, size: "s" },
    { id: "local.mytv", x: 3, y: 1, size: "s" },
    { id: "agentv.new", x: 0, y: 2, size: "m" },
    { id: "agentv.games", x: 2, y: 2, size: "s" },
  ];
  const response = await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout }) });
  assert.equal(response.status, 200);
}

// The screens T5.1 looks at, and how to get to each.
const SCREENS: [string, (page: Page) => Promise<void>][] = [
  ["home", async () => {}],
  ["apps", (page) => go(page, "apps")],
  ["settings", (page) => go(page, "settings")],
  ["an app's details", (page) => go(page, "details/agentv.sample")],
  ["music", (page) => go(page, "music")],
  // An app's setup, with the servers on your network (track 10's list).
  ["an app's setup", (page) => go(page, "app-setup/someone.radio")],
  // Its three previews are home itself, which T5.3 checks to the pixel. Here
  // they're blank, since the checks skip what's in them, and loading three
  // more launchers each time slows every other test running beside this one.
  ["settings → themes and backgrounds", async (page) => {
    await page.route(/\/\?preview/, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
    await go(page, "settings/look");
  }],
  ["weather", (page) => go(page, "weather")],
  ["new this week", (page) => go(page, "new")],
  ["the ambient screen", (page) => page.evaluate(() => (window as unknown as { agentvAmbient(on: boolean): void }).agentvAmbient(true))],
  // Last, since it changes home: the built-ins at their other sizes.
  ["home with small and large tiles", async (page) => {
    const layout = [
      { id: "agentv.weather", x: 0, y: 0, size: "l" },
      { id: "agentv.clock", x: 2, y: 0, size: "m" },
      { id: "agentv.music", x: 2, y: 1, size: "s" },
      { id: "agentv.new", x: 0, y: 2, size: "m" },
      { id: "agentv.sample", x: 3, y: 1, size: "s" },
      { id: "agentv.tube", x: 2, y: 2, size: "s" },
      { id: "local.mytv", x: 3, y: 2, size: "s" },
    ];
    await page.evaluate(async (body) => {
      await fetch("/api/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body });
    }, JSON.stringify({ layout }));
    await page.reload();
    await page.waitForSelector("html[data-look] #page .focused");
    await page.waitForTimeout(400);
  }],
  ["home with a small weather tile", async (page) => {
    const layout = [
      { id: "agentv.weather", x: 0, y: 0, size: "s" },
      { id: "agentv.clock", x: 1, y: 0, size: "s" },
      { id: "agentv.music", x: 2, y: 0, size: "s" },
      { id: "agentv.new", x: 3, y: 0, size: "s" },
    ];
    await page.evaluate(async (body) => {
      await fetch("/api/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body });
    }, JSON.stringify({ layout }));
    await page.reload();
    await page.waitForSelector("html[data-look] #page .focused");
    await page.waitForTimeout(400);
  }],
];

for (const look of LOOKS) {
  test(`T5.2 ${look}: there's no all apps tile, and Apps is one press from home`, async () => {
    await useLook(look);
    const home = await (await fetch(`${url}/api/home`)).json();
    assert.ok(!home.layout.some((tile: { id: string }) => tile.id === home.appsTile), "the layout has no all apps tile");
    // Even a layout saved with it, from before the looks, draws without it.
    const old = [{ id: "agentv.sample", x: 0, y: 0, size: "s" }, { id: home.appsTile, x: 1, y: 0, size: "s" }];
    await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: old }) });
    const page = await tv();
    try {
      assert.equal(await page.locator(`.tile-apps, .tile[data-id="${home.appsTile}"]`).count(), 0, "home draws no all apps tile");
      // Apps is on home itself, in the look's bar, and one OK on it opens Apps.
      const apps = page.locator('[data-action="bar-apps"]');
      assert.equal(await apps.count(), 1, "Apps is in the bar");
      await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-action="bar-apps"]')!;
        (window as unknown as { agentvLauncher: { focus: { set(el: HTMLElement, announce: boolean): void } } }).agentvLauncher.focus.set(el, false);
      });
      await page.keyboard.press("Enter");
      await page.waitForSelector(".page.apps, .apps-page");
      // Back from Apps is home, its parent.
      await page.keyboard.press("Escape");
      await page.waitForSelector("body.on-home");
      // The arrows reach it from the first tile.
      const reached = await page.evaluate(async () => {
        const launcher = (window as unknown as { agentvLauncher: { focus: { get(): HTMLElement | undefined; move(d: string): boolean } } }).agentvLauncher;
        const seen = new Set<string>();
        for (const way of ["down", "down", "down", "down", "right", "right", "left", "up", "up", "up", "up", "up"]) {
          launcher.focus.move(way);
          const at = launcher.focus.get();
          if (at?.dataset.action) seen.add(at.dataset.action);
        }
        return [...seen];
      });
      assert.ok(reached.includes("bar-apps") || reached.some((one) => one.startsWith("bar-")), `the arrows reach the bar: ${reached.join(", ")}`);
      // The phone's Apps button, beside Settings, opens it too.
      await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("home"));
    } finally {
      await page.close();
    }
  });

  for (const size of Object.keys(SIZES) as Size[]) {
    test(`T5.1 ${look} at ${size}: home, Apps, Settings, the built-in apps and the ambient screen fit and read clearly, dark and light`, async () => {
      await useLook(look);
      await builtinsOnHome();
      const problems: string[] = [];
      for (const theme of THEMES) {
        await useTheme(theme);
        for (const [where, open] of SCREENS) {
          const page = await tv(size);
          try {
            await open(page);
            await page.waitForTimeout(400);
            await settled(page);
            for (const one of await overflows(page)) problems.push(`${theme}, ${where}: ${one}`);
            for (const one of await shortfalls(page)) problems.push(`${theme}, ${where}: "${one.text}" reads at ${one.ratio} of ${one.needs} (${one.color} on ${one.behind})`);
          } finally {
            await page.close();
          }
        }
      }
      assert.deepEqual(problems, [], `${look} at ${size}:\n${problems.join("\n")}`);
      assert.deepEqual(errors.splice(0), [], "no screen had an error");
    });
  }
}

test("Terminal at more on screen has a 5 × 4 grid with a layout of its own", async () => {
  await useLook("terminal");
  await builtinsOnHome();
  const four = (await (await fetch(`${url}/api/home`)).json()).layout;
  // Until it's arranged, the 5 × 4 layout is the 4 × 3 one, in its places.
  const more = (await (await fetch(`${url}/api/home?grid=5x4`)).json()).layout;
  assert.deepEqual(more, four);
  const page = await tv("more");
  try {
    const columns = await page.$eval(".grid", (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    const rows = await page.$eval(".grid", (el) => getComputedStyle(el).gridTemplateRows.split(" ").length);
    assert.deepEqual([columns, rows], [5, 4]);
  } finally {
    await page.close();
  }
  // A tile in the fifth column fits there, and only there.
  const wide = [...four, { id: "someone.radio", x: 4, y: 3, size: "s" }];
  const kept = await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: wide, grid: "5x4" }) });
  assert.equal(kept.status, 200);
  assert.deepEqual((await (await fetch(`${url}/api/home?grid=5x4`)).json()).layout, wide);
  assert.deepEqual((await (await fetch(`${url}/api/home`)).json()).layout, four, "the 4 × 3 layout stays as it was");
  const refused = await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: wide }) });
  assert.equal(refused.status, 400, "the fifth column isn't on the 4 × 3 grid");
});

// How much of two screenshots differs, from 0 to 1, drawn in the browser.
async function difference(a: Buffer, b: Buffer): Promise<number> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ([one, two]) => {
      const load = (data: string) =>
        new Promise<HTMLImageElement>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.src = `data:image/png;base64,${data}`;
        });
      const [x, y] = await Promise.all([load(one), load(two)]);
      if (x.width !== y.width || x.height !== y.height) return 1;
      const pixels = (img: HTMLImageElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const draw = canvas.getContext("2d")!;
        draw.drawImage(img, 0, 0);
        return draw.getImageData(0, 0, img.width, img.height).data;
      };
      const [p, q] = [pixels(x), pixels(y)];
      let off = 0;
      for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 24) off++;
      return off / (p.length / 4);
    }, [a.toString("base64"), b.toString("base64")]);
  } finally {
    await page.close();
  }
}

// A page at a size's canvas, with the clock held still, as home or as its
// preview, once it's had time to draw.
// The preview's stand-ins (launcher/looks/showcase.ts) left out, so a
// preview and home draw the same titles and can be compared.
const NO_STAND_INS = 'export const SHOWCASE_APP = "agentv.new"; export const isShowcaseImage = () => false; export const showcasePicture = () => false; export const showcaseTile = (tile) => tile;';

async function shot(address: string, size: Size): Promise<Buffer> {
  const width = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height: Math.round((width * 9) / 16) } });
  try {
    await page.route("**/launcher/looks/showcase.ts", (route) => route.fulfill({ contentType: "text/javascript", body: NO_STAND_INS }));
    await page.clock.setFixedTime(new Date("2026-11-08T20:47:00"));
    await page.goto(`${url}${address}`);
    await page.waitForSelector("html[data-look] #page .focused");
    await page.waitForTimeout(1500);
    return await page.screenshot();
  } finally {
    await page.close();
  }
}

test("T5.3 setup's look step shows each look's preview, and the preview is home in that look, theme and size", async () => {
  await builtinsOnHome();
  await useTheme("tokyo-night");
  // Setup, at the look step: everything before it finished.
  const at = new Date().toISOString();
  const finished = Object.fromEntries(["welcome", "ready", "country", "ai", "people", "goal", "apps"].map((step) => [step, at]));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "look", finished, goal: "streaming" }));
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
      await page.goto(`${url}/`);
      await page.waitForSelector(".setup-look .look-card.focused");
      const frames = await page.$$eval(".setup-look .look-frame-page", (els) => els.map((el) => new URL((el as HTMLIFrameElement).src).search));
      assert.deepEqual(frames, LOOKS.map((look) => `?preview&look=${look}&size=standard`));
      // The looks by name, with no line under them, and one preview: the
      // focused look's, which moves with the focus.
      assert.equal(await page.locator(".setup-look .look-card-line").count(), 0);
      const shown = () => page.$eval(".setup-look-stage .look-frame.on", (el) => (el as HTMLElement).dataset.preview);
      assert.equal(await shown(), await page.$eval(".setup-look .look-card.focused", (el) => (el as HTMLElement).dataset.look));
      const focusedLook = () => page.$eval(".setup-look .look-card.focused", (el) => (el as HTMLElement).dataset.look);
      for (let i = 0; i < LOOKS.length && (await focusedLook()) !== "cinema"; i++) await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => (document.querySelector(".setup-look-stage .look-frame.on") as HTMLElement | null)?.dataset.preview === "cinema");
      // With no TMDB key yet, the preview fills New this week with the open
      // movies, and home itself doesn't.
      const cinema = page.frameLocator('.setup-look-stage [data-preview="cinema"] iframe');
      await cinema.locator('.cinema-poster-card img[src^="/launcher/looks/showcase/"]').first().waitFor();
      assert.match(await cinema.locator(".cinema-hero").innerText(), /cosmos laundromat/i);
      const home = (await (await fetch(`${url}/api/tile/agentv.new/l`)).json()).tile;
      assert.equal((home?.entries ?? []).length, 0, "the daemon's own tile has none");
      // Picking one sets the look and goes on to the theme and background.
      await page.locator('.setup-look [data-look="cinema"]').click();
      await page.waitForSelector(".theme2 .tb-themes");
      assert.equal((await (await fetch(`${url}/api/look`)).json()).look, "cinema");
      assert.equal((await (await fetch(`${url}/api/setup`)).json()).setup.step, "theme", "on to the theme, the next step");
    } finally {
      await page.close();
    }
  } finally {
    writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true }));
  }
  // The preview is home itself, in each look and size, dark and light.
  const off: string[] = [];
  for (const theme of THEMES) {
    await useTheme(theme);
    for (const look of LOOKS) {
      await useLook(look);
      for (const size of Object.keys(SIZES) as Size[]) {
        if (theme !== THEMES[0] && size !== "standard") continue;
        const home = await shot(`/?size=${size}`, size);
        const preview = await shot(`/?preview&look=${look}&size=${size}&theme=${theme}`, size);
        const differs = await difference(home, preview);
        if (differs > 0.002) off.push(`${look} at ${size} in ${theme}: ${(differs * 100).toFixed(2)}% of the screen differs`);
      }
    }
  }
  await useTheme("tokyo-night");
  assert.deepEqual(off, []);
});

test("Settings → Themes and backgrounds shows each of the theme's own pictures, and OK on one asks Omarchy to show it", async () => {
  // Two of Tokyo Night's, as the screen daemon hands them over, the first
  // the one Omarchy shows.
  const dir = join(import.meta.dirname, "..", "..", "..", "themes", "tokyo-night", "backgrounds");
  const files = readdirSync(dir)
    .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
    .sort()
    .slice(0, 2)
    .map((name) => {
      const body = readFileSync(join(dir, name));
      const type = name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
      return { id: createHash("sha256").update(body).digest("hex").slice(0, 16), type, body };
    });
  await fetch(`${url}/api/backgrounds/theme`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: "tokyo-night", current: files[0].id, files: files.map(({ id, type }) => ({ id, type })) }) });
  for (const file of files) await fetch(`${url}/api/backgrounds/theme/${file.id}`, { method: "POST", body: new Uint8Array(file.body) });
  const before = (await (await fetch(`${url}/api/backgrounds`)).json()).source;
  await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "theme" }) });
  await useLook("terminal");
  const page = await tv();
  const card = (id: string) => `.theme-picture[data-action="theme-picture-${id}"]`;
  try {
    await go(page, "settings/look");
    await page.waitForSelector(card(files[1].id));
    assert.equal(await page.locator(".theme-picture").count(), 2, "a card for each");
    assert.equal(await page.locator(".theme-picture.picked").getAttribute("data-action"), `theme-picture-${files[0].id}`, "the one Omarchy shows");
    await page.locator(card(files[1].id)).click();
    await page.waitForFunction((id) => (window as unknown as { screenRequests: { cmd: string; background?: string }[] }).screenRequests.some((r) => r.cmd === "theme-bg-set" && r.background === id), files[1].id);
    await page.waitForSelector(`${card(files[1].id)}.picked`);
  } finally {
    await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: before }) });
    await page.close();
  }
});

// Why the ring isn't on the focused element, to the pixel, or "" when it is.
// It runs in the page.
function ringOff(wanted: string): string {
  const el = document.querySelector<HTMLElement>("#page .focused");
  if (el?.dataset.action !== wanted) return `${el?.dataset.action ?? el?.className ?? "nothing"} has the focus, not ${wanted}`;
  const ring = document.getElementById("ring")!.getBoundingClientRect();
  const at = el.getBoundingClientRect();
  const far = Math.max(Math.abs(ring.left - at.left), Math.abs(ring.top - at.top), Math.abs(ring.right - at.right), Math.abs(ring.bottom - at.bottom));
  const say = (r: DOMRect) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`;
  return far > 1.5 ? `the ring is at ${say(ring)} and ${wanted} at ${say(at)}` : "";
}

// The arrow that goes from the focused element toward another: along its
// row when they share one, and up or down otherwise. It runs in the page.
function arrowTo(wanted: string): string {
  const from = document.querySelector("#page .focused")!.getBoundingClientRect();
  const to = document.querySelector(`[data-action="${wanted}"]`)!.getBoundingClientRect();
  if (Math.abs(to.top - from.top) < from.height / 2) return to.left > from.left ? "ArrowRight" : "ArrowLeft";
  return to.top > from.top ? "ArrowDown" : "ArrowUp";
}

// Two frames on, so what a scroll or a load set off has been drawn.
function frames(page: Page): Promise<null> {
  return page.evaluate(() => new Promise<null>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
}

// Waits for the ring to get there, and says where each is when it doesn't.
async function ringOn(page: Page, action: string, when: string): Promise<void> {
  let why = "";
  for (const until = Date.now() + 3000; Date.now() < until; await page.waitForTimeout(50)) {
    why = await page.evaluate(ringOff, action);
    if (!why) return;
  }
  assert.fail(`${when}: ${why}`);
}

test("Settings → Themes and backgrounds keeps the focus ring on the card as each look is picked, and its theme list shows whole rows and that it goes on", async () => {
  try {
    for (const size of Object.keys(SIZES) as Size[]) {
      for (const from of ["glass", "cinema"] as const) {
        await useLook(from);
        const page = await tv(size);
        const at = `${from} at ${size}`;
        try {
          await go(page, "settings/look");
          await settled(page);
          await page.keyboard.press("Enter");
          await ringOn(page, "look-terminal", `${at}, into the panel`);
          // Across the three cards, and each look picked in turn: the page
          // is laid out again in the new look after the pick. At larger the
          // third card is under the first, so the arrows go by where a card is.
          for (const look of ["glass", "terminal", "cinema", "terminal", "glass"] as const) {
            for (let presses = 0; presses < 2 && (await page.evaluate(() => document.querySelector<HTMLElement>("#page .focused")?.dataset.action)) !== `look-${look}`; presses++) {
              await page.keyboard.press(await page.evaluate(arrowTo, `look-${look}`));
            }
            await ringOn(page, `look-${look}`, `${at}, across to ${look}`);
            await page.keyboard.press("Enter");
            await page.waitForSelector(`html[data-look="${look}"]`);
            await ringOn(page, `look-${look}`, `${at}, ${look} picked`);
          }
          // The theme list under the cards shows whole rows, never part
          // of one, and a thumb beside it says it goes on and how far down.
          const list = () =>
            page.evaluate(() => {
              const box = document.querySelector(".look-list")!.getBoundingClientRect();
              const rows = [...document.querySelectorAll(".look-item")].map((el) => el.getBoundingClientRect());
              const cut = rows.filter((r) => r.bottom > box.top + 1 && r.top < box.bottom - 1 && (r.top < box.top - 1 || r.bottom > box.bottom + 1)).length;
              const thumb = document.querySelector<HTMLElement>(".look-scroll.scrolls .look-thumb span");
              const track = thumb?.parentElement?.getBoundingClientRect();
              const mark = thumb?.getBoundingClientRect();
              return { cut, shown: rows.filter((r) => r.top >= box.top - 1 && r.bottom <= box.bottom + 1).length, thumb: Boolean(mark?.width && mark.height), down: mark && track ? Math.round(mark.top - track.top) : -1 };
            });
          await page.keyboard.press("ArrowDown");
          assert.match((await page.evaluate(() => document.querySelector<HTMLElement>("#page .focused")?.dataset.action)) ?? "", /^theme-/, `${at}: down from the cards is the theme list`);
          assert.deepEqual(await list(), { cut: 0, shown: 4, thumb: true, down: 0 }, `${at}: two whole rows of themes, and the thumb at the top`);
          // The cards' previews load again after a pick. Each is home in a
          // frame, and what it scrolls is its own: the panel stays where the
          // focus is.
          await page.waitForFunction(() => [...document.querySelectorAll<HTMLIFrameElement>(".look-cards iframe")].every((frame) => frame.contentDocument?.querySelector("#page .focused")));
          await frames(page);
          const inSight = await page.evaluate(() => {
            const panel = document.querySelector(".settings-panel")!.getBoundingClientRect();
            const row = document.querySelector("#page .focused")!.getBoundingClientRect();
            return row.top >= panel.top - 1 && row.bottom <= panel.bottom + 1;
          });
          assert.ok(inSight, `${at}: the focused theme is still in sight once the previews have loaded`);
          for (let row = 0; row < 3; row++) await page.keyboard.press("ArrowDown");
          const focused = (await page.evaluate(() => document.querySelector<HTMLElement>("#page .focused")?.dataset.action)) ?? "";
          assert.match(focused, /^theme-/, `${at}: still in the list`);
          await ringOn(page, focused, `${at}, down the theme list`);
          // The thumb moves with the list's scroll, a frame after the keys.
          await frames(page);
          const down = await list();
          assert.ok(down.cut === 0 && down.shown === 4 && down.down > 0, `${at}: whole rows still, and the thumb has moved down: ${JSON.stringify(down)}`);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await useLook("terminal");
  }
});
