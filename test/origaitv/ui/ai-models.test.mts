// Settings, AI's two models in a real Chromium (ADR-103, Q312, T19.1), in
// each look, dark and light: "For asking" on Haiku 5.5 and "For building"
// on Sonnet 5.5 for Claude, right under Your AI, each fitting its row and
// reading clearly. Left and right step along Claude's list, OK goes round
// it, the daemon keeps each, and with a PIN set a change asks for it.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
const errors: string[] = [];

const send = (method: string, path: string, body?: unknown, grant?: string) =>
  fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", ...(grant ? { "X-OrigaiTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  ({ daemon, url } = await startBox(0, FIXTURES, { features: { looks: true } }));
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

test("T19.1 left and right step along Claude's list, OK goes round it, and the daemon keeps each; with a PIN, a change asks for it", async () => {
  await send("PUT", "/api/look", { look: "glass" });
  const page = await tv();
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

    // A PIN: the next change waits for it.
    assert.equal((await send("PUT", "/api/pin", { pin: "2468" })).status, 200);
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
