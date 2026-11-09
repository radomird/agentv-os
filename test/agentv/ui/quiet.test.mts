// A quiet TV when nobody's watching, in a real Chromium (ADR-019, layer 4;
// ADR-072, T13.1). The screen daemon itself runs on a stand-in Hyprland and
// drives home's real page, the way it does on the box over home's DevTools
// pipe. The terminal screensaver draws 30 frames a second and hands over to
// the slideshow after its time (shortened here). With the TV reported off,
// the screensaver gives way and never starts again, home hears it, and once
// the apps close the output is off. The TV's own power is the NUC's.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
const errors: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), "agentv-quiet-"));

before(async () => {
  ({ daemon, url } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  rmSync(scratch, { recursive: true, force: true });
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

// The screen daemon on that page, with the terminal screensaver picked in
// Settings and the TV's power as the test says.
async function tv(page: Page, tvOn: () => boolean) {
  const hypr = new StandInHyprland();
  const homeApp = new StandInApp("home", 100, pipe(page));
  const savers: StandInApp[] = [];
  const parts: Partial<Launcher> = {
    home: () => homeApp,
    screensaver: () => {
      const app = new StandInApp("screensaver", 200 + savers.length);
      savers.push(app);
      return app;
    },
    idleMinutes: async () => 10,
    ambientStyle: async () => "terminal",
    parent: () => null,
    profile: () => null,
    updating: async () => false,
    nightUpdates: async () => null,
  };
  // Everything else the launcher does is a quiet yes.
  const launcher = new Proxy(parts, {
    get: (target, name) => (name in target ? target[name as keyof Launcher] : name === "then" ? undefined : async () => undefined),
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
  return { hypr, screen, savers, lines };
}

test("T13.1 the terminal screensaver draws 30 frames a second, as the ambient screen runs it", async () => {
  // Omarchy as far as the screensaver uses it, with a ttfx that notes how
  // it was asked to draw.
  const omarchy = join(scratch, "omarchy");
  mkdirSync(join(omarchy, "bin"), { recursive: true });
  writeFileSync(join(omarchy, "bin", "omarchy-theme-osc"), "#!/bin/bash\n");
  writeFileSync(join(omarchy, "bin", "ttfx"), `#!/bin/bash\necho "$*" >>"${scratch}/ttfx.log"\nsleep 0.2\n`);
  chmodSync(join(omarchy, "bin", "omarchy-theme-osc"), 0o755);
  chmodSync(join(omarchy, "bin", "ttfx"), 0o755);
  writeFileSync(join(omarchy, "logo.txt"), "AGENTV\n");
  const saver = spawn(join(ROOT, "bin", "agentv-screensaver"), { env: { ...process.env, HOME: scratch, OMARCHY_PATH: omarchy }, stdio: ["pipe", "ignore", "ignore"] });
  await sleep(600);
  saver.stdin.write("x");
  await new Promise((resolve) => saver.on("exit", resolve));
  const runs = readFileSync(join(scratch, "ttfx.log"), "utf8").trim().split("\n");
  assert.ok(runs.length >= 2, "one effect after another");
  for (const run of runs) assert.match(run, /--frame-rate 30 /);
});

test("T13.1 after its time the screensaver hands over to the slideshow, and home stays on its ambient screen", async () => {
  const page = await home();
  const t = await tv(page, () => true);
  await t.screen.handle({ cmd: "screensaver-after", seconds: 0.5 });
  await t.screen.handle({ cmd: "idle-after", seconds: 0.1 });
  t.screen.seatIdle(true);
  await page.waitForSelector("#ambient.on .ambient-drift", { timeout: 5000 });
  await sleep(100);
  await t.screen.idle();
  assert.equal(t.savers.length, 1, "the terminal screensaver starts, as Settings picked");
  const saver = t.savers[0];
  t.hypr.open("0xc", saver.pid, "org.agentv.screensaver");
  await t.screen.idle();
  assert.equal(t.screen.front()?.role, "screensaver");
  await sleep(700);
  await t.screen.idle();
  assert.equal(saver.stopped, true, "it's stopped after its time");
  t.hypr.close("0xc");
  saver.exit();
  await t.screen.idle();
  assert.equal(t.screen.front()?.role, "home", "home is in front, with its slideshow");
  assert.equal(t.screen.ambient, true);
  assert.equal(await page.locator("#ambient.on").count(), 1, "the ambient screen is still up");
  assert.ok(t.lines.some((line) => line.startsWith("the terminal screensaver hands over to the slideshow")), t.lines.join("\n"));
  t.screen.stop();
  await page.close();
});

test("T13.1 with the TV reported off the screensaver gives way and never starts, home hears it, and the output goes off", async () => {
  const page = await home();
  let on = true;
  const t = await tv(page, () => on);
  await t.screen.handle({ cmd: "idle-after", seconds: 0.1 });
  t.screen.seatIdle(true);
  await page.waitForSelector("#ambient.on", { timeout: 5000 });
  await sleep(100);
  await t.screen.idle();
  const saver = t.savers[0];
  t.hypr.open("0xc", saver.pid, "org.agentv.screensaver");
  await t.screen.idle();

  on = false;
  await page.waitForFunction(() => (window as unknown as { tvHeard: string[] }).tvHeard.includes("off"), null, { timeout: 5000 });
  await t.screen.idle();
  assert.equal(saver.stopped, true, "the screensaver gives way at once");
  t.hypr.close("0xc");
  saver.exit();
  await t.screen.idle();
  assert.equal(t.screen.front()?.role, "home");
  // Once the apps close, nothing draws.
  await sleep(800);
  await t.screen.idle();
  assert.equal(t.hypr.dpms, false, "the output is off");
  assert.equal(((await t.screen.handle({ cmd: "status" })) as { output: string }).output, "off");
  assert.equal(await page.locator("#ambient.on").count(), 1, "home waits on its ambient screen");
  // Idle again with the TV off: still no screensaver.
  await t.screen.handle({ cmd: "ambient" });
  t.screen.seatIdle(true);
  await sleep(300);
  await t.screen.idle();
  assert.equal(t.savers.length, 1, "no screensaver for a TV that's off");

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
