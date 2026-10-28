// Your agent's builds on the TV, in a real Chromium (ADR-019, layer 4;
// ADR-043 to ADR-046, boards 10, 17 and 20): Apps' "+ add your own" asks
// what to make, the agent says what it understood with its cost and time,
// the build shows its steps on its page, its tile and home's bar, and a
// finished app or a failed build says so. Root's part, each build's
// status.json, is played by the test, as the daemon reads it on the box.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
let state = "";
let builds = "";
const errors: string[] = [];

async function send(method: string, path: string, body?: unknown, grant?: string, base = url) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as Record<string, any>;
}

before(async () => {
  ({ daemon, url, state, builds } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
  // Claude with a key, its terms accepted on a paired phone.
  writeFileSync(join(state, "..", "key.json"), JSON.stringify({ set: true, provider: "claude", at: new Date().toISOString() }));
  await send("POST", "/api/ai", { provider: "claude", path: "key" });
  const lan = `http://127.0.0.1:${daemon.lanPort}`;
  const code = (await send("POST", "/api/phones/pair", {})).pairing.code;
  const token = (await send("POST", "/api/phone/pair", { code, name: "iphone" }, undefined, lan)).token;
  const accepted = await fetch(`${lan}/api/phone/terms`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ provider: "claude", path: "key" }) });
  assert.equal(accepted.status, 200);
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

async function tv(): Promise<Page> {
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

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const drop = (name: string) => JSON.parse(readFileSync(join(state, "build-drop", `${name}.json`), "utf8"));
const page$ = (page: Page) => page.locator(".build-page").innerText();
const toasts = (page: Page) => page.locator("#toasts").innerText();

// Root's part: it takes a start the daemon dropped and says so, then the
// build in its folder says how it stands, a moment later.
function status(id: string, build: string, change: Record<string, unknown>): void {
  const start = join(state, "build-drop", "start.json");
  if (existsSync(start)) {
    const taken = JSON.parse(readFileSync(start, "utf8"));
    rmSync(start);
    mkdirSync(join(state, "..", "build-run"), { recursive: true });
    writeFileSync(join(state, "..", "build-run", "answer.json"), JSON.stringify({ action: "start", build: taken.build, started: true, at: new Date().toISOString() }));
  }
  const dir = join(builds, id, "1.0.0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ build, id, version: "1.0.0", phase: "understand", state: "running", steps: [], started: "", at: new Date(Date.now() + 5).toISOString(), ...change }));
}

const STEPS = (running: number) =>
  ["design", "packages", "build", "tests"].map((id, i) => ({ id, state: i < running ? "done" : i === running ? "running" : "waiting" }));

test("ADR-046 + add your own asks what to make, and the agent's reading of it is confirmed with its cost and time", async () => {
  const page = await tv();
  await go(page, "apps");
  await page.locator('[data-action="build"]').click();
  await page.waitForSelector(".build-ask");
  assert.match(await page.locator(".page").innerText(), /what should i make\?[\s\S]*type here, or on your phone/);
  await page.locator(".build-ask").fill("a game like tetris");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /reading what you asked/.test(document.querySelector(".build-page")?.textContent ?? ""));
  const start = drop("start");
  assert.deepEqual([start.phase, start.sentence, start.path, start.cap], ["understand", "a game like tetris", "key", { build: 5, month: 20 }]);

  // The agent read it as the game recipe.
  status(start.id, start.build, { state: "confirm", understood: { name: "Blocks", recipe: "game", says: "A falling-block puzzle for the remote and a gamepad" } });
  await page.waitForFunction(() => document.querySelector(".build-page")?.getAttribute("data-state") === "confirm", undefined, { timeout: 10_000 });
  const confirm = await page$(page);
  assert.match(confirm, /is this what you meant\?/);
  assert.match(confirm, /name\s+blocks/);
  assert.match(confirm, /kind\s+game/);
  assert.match(confirm, /cost\s+about \$0\.50 to \$3\.00 on your claude key, and never more than \$5\.00/);
  assert.match(confirm, /time\s+about 20 minutes/);
  assert.match(await toasts(page), /your agent read what you asked/);
  await page.locator('[data-action="confirm"]').click();
  await page.waitForFunction(() => document.querySelector(".build-page")?.getAttribute("data-state") === "starting");
  const build = drop("start");
  assert.deepEqual([build.phase, build.recipe, build.name], ["build", "game", "Blocks"]);
  await page.close();
});

test("a build shows its steps on its page, its tile in Apps and on home, and home's bar", async () => {
  const listed = (await send("GET", "/api/builds")).builds[0];
  status(listed.id, listed.build, { phase: "build", state: "running", step: "packages", steps: STEPS(1), understood: { name: "Blocks", recipe: "game", says: "A falling-block puzzle" } });
  const page = await tv();
  await page.waitForSelector(".grid .build-tile");
  assert.match(await page.locator(".grid .build-tile").innerText(), /building[\s\S]*blocks[\s\S]*1 of 4 steps/);
  assert.match(await page.locator(".bar-right").innerText(), /building blocks/);
  await go(page, "apps");
  await page.waitForSelector(".page .build-tile");
  assert.match(await page.locator(".page").innerText(), /# your agent's builds[\s\S]*blocks/);
  await page.locator(".page .build-tile").click();
  await page.waitForSelector('.build-page[data-state="running"]');
  const building = await page$(page);
  assert.match(building, /building blocks\./);
  assert.match(building, /\[x\] design[\s\S]*\[~\] packages[\s\S]*\[ \] build[\s\S]*\[ \] tests/);
  assert.match(building, /you can keep using the tv\. it takes about 20 minutes\. when it's done, approve blocks on your phone\./);

  // The gates passed: it waits for an adult on the phone, and the TV says so.
  status(listed.id, listed.build, { phase: "build", state: "approve", steps: STEPS(4), understood: { name: "Blocks", recipe: "game", says: "A falling-block puzzle" } });
  await page.waitForSelector('.build-page[data-state="approve"]', { timeout: 10_000 });
  assert.match(await page$(page), /blocks is ready\.[\s\S]*approve it on your phone, with the pin/);
  await page.waitForFunction(() => /blocks is ready: approve it on your phone/.test(document.getElementById("toasts")?.textContent ?? ""));
  await page.close();
});

test("a build that failed says why, and is tried again or put away", async () => {
  const listed = (await send("GET", "/api/builds")).builds[0];
  status(listed.id, listed.build, { phase: "build", state: "failed", reason: "its tests didn't pass", steps: STEPS(3).map((s) => (s.state === "running" ? { ...s, state: "failed" } : s)), understood: { name: "Blocks", recipe: "game", says: "A falling-block puzzle" } });
  const page = await tv();
  await page.waitForFunction(() => /couldn't build/.test(document.querySelector(".grid .build-tile")?.textContent ?? ""), undefined, { timeout: 10_000 });
  assert.match(await page.locator(".grid .build-tile").innerText(), /couldn't build[\s\S]*blocks[\s\S]*✗ its tests didn't pass/);
  assert.match(await page.locator(".bar-right").innerText(), /couldn't build blocks/);
  await page.locator(".grid .build-tile").click();
  await page.waitForSelector('.build-page[data-state="failed"]');
  assert.match(await page$(page), /couldn't build blocks\.[\s\S]*✗\s+its tests didn't pass[\s\S]*\[!\] tests/);
  await page.locator('[data-action="retry"]').click();
  await page.waitForFunction(() => document.querySelector(".build-page")?.getAttribute("data-state") !== "failed");
  assert.deepEqual([drop("start").phase, drop("start").recipe], ["build", "game"]);

  // Failed again: Delete puts it away, and its folder goes with it.
  status(listed.id, listed.build, { phase: "build", state: "failed", reason: "it stopped", steps: [] });
  await page.waitForSelector('.build-page[data-state="failed"]', { timeout: 10_000 });
  rmSync(join(state, "build-drop", "remove.json"), { force: true });
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => !document.querySelector(".build-page"));
  assert.deepEqual(drop("remove"), { id: listed.id });
  assert.equal((await send("GET", "/api/builds")).builds.length, 0);
  await go(page, "home");
  await page.waitForFunction(() => !document.querySelector(".grid .build-tile"));
  await page.close();
});

test("ADR-046 what setup's + add your own kept is asked from here with one press, and is kept no longer", async () => {
  // Setup kept it, as its apps step does.
  const setup = join(state, "setup.json");
  writeFileSync(setup, JSON.stringify({ ...JSON.parse(readFileSync(setup, "utf8")), wishes: ["Photos on my NAS"] }));
  const page = await tv();
  await go(page, "build");
  await page.waitForSelector('[data-wish="Photos on my NAS"]');
  assert.match(await page.locator(".page").innerText(), /kept from setup[\s\S]*photos on my nas/);
  await page.locator('[data-wish="Photos on my NAS"]').click();
  await page.waitForSelector('.build-page[data-state="starting"]');
  assert.equal(drop("start").sentence, "Photos on my NAS");
  assert.deepEqual((await send("GET", "/api/builds")).wishes, []);
  // A second ask waits for this one.
  await go(page, "build");
  await page.locator(".build-ask").fill("a quiz");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /another build is going/.test(document.getElementById("toasts")?.textContent ?? ""));
  await page.close();
});

test("a child's profile has no + add your own, and no builds", async () => {
  await send("PUT", "/api/pin", { pin: "2468" });
  const grant = (await send("POST", "/api/pin/check", { pin: "2468" })).grant;
  const child = (await send("POST", "/api/viewers", { name: "leo", role: "child" }, grant)).profile;
  await send("POST", "/api/viewer", { id: child.id });
  const page = await tv();
  await page.waitForFunction(() => document.querySelector(".bar-right span")?.textContent === "leo");
  await go(page, "apps");
  await page.waitForSelector(".page .section");
  assert.equal(await page.locator('[data-action="build"]').count(), 0);
  assert.equal(await page.locator(".build-tile").count(), 0);
  assert.equal((await fetch(`${url}/api/builds`)).status, 403);
  await send("POST", "/api/viewer", { id: "radomir" }, grant);
  await page.close();
});
