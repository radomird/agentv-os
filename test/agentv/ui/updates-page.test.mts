// Settings → Updates and its What's new, in a real Chromium (ADR-019,
// layer 4), in each look, at each size, in a dark theme and a light one,
// with a version as long as early updates' are: Install now has the focus as
// the page opens, every row's name stays on one line inside its row, the
// notes show a level deeper, and every word reads clearly.

import assert from "node:assert/strict";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
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
let updates = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url, updates } = await startBox(0, FIXTURES, { features: { looks: true } }));
  const status = {
    checked_at: new Date().toISOString(),
    ok: true,
    channel: "edge",
    agentv: { installed: "0.2.0.r470.g1234567ab-1", available: "0.2.0.r479.g7b931248a-1" },
    omarchy: { installed: "4.5.0-1", available: null },
    packages: 12,
    security: false,
    notes: { agentv: ["The PIN pad in every look", "Room around a focused poster"], agentv_date: "2026-11-12", omarchy: [] },
  };
  writeFileSync(join(updates, "status.json.next"), JSON.stringify(status));
  renameSync(join(updates, "status.json.next"), join(updates, "status.json"));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  rmSync(join(updates, "status.json"), { force: true });
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

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

// What's wrong with the panel as drawn: a row whose name wraps or runs out
// of it, or a row past the panel's side.
function rowsOff(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const panel = document.querySelector(".settings-panel")!.getBoundingClientRect();
    const found: string[] = [];
    for (const row of document.querySelectorAll<HTMLElement>(".settings-panel :is(.button, .panel-row)")) {
      const box = row.getBoundingClientRect();
      const name = row.querySelector("span");
      const which = row.dataset.action ?? row.dataset.row ?? row.textContent;
      if (box.right > panel.right + 1) found.push(`${which} runs past the panel`);
      if (row.scrollWidth > row.clientWidth + 2) found.push(`${which} is wider than its row`);
      if (name) {
        const line = parseFloat(getComputedStyle(name).lineHeight) || parseFloat(getComputedStyle(name).fontSize) * 1.3;
        if (name.getBoundingClientRect().height > line * 1.5) found.push(`${which}'s name wraps`);
      }
    }
    return found;
  });
}

for (const look of LOOKS) {
  test(`${look}: Updates opens on Install now, and it and What's new fit and read clearly at each size, dark and light`, async () => {
    await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
    const problems: string[] = [];
    for (const theme of THEMES) {
      assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200, `the theme ${theme} took`);
      for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
        const page = await tv(size);
        const at = `${theme}, ${size}`;
        try {
          // OK on System's Updates row.
          await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("settings/tv.updates"));
          await page.waitForSelector('.focused[data-action="updates"]');
          await page.keyboard.press("Enter");
          await page.waitForSelector('.settings-panel[data-page="updates"]');
          await page.waitForTimeout(300);
          const focused = await page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action"));
          if (focused !== "install") problems.push(`${at}: Updates opened on ${focused}, not Install now`);
          for (const one of await rowsOff(page)) problems.push(`${at}, Updates: ${one}`);
          for (const one of await shortfalls(page)) problems.push(`${at}, Updates: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
          // What's new, a level deeper.
          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("Enter");
          await page.waitForSelector('.settings-panel[data-page="whats-new"] .notes li');
          await page.waitForTimeout(300);
          const notes = await page.locator(".settings-panel .notes li").count();
          if (notes !== 2) problems.push(`${at}: What's new shows ${notes} notes, not the release's 2`);
          for (const one of await rowsOff(page)) problems.push(`${at}, What's new: ${one}`);
          for (const one of await shortfalls(page)) problems.push(`${at}, What's new: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
        } finally {
          await page.close();
        }
      }
    }
    assert.deepEqual(problems, [], `${look}:\n${problems.join("\n")}`);
  });
}
