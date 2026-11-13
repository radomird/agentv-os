// The adult PIN's pad in each look, in a real Chromium (ADR-019, layer 4).
// At each size, in a dark theme and a light one:
//
// - Glass and Cinema draw it in their own design: centred, with no panel and
//   no boxes, four dots for the digits, and keys that fill in the words'
//   colour when they have the focus, round in Glass and rounded cards in
//   Cinema, with the look's own delete icon;
// - Terminal's stays as it was: its prompt, boxes for the digits and square
//   keys;
// - in every look it's all on the screen, nothing in it is cut off, and its
//   words read clearly.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";
import { rendered, shortfalls } from "./legible.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
const SIZES = { larger: 1600, standard: 1920, more: 2400 } as const;
const THEMES = ["tokyo-night", "catppuccin-latte"];

let browser: Browser;
let daemon: Daemon;
let url = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", features: { looks: true } }));
  assert.equal(daemon.pin.set("4826", undefined), null);
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

async function pad(size: keyof typeof SIZES): Promise<Page> {
  const width = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height: Math.round((width * 9) / 16) } });
  page.on("pageerror", (error) => errors.push(error.message));
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
  // An adult action asks for it, as installing an update does.
  void page.evaluate(() => (window as unknown as { agentvLauncher: { askPin(action: string): Promise<unknown> } }).agentvLauncher.askPin("installing the update")).catch(() => {});
  await page.waitForSelector("#pin.on .pin-key.focused");
  // One digit in, and the focus on the next key.
  await page.keyboard.press("2");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelectorAll("#pin .pin-box.filled").length === 1);
  await page.waitForTimeout(300);
  return page;
}

interface Drawn {
  centre: number;
  headline: number;
  panel: { border: string; background: string };
  prompt: boolean;
  dots: { width: number; height: number; radius: string }[];
  keys: { width: number; height: number; radius: string; background: string }[];
  focused: { background: string; color: string };
  words: string;
  deleteIcon: { glyph: boolean; drawn: string };
  offScreen: string[];
  cut: string[];
}

function drawn(page: Page): Promise<Drawn> {
  return page.evaluate(() => {
    const pin = document.getElementById("pin")!;
    const el = pin.querySelector<HTMLElement>(".pin-pad")!;
    const style = (e: Element, pseudo?: string) => getComputedStyle(e, pseudo);
    const headline = el.querySelector(".headline")!.getBoundingClientRect();
    const focused = el.querySelector(".pin-key.focused")!;
    const remove = el.querySelector(".pin-delete")!;
    const offScreen: string[] = [];
    const cut: string[] = [];
    for (const e of el.querySelectorAll<HTMLElement>("*")) {
      const box = e.getBoundingClientRect();
      if (!box.width || !box.height || style(e).display === "none") continue;
      const name = `${e.tagName.toLowerCase()}.${e.className}`;
      if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) offScreen.push(name);
      if (!(e instanceof SVGElement) && (style(e).overflowX !== "visible" || style(e).overflowY !== "visible") && (e.scrollWidth > e.clientWidth + 2 || e.scrollHeight > e.clientHeight + 2)) cut.push(name);
    }
    return {
      centre: innerWidth / 2,
      headline: (headline.left + headline.right) / 2,
      panel: { border: style(el).borderTopStyle, background: style(el).backgroundColor },
      prompt: style(el.querySelector(".prompt")!).display !== "none",
      dots: [...el.querySelectorAll(".pin-box")].map((d) => ({ width: d.getBoundingClientRect().width, height: d.getBoundingClientRect().height, radius: style(d).borderTopLeftRadius })),
      keys: [...el.querySelectorAll(".pin-key:not(.focused):not(.pin-delete)")].map((k) => ({ width: k.getBoundingClientRect().width, height: k.getBoundingClientRect().height, radius: style(k).borderTopLeftRadius, background: style(k).backgroundColor })),
      focused: { background: style(focused).backgroundColor, color: style(focused).color },
      words: getComputedStyle(document.documentElement).getPropertyValue("--bright-foreground").trim(),
      deleteIcon: { glyph: style(remove.querySelector("svg")!).display !== "none", drawn: [style(remove, "::before").maskImage, style(remove, "::before").webkitMaskImage].find((one) => one?.startsWith("url(")) ?? "none" },
      offScreen,
      cut,
    };
  });
}

// A colour as the browser gives it, from the theme's hex.
function rgb(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

for (const look of LOOKS) {
  test(`the PIN pad in ${look} follows the look, fits and reads clearly at each size, dark and light`, async () => {
    await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
    const problems: string[] = [];
    for (const theme of THEMES) {
      assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200, `the theme ${theme} took`);
      for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
        const page = await pad(size);
        const at = `${theme}, ${size}`;
        try {
          const d = await drawn(page);
          for (const one of d.offScreen) problems.push(`${at}: ${one} is off the screen`);
          for (const one of d.cut) problems.push(`${at}: ${one} cuts off what's in it`);
          const padText = await page.locator("#pin").innerText();
          for (const one of await shortfalls(page)) {
            if (padText.includes(one.text)) problems.push(`${at}: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
          }
          if (look === "terminal") {
            // As it was.
            if (!d.prompt) problems.push(`${at}: Terminal's prompt is gone`);
            if (d.keys.some((k) => k.radius !== "0px")) problems.push(`${at}: Terminal's keys are rounded`);
            if (d.dots.some((dot) => dot.height <= dot.width)) problems.push(`${at}: Terminal's digits aren't boxes`);
            if (!d.deleteIcon.glyph) problems.push(`${at}: Terminal's delete glyph is gone`);
            continue;
          }
          if (Math.abs(d.headline - d.centre) > 2) problems.push(`${at}: the headline isn't centred (${Math.round(d.headline)} of ${d.centre})`);
          if (d.panel.border !== "none" || d.panel.background !== "rgba(0, 0, 0, 0)") problems.push(`${at}: the pad is drawn in a panel (${d.panel.border}, ${d.panel.background})`);
          if (d.prompt) problems.push(`${at}: Terminal's prompt shows`);
          if (d.dots.some((dot) => Math.abs(dot.width - dot.height) > 0.5 || dot.radius !== "50%")) problems.push(`${at}: the digits aren't dots`);
          const round = look === "glass";
          if (d.keys.some((k) => (round ? k.radius !== "50%" || Math.abs(k.width - k.height) > 0.5 : k.radius === "0px"))) problems.push(`${at}: the keys aren't ${round ? "round" : "rounded cards"}`);
          if (d.focused.background !== rgb(d.words)) problems.push(`${at}: the focused key isn't filled in the words' colour (${d.focused.background})`);
          if (d.focused.color === d.focused.background) problems.push(`${at}: the focused key's digit can't be seen`);
          if (d.deleteIcon.glyph || !d.deleteIcon.drawn.startsWith("url(")) problems.push(`${at}: delete has Terminal's glyph, not the look's icon`);
        } finally {
          await page.close();
        }
      }
    }
    assert.deepEqual(problems, [], `${look}:\n${problems.join("\n")}`);
  });
}
