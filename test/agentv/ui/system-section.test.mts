// Settings' System section, in a real Chromium (ADR-019, layer 4; ADR-095).
// In each look, at each size, in a dark theme and a light one:
//
// - the section is called System, and has one row each for Location,
//   Updates, Power, Omarchy's desktop and About;
// - Power opens a page with Restart, Shut down and sleep, and Back is System,
//   on Power; a child's System has no Power;
// - every row fits, and the words read clearly.
//
// And the update that couldn't install says where to try again: in
// Settings, under System.

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
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

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

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const rows = (page: Page) => page.locator(".settings-panel [data-focus]").evaluateAll((els) => els.filter((el) => !el.classList.contains("hidden")).map((el) => (el as HTMLElement).dataset.action));

// Until nothing on the page is still moving in, as a page slides in.
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  await page.waitForFunction(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5000 });
}

// Rows past the panel's side or wider than themselves.
function off(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const panel = document.querySelector(".settings-panel")!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(".settings-panel .button:not(.hidden)")]
      .filter((row) => row.getBoundingClientRect().right > panel.right + 1 || row.scrollWidth > row.clientWidth + 2)
      .map((row) => row.dataset.action ?? "");
  });
}

for (const look of LOOKS) {
  test(`${look}: System has Location, Updates, Power, Omarchy's desktop and About, and Power is a page, at each size, dark and light`, async () => {
    await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
    const problems: string[] = [];
    for (const theme of THEMES) {
      await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) });
      for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
        const page = await tv(size);
        const at = `${theme}, ${size}`;
        try {
          await go(page, "settings/tv");
          await page.waitForSelector('.settings-panel[data-page="tv"] [data-action="power"]');
          await settled(page);
          const name = (await page.locator('.menu-item[data-key="tv"]').innerText()).trim().toLowerCase();
          if (name !== "system") problems.push(`${at}: the section is "${name}"`);
          const system = await rows(page);
          if (system.join(" ") !== "country updates power desktop about") problems.push(`${at}: System's rows are ${system.join(", ")}`);
          for (const one of await off(page)) problems.push(`${at}, System: ${one} doesn't fit`);
          for (const one of await shortfalls(page)) problems.push(`${at}, System: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
          // OK on Power: its page, a level deeper.
          await page.locator('.settings-panel [data-action="power"]').hover();
          await page.keyboard.press("Enter");
          await page.waitForSelector('.settings-panel[data-page="power"] [data-action="restart"]');
          await settled(page);
          const power = await rows(page);
          if (power.join(" ") !== "restart shutdown sleep") problems.push(`${at}: Power's rows are ${power.join(", ")}`);
          for (const one of await off(page)) problems.push(`${at}, Power: ${one} doesn't fit`);
          for (const one of await shortfalls(page)) problems.push(`${at}, Power: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
          // Back is System, on Power.
          await page.keyboard.press("Escape");
          await page.waitForSelector('.settings-panel[data-page="tv"]');
          const back = await page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action"));
          if (back !== "power") problems.push(`${at}: Back from Power landed on ${back}`);
        } finally {
          await page.close();
        }
      }
    }
    assert.deepEqual(problems, [], `${look}:\n${problems.join("\n")}`);
  });
}

test("a child's System has no Power", async () => {
  await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look: "glass" }) });
  const page = await tv();
  try {
    await page.route("**/api/home", async (route) => {
      const home = await (await route.fetch()).json();
      await route.fulfill({ json: { ...home, viewer: { ...home.viewer, role: "child" } } });
    });
    await page.reload();
    await page.waitForSelector("html[data-look] #page .focused");
    await go(page, "settings/tv");
    await page.waitForSelector('.settings-panel[data-page="tv"] [data-action="updates"]');
    assert.deepEqual(await rows(page), ["country", "updates", "desktop", "about"]);
  } finally {
    // Its stand-in for /api/home may still be answering as the page closes.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.close();
  }
});

test("an update that couldn't install says to try again in Settings, under System", async () => {
  const page = await tv();
  try {
    const progress = { state: "running", step: "snapshot", percent: 2, detail: "", at: new Date().toISOString(), from: { agentv: "0.2.1-1", omarchy: "4.5.0-1" }, to: { agentv: "0.3.0-1" } };
    const write = (data: unknown) => {
      writeFileSync(join(updates, "progress.json.next"), JSON.stringify(data));
      renameSync(join(updates, "progress.json.next"), join(updates, "progress.json"));
    };
    write(progress);
    await page.waitForSelector("#updating.on");
    write({ ...progress, state: "failed", step: "packages", percent: 0, detail: "nothing changed" });
    await page.waitForFunction(() => /Settings, under System/i.test(document.getElementById("updating")?.innerText ?? ""));
    assert.doesNotMatch(await page.locator("#updating").innerText(), /settings →|this tv/i);
  } finally {
    rmSync(join(updates, "progress.json"), { force: true });
    await page.close();
  }
});
