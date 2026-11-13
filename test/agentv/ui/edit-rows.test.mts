// Editing home in Glass and Cinema, in a real Chromium (ADR-019, layer 4).
// Both draw home as rows, so the edit key opens the look's own home with its
// apps editable in place, never Terminal's grid. In each look, at each size,
// dark and light:
//
// - OK picks the focused app up, left and right carry it along its row, OK
//   puts it down and saves, and Back puts it back where it was;
// - Delete takes an app off home;
// - + and - change nothing, since neither look draws an app bigger;
// - a click picks an app up rather than opening it;
// - the bar says it's editing home, and how, where home says to hold OK
//   for details, and those words read clearly and fit;
// - and a child's profile with a PIN asks for it, as Terminal's does.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, beforeEach, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";
import { rendered, shortfalls } from "./legible.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["glass", "cinema"] as const;
const SIZES = { larger: 1600, standard: 1920, more: 2400 } as const;
const THEMES = ["tokyo-night", "catppuccin-latte"];

// Four apps in a row, then the games. All apps isn't a tile in these looks.
const START = [
  { id: "agentv.sample", x: 0, y: 0, size: "s" },
  { id: "agentv.tube", x: 1, y: 0, size: "s" },
  { id: "someone.radio", x: 2, y: 0, size: "s" },
  { id: "local.mytv", x: 3, y: 0, size: "s" },
  { id: "agentv.games", x: 0, y: 1, size: "s" },
  { id: "apps", x: 1, y: 1, size: "s" },
];

let browser: Browser;
let daemon: Daemon;
let url = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url } = await startBox(0, FIXTURES, { features: { looks: true } }));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

type Tile = { id: string; x: number; y: number; size: string };

async function layout(): Promise<Tile[]> {
  return (await (await fetch(`${url}/api/home`)).json()).layout;
}

// The apps in the order a row look draws them.
async function order(): Promise<string[]> {
  return (await layout())
    .filter((tile) => tile.id !== "apps")
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((tile) => tile.id);
}

async function setLayout(tiles: Tile[]): Promise<void> {
  const response = await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: tiles }) });
  assert.equal(response.status, 200, await response.text());
}

const useLook = (look: string) => fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
const useTheme = async (theme: string) => assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200, `the theme ${theme} took`);

beforeEach(() => setLayout(START));

async function tv(size: keyof typeof SIZES = "standard"): Promise<Page> {
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
  return page;
}

type Launcher = { agentvLauncher: { focus: { set(el: HTMLElement, announce: boolean): void; get(): HTMLElement | undefined } } };

// Home in edit mode, with the focus on an app.
async function editing(page: Page, on: string): Promise<void> {
  await page.keyboard.press("e");
  await page.waitForSelector(".row-edit .editing [data-id].focused");
  await focusOn(page, on);
}

async function focusOn(page: Page, id: string): Promise<void> {
  await page.evaluate((one) => {
    const el = document.querySelector<HTMLElement>(`.row-edit [data-id="${one}"]`)!;
    (window as unknown as Launcher).agentvLauncher.focus.set(el, false);
  }, id);
}

const focused = (page: Page) => page.evaluate(() => (window as unknown as Launcher).agentvLauncher.focus.get()?.dataset.id);
const held = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>(".row-edit .held")?.dataset.id ?? null);

for (const look of LOOKS) {
  test(`${look}: the edit key opens the look's own home, where OK, the arrows and Back move an app along its row`, async () => {
    await useLook(look);
    const page = await tv();
    try {
      await editing(page, "agentv.tube");
      assert.equal(await page.locator(".grid.editing, .badge, .corner").count(), 0, "not Terminal's grid");
      // Pick it up and carry it one to the right: nothing's saved yet.
      await page.keyboard.press("Enter");
      assert.equal(await held(page), "agentv.tube");
      await page.keyboard.press("ArrowRight");
      assert.equal(await held(page), "agentv.tube", "still held, redrawn in its new place");
      assert.equal(await focused(page), "agentv.tube", "the focus stays on it");
      const drawn = await page.locator(".row-edit [data-id]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.id));
      assert.ok(drawn.indexOf("agentv.tube") > drawn.indexOf("someone.radio"), `drawn after radio: ${drawn.join(", ")}`);
      assert.deepEqual(await order(), ["agentv.sample", "agentv.tube", "someone.radio", "local.mytv", "agentv.games"]);
      // Put it down: saved, in the order it's drawn.
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector(".row-edit .held"));
      await page.waitForTimeout(200);
      assert.deepEqual(await order(), ["agentv.sample", "someone.radio", "agentv.tube", "local.mytv", "agentv.games"]);
      // Back puts it back where it was.
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      assert.equal(await held(page), null);
      assert.deepEqual(await order(), ["agentv.sample", "someone.radio", "agentv.tube", "local.mytv", "agentv.games"]);
      // The first can't go further left, nor a game into the apps' row.
      await focusOn(page, "agentv.sample");
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Enter");
      await focusOn(page, "agentv.games");
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      assert.deepEqual(await order(), ["agentv.sample", "someone.radio", "agentv.tube", "local.mytv", "agentv.games"]);
      // Back again leaves for home.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".row-edit"));
    } finally {
      await page.close();
    }
  });

  test(`${look}: Delete takes an app off home, + and - change nothing, and a click picks an app up`, async () => {
    await useLook(look);
    const page = await tv();
    try {
      await editing(page, "someone.radio");
      const was = await layout();
      await page.keyboard.press("Equal");
      await page.keyboard.press("Minus");
      await page.waitForTimeout(200);
      assert.deepEqual(await layout(), was, "sizes are Terminal's");
      await page.keyboard.press("Delete");
      await page.waitForTimeout(300);
      assert.ok(!(await order()).includes("someone.radio"), "off home");
      assert.equal(await page.locator('.row-edit [data-id="someone.radio"]').count(), 0);
      assert.ok(await focused(page), "the focus lands on an app nearby");
      // A click picks up, and opens nothing.
      await page.locator('.row-edit [data-id="local.mytv"]').click();
      assert.equal(await held(page), "local.mytv");
      assert.ok(await page.locator(".row-edit").isVisible(), "still editing");
      await page.keyboard.press("Escape");
    } finally {
      await page.close();
    }
  });

  test(`${look}: editing's words read clearly and fit, and the held app stands out, at each size, dark and light`, async () => {
    await useLook(look);
    const problems: string[] = [];
    for (const theme of THEMES) {
      await useTheme(theme);
      for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
        const page = await tv(size);
        const at = `${theme}, ${size}`;
        try {
          await editing(page, "agentv.tube");
          await page.keyboard.press("Enter");
          await page.waitForTimeout(400);
          const seen = await page.evaluate(() => {
            const hint = document.querySelector<HTMLElement>(".edit-hint")!.getBoundingClientRect();
            const tile = document.querySelector<HTMLElement>(".row-edit .held")!;
            const style = getComputedStyle(tile);
            return { hint: { left: hint.left, right: hint.right, bottom: hint.bottom }, width: innerWidth, height: innerHeight, border: style.borderTopWidth, accent: style.borderTopColor };
          });
          if (seen.hint.left < 0 || seen.hint.right > seen.width || seen.hint.bottom > seen.height) problems.push(`${at}: the bar's words run off the screen`);
          if (parseFloat(seen.border) < 3) problems.push(`${at}: the held app has a ${seen.border} edge`);
          const words = await page.locator(".row-edit .edit-hint").innerText();
          if (!/^Editing home\. Move with the arrows, then OK$/.test(words.trim())) problems.push(`${at}: the bar says "${words}"`);
          for (const one of (await shortfalls(page)).filter((short) => words.includes(short.text))) problems.push(`${at}: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
        } finally {
          await page.close();
        }
      }
    }
    assert.deepEqual(problems, [], `${look}:\n${problems.join("\n")}`);
  });
}

test("glass: a child's profile with a PIN asks for it before editing home", async () => {
  await useLook("glass");
  const page = await tv();
  try {
    await page.route("**/api/home", async (route) => {
      const home = await (await route.fetch()).json();
      await route.fulfill({ json: { ...home, viewer: { ...home.viewer, role: "child" }, pin: { ...(home.pin ?? {}), set: true } } });
    });
    await page.reload();
    await page.waitForSelector("html[data-look] #page .focused");
    await rest(page);
    await page.keyboard.press("e");
    await page.waitForFunction(() => document.getElementById("pin")?.classList.contains("on"), null, { timeout: 5000 });
    assert.match(await page.locator("#pin").innerText(), /for editing home$/im);
    assert.equal(await page.locator(".row-edit").count(), 0, "not editing until the PIN's in");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.close();
  }
});
