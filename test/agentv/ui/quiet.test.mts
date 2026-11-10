// A quiet TV when nobody's watching, in a real Chromium (ADR-019, layer 4;
// ADR-072, T13.1, T17.1). The screen daemon itself runs on a stand-in
// Hyprland and drives home's real page, the way it does on the box over
// home's DevTools pipe. Idle shows home's own ambient screen, the one idle
// screen, with nothing else in front of it. With the TV reported off, home
// hears it, and once the apps close the output is off. The TV's own power
// is the NUC's.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { DevTools } from "../../../daemon/cdp.ts";
import type { Client, Hyprland, Layer, Monitor } from "../../../daemon/hyprland.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { HELD_WORKSPACE, Screen, type App, type Launcher, type Role } from "../../../daemon/screen.ts";
import { startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let browser: Browser;
let daemon: Daemon;
let url = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url } = await startBox());
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
async function tv(page: Page, tvOn: () => boolean) {
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
    const rows = await page.locator(".settings-panel .button > span:first-child").allInnerTexts();
    assert.ok(rows.includes("ambient screen after"), rows.join(", "));
    assert.ok(!rows.includes("ambient screen"), rows.join(", "));
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
