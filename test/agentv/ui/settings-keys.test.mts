// Settings' list and its pages, in a real Chromium (ADR-019, layer 4):
//
// - in each look, at each size, down on the last row of a section or of a
//   page in it (Appearance, and its theme page) stays on that row, so one
//   press too many can't skip past it or leave the page;
// - in Terminal, the panel beside the list runs down to the bar, as the list
//   does, so what's in it isn't cut off short of there: Appearance's rows
//   all show at each size, dark and light.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";
import { rendered } from "./legible.mts";

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
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

const useLook = (look: string) => fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
const useTheme = (theme: string) => fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) });

async function tv(size: keyof typeof SIZES): Promise<Page> {
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

type Launcher = { agentvLauncher: { go(route: string): void; focus: { set(el: HTMLElement, announce: boolean): void; get(): HTMLElement | undefined } } };
const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as Launcher).agentvLauncher.go(r), route);

// Puts the focus on the panel's last row, presses down, and says where the
// focus and the panel are after.
async function downFromLast(page: Page, route: string, panel: string, last: string): Promise<{ at: string | undefined; panel: string | undefined }> {
  await go(page, route);
  await page.waitForSelector(`.settings-panel[data-page="${panel}"] [data-action="${last}"]`);
  const lastOne = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".settings-panel [data-focus]")].at(-1)?.dataset.action);
  assert.equal(lastOne, last, `${last} is the last row on ${panel}`);
  await page.evaluate((one) => {
    const el = document.querySelector<HTMLElement>(`.settings-panel [data-action="${one}"]`)!;
    (window as unknown as Launcher).agentvLauncher.focus.set(el, false);
  }, last);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  return page.evaluate(() => ({ at: (window as unknown as Launcher).agentvLauncher.focus.get()?.dataset.action, panel: document.querySelector<HTMLElement>(".settings-panel")?.dataset.page }));
}

for (const look of LOOKS) {
  test(`${look}: down on the last row of a section, or of a page in it, stays there, at each size`, async () => {
    await useLook(look);
    const problems: string[] = [];
    for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
      const page = await tv(size);
      try {
        for (const [route, panel, last] of [
          ["settings/look", "look", "motion"],
          ["settings/theme", "theme", "theme-own"],
        ] as const) {
          const after = await downFromLast(page, route, panel, last);
          if (after.at !== last || after.panel !== panel) problems.push(`${size}, ${panel}: down went to ${after.at ?? "nothing"} on ${after.panel}`);
        }
      } finally {
        await page.close();
      }
    }
    assert.deepEqual(problems, []);
  });
}

test("Terminal: Settings' panel runs down to the bar, as the list does, and Appearance's rows aren't cut off, at each size, dark and light", async () => {
  await useLook("terminal");
  const problems: string[] = [];
  for (const theme of THEMES) {
    await useTheme(theme);
    for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
      const page = await tv(size);
      try {
        await go(page, "settings/look");
        await page.waitForSelector('.settings-panel[data-page="look"] [data-action="motion"]');
        await page.waitForTimeout(300);
        const seen = await page.evaluate(() => {
          const panel = document.querySelector<HTMLElement>(".settings-panel")!;
          const box = panel.getBoundingClientRect();
          const bar = document.querySelector(".bar")!.getBoundingClientRect();
          const list = document.querySelector(".settings .menu")!.getBoundingClientRect();
          const cut = [...panel.querySelectorAll<HTMLElement>("[data-focus]")].filter((row) => row.getBoundingClientRect().bottom > box.bottom + 1).map((row) => row.dataset.action);
          return { bottom: box.bottom, bar: bar.top, list: list.bottom, cut };
        });
        const at = `${theme}, ${size}`;
        if (seen.bottom < seen.list) problems.push(`${at}: the panel ends at ${Math.round(seen.bottom)}, above the list's ${Math.round(seen.list)}`);
        if (seen.bar - seen.bottom > 40) problems.push(`${at}: the panel ends ${Math.round(seen.bar - seen.bottom)} px above the bar`);
        if (seen.cut.length) problems.push(`${at}: Appearance is cut off at ${seen.cut.join(", ")}`);
      } finally {
        await page.close();
      }
    }
  }
  assert.deepEqual(problems, []);
});
