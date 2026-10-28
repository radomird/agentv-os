// Apps → add an app in a real Chromium (ADR-019, layer 4; ADR-042): an adult
// sees AgenTV's official apps that aren't on the TV, each with its one line,
// adds one past the PIN, and its tile follows the install until the app is
// in. A child's profile doesn't see it. Root's side is the test box's
// stand-in for agentv-setup-apps; the real one is the image layer's.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const PIN = "2468";
let browser: Browser;
let daemon: Daemon;
let url = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  assert.deepEqual(errors, [], "no errors on the page");
  await browser?.close();
  await daemon?.close();
});

// A TV whose screen daemon answers every request with ok and remembers it,
// with the viewer as the daemon says, or a child.
async function tv(role: "adult" | "child" = "adult"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: unknown[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  if (role === "child") {
    await page.route(`${url}/api/home`, async (route) => {
      const reply = await route.fetch();
      const state = await reply.json();
      await route.fulfill({ response: reply, json: { ...state, viewer: { ...state.viewer, role: "child" } } });
    });
  }
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);

test("ADR-042 Apps → add an app adds an official app past the PIN, and its tile follows the install", async () => {
  assert.equal(daemon.pin.set(PIN, undefined), null);
  const page = await tv();
  await go(page, "apps");
  await page.locator('[data-action="add-app"]').click();
  await page.waitForSelector('.add-tile[data-id="agentv.steam"]');
  assert.deepEqual(
    await page.locator(".add-tile").evaluateAll((els) => els.map((el) => el.getAttribute("data-id"))),
    ["agentv.immich", "agentv.jellyfin", "agentv.steam"],
    "the official apps that aren't on the TV, by name",
  );
  assert.match(await page.locator('.add-tile[data-id="agentv.steam"]').innerText(), /add\s+steam\s+steam big picture on the tv, full screen/, "what Enter does, and its one line");

  // Choosing one asks for the PIN, and Back leaves it as it was.
  await page.locator('.add-tile[data-id="agentv.steam"]').click();
  await page.waitForSelector(".pin-pad");
  assert.match(await page.locator(".pin-pad").innerText(), /for adding an app/);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".pin-pad", { state: "detached" });
  assert.equal(await page.locator('.add-tile[data-id="agentv.steam"] .add-state').count(), 0, "nothing's installing");

  // With the PIN, it installs, and its tile says so until it's in.
  await page.locator('.add-tile[data-id="agentv.steam"]').click();
  await page.waitForSelector(".pin-pad");
  for (const digit of PIN) await page.keyboard.press(digit);
  await page.waitForFunction(() => /queued|installing|installed/.test(document.querySelector('.add-tile[data-id="agentv.steam"] .add-state')?.textContent ?? ""));
  await page.waitForFunction(() => /installed/.test(document.querySelector('.add-tile[data-id="agentv.steam"] .add-state')?.textContent ?? ""), null, { timeout: 10_000 });
  assert.match(await page.locator('.add-tile[data-id="agentv.steam"]').innerText(), /open\s+steam\s+installed, and on your home/);
  assert.match(await page.locator("#toasts").innerText(), /adding steam/);

  // It's on the TV now, and it opens from its tile here.
  const home = await (await fetch(`${url}/api/home`)).json();
  assert.ok(home.apps.some((app: { id: string }) => app.id === "agentv.steam"));
  await page.locator('.add-tile[data-id="agentv.steam"]').click();
  await page.waitForFunction(() =>
    (window as unknown as { screenRequests: { cmd: string; app?: string }[] }).screenRequests.some((r) => r.cmd === "open-app" && r.app === "agentv.steam"),
  );
  await page.close();
});

test("ADR-042 a child's profile has no add an app", async () => {
  const page = await tv("child");
  await go(page, "apps");
  await page.waitForSelector(".page .row");
  assert.equal(await page.locator('[data-action="add-app"]').count(), 0);
  await go(page, "add-app");
  await page.waitForSelector(".grid .tile");
  assert.equal(await page.locator(".add-tile").count(), 0, "it goes home instead");
  // Its stand-in for /api/home may still be answering; that's not this test's.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.close();
});
