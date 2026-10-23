// Updates on the TV in a real Chromium (ADR-019, layer 4; ADR-025): what the
// update check found in Settings → Updates and What's new (S2.12), one toast
// on home per release (S2.13), and the Updating screen while an install runs.

import assert from "node:assert/strict";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let updates = "";

const STATUS = {
  checked_at: new Date().toISOString(),
  ok: true,
  channel: "stable",
  agentv: { installed: "0.2.1-1", available: "0.3.0-1" },
  omarchy: { installed: "4.0.6-1", available: "4.5.0-1" },
  packages: 46,
  security: false,
  notes: {
    agentv: ["tiles come in small, medium and large", "weather shows heavy rain and wind"],
    agentv_date: "2026-10-22",
    omarchy: ["Faster updates"],
  },
};

before(async () => {
  ({ daemon, url, updates } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

function write(name: string, data: unknown): void {
  writeFileSync(join(updates, `${name}.next`), JSON.stringify(data));
  // As the scripts do: a whole file at once.
  renameSync(join(updates, `${name}.next`), join(updates, name));
}

// A TV whose screen daemon answers every request with ok, and remembers them.
async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: { cmd: string }[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

function requested(page: Page, cmd: string): Promise<unknown> {
  return page.waitForFunction((c) => (window as unknown as { screenRequests: { cmd: string }[] }).screenRequests.some((r) => r.cmd === c), cmd);
}

test("S2.13 a new release shows one toast on home, and the bar says so until it's installed", async () => {
  write("status.json", STATUS);
  const page = await tv();
  await page.waitForSelector(".toast");
  assert.equal(await page.locator(".toast").innerText(), "agentv 0.3.0 is ready · settings → updates");
  assert.match(await page.locator(".bar").innerText(), /settings ●/);
  assert.match(await page.locator(".bar").innerText(), /agentv 0\.3\.0 is ready · settings → updates/);
  await page.close();
  // Once: the next time home shows, no toast.
  const again = await tv();
  await again.waitForTimeout(800);
  assert.equal(await again.locator(".toast").count(), 0);
  assert.match(await again.locator(".bar").innerText(), /settings ●/);
  await again.close();
});

test("S2.12 Settings → Updates shows both versions, the other packages, What's new, and installs", async () => {
  write("status.json", STATUS);
  const page = await tv();
  await page.locator('.bar-link:has-text("settings")').click();
  await page.locator('.menu-item[data-key="updates"]').click();
  const panel = await page.locator(".panel").innerText();
  assert.match(panel, /updates · a new release is out/);
  assert.match(panel, /agentv\s+0\.2\.1\s+→\s+0\.3\.0/);
  assert.match(panel, /omarchy\s+4\.0\.6\s+→\s+4\.5\.0/);
  assert.match(panel, /plus 46 system packages · tested by agentv's nightly run/);
  await page.locator('[data-action="whats-new"]').click();
  await page.waitForSelector(".notes");
  const notes = await page.locator(".page").innerText();
  assert.match(notes, /agentv 0\.3\.0 · thu 22 oct/);
  assert.match(notes, /\+ tiles come in small, medium and large/);
  assert.match(notes, /omarchy 4\.5\.0[\s\S]*\+ Faster updates/);
  await page.locator('[data-action="install"]').click();
  await requested(page, "update-install");
  await page.keyboard.press("Escape");
  await page.locator('[data-action="check"]').click();
  await requested(page, "update-check");
  await page.close();
});

test("the Updating screen covers the TV while an install runs, and home comes back on the new release", async () => {
  write("status.json", STATUS);
  const page = await tv();
  const progress = (state: string, step: string, percent: number, detail = "") => ({
    state,
    step,
    percent,
    detail,
    at: new Date().toISOString(),
    from: { agentv: "0.2.1-1", omarchy: "4.0.6-1" },
    to: { agentv: "0.3.0-1" },
  });
  write("progress.json", progress("running", "packages", 30, "1 of 4"));
  await page.waitForSelector("#updating.on");
  const screen = await page.locator("#updating").innerText();
  assert.match(screen, /updating to agentv 0\.3\.0/);
  assert.match(screen, /\[x\] snapshot of 0\.2\.1 saved/);
  assert.match(screen, /\[>\] installing packages · 1 of 4/);
  assert.match(screen, /\[ \] restart and check/);
  // Keys wait while it runs.
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#updating.on").count(), 1);
  // Done: the page loads again, from the new release.
  await page.evaluate(() => ((window as unknown as { before: boolean }).before = true));
  write("progress.json", progress("done", "restart", 100));
  await page.waitForFunction(() => !(window as unknown as { before?: boolean }).before, null, { timeout: 5000 });
  await page.waitForSelector(".grid .tile");
  assert.equal(await page.locator("#updating.on").count(), 0);
  await page.close();
});

test("an install that failed says whether anything changed, and a key puts it away", async () => {
  const page = await tv();
  const failed = { state: "running", step: "snapshot", percent: 2, detail: "", at: new Date().toISOString(), from: { agentv: "0.2.1-1", omarchy: "4.0.6-1" }, to: { agentv: "0.3.0-1" } };
  write("progress.json", failed);
  await page.waitForSelector("#updating.on");
  write("progress.json", { ...failed, state: "failed", step: "packages", percent: 0, detail: "nothing changed" });
  await page.waitForFunction(() => document.getElementById("updating")?.innerText.includes("couldn't update. nothing changed."));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.getElementById("updating")?.classList.contains("on"));
  rmSync(join(updates, "progress.json"));
  await page.close();
});
