// The look cards, in a real Chromium (ADR-019, layer 4): Settings →
// Appearance → Look and setup's look step, in each look, at each size, in a
// dark theme and a light one.
//
// - In Settings the three cards sit three across and fill the panel's width,
//   and each card's preview fills its frame.
// - The focus ring hugs the focused card, with the preview and the name
//   inside the card's padding, so the ring never crosses the name.
// - The look in use has a mark by its name and no second ring: no frame has
//   an outline, and its frame's edge is the same as the others'.
// - In setup the ring hugs the focused name the same way, and the look in
//   use has the same mark.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";
import { rendered } from "./legible.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
const SIZES = { larger: 1600, standard: 1920, more: 2400 } as const;
type Size = keyof typeof SIZES;
const THEMES = ["tokyo-night", "catppuccin-latte"];
// The least room between the ring's line and what's inside it, on the canvas.
const ROOM = 8;

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url, state } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", features: { looks: true } }));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true }));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

async function put(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${url}${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, `PUT ${path}`);
}

async function useTheme(theme: string): Promise<void> {
  await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) });
}

// A page at a viewport. The previews are blank: their frames are what's
// measured, and three more launchers per page would slow every test beside
// this one.
async function open(width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: Math.round((width * 9) / 16) } });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  await page.route(/\/\?preview/, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  return page;
}

// Once nothing moves, as the ring glides to the card.
async function still(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5000 });
  await page.waitForTimeout(200);
}

// What's wrong with the ring on the focused card, or [] when nothing is. It
// runs in the page.
function ringProblems(room: number): string[] {
  const problems: string[] = [];
  const card = document.querySelector<HTMLElement>("#page .look-card.focused");
  if (!card) return ["no card has the focus"];
  const z = Number(document.documentElement.style.zoom) || 1;
  const ringEl = document.getElementById("ring")!;
  const ring = ringEl.getBoundingClientRect();
  const at = card.getBoundingClientRect();
  const say = (r: { left: number; top: number; right: number; bottom: number }) => `${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)}`;
  // The ring hugs the card.
  const far = Math.max(Math.abs(ring.left - at.left), Math.abs(ring.top - at.top), Math.abs(ring.right - at.right), Math.abs(ring.bottom - at.bottom));
  if (far > 1.5) problems.push(`the ring is at ${say(ring)} and the card at ${say(at)}`);
  // Inside the ring's line, the preview and the name's words have room.
  const line = parseFloat(getComputedStyle(ringEl).borderTopWidth) * z;
  const inside = { left: ring.left + line, top: ring.top + line, right: ring.right - line, bottom: ring.bottom - line };
  const words = document.createRange();
  words.selectNodeContents(card.querySelector(".look-card-name")!);
  const parts: [string, DOMRect][] = [["the name", words.getBoundingClientRect()]];
  const frame = card.querySelector(".look-frame");
  if (frame) parts.push(["the preview", frame.getBoundingClientRect()]);
  for (const [what, r] of parts) {
    const gaps = [r.left - inside.left, r.top - inside.top, inside.right - r.right, inside.bottom - r.bottom].map((n) => Math.round(n / z));
    if (Math.min(...gaps) < room) problems.push(`${what} has ${gaps.join(", ")} px inside the ring (left, top, right, bottom)`);
  }
  return problems;
}

// What's wrong with the in-use mark and the frames' edges, or [] when
// nothing is. It runs in the page.
function markProblems(current: string): string[] {
  const problems: string[] = [];
  for (const card of document.querySelectorAll<HTMLElement>("#page .look-card")) {
    const mark = getComputedStyle(card.querySelector(".look-card-name")!, "::after");
    const marked = mark.content !== "none" && mark.content !== "normal" && parseFloat(mark.width) > 0 && mark.backgroundColor !== "rgba(0, 0, 0, 0)";
    const inUse = card.dataset.look === current;
    if (marked !== inUse) problems.push(`${card.dataset.look} is ${inUse ? "in use and has no mark" : "not in use and has a mark"}`);
    if (card.classList.contains("picked") !== inUse) problems.push(`${card.dataset.look} is ${inUse ? "in use and not picked" : "picked and not in use"}`);
  }
  const frames = [...document.querySelectorAll<HTMLElement>("#page .look-card .look-frame")].map((el) => {
    const style = getComputedStyle(el);
    return { look: el.closest<HTMLElement>(".look-card")!.dataset.look, outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0, edge: `${style.borderTopWidth} ${style.borderTopColor}`, shadow: style.boxShadow };
  });
  for (const frame of frames) {
    if (frame.outline) problems.push(`${frame.look}'s preview has an outline`);
    if (frame.edge !== frames[0].edge || frame.shadow !== frames[0].shadow) problems.push(`${frame.look}'s preview has an edge of its own: ${frame.edge} ${frame.shadow}`);
  }
  return problems;
}

// What's wrong with the cards' row in Settings, or [] when nothing is: three
// across, filling the panel's width, each preview filling its frame. It runs
// in the page.
function rowProblems(): string[] {
  const problems: string[] = [];
  const cards = [...document.querySelectorAll<HTMLElement>("#page .look-cards .look-card")].map((el) => el.getBoundingClientRect());
  if (cards.length !== 3) return [`${cards.length} cards`];
  if (cards.some((r) => Math.abs(r.top - cards[0].top) > 1)) problems.push(`the cards aren't in one row: tops at ${cards.map((r) => Math.round(r.top)).join(", ")}`);
  const panel = document.querySelector<HTMLElement>("#page .look-cards")!.parentElement!;
  const box = panel.getBoundingClientRect();
  const style = getComputedStyle(panel);
  const z = Number(document.documentElement.style.zoom) || 1;
  const left = box.left + (parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)) * z;
  const right = box.right - (parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight)) * z;
  if (Math.abs(cards[0].left - left) > 1.5 || Math.abs(cards[2].right - right) > 1.5) {
    problems.push(`the cards go from ${Math.round(cards[0].left)} to ${Math.round(cards[2].right)}, and the panel from ${Math.round(left)} to ${Math.round(right)}`);
  }
  for (const frame of document.querySelectorAll<HTMLElement>("#page .look-cards .look-frame")) {
    const page = frame.querySelector("iframe")!.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    const fs = getComputedStyle(frame);
    const width = f.width - (parseFloat(fs.borderLeftWidth) + parseFloat(fs.borderRightWidth)) * z;
    if (Math.abs(page.width - width) > 1.5) problems.push(`a preview is ${Math.round(page.width)} wide in a frame ${Math.round(width)} wide`);
  }
  return problems;
}

for (const look of LOOKS) {
  test(`${look}: Settings' look cards fill the panel three across, and one ring hugs the focused card with its name inside, at each size, dark and light`, async () => {
    await put("/api/look", { look });
    const problems: string[] = [];
    for (const theme of THEMES) {
      await useTheme(theme);
      for (const size of Object.keys(SIZES) as Size[]) {
        const page = await open(SIZES[size]);
        const at = `${theme}, ${size}`;
        try {
          await page.goto(`${url}/?size=${size}`);
          await page.waitForSelector("html[data-look] #page .focused");
          await rest(page);
          await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("settings/looks"));
          await page.waitForSelector("#page .look-cards .look-card");
          await still(page);
          await page.keyboard.press("Enter");
          await page.waitForSelector("#page .look-card.focused");
          for (const problem of await page.evaluate(rowProblems)) problems.push(`${at}: ${problem}`);
          for (const problem of await page.evaluate(markProblems, look)) problems.push(`${at}: ${problem}`);
          // Each card in turn, left to right.
          for (const one of LOOKS) {
            for (let presses = 0; presses < 3 && (await page.evaluate(() => document.querySelector<HTMLElement>("#page .focused")?.dataset.look)) !== one; presses++) {
              await page.keyboard.press("ArrowRight");
            }
            await still(page);
            for (const problem of await page.evaluate(ringProblems, ROOM)) problems.push(`${at}, on ${one}: ${problem}`);
          }
        } finally {
          await page.close();
        }
      }
    }
    assert.deepEqual(problems, []);
  });
}

test("setup's look step: one ring hugs the focused name with the name inside, and the look in use has the mark, in each look, at each size, dark and light", async () => {
  const problems: string[] = [];
  const at = new Date().toISOString();
  const finished = Object.fromEntries(["welcome", "ready", "country", "ai", "people", "goal", "apps"].map((step) => [step, at]));
  try {
    for (const theme of THEMES) {
      await useTheme(theme);
      for (const look of LOOKS) {
        await put("/api/look", { look });
        for (const size of Object.keys(SIZES) as Size[]) {
          writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "look", finished, goal: "streaming" }));
          const page = await open(SIZES[size]);
          const where = `${theme}, ${look} in use, at ${size}`;
          try {
            await page.goto(`${url}/`);
            await page.waitForSelector(".setup-look .look-card.focused");
            await rest(page);
            for (const problem of await page.evaluate(markProblems, look)) problems.push(`${where}: ${problem}`);
            // Each name in turn, down the list.
            const focused = () => page.evaluate(() => document.querySelector<HTMLElement>("#page .focused")?.dataset.look);
            for (const one of LOOKS) {
              for (let presses = 0; presses < 3 && (await focused()) !== one; presses++) {
                await page.keyboard.press(LOOKS.indexOf(one) < LOOKS.indexOf((await focused()) as (typeof LOOKS)[number]) ? "ArrowUp" : "ArrowDown");
              }
              await still(page);
              for (const problem of await page.evaluate(ringProblems, ROOM)) problems.push(`${where}, on ${one}: ${problem}`);
            }
          } finally {
            await page.close();
          }
        }
      }
    }
  } finally {
    writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true }));
    await put("/api/look", { look: "terminal" });
  }
  assert.deepEqual(problems, []);
});
