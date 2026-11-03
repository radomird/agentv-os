// Updates on the TV in a real Chromium (ADR-019, layer 4; ADR-025): what the
// update check found in Settings → Updates and What's new (S2.12), one toast
// on home per release (S2.13), Tonight, Later and updating overnight on its
// own, and the Updating screen while an install runs.

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
let state = "";

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
  ({ daemon, url, updates, state } = await startBox());
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

// A TV whose screen daemon answers every request with ok, and remembers them,
// once ready is on the page.
async function tv(ready = ".grid .tile.focused"): Promise<Page> {
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
  await page.waitForSelector(ready);
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
  // Home tells the box it showed the toast as it shows it. The page closes
  // only once the box has it, as the TV's page never closes that quickly.
  await page.waitForFunction(async () => (await (await fetch("/api/updates")).json()).toasted === "0.3.0");
  await page.close();
  // Once: the next time home shows, no toast.
  const again = await tv();
  await again.waitForTimeout(800);
  assert.deepEqual(await again.locator(".toast").allInnerTexts(), []);
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

test("S2.12 an update the nightly run hasn't passed waits: no Install now, no toast, nothing in the bar", async () => {
  write("status.json", { ...STATUS, agentv: { installed: "0.2.1-1", available: "0.3.1-1" }, waiting: true });
  const page = await tv();
  await page.waitForTimeout(800);
  assert.equal(await page.locator(".toast").count(), 0);
  assert.doesNotMatch(await page.locator(".bar").innerText(), /settings ●|is ready/);
  await page.locator('.bar-link:has-text("settings")').click();
  await page.locator('.menu-item[data-key="updates"]').click();
  const panel = await page.locator(".panel").innerText();
  assert.match(panel, /updates · waiting for tonight's tests/);
  assert.match(panel, /agentv\s+0\.2\.1\s+→\s+0\.3\.1/);
  assert.match(panel, /it waits until agentv's nightly run has tested it/);
  assert.equal(await page.locator('[data-action="install"]').count(), 0);
  await page.locator('[data-action="whats-new"]').click();
  await page.waitForSelector(".notes");
  assert.equal(await page.locator('[data-action="install"]').count(), 0);
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
  // One the nightly run hasn't passed yet says so.
  write("progress.json", { ...failed, at: new Date().toISOString() });
  await page.waitForSelector("#updating.on");
  write("progress.json", { ...failed, state: "failed", step: "packages", percent: 0, detail: "not tested yet" });
  await page.waitForFunction(() => document.getElementById("updating")?.innerText.includes("not tested yet. nothing changed."));
  assert.match(await page.locator("#updating").innerText(), /agentv's nightly run hasn't passed it yet/);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.getElementById("updating")?.classList.contains("on"));
  rmSync(join(updates, "progress.json"));
  await page.close();
});

// The box after updating to 0.3.0 from 0.2.1, with the snapshot from before.
const UPDATED = { ...STATUS, agentv: { installed: "0.3.0-1", available: null }, omarchy: { installed: "4.0.6-1", available: null }, packages: 0 };
const GO_BACK = { snapshot: 3, widevine: false, at: "2026-10-23T22:00:00Z", from: { agentv: "0.2.1-1", omarchy: "4.0.6-1" }, to: { agentv: "0.3.0-1", omarchy: "4.0.6-1" } };
const AFTER = {
  at: "2026-10-23T22:01:00Z",
  ok: false,
  agentv: "0.3.0-1",
  checks: [
    { name: "daemon", ok: true, detail: "" },
    { name: "home screen", ok: true, detail: "" },
    { name: "chromium and widevine", ok: true, detail: "" },
    { name: "jellyfin", ok: false, detail: "jellyfin won't load" },
  ],
};

test("S2.14 when the check after an update finds something off, home makes way for Go back", async () => {
  write("status.json", UPDATED);
  write("go-back.json", GO_BACK);
  write("after.json", AFTER);
  const page = await tv(".check-rows");
  const text = await page.locator(".page").innerText();
  assert.match(text, /something's off\./);
  assert.match(text, /the update finished, but jellyfin won't load\. go back to 0\.2\.1\?/);
  assert.match(text, /\[x\] daemon[\s\S]*\[x\] home screen[\s\S]*\[x\] chromium and widevine[\s\S]*\[!\] jellyfin won't load/);
  // Go back has the focus: OK goes back.
  assert.equal(await page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action")), "go-back");
  await page.keyboard.press("Enter");
  await requested(page, "update-go-back");
  await page.close();
});

test("S2.14 Keep stays on the new version, and home doesn't ask again for that check", async () => {
  write("status.json", UPDATED);
  write("go-back.json", GO_BACK);
  write("after.json", { ...AFTER, at: "2026-10-23T22:02:00Z" });
  const page = await tv(".check-rows");
  await page.locator('[data-action="keep"]').click();
  await page.waitForSelector(".grid .tile");
  await page.close();
  const again = await tv();
  await again.waitForTimeout(800);
  assert.equal(await again.locator(".check-rows").count(), 0);
  // Settings → Updates still offers Go back while the snapshot is kept.
  await again.locator('.bar-link:has-text("settings")').click();
  await again.locator('.menu-item[data-key="updates"]').click();
  assert.match(await again.locator(".panel").innerText(), /go back to 0\.2\.1[\s\S]*kept until the next update/);
  await again.locator('.panel [data-action="go-back"]').click();
  await requested(again, "update-go-back");
  await again.close();
});

test("S2.14 going back covers the TV until the restart, and home says so after", async () => {
  write("status.json", UPDATED);
  rmSync(join(updates, "after.json"), { force: true });
  const page = await tv();
  write("progress.json", { state: "going-back", what: "go-back", step: "restart", percent: 40, detail: "", at: new Date().toISOString(), from: { agentv: "0.3.0-1", omarchy: "4.0.6-1" }, to: { agentv: "0.2.1-1" } });
  await page.waitForSelector("#updating.on");
  const screen = await page.locator("#updating").innerText();
  assert.match(screen, /going back to agentv 0\.2\.1/);
  assert.match(screen, /restarting\. back in a moment\./);
  assert.doesNotMatch(screen, /installing packages/);
  await page.close();
  // After the restart, on the version from before: one toast.
  rmSync(join(updates, "progress.json"));
  rmSync(join(updates, "go-back.json"));
  write("status.json", STATUS);
  write("went-back.json", { at: "2026-10-23T22:06:00Z", from: { agentv: "0.3.0-1", omarchy: "4.0.6-1" }, to: { agentv: "0.2.1-1" } });
  const back = await tv();
  await back.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent?.startsWith("back on agentv 0.2.1")));
  await back.close();
  const later = await tv();
  await later.waitForTimeout(800);
  assert.equal(await later.locator(".toast", { hasText: "back on agentv" }).count(), 0);
  await later.close();
  rmSync(join(updates, "went-back.json"));
});

async function openUpdates(page: Page): Promise<void> {
  await page.locator('.bar-link:has-text("settings")').click();
  await page.locator('.menu-item[data-key="updates"]').click();
  await page.waitForSelector('.panel [data-action="check"]');
}

function api(page: Page, path: string): Promise<any> {
  return page.evaluate(async (p) => (await fetch(p)).json(), path);
}

test("S2.12 Tonight asks for tonight, home's bar says so, and Later takes it back", async () => {
  write("status.json", STATUS);
  const page = await tv();
  await openUpdates(page);
  const choices = await page.locator('.panel [data-action="install"], .panel [data-action="tonight"], .panel [data-action="later"]').allInnerTexts();
  assert.deepEqual(choices, ["↵ install now", "tonight", "later"]);
  await page.locator('.panel [data-action="tonight"]').click();
  await page.waitForSelector(".tonight-note");
  assert.equal((await api(page, "/api/updates")).tonight.version, "0.3.0-1");
  assert.match(await page.locator(".panel").innerText(), /it installs tonight, between 2 and 5, once nothing has played for half an hour/);
  assert.equal(await page.locator('.panel [data-action="tonight"]').count(), 0, "chosen already");
  assert.equal(await page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action")), "later");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".grid .tile");
  assert.match(await page.locator(".bar").innerText(), /agentv 0\.3\.0 installs tonight/);
  // Later: not tonight, and home stops saying it's ready.
  await openUpdates(page);
  await page.locator('.panel [data-action="later"]').click();
  // Later is two requests, and the first one's news redraws Settings, so
  // the note can go before the second lands: wait for both.
  await page.waitForFunction(() => !document.querySelector(".tonight-note"));
  for (let i = 0; i < 50 && (await api(page, "/api/updates")).seen.later !== "0.3.0-1"; i++) await page.waitForTimeout(50);
  const after = await api(page, "/api/updates");
  assert.equal(after.tonight, null);
  assert.equal(after.seen.later, "0.3.0-1");
  await page.waitForFunction(() => document.querySelector(".focused")?.getAttribute("data-action") === "tonight");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".grid .tile");
  assert.doesNotMatch(await page.locator(".bar").innerText(), /is ready|installs tonight/);
  // Install now still works from there.
  await openUpdates(page);
  await page.locator('.panel [data-action="install"]').click();
  await requested(page, "update-install");
  await page.close();
  rmSync(join(state, "update-seen.json"), { force: true });
});

test("S2.12 What's new has Install now, Tonight and Later too, and Later goes back", async () => {
  write("status.json", STATUS);
  const page = await tv();
  await openUpdates(page);
  await page.locator('[data-action="whats-new"]').click();
  await page.waitForSelector(".notes-choices");
  assert.deepEqual(await page.locator(".notes-choices .button").allInnerTexts(), ["↵ install now", "tonight", "later"]);
  await page.locator('.notes-choices [data-action="tonight"]').click();
  await page.waitForSelector(".notes-choices .tonight-note");
  assert.equal((await api(page, "/api/updates")).tonight.version, "0.3.0-1");
  await page.locator('.notes-choices [data-action="later"]').click();
  await page.waitForSelector('.panel [data-action="check"]');
  assert.equal((await api(page, "/api/updates")).tonight, null);
  await page.close();
  rmSync(join(state, "update-seen.json"), { force: true });
});

test("S2.12 an update the nightly run hasn't passed has no Tonight or Later", async () => {
  write("status.json", { ...STATUS, agentv: { installed: "0.2.1-1", available: "0.3.1-1" }, waiting: true });
  const page = await tv();
  await openUpdates(page);
  assert.equal(await page.locator('.panel [data-action="tonight"], .panel [data-action="later"]').count(), 0);
  await page.close();
});

test("S2.12 updating overnight on its own is off until it's turned on, and it stays", async () => {
  write("status.json", STATUS);
  const page = await tv();
  await openUpdates(page);
  const toggle = page.locator('.panel [data-action="overnight"]');
  assert.match(await toggle.innerText(), /update overnight on its own\s+\[ \]/);
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-action="overnight"] .button-value')?.textContent === "[x]");
  assert.equal((await api(page, "/api/home")).settings.updateOvernight, true);
  assert.match(await page.locator(".panel").innerText(), /tested updates install between 2 and 5, once nothing has played for half an hour/);
  assert.equal(await page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action")), "overnight");
  await page.close();
  const again = await tv();
  await openUpdates(again);
  assert.match(await again.locator('.panel [data-action="overnight"]').innerText(), /\[x\]/);
  await again.locator('.panel [data-action="overnight"]').click();
  await again.waitForFunction(() => document.querySelector('[data-action="overnight"] .button-value')?.textContent === "[ ]");
  assert.equal((await api(again, "/api/home")).settings.updateOvernight, false);
  await again.close();
});
