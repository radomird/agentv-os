// How much of a plan is used, on the TV (ADR-103, Q313, T19.1), in a real
// Chromium with a stand-in for Omarchy's usage check: on a plan, Settings,
// AI has a row with a bar for the 5 hours and one for the week, in each
// look, dark and light, and its page says when each starts over. No dollar
// amount shows anywhere in AI on a plan, and no key's limits. Where the
// check can't answer, the row says it's using the plan, and where the plan's
// sign-in ran out, it offers signing in again. A key keeps its spending bar
// against the month.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { UsageReply, UsageWindow } from "../../../daemon/plan-usage.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";
import { rendered, shortfalls } from "./legible.mts";
import { pairPhone, type TestPhone } from "../unit/phone-client.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
const THEMES = ["tokyo-night", "catppuccin-latte"];

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
let phone: TestPhone;
const errors: string[] = [];
// What the stand-in check says, and how often it was asked.
let windows: UsageWindow[] | null = null;
let signIn: "expired" | "none" | null = null;
let asOf: string | null = null;
let asked = 0;

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function use(path: "plan" | "key"): Promise<void> {
  assert.equal((await send("POST", "/api/ai", { provider: "claude", path })).status, 200);
  assert.equal((await phone.fetch("/api/phone/terms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "claude", path }) })).status, 200);
}

before(async () => {
  ({ daemon, url, state } = await startBox(0, FIXTURES, { features: { looks: true }, planUsage: async (): Promise<UsageReply | null> => (asked++, signIn ? { signIn } : windows ? { windows, ...(asOf ? { asOf } : {}) } : null) }));
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
  const code = (await (await send("POST", "/api/phones/pair", {})).json()).pairing.code;
  phone = await pairPhone(`http://127.0.0.1:${daemon.lanPort}`, code, "pixel");
  await use("plan");
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
const actions = (page: Page) => page.locator(".settings-panel [data-focus]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.action));
const soon = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

for (const look of LOOKS) {
  test(`T19.1 ${look}: on a plan, AI shows the 5 hours and the week as bars in %, with no dollar amount, dark and light`, async () => {
    await send("PUT", "/api/look", { look });
    windows = [
      { window: "hours", hours: 5, percent: 23, resets: soon(2) },
      { window: "week", percent: 41, resets: soon(80) },
    ];
    await daemon.planUsages.get("claude", true);
    const problems: string[] = [];
    for (const theme of THEMES) {
      assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200);
      const page = await tv();
      try {
        await go(page, "settings/ai");
        await page.waitForSelector('.settings-panel[data-page="ai"] [data-action="plan-week"]');
        await rest(page);
        await settled(page);
        const rows = await actions(page);
        for (const gone of ["usage", "cap-build", "cap-month"]) if (rows.includes(gone)) problems.push(`${theme}: AI has ${gone} on a plan`);
        if (!rows.includes("safeguards")) problems.push(`${theme}: no safety checks row`);
        const hours = (await page.locator('[data-action="plan-hours"]').innerText()).replace(/\s+/g, " ").trim().toLowerCase();
        if (hours !== "5-hour limit 23%") problems.push(`${theme}: the 5 hours say "${hours}"`);
        const width = await page.locator('[data-action="plan-week"] .meter > span').evaluate((el) => (el as HTMLElement).style.width);
        if (width !== "41%") problems.push(`${theme}: the week's bar is ${width}`);
        const panel = await page.locator(".settings-panel").innerText();
        if (/\$/.test(panel)) problems.push(`${theme}: AI shows a dollar amount: ${panel.replace(/\s+/g, " ")}`);
        for (const one of await shortfalls(page)) problems.push(`${theme}: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
        // Its page: how much, and when it starts over, and still no dollars.
        await page.locator('[data-action="plan-hours"]').click();
        await page.waitForSelector('.settings-panel[data-page="usage"] .plan-window');
        const page2 = (await page.locator(".settings-panel").innerText()).replace(/\s+/g, " ");
        if (!/your claude plan/i.test(page2)) problems.push(`${theme}: the page's title: ${page2}`);
        if (!/23% used/i.test(page2) || !/41% used/i.test(page2)) problems.push(`${theme}: the page's numbers: ${page2}`);
        if (!/starts over at \d\d:\d\d/i.test(page2) || !/starts over \w+ at \d\d:\d\d/i.test(page2)) problems.push(`${theme}: when each starts over: ${page2}`);
        if (/\$/.test(page2)) problems.push(`${theme}: the page shows a dollar amount`);
      } finally {
        await page.close();
      }
    }
    assert.deepEqual(problems, [], `${look}:\n${problems.join("\n")}`);
  });
}

test("Q341 while the plan's limits are paused, AI shows the numbers it last read, with how long ago, clear to read", async () => {
  await send("PUT", "/api/look", { look: "glass" });
  windows = [
    { window: "hours", hours: 5, percent: 23, resets: soon(2) },
    { window: "week", percent: 41, resets: soon(80) },
  ];
  asOf = new Date(Date.now() - 8 * 3600_000).toISOString();
  await daemon.planUsages.get("claude", true);
  const page = await tv();
  try {
    await go(page, "settings/ai");
    await page.waitForSelector('.settings-panel[data-page="ai"] .plan-age');
    await rest(page);
    await page.waitForTimeout(300);
    assert.equal((await page.locator('[data-action="plan-hours"]').innerText()).replace(/\s+/g, " ").trim(), "5-hour limit 23%");
    assert.equal(await page.locator(".settings-panel .plan-age").innerText(), "As of 8 hours ago");
    assert.deepEqual(await shortfalls(page), []);
    await page.locator('[data-action="plan-hours"]').click();
    await page.waitForSelector('.settings-panel[data-page="usage"] .plan-age');
    assert.match(await page.locator(".settings-panel").innerText(), /23% used[\s\S]*41% used[\s\S]*As of 8 hours ago/);
  } finally {
    await page.close();
    asOf = null;
  }
});

test("T19.1 where the plan's sign-in ran out, AI says to sign in again, and OK opens the plan's sign-in", async () => {
  await send("PUT", "/api/look", { look: "glass" });
  signIn = "expired";
  await daemon.planUsages.get("claude", true);
  const page = await tv();
  try {
    await go(page, "settings/ai");
    await page.waitForSelector('.settings-panel [data-action="usage-sign-in"]');
    assert.equal((await page.locator('.settings-panel [data-action="usage-sign-in"]').innerText()).replace(/\s+/g, " ").trim(), "Limits Sign in again");
    assert.equal(await page.locator('[data-action^="plan-"] .meter').count(), 0, "no old numbers");
    await page.locator('.settings-panel [data-action="usage-sign-in"]').click();
    await page.waitForSelector(".page.plan-sign-in");
  } finally {
    await page.close();
    signIn = null;
  }
});

test("T19.1 where the check can't answer, the row says it's using the plan; a key keeps its spending bar against the month", async () => {
  await send("PUT", "/api/look", { look: "glass" });
  windows = null;
  await daemon.planUsages.get("claude", true);
  const page = await tv();
  try {
    await go(page, "settings/ai");
    await page.waitForSelector('.settings-panel [data-action="usage"]');
    await page.waitForFunction(() => /Using your plan/.test(document.querySelector('.settings-panel [data-action="usage"]')?.textContent ?? ""));
    assert.equal((await page.locator('.settings-panel [data-action="usage"]').innerText()).replace(/\s+/g, " ").trim(), "Limits Using your plan");
    assert.doesNotMatch(await page.locator(".settings-panel").innerText(), /\$/);
    await page.locator('.settings-panel [data-action="usage"]').click();
    await page.waitForSelector('.settings-panel[data-page="usage"]');
    assert.match(await page.locator(".settings-panel").innerText(), /Your Claude plan[\s\S]*Using your plan/);
  } finally {
    await page.close();
  }
  // A key: the month's spending, as before.
  writeFileSync(join(state, "..", "key.json"), JSON.stringify({ set: true, provider: "claude", at: new Date().toISOString() }));
  await use("key");
  const keyed = await tv();
  try {
    await go(keyed, "settings/ai");
    await keyed.waitForSelector('.settings-panel [data-action="cap-month"]');
    assert.match(await keyed.locator('.settings-panel [data-action="usage"]').innerText(), /Spent this month\s+\$0 of \$20/);
    assert.equal(await keyed.locator('[data-action^="plan-"]').count(), 0);
  } finally {
    await keyed.close();
    await use("plan");
  }
});
