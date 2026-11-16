// Settings, AI's two models in a real Chromium (ADR-103, Q312, T19.1), in
// each look, dark and light: "For asking" on Haiku 5.5 and "For building"
// on Sonnet 5.5 for Claude, right under Your AI, each fitting its row and
// reading clearly. Left and right step along Claude's list, OK goes round
// it, the daemon keeps each, and with a PIN set a change asks for it.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";
import { rendered, shortfalls } from "./legible.mts";
import { pairPhone } from "../unit/phone-client.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
const THEMES = ["tokyo-night", "catppuccin-latte"];

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
let builds = "";
const errors: string[] = [];

const send = (method: string, path: string, body?: unknown, grant?: string) =>
  fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", ...(grant ? { "X-OrigaiTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  ({ daemon, url, state, builds } = await startBox(0, FIXTURES, { features: { looks: true } }));
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
  // Claude's plan, its terms accepted on a paired phone.
  assert.equal((await send("POST", "/api/ai", { provider: "claude", path: "plan" })).status, 200);
  const code = (await (await send("POST", "/api/phones/pair", {})).json()).pairing.code;
  const phone = await pairPhone(`http://127.0.0.1:${daemon.lanPort}`, code, "pixel");
  assert.equal((await phone.fetch("/api/phone/terms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "claude", path: "plan" }) })).status, 200);
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  await page.waitForSelector("html[data-look] #page .focused");
  await rest(page);
  return page;
}

// Until the page has stopped drawing: Settings draws AI again as each of its
// answers comes in, and each drawing fades in, its words fainter until it's
// there.
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  await page.waitForFunction(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5000 });
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go(r), route);
const rows = (page: Page) => page.locator(".settings-panel [data-focus]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.action));
const value = (page: Page, action: string) => page.locator(`.settings-panel [data-action="${action}"] .button-value`).innerText();
const models = async () => (await (await fetch(`${url}/api/ai`)).json()).models as { ask: string; build: string };

// Rows past the panel's side or wider than themselves.
function off(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const panel = document.querySelector(".settings-panel")!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(".settings-panel .button")]
      .filter((row) => row.getBoundingClientRect().right > panel.right + 1 || row.scrollWidth > row.clientWidth + 2)
      .map((row) => row.dataset.action ?? "");
  });
}

for (const look of LOOKS) {
  test(`T19.1 ${look}: AI has For asking on Haiku 5.5 and For building on Sonnet 5.5, under Your AI, fitting and clear, dark and light`, async () => {
    await send("PUT", "/api/look", { look });
    const problems: string[] = [];
    for (const theme of THEMES) {
      assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200);
      const page = await tv();
      try {
        await go(page, "settings/ai");
        await page.waitForSelector('.settings-panel[data-page="ai"] [data-action="build-model"]');
        await rest(page);
        await settled(page);
        const order = (await rows(page)).slice(0, 3).join(" ");
        if (order !== "your-ai ask-model build-model") problems.push(`${theme}: AI's rows start ${order}`);
        const words = (await page.locator('.settings-panel [data-action="ask-model"]').innerText()).replace(/\s+/g, " ").trim();
        if (words.toLowerCase() !== "for asking haiku 5.5") problems.push(`${theme}: the asking row says "${words}"`);
        if (look !== "terminal" && words !== "For asking Haiku 5.5") problems.push(`${theme}: the asking row's capitals are "${words}"`);
        if ((await value(page, "build-model")).toLowerCase() !== "sonnet 5.5") problems.push(`${theme}: building is ${await value(page, "build-model")}`);
        for (const one of await off(page)) problems.push(`${theme}: ${one} doesn't fit`);
        for (const one of await shortfalls(page)) problems.push(`${theme}: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
      } finally {
        await page.close();
      }
    }
    assert.deepEqual(problems, [], `${look}:\n${problems.join("\n")}`);
  });
}

for (const look of LOOKS) {
  test(`Q324 ${look}: Fable for building says it can cost extra on your plan, under its name, fitting and clear, dark and light`, async () => {
    await send("PUT", "/api/look", { look });
    assert.equal((await send("PUT", "/api/ai/models", { use: "build", model: "claude-fable-5-2" })).status, 200);
    const problems: string[] = [];
    try {
      for (const theme of THEMES) {
        assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200);
        const page = await tv();
        try {
          await go(page, "settings/ai");
          await page.waitForSelector('.settings-panel [data-action="build-model"].noted');
          await rest(page);
          await settled(page);
          const said = (await page.locator('.settings-panel [data-action="build-model"] .button-note').innerText()).trim();
          if (said.toLowerCase() !== "can cost extra on your plan") problems.push(`${theme}: the line says "${said}"`);
          if (await page.locator('.settings-panel [data-action="ask-model"] .button-note').isVisible()) problems.push(`${theme}: Haiku says it too`);
          // The line sits under the row's words, inside the row.
          const placed = await page.locator('.settings-panel [data-action="build-model"]').evaluate((row) => {
            const box = row.getBoundingClientRect();
            const note = row.querySelector(".button-note")!.getBoundingClientRect();
            const words = row.querySelector(".button-value")!.getBoundingClientRect();
            return note.top >= words.bottom - 1 && note.bottom <= box.bottom + 1 && note.right <= box.right + 1;
          });
          if (!placed) problems.push(`${theme}: the line isn't under the row's words, inside it`);
          for (const one of await off(page)) problems.push(`${theme}: ${one} doesn't fit`);
          for (const one of await shortfalls(page)) problems.push(`${theme}: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
        } finally {
          await page.close();
        }
      }
    } finally {
      await send("PUT", "/api/ai/models", { use: "build", model: "claude-sonnet-5-5" });
    }
    assert.deepEqual(problems, [], `${look}:\n${problems.join("\n")}`);
  });
}

// A build waiting on "Make X?" for Blocks, on the household's plan.
async function waitingBuild(): Promise<string> {
  const made = (await (await send("POST", "/api/builds", { sentence: "a game like tetris" })).json()).build;
  rmSync(join(state, "build-drop", "start.json"), { force: true });
  const dir = join(builds, made.id, "1.0.0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ build: made.build, id: made.id, version: "1.0.0", phase: "understand", state: "confirm", steps: [], understood: { name: "Blocks", recipe: "game", says: "A falling-block game" }, started: "", at: new Date(Date.now() + 5).toISOString() }));
  return made.build;
}

test("Q324 Make X? on a plan, in each look: Fable's row has the model apart from its name, and says it can cost extra inside the row, clear to read", async () => {
  assert.equal((await send("PUT", "/api/ai/models", { use: "build", model: "claude-fable-5-2" })).status, 200);
  const build = await waitingBuild();
  const problems: string[] = [];
  try {
    for (const look of LOOKS) {
      await send("PUT", "/api/look", { look });
      const page = await tv();
      try {
        await go(page, `build/${build}`);
        await page.waitForSelector('[data-action="model"].noted');
        await rest(page);
        await settled(page);
        const row = await page.locator('[data-action="model"]').evaluate((el) => {
          const box = el.getBoundingClientRect();
          const [name, value] = [...el.children].map((child) => child.getBoundingClientRect());
          const note = el.querySelector(".button-note")!.getBoundingClientRect();
          return { apart: value.left - name.right, inside: note.left >= box.left && note.right <= box.right + 1 && note.bottom <= box.bottom + 1, under: note.top >= value.bottom - 1, said: (el.querySelector(".button-note") as HTMLElement).innerText.trim().toLowerCase() };
        });
        if (row.apart < 16) problems.push(`${look}: the model sits ${Math.round(row.apart)} px from "Model"`);
        if (!row.inside || !row.under) problems.push(`${look}: the line isn't under the model, inside the row`);
        if (row.said !== "can cost extra on your plan") problems.push(`${look}: the line says "${row.said}"`);
        for (const one of await shortfalls(page)) problems.push(`${look}: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await send("PUT", "/api/ai/models", { use: "build", model: "claude-sonnet-5-5" });
    await send("POST", `/api/builds/${build}/forget`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("T19.1 left and right step along Claude's list, OK goes round it, and the daemon keeps each; with a PIN, a change asks for it", async () => {
  await send("PUT", "/api/look", { look: "glass" });
  let page = await tv();
  try {
    await go(page, "settings/ai.ask-model");
    await page.waitForSelector('.settings-panel [data-action="ask-model"]');
    await page.locator('.settings-panel [data-action="ask-model"]').hover();
    assert.equal(await page.locator(".focused").getAttribute("data-action"), "ask-model");
    // Right from the last does nothing; left is the one above.
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    assert.equal((await models()).ask, "claude-haiku-5-5");
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => document.querySelector('.settings-panel [data-action="ask-model"] .button-value')?.textContent === "Sonnet 5.5");
    assert.equal((await models()).ask, "claude-sonnet-5-5");
    assert.equal(await page.locator(".focused").getAttribute("data-action"), "ask-model", "the focus stays on the row");
    // OK on building goes on to Haiku, then round to Fable.
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.locator(".focused").getAttribute("data-action"), "build-model");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('.settings-panel [data-action="build-model"] .button-value')?.textContent === "Haiku 5.5");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('.settings-panel [data-action="build-model"] .button-value')?.textContent === "Fable 5.2");
    assert.equal((await models()).build, "claude-fable-5-2");

    // A PIN, set before the page opens (an open page hears of it a moment
    // later): the next change waits for it.
    assert.equal((await send("PUT", "/api/pin", { pin: "2468" })).status, 200);
    await page.close();
    page = await tv();
    await go(page, "settings/ai.build-model");
    await page.waitForSelector('.settings-panel [data-action="build-model"]');
    await page.locator('.settings-panel [data-action="build-model"]').hover();
    assert.equal(await page.locator(".focused").getAttribute("data-action"), "build-model");
    await page.keyboard.press("ArrowRight");
    await page.waitForSelector(".pin-pad");
    assert.equal((await models()).build, "claude-fable-5-2", "nothing changes before the PIN");
    await page.keyboard.type("2468");
    await page.waitForFunction(() => document.querySelector('.settings-panel [data-action="build-model"] .button-value')?.textContent === "Opus 5.5");
    assert.equal((await models()).build, "claude-opus-5-5");
  } finally {
    await page.close();
    const grant = (await (await send("POST", "/api/pin/check", { pin: "2468" })).json()).grant;
    await send("DELETE", "/api/pin", undefined, grant);
  }
});
