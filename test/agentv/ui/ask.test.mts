// The Ask box building apps, on the TV and the phone in a real Chromium
// (ADR-068, ADR-019 layer 4, D5), with the askbuilds switch off and then on.
// On: the bar's Ask is everyone's; "make me a game like tetris" opens the
// build's page, its confirm says "make blocks?" with its recipe, and the
// build's tile on home shows its steps; a child's make is "ask a grown-up";
// an app the agent made has "change it", whose change waits for an ok on
// the TV and the phone. Off: none of that, as before. The router and root's
// part of the builder are stand-ins, as in builds.test.mts.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { installLocal } from "../../../daemon/apps/install.ts";
import { NONE, type Route } from "../../../daemon/router.ts";
import { bothWays, FIXTURES, startBox, type BoxOptions } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");
const ROOT = join(import.meta.dirname, "../../..");

let browser: Browser;
const errors: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), "agentv-ask-ui-"));

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  rmSync(scratch, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

// What the stand-in router makes of each sentence. The make's what is the
// builder's sentence, so this app's id is local.blocks.
function route(sentence: string): Route {
  if (sentence === "make me a game like tetris") return { ...NONE, intent: "make", what: "blocks" };
  if (sentence === "make me a game with unicorns") return { ...NONE, intent: "make", what: "a game with unicorns" };
  if (/^change blocks: /.test(sentence)) return { ...NONE, intent: "change", app: "local.blocks", what: sentence.replace(/^change blocks: /, "") };
  return { ...NONE };
}

async function box(options: Pick<BoxOptions, "features">) {
  // No app the agent made yet, so Apps has its examples.
  const started = await startBox(0, FIXTURES.filter((app) => app.tier !== "local"), {
    ...options,
    router: async (sentence) => {
      const r = route(sentence);
      return { sentence, route: r, ...(r.intent === "none" ? { none: "unroutable" as const } : {}), provider: "claude", via: "api", model: "test", ms: 5 };
    },
  });
  const { daemon, url, state } = started;
  const lan = `http://127.0.0.1:${daemon.lanPort}`;
  const send = async (method: string, path: string, body?: unknown, grant?: string, base = url) =>
    (await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<Record<string, any>>;
  // Claude with a key, its terms accepted on a paired phone, as a build needs.
  writeFileSync(join(state, "..", "key.json"), JSON.stringify({ set: true, provider: "claude", at: new Date().toISOString() }));
  await send("POST", "/api/ai", { provider: "claude", path: "key" });
  const code = (await send("POST", "/api/phones/pair", {})).pairing.code;
  const token = (await send("POST", "/api/phone/pair", { code, name: "iphone" }, undefined, lan)).token as string;
  const accepted = await fetch(`${lan}/api/phone/terms`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ provider: "claude", path: "key" }) });
  assert.equal(accepted.status, 200);
  return { ...started, lan, token, send };
}

async function tv(url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true, apps: [] })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

const go = (page: Page, r: string) => page.evaluate((to) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(to), r);

// Root's part: it takes the start the daemon dropped, and the build's
// folder says how it stands.
function rootTakes(state: string): Record<string, any> {
  const start = join(state, "build-drop", "start.json");
  const taken = JSON.parse(readFileSync(start, "utf8"));
  rmSync(start);
  mkdirSync(join(state, "..", "build-run"), { recursive: true });
  writeFileSync(join(state, "..", "build-run", "answer.json"), JSON.stringify({ action: "start", build: taken.build, started: true, at: new Date().toISOString() }));
  return taken;
}

function status(builds: string, build: string, version: string, change: Record<string, unknown>): void {
  const dir = join(builds, "local.blocks", version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ build, id: "local.blocks", version, phase: "understand", state: "running", steps: [], started: "", at: new Date(Date.now() + 5).toISOString(), ...change }));
}

const UNDERSTOOD = { name: "Blocks", recipe: "game", says: "A falling-block game for the remote" };
const STEPS = (running: number) => ["plan-the-game", "draw-the-board", "write-the-rules"].map((id, i) => ({ id, state: i < running ? "done" : i === running ? "running" : "waiting" }));

async function typeAsk(page: Page, sentence: string): Promise<void> {
  await page.waitForSelector(".ask-page .ask-field");
  await page.locator(".ask-field").fill(sentence);
  await page.locator(".ask-field").focus();
  await page.keyboard.press("Enter");
}

bothWays("askbuilds", "T11.2 the TV's Ask makes an app to the confirm and a tile on home, a child is told to ask a grown-up, and an app the agent made has change it", async (on, options) => {
  const { daemon, url, state, builds, apps, send, lan, token } = await box(options);
  try {
    const page = await tv(url);
    if (!on) {
      // As it ships: no Ask on phase 1's bar, a make is "i didn't get that",
      // and Apps' "+ add your own" is the old page.
      assert.equal(await page.locator('[data-action="bar-ask"]').count(), 0);
      assert.equal((await send("POST", "/api/say", { sentence: "make me a game like tetris" })).said.outcome.say, "i didn't get that");
      assert.equal(existsSync(join(state, "build-drop", "start.json")), false, "nothing was built");
      await go(page, "apps");
      await page.locator('[data-action="build"]').click();
      await page.waitForSelector(".build-ask");
      assert.match(await page.locator(".page").innerText(), /what should i make\?/);
      assert.equal(await page.locator(".ask-examples").count(), 0);
      await page.close();
      return;
    }

    // Apps, with nothing the agent made yet, has examples of what to make.
    await go(page, "apps");
    await page.waitForSelector(".ask-examples");
    assert.deepEqual(await page.locator(".ask-examples .button").allTextContents(), ["make a game like tetris", "make a slideshow of the photos on my nas", "make a better weather app"]);

    // The bar's Ask, then a make: the build's page reads it, then asks.
    await go(page, "home");
    await page.locator('[data-action="bar-ask"]').click();
    await page.waitForSelector(".ask-page");
    assert.match(await page.locator(".ask-page").innerText(), /ask[\s\S]*what do you want\?[\s\S]*type here, or on your phone/);
    assert.deepEqual(await page.locator(".ask-suggestions .button").allTextContents(), ["continue", "what's new", "make a game like tetris"]);
    await typeAsk(page, "make me a game like tetris");
    await page.waitForSelector(".build-page", { timeout: 10_000 });
    const start = rootTakes(state);
    assert.deepEqual([start.phase, start.sentence, start.id], ["understand", "blocks", "local.blocks"]);
    status(builds, start.build, "1.0.0", { state: "confirm", understood: UNDERSTOOD });
    await page.waitForFunction(() => document.querySelector(".build-page")?.getAttribute("data-state") === "confirm", undefined, { timeout: 10_000 });
    assert.match(await page.locator(".build-page").innerText(), /make blocks\?[\s\S]*recipe: game · it stays on this tv · about \$/);
    // The phone has the same confirm, in its Ask.
    const ask = await (await fetch(`${lan}/api/phone/ask`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.deepEqual([ask.ask.kind, ask.ask.state, ask.ask.recipe], ["build", "confirm", "game"]);
    await page.locator('[data-action="confirm"]').click();
    await page.waitForFunction(() => document.querySelector(".build-page")?.getAttribute("data-state") !== "confirm");
    const built = rootTakes(state);
    assert.deepEqual([built.phase, built.recipe], ["build", "game"]);

    // Building: its tile on home says how far it got and the step it's on.
    status(builds, start.build, "1.0.0", { phase: "build", state: "running", steps: STEPS(1), understood: UNDERSTOOD });
    await go(page, "home");
    await page.waitForFunction(() => /building 1\/3[\s\S]*draw the board/.test((document.querySelector(".grid .build-tile") as HTMLElement | null)?.innerText ?? ""), undefined, { timeout: 10_000 });

    // Approved and installed: Blocks is on the TV, made by the agent.
    status(builds, start.build, "1.0.0", { phase: "build", state: "installed", steps: STEPS(3), understood: UNDERSTOOD });
    const pkg = join(scratch, `blocks-${Date.now()}`);
    cpSync(join(ROOT, "test/agentv/fixtures/apps/blocks"), pkg, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(pkg, "manifest.json"), "utf8"));
    writeFileSync(join(pkg, "manifest.json"), JSON.stringify({ ...manifest, id: "local.blocks", author: "your agent" }));
    await installLocal(pkg, apps, async () => true);
    await page.reload();
    await page.waitForSelector(".grid .tile.focused");

    // Its details' "change it" starts the Ask box with "change blocks: ".
    await go(page, "details/local.blocks");
    await page.locator('[data-action="change"]').click();
    await page.waitForSelector(".ask-page");
    assert.equal(await page.locator(".ask-field").inputValue(), "change blocks: ");
    await typeAsk(page, "change blocks: make the pieces fall faster");
    await page.waitForSelector(".ask-change", { timeout: 10_000 });
    assert.match(await page.locator(".ask-change").innerText(), /change blocks\?[\s\S]*recipe: game · it stays on this tv/);
    assert.equal(existsSync(join(state, "build-drop", "start.json")), false, "nothing starts before the ok");
    await page.locator('[data-action="confirm"]').click();
    await page.waitForSelector(".build-page:not(.ask-change)", { timeout: 10_000 });
    const changed = rootTakes(state);
    assert.deepEqual([changed.version, changed.from, changed.change], ["1.1.0", "1.0.0", "make the pieces fall faster"]);

    // A child: the bar's Ask is theirs too, and a make is "ask a grown-up".
    assert.equal((await fetch(`${url}/api/pin`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "2468" }) })).status, 200);
    const grant = (await send("POST", "/api/pin/check", { pin: "2468" })).grant;
    const child = (await send("POST", "/api/viewers", { name: "mia", role: "child" }, grant)).profile;
    await send("POST", "/api/viewer", { id: child.id });
    await page.reload();
    await page.waitForSelector(".grid .tile.focused");
    await page.locator('[data-action="bar-ask"]').click();
    await page.waitForSelector(".ask-page");
    assert.match(await page.locator(".ask-page .prompt").innerText(), /ask · mia/);
    assert.deepEqual(await page.locator(".ask-suggestions .button").allTextContents(), ["continue", "what's new"]);
    await typeAsk(page, "make me a game with unicorns");
    await page.waitForFunction(() => document.querySelector(".ask-said.ask-no")?.textContent === "ask a grown-up to make apps", undefined, { timeout: 10_000 });
    assert.equal(existsSync(join(state, "build-drop", "start.json")), false, "nothing was built");
    await page.close();
  } finally {
    await daemon.close();
  }
});

test("T11.2 on the phone's remote, Ask is the same box, and a make your agent read waits there for an ok", async () => {
  const { daemon, url, state, builds, lan } = await box({ features: { askbuilds: true, remote2: true } });
  try {
    const { pairing } = await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json();
    const hand = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    hand.on("pageerror", (error) => errors.push(error.message));
    await hand.goto(`${lan}/?code=${pairing.code}`);
    await hand.waitForSelector(".r2");
    await hand.locator(".r2-ask").first().tap();
    await hand.waitForSelector("#r2-sheet .ask-chips");
    assert.equal(await hand.locator("#r2-sheet h1").first().textContent(), "what do you want?");
    assert.deepEqual(await hand.locator("#r2-sheet .ask-chips .chip").allTextContents(), ["continue", "what's new", "make a game"]);
    assert.equal(await hand.locator('#r2-sheet [data-action="say"]').count(), 0, "no send button: the keyboard's send key asks");
    // "make a game" fills the box and leaves the keyboard up for the rest.
    await hand.locator('#r2-sheet [data-suggestion="make a game"]').tap();
    assert.equal(await hand.locator("#say-text").inputValue(), "make a game like ");
    await hand.locator("#say-text").fill("make me a game like tetris");
    await hand.locator("#say-text").press("Enter");
    for (let i = 0; i < 100 && !existsSync(join(state, "build-drop", "start.json")); i++) await new Promise((done) => setTimeout(done, 50));
    const start = rootTakes(state);
    // The sheet stays up after the send, and shows what the agent read.
    status(builds, start.build, "1.0.0", { state: "confirm", understood: UNDERSTOOD });
    await hand.waitForSelector('#r2-sheet [data-ask="confirm"]', { timeout: 10_000 });
    assert.match(await hand.locator('#r2-sheet [data-ask="confirm"]').innerText(), /make blocks\?[\s\S]*recipe: game · it stays on this tv/);
    await hand.locator('#r2-sheet [data-action="ask-confirm"]').tap();
    for (let i = 0; i < 100 && !existsSync(join(state, "build-drop", "start.json")); i++) await new Promise((done) => setTimeout(done, 50));
    assert.deepEqual([rootTakes(state).phase], ["build"]);
    await hand.close();
  } finally {
    await daemon.close();
  }
});
