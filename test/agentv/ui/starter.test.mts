// The streaming starter pack in setup (ADR-066, D3; T9.2's screen), on the
// TV in a real Chromium at 1920 × 1080, with the starter switch off and on.
// The index here lists two stand-in streaming apps with made-up names,
// beside Jellyfin, Immich and Steam, the way the signed index lists the real
// ones: by their manifest's category. Installing them is the stand-in root's
// (box.mts), and the six real tiles with their icons are the image layer's.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before } from "node:test";
import type { Browser, Page } from "playwright-core";
import { bothWays, OFFICIAL, startBox, type BoxOptions } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

// Two made-up streaming apps. Harbour's description says more after its
// first sentence, the way an app whose service plays in SD here will.
const STREAMING = [
  { id: "agentv.kite", name: "Kite", description: "Kite on the TV" },
  { id: "agentv.harbour", name: "Harbour", description: "Harbour on the TV. Plays in SD here." },
].map((app) => ({ ...OFFICIAL[0], ...app, category: "streaming", path: `apps/${app.name.toLowerCase()}` }));

let browser: Browser;
const errors: string[] = [];

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  assert.deepEqual(errors, []);
});

// A fresh box with the stand-in streaming apps in its index, at setup's apps
// step for the goal.
async function atApps(goal: string, options: Pick<BoxOptions, "features">): Promise<{ url: string; page: Page; close: () => Promise<void> }> {
  const { daemon, url } = await startBox(0, undefined, { ...options, catalog: [...OFFICIAL, ...STREAMING] });
  try {
    return await walk(daemon, url, goal);
  } catch (error) {
    await daemon.close();
    throw error;
  }
}

async function walk(daemon: Awaited<ReturnType<typeof startBox>>["daemon"], url: string, goal: string): Promise<{ url: string; page: Page; close: () => Promise<void> }> {
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // A test box starts with setup done, so it starts again.
  await post("/api/setup", { done: false });
  await post("/api/setup/finish", { step: "welcome", keyboard: true });
  await post("/api/setup/ready", { update: "none" });
  for (const step of ["ready", "box", "country", "ai", "people"]) await post("/api/setup/finish", { step });
  await post("/api/setup/goal", { goal });
  await post("/api/setup/finish", { step: "goal" });
  assert.equal((await (await fetch(`${url}/api/setup`)).json()).setup.step, "apps");
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    (window as unknown as { agentvScreen: (json: string) => void }).agentvScreen = () => {};
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".apps-page .app-pick");
  return {
    url,
    page,
    close: async () => {
      await page.close();
      await daemon.close();
    },
  };
}

const groups = (page: Page) => page.locator(".app-group:not(.hidden) .app-head").allInnerTexts();
const names = (page: Page, group: string) => page.locator(".app-group:not(.hidden)", { has: page.locator(".app-head", { hasText: group }) }).locator(".app-pick .app-name").allInnerTexts();
const homeHas = async (url: string, ids: string[]) => {
  for (let i = 0; i < 100; i++) {
    const apps: { id: string }[] = (await (await fetch(`${url}/api/home`)).json()).apps;
    if (ids.every((id) => apps.some((app) => app.id === id))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

bothWays("starter", "T9.2 on Streaming, setup's apps start with the starter pack, every app in it ticked, and continue installs them", async (on, options) => {
  const { url, page, close } = await atApps("streaming", options);
  try {
    if (!on) {
      // As before: the servers you run yourself, and a streaming app is one
      // more official app.
      assert.deepEqual(await groups(page), ["# for streaming", "# more"]);
      assert.deepEqual(await names(page, "# for streaming"), ["jellyfin"]);
      assert.deepEqual(await names(page, "# more"), ["harbour", "immich", "kite", "steam"]);
      assert.equal(await page.locator(".app-pick.on").count(), 0, "nothing is ticked");
      assert.equal(await page.locator(".setup-line").count(), 0);
      return;
    }
    assert.deepEqual(await groups(page), ["# streaming", "# more"]);
    assert.equal(await page.locator(".setup-line").innerText(), "the streaming apps are picked");
    assert.equal(await page.locator(".setup-line").textContent(), "The streaming apps are picked");
    assert.deepEqual(await names(page, "# streaming"), ["harbour", "kite"]);
    for (const id of ["agentv.harbour", "agentv.kite"]) assert.match(await page.locator(`[data-app="${id}"]`).innerText(), /\[x\]/);
    assert.match(await page.locator('[data-app="agentv.harbour"]').innerText(), /plays in sd here/, "its description's second sentence is its note");
    assert.equal((await page.locator('[data-app="agentv.kite"] .app-note-line').innerText()).trim(), "", "and no note when it says no more");
    assert.deepEqual(await names(page, "# more"), ["jellyfin", "immich", "steam"], "the servers you run yourself first");
    // One way to build: the last tile of the grid, shaped like the apps
    // before it, with Ask's sparkle and no small line under it.
    const add = page.locator(".app-group:not(.hidden) .app-row").last().locator(":scope > :last-child.app-add");
    assert.match(await add.innerText(), /^can't find it\?\s+build your own$/);
    assert.equal(await page.locator(".app-add").count(), 1);
    assert.equal(await add.locator(".app-face .glyph-spark").count(), 1);
    assert.equal(await add.locator(".app-note-line").count(), 0);
    const box = (selector: string) => page.locator(selector).evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height, el.scrollHeight <= el.clientHeight + 1]);
    assert.deepEqual(await box(".app-add"), await box('[data-app="agentv.steam"]'), "the same shape, and its words fit it");
    assert.equal((await box(".app-add"))[2], true);
    // The apps are picked already, so the focus starts on continue: the
    // first press goes on, and doesn't untick one. The pack is one press down.
    assert.equal(await page.locator(".focused").getAttribute("data-action"), "continue");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.locator(".app-pick.focused").getAttribute("data-app"), "agentv.harbour", "down from continue is the pack");

    // OK unticks one and ticks it again; continue installs both, and nothing else.
    await page.keyboard.press("Enter");
    assert.match(await page.locator('[data-app="agentv.harbour"]').innerText(), /\[ \]/);
    await page.keyboard.press("Enter");
    assert.match(await page.locator('[data-app="agentv.harbour"]').innerText(), /\[x\]/);
    await page.locator('[data-action="continue"]').click();
    assert.ok(await homeHas(url, ["agentv.harbour", "agentv.kite"]), "home has the starter pack");
    const apps: { id: string }[] = (await (await fetch(`${url}/api/home`)).json()).apps;
    assert.ok(!apps.some((app) => ["agentv.jellyfin", "agentv.immich", "agentv.steam"].includes(app.id)), "only the pack");
  } finally {
    await close();
  }
});

bothWays("starter", "T9.2 on any other goal, the starter pack is one press away, and that press ticks every app in it", async (on, options) => {
  const { url, page, close } = await atApps("media", options);
  try {
    if (!on) {
      assert.deepEqual(await groups(page), ["# for photos", "# more"]);
      assert.deepEqual(await names(page, "# more"), ["harbour", "kite", "steam"]);
      assert.equal(await page.locator('[data-app="starter"]').count(), 0);
      return;
    }
    assert.deepEqual(await groups(page), ["# for photos", "# more"]);
    assert.equal(await page.locator(".setup-line").innerText(), "add all the streaming apps with one press");
    assert.equal(await page.locator(".app-group:not(.hidden) .app-row").last().locator(":scope > :last-child.app-add").count(), 1, "build your own ends the grid here too");
    assert.deepEqual(await names(page, "# for photos"), ["jellyfin", "immich"]);
    assert.deepEqual(await names(page, "# more"), ["streaming", "steam"], "the pack starts more, as one card");
    const pack = page.locator('[data-app="starter"]');
    assert.match(await pack.innerText(), /\[ \][\s\S]*streaming[\s\S]*harbour and kite/);

    // Down from the photos apps and left to the pack, one press ticks it,
    // another unticks it, and a third again.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.locator(".app-pick.focused").getAttribute("data-app"), "starter");
    await page.keyboard.press("Enter");
    assert.match(await pack.innerText(), /\[x\]/);
    await page.keyboard.press("Enter");
    assert.match(await pack.innerText(), /\[ \]/);
    await page.keyboard.press("Enter");
    await page.locator('[data-action="continue"]').click();
    assert.ok(await homeHas(url, ["agentv.harbour", "agentv.kite"]), "home has every app in the pack");
  } finally {
    await close();
  }
});
