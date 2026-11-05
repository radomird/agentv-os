// T4.1: home and the built-in apps at each of the TV's sizes (ADR-062), in
// every look, with nothing cut off. Each size is a canvas, 1600, 1920 or
// 2400 pixels across, which the TV's scale makes of a 4K output. The page is
// opened at that canvas and that scale, as Hyprland gives it to home's
// Chromium, and every piece of text and everything that takes the focus has
// to be on the screen and inside the box it's drawn in. Words a page shortens
// on purpose, with an ellipsis or a line clamp, are fine.
//
// The looks come from GET and PUT /api/look once that's there. Until then
// it's the one look home has.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, startBox } from "./box.mts";
import { startMet, type Met } from "./met.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const SIZES = [
  { size: "larger", canvas: [1600, 900] },
  { size: "standard", canvas: [1920, 1080] },
  { size: "more", canvas: [2400, 1350] },
] as const;
const LOOKS = ["terminal", "glass", "cinema"];
// The 4K TV the scale is worked out for.
const TV = { output: "HDMI-A-1", modes: ["3840x2160@60.00Hz", "1920x1080@60.00Hz"], live: { mode: "3840x2160@60", scale: 2 } };

let browser: Browser;
let daemon: Daemon;
let met: Met;
let url = "";
let state = "";
let screenDaemon = true;
const errors: string[] = [];

// The screen daemon's side of a size change: it takes each ask and says
// the TV runs at it, as DisplayWatch does once Hyprland has it.
async function standInScreen(): Promise<void> {
  while (screenDaemon) {
    const said = (await (await fetch(`${url}/api/display/ask`).catch(() => null))?.json().catch(() => null)) as { ask?: { n: number; target: { mode: string; scale: number } } | null } | null;
    const ask = said?.ask;
    if (!ask) continue;
    await fetch(`${url}/api/display/ask/${ask.n}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, live: { mode: ask.target.mode, scale: ask.target.scale } }) });
  }
}

before(async () => {
  met = await startMet();
  ({ daemon, url, state } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", forecast: met.url }));
  writeFileSync(join(state, "features.json"), JSON.stringify({ sizes: true }));
  await fetch(`${url}/api/display/tv`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(TV) });
  void standInScreen();
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  screenDaemon = false;
  await browser?.close();
  await daemon?.close();
  met?.close();
});

// The looks this box draws: the ones PUT /api/look takes, or the one there is.
async function looks(): Promise<string[]> {
  const took: string[] = [];
  for (const look of LOOKS) {
    const response = await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) }).catch(() => null);
    if (response?.ok) took.push(look);
  }
  return took.length > 0 ? took : ["the one look home has"];
}

async function setLook(look: string): Promise<void> {
  if (!LOOKS.includes(look)) return;
  await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
}

async function setSize(size: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/api/display`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size }) });
  assert.equal(response.status, 200, `the size ${size} is set`);
  return (await response.json()) as Record<string, unknown>;
}

// Two homes with every built-in on it, each tile at each of its sizes
// between them: Weather, Clock, Music, New this week, an app and the apps.
const HOMES = {
  "home with weather large": [
    { id: "agentv.weather", x: 0, y: 0, size: "l" },
    { id: "agentv.clock", x: 2, y: 0, size: "m" },
    { id: "agentv.music", x: 2, y: 1, size: "m" },
    { id: "agentv.new", x: 0, y: 2, size: "m" },
    { id: "agentv.sample", x: 2, y: 2, size: "s" },
    { id: "apps", x: 3, y: 2, size: "s" },
  ],
  "home with music and new large": [
    { id: "agentv.music", x: 0, y: 0, size: "l" },
    { id: "agentv.new", x: 2, y: 0, size: "l" },
    { id: "agentv.clock", x: 0, y: 2, size: "s" },
    { id: "agentv.weather", x: 1, y: 2, size: "m" },
    { id: "apps", x: 3, y: 2, size: "s" },
  ],
} as const;

async function setHome(layout: readonly object[]): Promise<void> {
  const response = await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout }) });
  assert.equal(response.status, 200, (await response.text()).slice(0, 200));
}

async function tv(canvas: readonly [number, number]): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: canvas[0], height: canvas[1] }, deviceScaleFactor: 3840 / canvas[0] });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

// Everything on the page that's cut off: off the screen, past the edge of the
// box it's drawn in, or clipped inside itself, unless that's an ellipsis or a
// line clamp, or it's in a list that scrolls.
function cutOff(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    // Each thing once: what's inside something already found isn't said again.
    const flagged = new Set<Element>();
    const push = (el: Element, text: string) => {
      for (let at: Element | null = el; at; at = at.parentElement) if (flagged.has(at)) return;
      flagged.add(el);
      found.push(text);
    };
    const say = (el: Element) => (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || (el as HTMLElement).dataset.action || el.className;
    const clips = (style: CSSStyleDeclaration) => style.overflowX !== "visible" || style.overflowY !== "visible";
    const scrolls = (style: CSSStyleDeclaration) => /auto|scroll/.test(style.overflowY) || /auto|scroll/.test(style.overflowX);
    const shortened = (style: CSSStyleDeclaration) => style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none";
    for (const el of document.querySelectorAll<HTMLElement>("#page *, #bar *, .bar *")) {
      const style = getComputedStyle(el);
      if (style.visibility !== "visible" || el.closest("svg, [aria-hidden='true']")) continue;
      const own = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
      if (!own && !el.hasAttribute("data-focus")) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      let opacity = 1;
      for (let at: Element | null = el; at; at = at.parentElement) opacity *= Number(getComputedStyle(at).opacity);
      if (opacity === 0) continue;
      // Inside itself: words that don't fit and aren't shortened on purpose.
      if (own && clips(style) && !shortened(style) && !scrolls(style) && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
        push(el, `"${say(el)}" doesn't fit in itself`);
        continue;
      }
      // In a list that scrolls, what's below comes into view with the focus.
      let inScroller = false;
      for (let at = el.parentElement; at && at !== document.body; at = at.parentElement) {
        const outer = getComputedStyle(at);
        if (!scrolls(outer)) continue;
        inScroller = true;
        const edge = at.getBoundingClientRect();
        if (box.left < edge.left - 1 || box.right > edge.right + 1) push(el, `"${say(el)}" runs past the side of its list`);
        // The list itself stops at the status bar, so what it scrolls into
        // view is never under it.
        const bar = document.querySelector(".screen .bar")?.getBoundingClientRect();
        if (bar && edge.bottom > bar.top + 1 && edge.top < bar.bottom) push(at, `the list "${say(at)}" runs under the status bar`);
        if (edge.bottom > innerHeight + 1) push(at, `the list "${say(at)}" runs off the screen`);
        break;
      }
      // The box it's drawn in: the nearest one that clips and doesn't scroll.
      for (let at = el.parentElement; at && at !== document.body; at = at.parentElement) {
        const outer = getComputedStyle(at);
        if (!clips(outer)) continue;
        if (scrolls(outer)) break;
        const edge = at.getBoundingClientRect();
        if (box.left < edge.left - 1 || box.right > edge.right + 1 || box.top < edge.top - 1 || box.bottom > edge.bottom + 1) {
          push(el, `"${say(el)}" is cut off by its ${at.className || at.tagName.toLowerCase()}`);
        }
        break;
      }
      // Under the status bar, which is drawn over the page.
      const bar = document.querySelector(".screen .bar");
      if (bar && !bar.contains(el) && !el.contains(bar)) {
        const under = bar.getBoundingClientRect();
        if (box.bottom > under.top + 1 && box.top < under.bottom - 1 && box.right > under.left && box.left < under.right) {
          // In a list that scrolls, only what can't scroll out from under it.
          if (!inScroller) push(el, `"${say(el)}" is under the status bar`);
        }
      }
      if (inScroller) continue;
      if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) push(el, `"${say(el)}" is off the screen`);
    }
    return [...new Set(found)];
  });
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const settle = (page: Page) => page.waitForTimeout(450);

test("T4.1 home and the built-in apps at 1600, 1920 and 2400 in every look, with nothing cut off", async () => {
  const problems: string[] = [];
  for (const look of await looks()) {
    await setLook(look);
    for (const { size, canvas } of SIZES) {
      const answer = await setSize(size);
      assert.deepEqual(answer.canvas, canvas, `${size} is a ${canvas[0]} wide canvas`);
      const page = await tv(canvas);
      try {
        // The page is the canvas, at the TV's own pixels: no zoom.
        assert.deepEqual(await page.evaluate(() => [document.documentElement.style.zoom, document.body.clientWidth, document.body.clientHeight]), ["1", canvas[0], canvas[1]], `${size}: home lays out on its canvas`);
        const check = async (where: string) => {
          await settle(page);
          for (const problem of await cutOff(page)) problems.push(`${look}, ${size}, ${where}: ${problem}`);
        };
        for (const [name, layout] of Object.entries(HOMES)) {
          await setHome(layout);
          await page.reload();
          await page.waitForSelector(".grid .tile.focused");
          await check(name);
        }
        for (const route of ["apps", "add-app", "details/agentv.sample", "music", "whats-new"]) {
          await go(page, route);
          await check(route);
          await page.keyboard.press("Home");
        }
        await go(page, "settings");
        await settle(page);
        const sections = await page.$$eval(".menu [data-key]", (items) => items.map((item) => (item as HTMLElement).dataset.key!));
        assert.ok(sections.length > 5, "settings has its sections");
        for (const key of sections) {
          await go(page, `settings/${key}`);
          await check(`settings → ${key}`);
        }
        await page.keyboard.press("Home");
        await page.evaluate(() => (window as unknown as { agentvAmbient: (on: boolean) => void }).agentvAmbient(true));
        await settle(page);
        const ambient = await page.evaluate(() => {
          const el = document.getElementById("ambient");
          const box = el?.getBoundingClientRect();
          return box ? [Math.round(box.width), Math.round(box.height)] : null;
        });
        if (ambient) assert.deepEqual(ambient, [canvas[0], canvas[1]], `${size}: the ambient screen fills the canvas`);
        await page.screenshot({ path: join(process.env.AGENTV_UI_SHOTS ?? state, `success-T4.1-${look.split(" ")[0]}-${size}.png`) }).catch(() => {});
      } finally {
        await page.close();
      }
    }
  }
  if (process.env.AGENTV_UI_SHOTS) writeFileSync(join(process.env.AGENTV_UI_SHOTS, "T4.1-problems.txt"), problems.join("\n"));
  assert.deepEqual(problems, [], "nothing is cut off");
  assert.deepEqual(errors, [], "no errors on the page");
});

test("T4.1 the size picker in Settings steps through the sizes this TV offers, and home follows within a second", async () => {
  await setSize("standard");
  const page = await tv([1920, 1080]);
  try {
    await go(page, "settings/look");
    await settle(page);
    const row = page.locator('[data-action="size"]');
    assert.equal((await row.locator(".button-value").textContent())?.trim(), "standard");
    await row.focus();
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-action="size"]')!;
      (window as unknown as { agentvLauncher: { focus: { set(el: HTMLElement): void } } }).agentvLauncher.focus.set(el);
    });
    const started = Date.now();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--canvas-width") === "2400px", undefined, { timeout: 1000 });
    assert.ok(Date.now() - started < 1000, "the new size applies within a second");
    assert.equal(((await (await fetch(`${url}/api/display`)).json()) as { size: string }).size, "more");
    await page.waitForFunction(() => document.querySelector('[data-action="size"] .button-value')?.textContent?.trim() === "more on screen");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    assert.equal(((await (await fetch(`${url}/api/display`)).json()) as { size: string }).size, "more", "right at the last size stays there");
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => document.querySelector('[data-action="size"] .button-value')?.textContent?.trim() === "standard");
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => document.querySelector('[data-action="size"] .button-value')?.textContent?.trim() === "larger");
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--canvas-width")), "1600px");
  } finally {
    await page.close();
    await setSize("standard");
  }
});

test("T4.1 with the sizes switched off, there's no picker and home zooms 1920 × 1080 to fit, as before", async () => {
  writeFileSync(join(state, "features.json"), JSON.stringify({ sizes: false }));
  const page = await tv([3840, 2160]);
  try {
    assert.deepEqual(await page.evaluate(() => [document.documentElement.style.zoom, document.body.clientWidth]), ["2", 1920]);
    await go(page, "settings/look");
    await settle(page);
    assert.equal(await page.locator('[data-action="size"]').count(), 0);
  } finally {
    await page.close();
    writeFileSync(join(state, "features.json"), JSON.stringify({ sizes: true }));
  }
});
