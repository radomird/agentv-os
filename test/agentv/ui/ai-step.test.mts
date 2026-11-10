// Setup's AI step with setup's own switch on (design page D3), in a real
// Chromium. Each provider shows its own icon, fetched on the box from its
// site, here stand-in sites the test serves, and a provider whose site has
// no icon shows its name alone. Picking Claude offers the plan's sign-in
// right there: the terms are accepted on the phone first, then the TV shows
// the CLI's link as a QR code and takes the code its page gives, and setup
// moves on once it's signed in. Root's hand-over and the CLI are the image
// layer's: here the test plays their part through the build drop.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";
import { pairPhone, type TestPhone } from "../unit/phone-client.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

// A 2 × 2 PNG, as a provider's apple-touch-icon.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAKAgCAn8bSAgAAAAASUVORK5CYII=", "base64");

let browser: Browser;
let daemon: Daemon;
let sites: Server;
let url = "";
let lan = "";
let state = "";
let run = "";
const asked: string[] = [];
const errors: string[] = [];
const tools = mkdtempSync(join(tmpdir(), "agentv-ai-step-"));
const path = process.env.PATH;

before(async () => {
  // The providers' sites: Claude's page names an icon, Gemini has only a
  // favicon, and the others have none at all.
  sites = createServer((request, response) => {
    asked.push(request.url ?? "");
    if (request.url === "/claude/") {
      response.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><link rel="apple-touch-icon" href="/claude/touch.png">');
    } else if (request.url === "/claude/touch.png") {
      response.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
    } else if (request.url === "/gemini/") {
      response.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><link rel="icon" href="/gemini/favicon.png">');
    } else if (request.url === "/gemini/favicon.png") {
      response.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => sites.listen(0, "127.0.0.1", () => resolve()));
  const at = `http://127.0.0.1:${(sites.address() as { port: number }).port}`;
  writeFileSync(join(tools, "qrencode"), `#!/bin/bash\necho '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21"><rect width="21" height="21"/></svg>'\n`);
  chmodSync(join(tools, "qrencode"), 0o755);
  process.env.PATH = `${tools}:${path}`;
  let builds = "";
  ({ daemon, url, state, builds } = await startBox(0, undefined, {
    aiSites: { claude: `${at}/claude/`, chatgpt: `${at}/chatgpt/`, gemini: `${at}/gemini/`, grok: `${at}/grok/`, muse: `${at}/muse/` },
    features: { setup2: true },
  }));
  run = join(builds, "..", "build-run");
  lan = `http://127.0.0.1:${daemon.lanPort}`;
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  sites?.close();
  process.env.PATH = path;
  rmSync(tools, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

function atAi(): void {
  writeFileSync(join(state, "features.json"), JSON.stringify({ setup2: true }));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "ai", finished: { welcome: "2026-11-05T10:00:00Z", ready: "2026-11-05T10:01:00Z", country: "2026-11-05T10:02:00Z" } }));
  rmSync(join(state, "ai.json"), { force: true });
  rmSync(join(state, "plan-sign-in.json"), { force: true });
  rmSync(join(state, "build-drop"), { recursive: true, force: true });
  rmSync(run, { recursive: true, force: true });
}

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  return page;
}

// An adult on a paired phone accepts the terms the TV shows.
async function acceptOnPhone(provider: string, way: string): Promise<void> {
  const code = (await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json()).pairing.code;
  const paired = await pairPhone(lan, code, "pixel");
  const accepted = await paired.fetch(`/api/phone/terms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, path: way }) });
  assert.equal(accepted.status, 200);
}

// Root's hand-over and the CLI's sign-in, as they'd write their status.
function signInSays(status: Record<string, unknown>): void {
  mkdirSync(join(run, "sign-in"), { recursive: true });
  writeFileSync(join(run, "sign-in", "status.json"), JSON.stringify({ provider: "claude", at: new Date(Date.now() + 1000).toISOString(), ...status }));
}

test("T7.2 each provider shows its own icon from its site, and one whose site has none shows its name alone", async () => {
  atAi();
  const page = await tv();
  try {
    await page.waitForSelector(".ai-cards");
    assert.equal(await page.locator(".setup-headline").getAttribute("aria-label"), "pick your ai.");
    assert.equal(await page.locator(".setup-line").textContent(), "it builds your apps and answers what you ask");
    assert.equal(await page.locator(".bar .bar-step").textContent(), "6 of 12 · ai");
    assert.deepEqual(await page.locator(".ai-card .ai-name").allTextContents(), ["claude", "chatgpt", "gemini", "grok", "muse"]);
    assert.deepEqual(await page.locator(".ai-card .ai-maker").allTextContents(), ["anthropic", "openai", "google", "xai", "meta"]);
    // The icons that came load; the ones that didn't are gone, names left.
    await page.waitForFunction(() => document.querySelectorAll(".ai-icon").length === 2 && [...document.querySelectorAll<HTMLImageElement>(".ai-icon")].every((img) => img.complete && img.naturalWidth > 0));
    assert.deepEqual(await page.locator(".ai-icon").evaluateAll((imgs) => imgs.map((img) => img.getAttribute("data-icon"))), ["claude", "gemini"]);
    for (const provider of ["chatgpt", "grok", "muse"]) {
      assert.equal(await page.locator(`.ai-card[data-provider="${provider}"] img`).count(), 0, `${provider} shows its name alone`);
    }
    assert.equal(await page.locator(".focused").getAttribute("data-provider"), "claude");
    // Kept on the box: the sites aren't asked again.
    const before = asked.length;
    await page.reload();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".ai-icon")].filter((img) => img.naturalWidth > 0).length === 2);
    assert.deepEqual(asked.slice(before).filter((u) => u.startsWith("/claude") || u.startsWith("/gemini")), [], "the icons came from the box's own copy");
    assert.ok(existsSync(join(state, "ai-icons", "claude")));
  } finally {
    await page.close();
  }
});

test("ADR-070 the plan's sign-in starts right at the AI step: terms on the phone, the link as a QR code, the code, and on", async () => {
  atAi();
  const page = await tv();
  try {
    await page.waitForSelector(".ai-cards");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-options");
    assert.equal(await page.locator(".setup-headline").getAttribute("aria-label"), "sign in to claude.");
    assert.deepEqual(await page.locator(".ai-options > .button").allTextContents(), ["↵ use my plan", "use a key from my phone", "later, in settings"]);
    assert.equal(await page.locator(".ai-paste.hidden").count(), 1, "no code to paste until the sign-in asks for one");
    assert.equal(await page.locator(".focused").textContent(), "↵ use my plan");
    await page.keyboard.press("Enter");
    // The terms come first, accepted on the phone. Nothing signs in before.
    await page.waitForSelector(".terms-list");
    assert.equal(existsSync(join(state, "build-drop", "sign-in.json")), false);
    await acceptOnPhone("claude", "plan");
    // Back on the ways in, the sign-in starts by itself, without a build.
    await page.waitForSelector(".ai-options");
    for (let i = 0; i < 50 && !existsSync(join(state, "build-drop", "sign-in.json")); i++) await page.waitForTimeout(100);
    assert.deepEqual(JSON.parse(readFileSync(join(state, "build-drop", "sign-in.json"), "utf8")), { build: null, provider: "claude" });
    // The CLI's link: a QR code to scan, and a field for the code its page
    // gives.
    signInSays({ state: "waiting", url: "https://claude.ai/oauth/authorize?code=true&state=s7Q", pastes: true });
    await page.waitForSelector(".ai-qr:not(.hidden) .qr[src]");
    assert.equal(await page.locator('[data-line="sign-in"]').textContent(), "scan to sign in, then paste the code it gives you");
    await page.fill('[data-action="sign-in-code"]', "good-code#s7Q");
    await page.locator('[data-action="send-code"]').click();
    for (let i = 0; i < 50 && !existsSync(join(state, "build-drop", "sign-in-code.json")); i++) await page.waitForTimeout(100);
    assert.deepEqual(JSON.parse(readFileSync(join(state, "build-drop", "sign-in-code.json"), "utf8")), { code: "good-code#s7Q" });
    // Signed in: on to who watches, with the plan kept for voice.
    signInSays({ state: "done" });
    await page.waitForFunction(() => document.querySelector(".bar .bar-step")?.textContent === "7 of 12 · who watches");
    const ai = await (await fetch(`${url}/api/ai`)).json();
    assert.deepEqual([ai.provider, ai.path], ["claude", "plan"]);
    assert.equal((await (await fetch(`${url}/api/ai/sign-in`)).json()).signIn.signedIn, true);
  } finally {
    await page.close();
  }
});

test("T17.1 on stable, the AI step offers a plan for Claude, ChatGPT and Grok, says Google is key only, and keeps Muse's coming soon", async () => {
  atAi();
  // This box goes to stable, where a plan was Claude's alone before.
  const channel = join(state, "..", "channel");
  const was = readFileSync(channel, "utf8");
  writeFileSync(channel, "stable\n");
  const page = await tv();
  try {
    await page.waitForSelector(".ai-cards");
    const ways = async (provider: string) => {
      await page.locator(`.ai-card[data-provider="${provider}"]`).click();
      await page.waitForSelector(".ai-options");
      const found = { buttons: await page.locator(".ai-options > .button").allTextContents(), line: (await page.locator('[data-line="sign-in"]').textContent()) ?? "" };
      await page.keyboard.press("Escape");
      await page.waitForSelector(".ai-cards");
      return found;
    };
    assert.equal((await (await fetch(`${url}/api/ai`)).json()).channel, "stable");
    for (const provider of ["claude", "chatgpt", "grok"]) {
      const found = await ways(provider);
      assert.deepEqual(found.buttons, ["↵ use my plan", "use a key from my phone", "later, in settings"], provider);
      assert.doesNotMatch(found.line, /coming soon|best effort|key works now/, provider);
    }
    // Google keeps its plan to its own apps, by its own terms: no plan to
    // pick, and the line says so without a "soon".
    const google = await ways("gemini");
    assert.deepEqual(google.buttons, ["use a key from my phone", "later, in settings"]);
    assert.equal(google.line, "google keeps its plan to its own apps. a key works now");
    // Meta has been asked, so Muse's is coming soon.
    const muse = await ways("muse");
    assert.deepEqual(muse.buttons, ["use a key from my phone", "later, in settings"]);
    assert.equal(muse.line, "a muse code subscription is coming soon. a key works now");
  } finally {
    writeFileSync(channel, was);
    await page.close();
  }
});

test("ADR-070 a sign-in that fails says why and tries again, and later leaves it for Settings with the plan kept", async () => {
  atAi();
  writeFileSync(join(state, "ai.json"), JSON.stringify({ provider: "claude", path: "plan" }));
  await acceptOnPhone("claude", "plan");
  const page = await tv();
  try {
    await page.waitForSelector(".ai-options");
    for (let i = 0; i < 50 && !existsSync(join(state, "build-drop", "sign-in.json")); i++) await page.waitForTimeout(100);
    signInSays({ state: "failed", reason: "it took longer than 15 minutes" });
    await page.waitForFunction(() => document.querySelector('[data-line="sign-in"]')?.textContent === "that didn't work: it took longer than 15 minutes. try again");
    rmSync(join(state, "build-drop", "sign-in.json"), { force: true });
    await page.keyboard.press("Enter");
    for (let i = 0; i < 50 && !existsSync(join(state, "build-drop", "sign-in.json")); i++) await page.waitForTimeout(100);
    assert.ok(existsSync(join(state, "build-drop", "sign-in.json")), "use my plan starts it again");
    await page.locator('[data-action="later"]').click();
    await page.waitForFunction(() => document.querySelector(".bar .bar-step")?.textContent === "7 of 12 · who watches");
    const ai = await (await fetch(`${url}/api/ai`)).json();
    assert.deepEqual([ai.provider, ai.path], ["claude", "plan"], "Settings → AI and a first build still have the plan to sign in to");
  } finally {
    await page.close();
    rmSync(join(state, "features.json"), { force: true });
  }
});

test("ADR-070 a plan left for later in setup signs in from Settings → AI, and with setup's own switch off there's no new row", async () => {
  // Setup done, with Claude's plan picked and its terms accepted.
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true }));
  writeFileSync(join(state, "ai.json"), JSON.stringify({ provider: "claude", path: "plan" }));
  rmSync(join(state, "plan-sign-in.json"), { force: true });
  rmSync(join(state, "build-drop"), { recursive: true, force: true });
  rmSync(run, { recursive: true, force: true });
  await acceptOnPhone("claude", "plan");
  const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
  for (const on of [false, true]) {
    writeFileSync(join(state, "features.json"), JSON.stringify({ setup2: on }));
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${url}/`);
      await page.waitForFunction((want) => (document.documentElement.dataset.features ?? "").split(" ").includes("setup2") === want, on);
      await page.waitForFunction(() => Boolean((window as unknown as { agentvLauncher?: unknown }).agentvLauncher));
      await go(page, "settings/ai");
      await page.waitForSelector('[data-action="use-plan"]');
      if (!on) {
        assert.equal(await page.locator('[data-action="plan-sign-in"]').count(), 0);
        continue;
      }
      await page.locator('[data-action="plan-sign-in"]').click();
      for (let i = 0; i < 50 && !existsSync(join(state, "build-drop", "sign-in.json")); i++) await page.waitForTimeout(100);
      assert.deepEqual(JSON.parse(readFileSync(join(state, "build-drop", "sign-in.json"), "utf8")), { build: null, provider: "claude" });
      signInSays({ state: "waiting", url: "https://claude.ai/oauth/authorize?code=true&state=s7Q", pastes: true });
      await page.waitForSelector(".build-qr:not(.hidden) img[src]");
      await page.fill('[data-action="sign-in-code"]', "good-code#s7Q");
      await page.locator('[data-action="send-code"]').click();
      for (let i = 0; i < 50 && !existsSync(join(state, "build-drop", "sign-in-code.json")); i++) await page.waitForTimeout(100);
      assert.deepEqual(JSON.parse(readFileSync(join(state, "build-drop", "sign-in-code.json"), "utf8")), { code: "good-code#s7Q" });
      signInSays({ state: "done" });
      await page.locator('.toast:has-text("you\'re signed in to your plan")').waitFor();
      await page.waitForSelector('[data-action="plan-sign-in"]');
      assert.equal((await (await fetch(`${url}/api/ai/sign-in`)).json()).signIn.signedIn, true);
    } finally {
      await page.close();
    }
  }
});
