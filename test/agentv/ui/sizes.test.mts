// T4.1: home and the built-in apps at each of the TV's sizes (ADR-062), in
// every look, with nothing cut off. Each size is a canvas, 1600, 1920 or
// 2400 pixels across, which the TV's scale makes of a 4K output. Here it
// goes the way it does on the box: the sizes and looks switched on, the size
// picked through /api/display with a stand-in screen daemon setting it, and
// the page opened at that canvas and that scale, as Hyprland gives it to
// home's Chromium. Every piece of text and everything that takes the focus
// has to be on the screen, inside the box it's drawn in and clear of the
// status bar. Words a page shortens on purpose, with an ellipsis or a line
// clamp, are fine. Then the size pickers: Settings → Themes and backgrounds
// and setup's look step.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";
import { startMet, type Met } from "./met.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const SIZES = [
  { size: "larger", canvas: [1600, 900] },
  { size: "standard", canvas: [1920, 1080] },
  { size: "more", canvas: [2400, 1350] },
] as const;
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
  ({ daemon, url, state } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", forecast: met.url, features: { looks: true, sizes: true } }));
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

async function put(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 200, `${path} ${JSON.stringify(body)}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// Two homes with every built-in on it, each tile at each of its sizes
// between them: Weather, Clock, Music, New this week and two apps.
const HOMES = {
  "home with weather large": [
    { id: "agentv.weather", x: 0, y: 0, size: "l" },
    { id: "agentv.clock", x: 2, y: 0, size: "m" },
    { id: "agentv.music", x: 2, y: 1, size: "m" },
    { id: "agentv.new", x: 0, y: 2, size: "m" },
    { id: "agentv.sample", x: 2, y: 2, size: "s" },
    { id: "agentv.tube", x: 3, y: 2, size: "s" },
  ],
  "home with music and new large": [
    { id: "agentv.music", x: 0, y: 0, size: "l" },
    { id: "agentv.new", x: 2, y: 0, size: "l" },
    { id: "agentv.clock", x: 0, y: 2, size: "s" },
    { id: "agentv.weather", x: 1, y: 2, size: "m" },
    { id: "agentv.sample", x: 3, y: 2, size: "s" },
  ],
} as const;

async function tv(canvas: readonly [number, number]): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: canvas[0], height: canvas[1] }, deviceScaleFactor: 3840 / canvas[0] });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector("#page .focused");
  await rest(page);
  return page;
}

// Everything on the page that's cut off: off the screen, past the edge of the
// box it's drawn in, under the status bar, or clipped inside itself, unless
// that's an ellipsis or a line clamp, or it's in a list that scrolls.
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
    const say = (el: Element) => (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || (el as HTMLElement).dataset.action || String(el.className);
    const clips = (style: CSSStyleDeclaration) => style.overflowX !== "visible" || style.overflowY !== "visible";
    const scrolls = (el: Element, style: CSSStyleDeclaration) => el.hasAttribute("data-scroll") || /auto|scroll/.test(style.overflowY) || /auto|scroll/.test(style.overflowX);
    const shortened = (style: CSSStyleDeclaration) => style.textOverflow === "ellipsis" || (style.webkitLineClamp !== "none" && style.webkitLineClamp !== "");
    const barEl = document.querySelector("#page .bar");
    const bar = barEl?.getBoundingClientRect() ?? null;
    const shown = document.querySelector("#ambient.on") ? "#ambient.on *" : "#page *";
    for (const el of document.querySelectorAll<HTMLElement>(shown)) {
      const style = getComputedStyle(el);
      if (style.visibility !== "visible" || el.closest("svg, [aria-hidden='true']") || el instanceof HTMLImageElement) continue;
      const own = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
      if (!own && !el.hasAttribute("data-focus")) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      let opacity = 1;
      for (let at: Element | null = el; at; at = at.parentElement) opacity *= Number(getComputedStyle(at).opacity);
      if (opacity === 0) continue;
      // Inside itself: words that don't fit and aren't shortened on purpose.
      if (own && clips(style) && !shortened(style) && !scrolls(el, style) && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
        push(el, `"${say(el)}" doesn't fit in itself`);
        continue;
      }
      // In a list that scrolls, what's below comes into view with the
      // focus, so only the part in sight counts. A list must stop above a
      // status bar along the bottom, or what it scrolls into view ends up
      // under it. (Glass and Cinema have theirs along the top, and their
      // pages start below it.)
      let seen: DOMRect | null = box;
      for (let at = el.parentElement; at && at !== document.body; at = at.parentElement) {
        if (!scrolls(at, getComputedStyle(at))) continue;
        const edge = at.getBoundingClientRect();
        // The part of the list in sight: a list inside another that scrolls
        // is cut off at that one's edges.
        let shownTop = edge.top;
        let shownBottom = edge.bottom;
        for (let outer = at.parentElement; outer && outer !== document.body; outer = outer.parentElement) {
          if (!scrolls(outer, getComputedStyle(outer))) continue;
          const outerEdge = outer.getBoundingClientRect();
          shownTop = Math.max(shownTop, outerEdge.top);
          shownBottom = Math.min(shownBottom, outerEdge.bottom);
        }
        const bottomBar = bar && bar.top > innerHeight / 2;
        if (bottomBar && barEl && !at.contains(barEl) && shownBottom > bar.top + 1) push(at, `the list "${say(at)}" runs under the status bar`);
        const top = Math.max(box.top, shownTop);
        const bottom = Math.min(box.bottom, shownBottom);
        seen = bottom > top ? new DOMRect(box.left, top, box.width, bottom - top) : null;
        break;
      }
      const inScroller = seen !== box;
      // The box it's drawn in: the nearest one that clips and doesn't scroll.
      for (let at = el.parentElement; at && at !== document.body; at = at.parentElement) {
        const outer = getComputedStyle(at);
        if (!clips(outer)) continue;
        if (scrolls(at, outer)) break;
        const edge = at.getBoundingClientRect();
        if (box.left < edge.left - 1 || box.right > edge.right + 1 || box.top < edge.top - 1 || box.bottom > edge.bottom + 1) {
          push(el, `"${say(el)}" is cut off by its ${at.className || at.tagName.toLowerCase()}`);
        }
        break;
      }
      if (seen && bar && barEl && !barEl.contains(el) && !el.contains(barEl) && seen.bottom > bar.top + 1 && seen.top < bar.bottom - 1 && seen.right > bar.left && seen.left < bar.right) {
        push(el, `"${say(el)}" is under the status bar`);
      }
      if (inScroller) continue;
      if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) push(el, `"${say(el)}" is off the screen`);
    }
    return found;
  });
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);

test("T4.1 home and the built-in apps at 1600, 1920 and 2400 in every look, with nothing cut off", async () => {
  const problems: string[] = [];
  const looks = ((await (await fetch(`${url}/api/look`)).json()) as { looks: { id: string }[] }).looks.map((look) => look.id);
  assert.deepEqual(looks, ["terminal", "glass", "cinema"]);
  for (const look of looks) {
    await put("/api/look", { look });
    for (const { size, canvas } of SIZES) {
      const answer = await put("/api/display", { size });
      assert.deepEqual([answer.canvas, answer.applied], [canvas, true], `${size} is a ${canvas[0]} wide canvas, and the TV took it`);
      for (const [name, layout] of Object.entries(HOMES)) {
        await put("/api/layout", { layout });
        const page = await tv(canvas);
        try {
          // Home lays out on the size's canvas, at the TV's own pixels.
          assert.deepEqual(
            await page.evaluate(() => [document.documentElement.dataset.look, document.documentElement.dataset.size, document.documentElement.style.zoom]),
            [look, size, "1"],
            `${look} at ${size}: home lays out on its canvas, with no zoom`,
          );
          const check = async (where: string) => {
            await rest(page);
            for (const problem of await cutOff(page)) problems.push(`${look}, ${size}, ${where}: ${problem}`);
          };
          await check(name);
          if (name !== "home with weather large") continue;
          for (const route of ["apps", "add-app", "details/agentv.sample", "music", "weather", "new"]) {
            await go(page, route);
            await check(route);
            await page.keyboard.press("Home");
          }
          await go(page, "settings");
          await rest(page);
          const sections = await page.$$eval(".menu [data-key]", (items) => items.map((item) => (item as HTMLElement).dataset.key!));
          assert.ok(sections.length > 5, "settings has its sections");
          for (const key of sections) {
            await go(page, `settings/${key}`);
            await check(`settings → ${key}`);
          }
          await page.keyboard.press("Home");
          await page.evaluate(() => (window as unknown as { agentvAmbient: (on: boolean) => void }).agentvAmbient(true));
          await check("the ambient screen");
          if (process.env.AGENTV_UI_SHOTS) await page.screenshot({ path: join(process.env.AGENTV_UI_SHOTS, `success-T4.1-${look}-${size}.png`) }).catch(() => {});
        } finally {
          await page.close();
        }
      }
    }
  }
  await put("/api/look", { look: "terminal" });
  await put("/api/display", { size: "standard" });
  if (process.env.AGENTV_UI_SHOTS) writeFileSync(join(process.env.AGENTV_UI_SHOTS, "T4.1-problems.txt"), problems.join("\n"));
  assert.deepEqual(problems, [], "nothing is cut off");
  assert.deepEqual(errors, [], "no errors on the page");
});

test("T4.1 the size row in Settings steps through the sizes this TV offers, and home follows within a second", async () => {
  await put("/api/display", { size: "standard" });
  const page = await tv([1920, 1080]);
  const value = () => page.locator('[data-action="size"] .button-value').textContent().then((text) => text?.trim());
  try {
    await go(page, "settings/look");
    await rest(page);
    assert.equal(await value(), "Standard");
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-action="size"]')!;
      (window as unknown as { agentvLauncher: { focus: { set(el: HTMLElement): void } } }).agentvLauncher.focus.set(el);
    });
    const started = Date.now();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.documentElement.dataset.size === "more", undefined, { timeout: 1000 });
    assert.ok(Date.now() - started < 1000, "the new size applies within a second");
    assert.equal(((await (await fetch(`${url}/api/display`)).json()) as { size: string }).size, "more");
    await page.waitForFunction(() => document.querySelector('[data-action="size"] .button-value')?.textContent?.trim() === "More on screen");
    await page.keyboard.press("ArrowRight");
    await rest(page);
    assert.equal(((await (await fetch(`${url}/api/display`)).json()) as { size: string }).size, "more", "right at the last size stays there");
    for (const want of ["Standard", "Larger"]) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction((w) => document.querySelector('[data-action="size"] .button-value')?.textContent?.trim() === w, want);
    }
    await page.waitForFunction(() => document.documentElement.dataset.size === "larger");
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--canvas-width")), "1600px");
  } finally {
    await page.close();
    await put("/api/display", { size: "standard" });
  }
});

test("T4.1 on a 4K TV, Settings puts it on 1080p output and back, and the sizes follow", async () => {
  await put("/api/display", { size: "more" });
  const page = await tv([2400, 1350]);
  const value = (action: string) => page.locator(`[data-action="${action}"] .button-value`).textContent().then((text) => text?.trim());
  const display = async () => (await (await fetch(`${url}/api/display`)).json()) as { output: string; mode: string; scale: number; size: string; sizes: string[] };
  try {
    await go(page, "settings/look");
    await rest(page);
    assert.equal(await value("resolution"), "4K");
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-action="resolution"]')!;
      (window as unknown as { agentvLauncher: { focus: { set(el: HTMLElement): void } } }).agentvLauncher.focus.set(el);
    });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-action="resolution"] .button-value')?.textContent?.trim() === "1080p");
    const hd = await display();
    assert.deepEqual([hd.output, hd.mode, hd.scale, hd.size, hd.sizes], ["1080p", "1920x1080@60", 1, "standard", ["larger", "standard"]], "1080p output, where more on screen isn't offered");
    assert.equal(await value("size"), "Standard");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-action="resolution"] .button-value')?.textContent?.trim() === "4K");
    const uhd = await display();
    assert.deepEqual([uhd.output, uhd.mode, uhd.scale, uhd.size], ["auto", "3840x2160@60", 1.6, "more"], "back at 4K, more on screen comes back too");
  } finally {
    await page.close();
    await put("/api/display", { output: "auto", size: "standard" });
  }
});

test("T4.1 setup's look step offers the TV's sizes under the looks, and each look's preview follows the size", async () => {
  await put("/api/display", { size: "standard" });
  const at = new Date().toISOString();
  const finished = Object.fromEntries(["welcome", "ready", "country", "ai", "people", "goal", "apps"].map((step) => [step, at]));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "look", finished, goal: "streaming" }));
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  try {
    await page.goto(`${url}/`);
    await page.waitForSelector(".setup-look .look-card.focused");
    const chips = () => page.$$eval(".setup-look-sizes .chip", (els) => els.map((el) => `${el.textContent?.trim()}${el.classList.contains("picked") ? " *" : ""}`));
    assert.deepEqual(await chips(), ["Larger", "Standard *", "More on screen"]);
    const previews = () => page.$$eval(".setup-look .look-frame-page", (els) => els.map((el) => new URL((el as HTMLIFrameElement).src).searchParams.get("size")));
    assert.deepEqual(await previews(), ["standard", "standard", "standard"]);
    await page.locator('.setup-look-sizes [data-action="size-more"]').click();
    await page.waitForFunction(() => document.querySelector('.setup-look-sizes [data-action="size-more"]')?.classList.contains("picked"));
    assert.deepEqual(await chips(), ["Larger", "Standard", "More on screen *"]);
    assert.deepEqual(await previews(), ["more", "more", "more"], "each look's preview is home at more on screen");
    assert.equal(((await (await fetch(`${url}/api/display`)).json()) as { size: string }).size, "more");
    assert.equal(((await (await fetch(`${url}/api/setup`)).json()) as { setup: { step: string } }).setup.step, "look", "picking a size stays on the step");
  } finally {
    await page.close();
    writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true }));
    await put("/api/display", { size: "standard" });
  }
});

test("T4.1 with the sizes switched off, there's no size picker and home is at standard, as before", async () => {
  writeFileSync(join(state, "features.json"), JSON.stringify({ looks: true, sizes: false }));
  const page = await tv([3840, 2160]);
  try {
    assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.size, document.documentElement.style.zoom]), ["standard", "2"]);
    await go(page, "settings/look");
    await rest(page);
    assert.equal(await page.locator('[data-action="size"]').count(), 0);
    assert.equal((await page.locator('[data-row="size"] .button-value').textContent())?.trim(), "Standard");
    assert.equal((await fetch(`${url}/api/display`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size: "larger" }) })).status, 409);
  } finally {
    await page.close();
    writeFileSync(join(state, "features.json"), JSON.stringify({ looks: true, sizes: true }));
  }
});
