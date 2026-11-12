// A quiet TV when nobody's watching, in a real Chromium (ADR-019, layer 4;
// ADR-072, T13.1, T17.1). The screen daemon itself runs on a stand-in
// Hyprland and drives home's real page, the way it does on the box over
// home's DevTools pipe. Idle shows home's own ambient screen, the one idle
// screen, with nothing else in front of it. With the TV reported off, home
// hears it, and once the apps close the output is off. The TV's own power
// is the NUC's.

import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { DevTools } from "../../../daemon/cdp.ts";
import type { Client, Hyprland, Layer, Monitor } from "../../../daemon/hyprland.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { HELD_WORKSPACE, Screen, type App, type Launcher, type Role } from "../../../daemon/screen.ts";
import { ROOT, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let browser: Browser;
let daemon: Daemon;
let url = "";
let appsDir = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url, apps: appsDir } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

// Hyprland as far as the screen daemon uses it here: windows moving to the
// TV and out of sight, focus, full screen, and the output's power.
class StandInHyprland implements Hyprland {
  windows: Client[] = [];
  dpms = true;
  private handler: (name: string, data: string) => void = () => {};
  async clients() {
    return structuredClone(this.windows);
  }
  async monitors(): Promise<Monitor[]> {
    return [{ name: "HDMI-A-1", width: 1920, height: 1080, refreshRate: 60, focused: true, specialWorkspace: { id: -98, name: "" } }];
  }
  async layers(): Promise<Layer[]> {
    return [];
  }
  events(handler: (name: string, data: string) => void) {
    this.handler = handler;
  }
  async eval() {}
  async dispatch(expression: string) {
    let m: RegExpMatchArray | null;
    if ((m = expression.match(/^hl\.dsp\.window\.move\(\{ window = "address:(0x\w+)", workspace = "([^"]+)"/))) {
      const window = this.windows.find((w) => w.address === m![1]);
      if (window) window.workspace = { id: m[2] === "1" ? 1 : -98, name: m[2] };
    } else if ((m = expression.match(/^hl\.dsp\.window\.fullscreen_state\(\{ window = "address:(0x\w+)", internal = (\d)/))) {
      const window = this.windows.find((w) => w.address === m![1]);
      if (window) window.fullscreen = Number(m[2]);
    } else if ((m = expression.match(/^hl\.dsp\.dpms\(\{ action = "(enable|disable)" \}\)$/))) {
      this.dpms = m[1] === "enable";
    }
  }
  open(address: string, pid: number, cls: string) {
    this.windows.push({ address, pid, class: cls, initialClass: cls, title: cls, workspace: { id: -98, name: HELD_WORKSPACE }, fullscreen: 0, mapped: true });
    this.handler("openwindow", `${address.slice(2)},${HELD_WORKSPACE},${cls},${cls}`);
  }
  close(address: string) {
    this.windows = this.windows.filter((w) => w.address !== address);
    this.handler("closewindow", address.slice(2));
  }
}

class StandInApp implements App {
  role: Role;
  pid: number;
  cdp?: DevTools;
  startedAt = Date.now();
  stopped = false;
  private exits: Array<() => void> = [];
  constructor(role: Role, pid: number, cdp?: DevTools) {
    this.role = role;
    this.pid = pid;
    this.cdp = cdp;
  }
  stop() {
    this.stopped = true;
  }
  onExit(callback: () => void) {
    this.exits.push(callback);
  }
  exit() {
    for (const callback of this.exits) callback();
  }
}

// Home's DevTools pipe, on the real page.
function pipe(page: Page): DevTools {
  return {
    bind: async () => {},
    evaluate: async (_prefix: string, expression: string) => page.evaluate(expression),
    open: async () => "",
    close: async () => {},
    evaluateIn: async () => undefined,
    pages: async () => [],
    addScriptIn: async () => {},
  } as unknown as DevTools;
}

// Home at 1920 × 1080, with every call the screen daemon makes to its
// agentvTv noted, and its requests to the screen daemon answered.
async function home(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, any>;
    w.tvHeard = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
    let real: ((state: string) => void) | undefined;
    Object.defineProperty(window, "agentvTv", {
      configurable: true,
      get: () => (real ? (state: string) => (w.tvHeard.push(state), real!(state)) : undefined),
      set: (fn) => (real = fn),
    });
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

// The screen daemon on that page, with the TV's power as the test says.
// Anything the daemon asks its launcher to start besides home is noted.
async function tv(page: Page, tvOn: () => boolean, more: Partial<Launcher> = {}) {
  const hypr = new StandInHyprland();
  const homeApp = new StandInApp("home", 100, pipe(page));
  const started: string[] = [];
  const parts: Partial<Launcher> = {
    home: () => homeApp,
    idleMinutes: async () => 10,
    parent: () => null,
    profile: () => null,
    updating: async () => false,
    nightUpdates: async () => null,
    ...more,
  };
  // Everything else the launcher does is a quiet yes, noted by name.
  const launcher = new Proxy(parts, {
    get: (target, name) =>
      name in target
        ? target[name as keyof Launcher]
        : name === "then"
          ? undefined
          : async () => {
              started.push(String(name));
            },
  }) as Launcher;
  const lines: string[] = [];
  const screen = new Screen({
    hyprland: hypr,
    launcher,
    log: (line) => lines.push(line),
    homeRestartMs: 10,
    homeCheckMs: 60_000,
    idleReportMs: 0,
    ambientSettleMs: 0,
    tvPoll: tvOn,
    tvPollMs: 50,
    tvOffCloseMs: 600,
    tvHotplug: () => () => {},
  });
  await screen.start();
  await sleep(0);
  hypr.open("0xa", homeApp.pid, "chromium");
  await screen.idle();
  return { hypr, screen, started, lines };
}

test("T17.1 idle shows home's ambient screen with its pictures, and nothing else comes in front of it", async () => {
  const page = await home();
  const t = await tv(page, () => true);
  await t.screen.handle({ cmd: "idle-after", seconds: 0.1 });
  t.screen.seatIdle(true);
  await page.waitForSelector("#ambient.on .ambient-drift", { timeout: 5000 });
  await sleep(700);
  await t.screen.idle();
  assert.equal(t.screen.ambient, true);
  assert.equal(t.screen.front()?.role, "home", "home is in front, on its ambient screen");
  assert.equal(await page.locator("#ambient.on").count(), 1);
  // No terminal, no effect: the daemon asked its launcher for no window.
  assert.deepEqual(t.started.filter((name) => /screensaver|ambientStyle/.test(name)), []);
  assert.ok(!t.lines.some((line) => /screensaver/.test(line)), t.lines.join("\n"));
  // A key ends it.
  t.screen.seatIdle(false);
  await page.waitForFunction(() => !document.querySelector("#ambient.on"), null, { timeout: 5000 });
  assert.equal(t.screen.ambient, false);
  t.screen.stop();
  await page.close();
});

test("T17.1 Settings, themes and backgrounds has no screensaver row, only how long the TV waits", async () => {
  const page = await home();
  try {
    await page.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("settings/look"));
    await page.waitForSelector('[data-action="idle"]');
    assert.equal(await page.locator('[data-action="ambient-style"]').count(), 0);
    // "terminal" is still a look's name here. What's gone is the row that
    // picked what the idle screen shows.
    const rows = (await page.locator(".settings-panel .button > span:first-child").allInnerTexts()).map((row) => row.toLowerCase());
    assert.ok(rows.includes("screen saver"), rows.join(", "));
    assert.equal(rows.filter((row) => /screen ?saver|ambient/.test(row)).length, 1, rows.join(", "));
    assert.match(await page.locator('.settings-panel [data-action="idle"] .button-value').innerText(), /^after \d+ min$/i);
    assert.doesNotMatch(await page.locator(".settings-panel").innerText(), /screensaver/i);
    assert.equal(await page.evaluate(async () => "ambient" in (await (await fetch("/api/home")).json()).settings), false);
  } finally {
    await page.close();
  }
});

test("T13.1 with the TV reported off home hears it, the output goes off, and home waits on its ambient screen", async () => {
  const page = await home();
  let on = true;
  const t = await tv(page, () => on);
  await t.screen.handle({ cmd: "idle-after", seconds: 0.1 });
  t.screen.seatIdle(true);
  await page.waitForSelector("#ambient.on", { timeout: 5000 });
  await sleep(100);
  await t.screen.idle();

  on = false;
  await page.waitForFunction(() => (window as unknown as { tvHeard: string[] }).tvHeard.includes("off"), null, { timeout: 5000 });
  await t.screen.idle();
  assert.equal(t.screen.front()?.role, "home");
  // Once the apps close, nothing draws.
  await sleep(800);
  await t.screen.idle();
  assert.equal(t.hypr.dpms, false, "the output is off");
  assert.equal(((await t.screen.handle({ cmd: "status" })) as { output: string }).output, "off");
  assert.equal(await page.locator("#ambient.on").count(), 1, "home waits on its ambient screen");
  // The TV back on: the output, then home hears it.
  on = true;
  await page.waitForFunction(() => (window as unknown as { tvHeard: string[] }).tvHeard.includes("on"), null, { timeout: 5000 });
  await t.screen.idle();
  assert.equal(t.hypr.dpms, true, "the output is on again");
  assert.deepEqual(await page.evaluate(() => (window as unknown as { tvHeard: string[] }).tvHeard), ["off", "on"]);
  assert.deepEqual(errors, []);
  t.screen.stop();
  await page.close();
});

// The TV going off leaves a game where it is (ADR-084, T16.2). A web app,
// Steam's stand-in and Blocks, a game as this TV makes them (a page on home,
// category games), are open, and so is Notes, a page on home that isn't a
// game. Home's page is the real one, so what it shows when the TV is back is
// what the couch sees.
test("T16.2 with the TV off for a while a web app and a page app that isn't a game close, and Steam and a game made on this TV stay open: the TV comes back on to the game, not the ambient screen", async () => {
  cpSync(join(ROOT, "test/agentv/fixtures/apps/blocks"), join(appsDir, "agentv.blocks"), { recursive: true });
  // Notes: the same page under another name, and not a game.
  cpSync(join(ROOT, "test/agentv/fixtures/apps/blocks"), join(appsDir, "agentv.notes"), { recursive: true });
  const notes = JSON.parse(readFileSync(join(appsDir, "agentv.notes/manifest.json"), "utf8"));
  writeFileSync(join(appsDir, "agentv.notes/manifest.json"), JSON.stringify({ ...notes, id: "agentv.notes", name: "Notes", tv: { ...notes.tv, category: "utility" } }));
  const installed = JSON.parse(readFileSync(join(appsDir, "installed.json"), "utf8"));
  installed["agentv.blocks"] = { id: "agentv.blocks", name: "Blocks", version: "1.0.0", tier: "official", installedAt: "2026-10-27T12:00:00Z" };
  installed["agentv.notes"] = { id: "agentv.notes", name: "Notes", version: "1.0.0", tier: "official", installedAt: "2026-10-27T12:00:00Z" };
  writeFileSync(join(appsDir, "installed.json"), JSON.stringify(installed, null, 2));
  const page = await home();
  // The services' Chromium, as far as opening and closing a page goes.
  const closed: string[] = [];
  const webCdp = {
    ...pipe(page),
    pages: async () => [{ targetId: "tube", url: "https://tube.example/" }],
    evaluateIn: async () => 0,
    close: async (target: string) => void closed.push(target),
  } as unknown as DevTools;
  const web = new StandInApp("web", 300, webCdp);
  const steam = new StandInApp("steam", 400);
  let locks = 0;
  let on = true;
  const t = await tv(page, () => on, {
    // What each app is, as the box's own daemon says.
    appTarget: async (id) => {
      const response = await fetch(`${url}/api/apps/${id}/launch`);
      return response.ok ? await response.json() : null;
    },
    web: () => web,
    steam: () => steam,
    // No PIN on this box, so nothing locks, and the daemon is asked as ever.
    lock: async () => {
      locks++;
      const response = await fetch(`${url}/api/pin/lock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "tv-off" }) });
      return ((await response.json()) as { locked?: boolean }).locked === true;
    },
  });
  const open = async () => ((await t.screen.handle({ cmd: "status" })) as { open: { id: string }[] }).open.map((o) => o.id);

  assert.deepEqual(await t.screen.fromHome({ cmd: "open-app", app: "agentv.tube" }), { ok: true });
  t.hypr.open("0xb", web.pid, "chromium");
  await sleep(150);
  await t.screen.idle();
  assert.equal(t.screen.front()?.role, "web");
  await t.screen.home();
  assert.deepEqual(await t.screen.fromHome({ cmd: "open-app", app: "agentv.games" }), { ok: true });
  t.hypr.open("0xf", steam.pid, "gamescope");
  await t.screen.idle();
  assert.equal(t.screen.front()?.role, "steam");
  await t.screen.home();
  // Notes, from its tile, and then home again: it waits behind home.
  assert.deepEqual(await t.screen.fromHome({ cmd: "open-app", app: "agentv.notes" }), { ok: true });
  await page.waitForSelector('.page-app.on[data-app="agentv.notes"]:not(.loading)', { timeout: 10_000 });
  await t.screen.home();
  await page.waitForSelector('.page-app[data-app="agentv.notes"]:not(.on)', { state: "attached" });
  // The game, from its tile: home's own frame, in front.
  assert.deepEqual(await t.screen.fromHome({ cmd: "open-app", app: "agentv.blocks" }), { ok: true });
  await page.waitForSelector('.page-app.on[data-app="agentv.blocks"]:not(.loading)', { timeout: 10_000 });
  const frame = page.frames().find((f) => f.url().includes("agentv.blocks.app.localhost"))!;
  await frame.evaluate(() => void ((window as unknown as { kept: string }).kept = "mid-level"));
  assert.equal(await page.evaluate(() => (window as unknown as { agentvGame: () => string | null }).agentvGame()), "agentv.blocks", "home says the game's in front");
  assert.deepEqual(await open(), ["agentv.tube", "agentv.games"]);

  on = false;
  await page.waitForFunction(() => (window as unknown as { tvHeard: string[] }).tvHeard.includes("off"), null, { timeout: 5000 });
  await sleep(900);
  await t.screen.idle();
  assert.deepEqual(closed, ["tube"], "the web app closed");
  assert.deepEqual(await open(), ["agentv.games"], "Steam is still open");
  assert.equal(steam.stopped, false);
  assert.equal(t.hypr.windows.some((w) => w.address === "0xf"), true, "with its window");
  assert.equal(locks, 1, "the lock is asked for, as before");
  assert.equal(t.hypr.dpms, false, "the output is off");
  assert.equal(await page.locator("#ambient.on").count(), 0, "no ambient screen over the game");
  assert.equal(await page.locator('.page-app.on[data-app="agentv.blocks"]').count(), 1, "the game is still in front");
  assert.equal(await page.locator('.page-app[data-app="agentv.notes"]').count(), 0, "the page app that isn't a game closed");
  assert.equal(page.frames().some((f) => f.url().includes("agentv.notes.app.localhost")), false, "with its page");

  on = true;
  await page.waitForFunction(() => (window as unknown as { tvHeard: string[] }).tvHeard.includes("on"), null, { timeout: 5000 });
  await t.screen.idle();
  assert.equal(t.hypr.dpms, true, "the output is on again");
  assert.equal(t.screen.front()?.role, "home");
  assert.equal(await page.locator("#ambient.on").count(), 0, "the TV is back on the game, not the ambient screen");
  assert.equal(await page.locator('.page-app.on[data-app="agentv.blocks"]').isVisible(), true);
  assert.equal(await frame.evaluate(() => (window as unknown as { kept: string }).kept), "mid-level", "the same page, as it was left");
  if (process.env.AGENTV_UI_SHOTS) await page.screenshot({ path: join(process.env.AGENTV_UI_SHOTS, "tv-back-on-game.png") });

  // Steam in front this time: it stays in front, with home behind it and
  // off its ambient screen.
  await t.screen.home();
  await t.screen.fromHome({ cmd: "open-app", app: "agentv.games" });
  assert.equal(t.screen.front()?.address, "0xf");
  on = false;
  await sleep(1000);
  await t.screen.idle();
  assert.equal(t.hypr.dpms, false);
  assert.equal(steam.stopped, false);
  assert.equal(t.screen.front()?.address, "0xf", "Steam is still in front");
  assert.equal(await page.locator("#ambient.on").count(), 0);
  on = true;
  await sleep(200);
  await t.screen.idle();
  assert.equal(t.hypr.dpms, true);
  assert.equal(t.screen.front()?.address, "0xf", "and the TV comes back on to it");
  assert.equal(t.hypr.windows.find((w) => w.address === "0xf")?.workspace.name, "1");
  assert.deepEqual(errors, []);
  t.screen.stop();
  await page.close();
});
