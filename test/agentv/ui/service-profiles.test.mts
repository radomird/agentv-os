// A service's own profiles in app details, in a real Chromium (ADR-019,
// layer 4; ADR-009): an adult picks the profile a child watching opens,
// from the ones the app listed, past the adult PIN; before the app has
// listed them, the details say to open it once; a child's details don't
// have it; and a switch to someone else tells the TV session, so the apps
// open take the service's profile for them.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, startBox, type Fixture } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const FAMILY: Fixture = {
  id: "local.family",
  name: "Family TV",
  tier: "local",
  category: "streaming",
  edit: (m) => ((m.tv.capabilities = ["launch", "profiles"]), delete m.tv.tiles, (m.tv.homeUrl = "https://family.example/"), (m.tv.origins = ["https://family.example"]), (m.tv.setup = [])),
};

let browser: Browser;
let daemon: Daemon;
let url = "";
const errors: string[] = [];
const PIN = "4826";
const dir = mkdtempSync(join(tmpdir(), "agentv-service-profiles-ui-"));

before(async () => {
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  process.env.AGENTV_PASSWD = passwd;
  ({ daemon, url } = await startBox(0, [...FIXTURES, FAMILY]));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  delete process.env.AGENTV_PASSWD;
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

type Request = { cmd: string; app?: string };

// A TV whose screen daemon answers every request with ok and remembers it.
async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: Request[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true, apps: [] })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

async function send(method: string, path: string, body?: unknown, grant?: string) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as Record<string, any>;
}
const grant = async () => (await send("POST", "/api/pin/check", { pin: PIN })).grant as string;
const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const sent = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { screenRequests: Request[] }).screenRequests.filter((r) => r.cmd === c), cmd);
const picker = (page: Page) => page.locator('[data-action="child-profile"]').innerText();

async function waitPad(page: Page, up: boolean): Promise<void> {
  await page.waitForFunction((want) => document.getElementById("pin")?.classList.contains("on") === want, up);
}

test("ADR-009 before an app lists its profiles, its details say to open it once", async () => {
  const page = await tv();
  await go(page, "details/local.family");
  await page.waitForSelector('[data-action="child-profile"]');
  assert.match(await picker(page), /profile for children\s+open it first/);
  await page.locator('[data-action="child-profile"]').click();
  await page.waitForFunction(() => /open family tv once, signed in, and its profiles show here/.test(document.body.textContent ?? ""));
  // An app without profiles doesn't have it.
  await go(page, "details/agentv.tube");
  await page.waitForSelector('[data-action="home"]');
  assert.equal(await page.locator('[data-action="child-profile"]').count(), 0);
  await page.close();
});

test("ADR-009 an adult picks the profile for children from the ones the app listed, past the PIN", async () => {
  await send("POST", "/api/apps/local.family/profiles", { names: ["Radomir", "Kids"] });
  await send("PUT", "/api/pin", { pin: PIN });
  const page = await tv();
  await go(page, "details/local.family");
  await page.waitForSelector('[data-action="child-profile"]');
  assert.match(await picker(page), /profile for children\s+‹ none ›/);
  await page.locator('[data-action="child-profile"]').click();
  await waitPad(page, true);
  for (const digit of PIN) await page.keyboard.press(digit);
  await waitPad(page, false);
  await page.waitForFunction(() => /‹ radomir ›/.test(document.querySelector('[data-action="child-profile"]')?.textContent ?? ""));
  assert.equal((await send("GET", "/api/apps/local.family/profiles")).forChildren, "Radomir");
  // Each choice moves to the next, then none.
  for (const want of ["kids", "none"]) {
    await page.locator('[data-action="child-profile"]').click();
    if (await page.evaluate(() => document.getElementById("pin")?.classList.contains("on"))) {
      for (const digit of PIN) await page.keyboard.press(digit);
      await waitPad(page, false);
    }
    await page.waitForFunction((w) => new RegExp(`‹ ${w} ›`).test(document.querySelector('[data-action="child-profile"]')?.textContent ?? ""), want);
  }
  assert.equal((await send("GET", "/api/apps/local.family/profiles")).forChildren, null);
  assert.equal(await page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action")), "child-profile", "the focus stays on it");
  await page.close();
});

test("ADR-009 a switch to someone else tells the TV session, and a child's details don't have the picker", async () => {
  const added = await send("POST", "/api/viewers", { name: "mila", role: "child" }, await grant());
  const mila = added.profile as { id: string };
  await send("POST", `/api/apps/local.family/for-children`, { allowed: true }, await grant());
  const page = await tv();
  await send("POST", "/api/viewer", { id: mila.id });
  await page.waitForFunction(() => document.querySelector(".bar-right span")?.textContent === "mila");
  await page.waitForFunction(() => (window as unknown as { screenRequests: Request[] }).screenRequests.some((r) => r.cmd === "viewer"));
  assert.equal((await sent(page, "viewer")).length, 1);
  await go(page, "details/local.family");
  await page.waitForSelector('[data-action="home"]');
  assert.equal(await page.locator('[data-action="child-profile"]').count(), 0);
  await send("POST", "/api/viewer", { id: "radomir" }, await grant());
  await page.close();
});
