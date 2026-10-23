// Guards daemon/screen.ts, AgenTV's screen daemon (ADR-031), against a fake
// Hyprland that moves, focuses and closes windows the way the real one does.
// Run by screen-test.sh with Node's own test runner.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client, Hyprland, Layer, Monitor } from "../../../daemon/hyprland.ts";
import type { DevTools } from "../../../daemon/cdp.ts";
import { PAUSE, RESUME } from "../../../daemon/media.ts";
import { HELD_WORKSPACE, SERVICES_PROFILE, Screen, type App, type Launcher, type Role } from "../../../daemon/screen.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeHyprland implements Hyprland {
  windows: Client[] = [];
  dispatched: string[] = [];
  specialShown = false;
  active = "";
  exited = false;
  private handler: (name: string, data: string) => void = () => {};

  async clients() {
    return structuredClone(this.windows);
  }
  async monitors(): Promise<Monitor[]> {
    const special = this.specialShown ? HELD_WORKSPACE : "";
    return [{ name: "HDMI-A-1", width: 1920, height: 1080, refreshRate: 60, focused: true, specialWorkspace: { id: -98, name: special } }];
  }
  async layers(): Promise<Layer[]> {
    return [];
  }
  events(handler: (name: string, data: string) => void) {
    this.handler = handler;
  }

  async dispatch(expression: string) {
    this.dispatched.push(expression);
    let m;
    if ((m = expression.match(/^hl\.dsp\.window\.move\(\{ window = "address:(0x\w+)", workspace = "([^"]+)"/))) {
      const window = this.get(m[1]);
      window.workspace = { id: m[2] === "1" ? 1 : -98, name: m[2] };
      this.emit("movewindowv2", `${m[1].slice(2)},${window.workspace.id},${m[2]}`);
    } else if ((m = expression.match(/^hl\.dsp\.focus\(\{ window = "address:(0x\w+)"/))) {
      this.active = m[1];
    } else if ((m = expression.match(/^hl\.dsp\.window\.fullscreen_state\(\{ window = "address:(0x\w+)", internal = 2/))) {
      this.get(m[1]).fullscreen = 2;
    } else if ((m = expression.match(/^hl\.dsp\.window\.close\(\{ window = "address:(0x\w+)"/))) {
      this.close(m[1]);
    } else if ((m = expression.match(/^hl\.dsp\.workspace\.toggle_special\("([^"]+)"\)$/))) {
      this.specialShown = !this.specialShown;
      this.emit("activespecial", this.specialShown ? `special:${m[1]},HDMI-A-1` : ",HDMI-A-1");
    } else if (expression === "hl.dsp.exit()") {
      this.exited = true;
    } else {
      throw new Error(`the fake doesn't know ${expression}`);
    }
  }

  get(address: string): Client {
    const window = this.windows.find((w) => w.address === address);
    if (!window) throw new Error(`no window ${address}`);
    return window;
  }

  emit(name: string, data: string) {
    this.handler(name, data);
  }

  // A window opening, out of sight, as the TV session's window rule puts it.
  open(address: string, pid: number, cls = "chromium") {
    this.windows.push({
      address,
      pid,
      class: cls,
      initialClass: cls,
      title: cls,
      workspace: { id: -98, name: HELD_WORKSPACE },
      fullscreen: 0,
      mapped: true,
    });
    this.emit("openwindow", `${address.slice(2)},${HELD_WORKSPACE},${cls},${cls}`);
  }

  close(address: string) {
    this.windows = this.windows.filter((w) => w.address !== address);
    this.emit("closewindow", address.slice(2));
  }

  onTv(): string[] {
    return this.windows.filter((w) => w.workspace.name === "1").map((w) => w.address);
  }
}

// A Chromium's DevTools pipe: its pages, whether each plays, and what the
// daemon ran in them.
class FakeBrowser implements DevTools {
  pageList: { targetId: string; url: string }[] = [];
  playing = new Map<string, boolean>();
  heldByHome = new Set<string>();
  evaluated: string[] = [];
  closed: string[] = [];
  private next = 1;
  addPage(url: string): string {
    const targetId = `t${this.next++}`;
    this.pageList.push({ targetId, url });
    return targetId;
  }
  async bind() {}
  async evaluate(_prefix: string, expression: string) {
    this.evaluated.push(expression);
    return {};
  }
  async open(url: string) {
    return this.addPage(url);
  }
  async close(targetId: string) {
    this.closed.push(targetId);
    this.pageList = this.pageList.filter((p) => p.targetId !== targetId);
  }
  async pages() {
    return this.pageList;
  }
  async evaluateIn(targetId: string, expression: string) {
    if (expression === PAUSE && this.playing.get(targetId)) {
      this.playing.set(targetId, false);
      this.heldByHome.add(targetId);
      return 1;
    }
    if (expression === RESUME && this.heldByHome.delete(targetId)) {
      this.playing.set(targetId, true);
      return 1;
    }
    return 0;
  }
  target(url: string): string {
    const page = this.pageList.find((p) => p.url === url);
    if (!page) throw new Error(`no page at ${url}`);
    return page.targetId;
  }
}

class FakeApp implements App {
  role: Role;
  pid: number;
  startedAt = Date.now();
  stopped = false;
  cdp?: DevTools;
  private exits: Array<() => void> = [];
  constructor(role: Role, pid: number) {
    this.role = role;
    this.pid = pid;
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

class FakeLauncher implements Launcher {
  pid = 100;
  started: Array<{ role: Role; app: FakeApp; url?: string }> = [];
  parents = new Map<number, number>();
  profiles = new Map<number, string>();
  toasts: string[] = [];
  steamInstalled = true;
  browser = new FakeBrowser();
  homeBrowser = new FakeBrowser();

  async homeReady() {}
  private launch(role: Role, url?: string) {
    const app = new FakeApp(role, this.pid++);
    this.started.push({ role, app, url });
    return app;
  }
  home() {
    const app = this.launch("home");
    app.cdp = this.homeBrowser;
    return app;
  }
  web(url: string) {
    const app = this.launch("web", url);
    app.cdp = this.browser;
    this.browser.addPage(url);
    return app;
  }
  steam() {
    if (!this.steamInstalled) throw new Error("Steam isn't installed.");
    return this.launch("steam");
  }
  targets = new Map<string, { runtime: "web"; url: string } | { runtime: "native"; exec: string[] }>();
  desktops = 0;
  async appTarget(id: string) {
    return this.targets.get(id) ?? null;
  }
  desktop() {
    this.desktops++;
  }
  async toast(text: string) {
    this.toasts.push(text);
  }
  parent(pid: number) {
    return this.parents.get(pid) ?? null;
  }
  profile(pid: number) {
    return this.profiles.get(pid) ?? null;
  }
  last(role: Role): FakeApp {
    const found = this.started.filter((s) => s.role === role).pop();
    if (!found) throw new Error(`nothing started as ${role}`);
    return found.app;
  }
}

async function tv(options: { now?: () => number; backHoldMs?: number } = {}) {
  const hypr = new FakeHyprland();
  const launcher = new FakeLauncher();
  const lines: string[] = [];
  const screen = new Screen({ hyprland: hypr, launcher, log: (line) => lines.push(line), homeRestartMs: 10, ...options });
  await screen.start();
  await sleep(0);
  // The home screen's Chromium opens its window.
  hypr.open("0xa", launcher.last("home").pid);
  await screen.idle();
  return { hypr, launcher, screen, lines };
}

test("S1.1 the home screen starts with the session and comes in front, full screen and focused", async () => {
  const { hypr, screen } = await tv();
  assert.deepEqual(hypr.onTv(), ["0xa"]);
  assert.equal(hypr.get("0xa").fullscreen, 2);
  assert.equal(hypr.active, "0xa");
  assert.equal(screen.front()?.role, "home");
});

test("S1.6 a new window stays out of sight, and focus stays on the TV", async () => {
  const { hypr, screen } = await tv();
  hypr.open("0xb", 999, "foot");
  await screen.idle();
  assert.deepEqual(hypr.onTv(), ["0xa"]);
  assert.equal(hypr.get("0xb").workspace.name, HELD_WORKSPACE);
  assert.equal(hypr.active, "0xa");
});

test("S1.6 a window that grabs focus gets it taken back", async () => {
  const { hypr, screen } = await tv();
  hypr.open("0xb", 999, "foot");
  await screen.idle();
  hypr.active = "0xb";
  await sleep(150);
  hypr.emit("activewindowv2", "b");
  await screen.idle();
  assert.equal(hypr.active, "0xa");
});

test("S1.6 the workspace of windows out of sight is hidden again if something shows it", async () => {
  const { hypr, screen } = await tv();
  hypr.open("0xb", 999, "foot");
  await screen.idle();
  // Focusing a held window from outside shows its special workspace.
  hypr.specialShown = true;
  hypr.active = "0xb";
  hypr.emit("activespecial", `${HELD_WORKSPACE},HDMI-A-1`);
  await screen.idle();
  assert.equal(hypr.specialShown, false);
  assert.equal(hypr.active, "0xa");
  // Events that come late, after it's hidden, don't show it again.
  hypr.emit("activespecial", `${HELD_WORKSPACE},HDMI-A-1`);
  hypr.emit("activespecial", `${HELD_WORKSPACE},HDMI-A-1`);
  await screen.idle();
  assert.equal(hypr.specialShown, false);
  assert.equal(hypr.active, "0xa");
});

test("S1.6 focus on a window out of sight hides its workspace again, and goes back to the TV", async () => {
  const { hypr, screen } = await tv();
  hypr.open("0xb", 999, "foot");
  await screen.idle();
  await sleep(150);
  hypr.specialShown = true;
  hypr.active = "0xb";
  hypr.emit("activewindowv2", "b");
  await screen.idle();
  assert.equal(hypr.specialShown, false);
  assert.equal(hypr.active, "0xa");
});

test("S1.6 a window moved onto the TV from outside goes back out of sight", async () => {
  const { hypr, screen } = await tv();
  hypr.open("0xb", 999, "foot");
  await screen.idle();
  hypr.get("0xb").workspace = { id: 1, name: "1" };
  hypr.emit("movewindowv2", "b,1,1");
  await screen.idle();
  assert.deepEqual(hypr.onTv(), ["0xa"]);
  assert.equal(hypr.active, "0xa");
});

test("S1.6 a crashed home screen starts again and comes back in front", async () => {
  const { hypr, launcher, screen } = await tv();
  hypr.open("0xb", 999, "foot");
  await screen.idle();
  const first = launcher.last("home");
  hypr.close("0xa");
  first.exit();
  await screen.idle();
  // Nothing else takes the screen meanwhile.
  assert.deepEqual(hypr.onTv(), []);
  await sleep(50);
  const second = launcher.last("home");
  assert.notEqual(second.pid, first.pid);
  hypr.open("0xc", second.pid);
  await screen.idle();
  assert.deepEqual(hypr.onTv(), ["0xc"]);
  assert.equal(hypr.active, "0xc");
  assert.equal(screen.homeRestarts, 1);
});

test("a web app opens in front of the home screen, which goes out of sight", async () => {
  const { hypr, launcher, screen } = await tv();
  assert.deepEqual(await screen.handle({ cmd: "open", url: "https://example.org/" }), { ok: true });
  const web = launcher.last("web");
  hypr.open("0xd", web.pid);
  await screen.idle();
  assert.deepEqual(hypr.onTv(), ["0xd"]);
  assert.equal(hypr.get("0xa").workspace.name, HELD_WORKSPACE);
  assert.equal(screen.front()?.role, "web");
});

test("the app in front may bring its own window in front, such as a sign-in, and gets its first back after", async () => {
  const { hypr, launcher, screen } = await tv();
  await screen.handle({ cmd: "open", url: "https://example.org/" });
  const web = launcher.last("web");
  hypr.open("0xd", web.pid);
  await screen.idle();
  hypr.open("0xe", web.pid);
  await screen.idle();
  assert.deepEqual(hypr.onTv(), ["0xe"]);
  hypr.close("0xe");
  await screen.idle();
  assert.deepEqual(hypr.onTv(), ["0xd"]);
});

test("closing the app in front brings the home screen back", async () => {
  const { hypr, launcher, screen } = await tv();
  await screen.handle({ cmd: "open", url: "https://example.org/" });
  hypr.open("0xd", launcher.last("web").pid);
  await screen.idle();
  hypr.close("0xd");
  await screen.idle();
  assert.deepEqual(hypr.onTv(), ["0xa"]);
  assert.equal(hypr.active, "0xa");
});

test("home puts the home screen back in front of an app", async () => {
  const { hypr, launcher, screen } = await tv();
  await screen.handle({ cmd: "open", url: "https://example.org/" });
  hypr.open("0xd", launcher.last("web").pid);
  await screen.idle();
  assert.deepEqual(await screen.handle({ cmd: "home" }), { ok: true });
  assert.deepEqual(hypr.onTv(), ["0xa"]);
  assert.equal(hypr.get("0xd").workspace.name, HELD_WORKSPACE);
});

test("a home screen that restarts while an app is in front stays behind it", async () => {
  const { hypr, launcher, screen } = await tv();
  await screen.handle({ cmd: "open", url: "https://example.org/" });
  hypr.open("0xd", launcher.last("web").pid);
  await screen.idle();
  const first = launcher.last("home");
  hypr.close("0xa");
  first.exit();
  await sleep(50);
  hypr.open("0xc", launcher.last("home").pid);
  await screen.idle();
  assert.deepEqual(hypr.onTv(), ["0xd"]);
  assert.equal(hypr.get("0xc").workspace.name, HELD_WORKSPACE);
});

test("a window of the services' Chromium that the daemon didn't start is known by its profile", async () => {
  const { hypr, launcher, screen } = await tv();
  launcher.profiles.set(500, SERVICES_PROFILE);
  await screen.handle({ cmd: "open", url: "https://example.org/" });
  // The new process handed its window to the running browser and left.
  launcher.last("web").exit();
  hypr.open("0xd", 500);
  await screen.idle();
  assert.deepEqual(hypr.onTv(), ["0xd"]);
});

test("a window from a child process of an app belongs to that app", async () => {
  const { hypr, launcher, screen } = await tv();
  await screen.handle({ cmd: "open", app: "steam" });
  launcher.parents.set(700, launcher.last("steam").pid);
  hypr.open("0xf", 700, "gamescope");
  await screen.idle();
  assert.deepEqual(hypr.onTv(), ["0xf"]);
  assert.equal(screen.front()?.role, "steam");
});

test("Steam that isn't installed says so", async () => {
  const { launcher, screen } = await tv();
  launcher.steamInstalled = false;
  const answer = (await screen.handle({ cmd: "open", app: "steam" })) as { ok: boolean; error: string };
  assert.equal(answer.ok, false);
  assert.match(answer.error, /isn't installed/);
});

test("only web pages open on the TV", async () => {
  const { screen } = await tv();
  const answer = (await screen.handle({ cmd: "open", url: "file:///etc/passwd" })) as { ok: boolean };
  assert.equal(answer.ok, false);
});

test("a toast goes to the overlay", async () => {
  const { launcher, screen } = await tv();
  assert.deepEqual(await screen.handle({ cmd: "toast", text: "Hello" }), { ok: true });
  assert.deepEqual(launcher.toasts, ["Hello"]);
});

test("status says what's in front and where every window is", async () => {
  const { hypr, screen } = await tv();
  hypr.open("0xb", 999, "foot");
  await screen.idle();
  const status = (await screen.handle({ cmd: "status" })) as any;
  assert.equal(status.ok, true);
  assert.equal(status.front.role, "home");
  assert.equal(status.front.workspace, "1");
  const foot = status.windows.find((w: any) => w.class === "foot");
  assert.equal(foot.workspace, HELD_WORKSPACE);
  assert.equal(foot.front, false);
  assert.equal(status.monitors[0].refresh_rate, 60);
});

test("end closes every window, then ends Hyprland, and the home screen stays down", async () => {
  const { hypr, launcher, screen } = await tv();
  const home = launcher.last("home");
  assert.deepEqual(await screen.handle({ cmd: "end" }), { ok: true });
  assert.deepEqual(hypr.windows, []);
  home.exit();
  await sleep(400);
  assert.equal(hypr.exited, true);
  assert.equal(launcher.started.filter((s) => s.role === "home").length, 1);
});

test("an unknown request is refused", async () => {
  const { screen } = await tv();
  assert.equal(((await screen.handle({ cmd: "reboot" })) as { ok: boolean }).ok, false);
});

test("the home screen opens an installed web app the way its manifest says", async () => {
  const { hypr, launcher, screen } = await tv();
  launcher.targets.set("agentv.tube", { runtime: "web", url: "https://tube.example/" });
  assert.deepEqual(await screen.fromHome({ cmd: "open-app", app: "agentv.tube" }), { ok: true });
  const web = launcher.last("web");
  hypr.open("0xd", web.pid);
  await screen.idle();
  assert.equal(screen.front()?.role, "web");
  assert.deepEqual(await screen.fromHome({ cmd: "open-app", app: "agentv.nothing" }), { ok: false, error: "that app can't be opened yet" });
  launcher.targets.set("agentv.player", { runtime: "native", exec: ["player"] });
  assert.equal((await screen.fromHome({ cmd: "open-app", app: "agentv.player" }) as { ok: boolean }).ok, false);
});

test("the home screen's Settings → Omarchy desktop runs agentv desktop", async () => {
  const { launcher, screen } = await tv();
  assert.deepEqual(await screen.fromHome({ cmd: "desktop" }), { ok: true });
  assert.equal(launcher.desktops, 1);
  assert.equal((await screen.fromHome({ cmd: "rm" }) as { ok: boolean }).ok, false);
});

// --- Home and Back (ADR-031, stage 2) ----------------------------------------

// Opens an installed web app from the home screen, and its window.
async function openApp(t: Awaited<ReturnType<typeof tv>>, id: string, address: string): Promise<string> {
  const url = `https://${id}.example/`;
  t.launcher.targets.set(id, { runtime: "web", url });
  assert.deepEqual(await t.screen.fromHome({ cmd: "open-app", app: id }), { ok: true });
  await sleep(20);
  t.hypr.open(address, t.launcher.last("web").pid);
  await t.screen.idle();
  assert.equal(t.screen.front()?.address, address);
  return t.launcher.browser.target(url);
}

async function open(screen: Screen): Promise<any[]> {
  return ((await screen.handle({ cmd: "status" })) as any).open;
}

test("S2.15 Home pauses the app in front and shows home within 1 s; choosing it again plays it where it was", async () => {
  const t = await tv();
  const page = await openApp(t, "agentv.tube", "0xb");
  t.launcher.browser.playing.set(page, true);
  const started = Date.now();
  assert.deepEqual(await t.screen.handle({ cmd: "home" }), { ok: true });
  assert.ok(Date.now() - started < 1000);
  assert.equal(t.screen.front()?.role, "home");
  assert.equal(t.launcher.browser.playing.get(page), false);
  // Paused and out of sight, not closed.
  assert.equal(t.hypr.get("0xb").workspace.name, HELD_WORKSPACE);
  assert.deepEqual(await open(t.screen), [{ id: "agentv.tube", role: "web", paused: true, front: false }]);
  // The home screen hears about it, for the tile.
  assert.ok(t.launcher.homeBrowser.evaluated.some((e) => e.includes("agentvRunning") && e.includes("agentv.tube") && e.includes("paused\\\":true")));
  const before = t.launcher.started.length;
  assert.deepEqual(await t.screen.fromHome({ cmd: "open-app", app: "agentv.tube" }), { ok: true });
  assert.equal(t.screen.front()?.address, "0xb");
  assert.equal(t.launcher.browser.playing.get(page), true);
  // Nothing new started: the same window came back.
  assert.equal(t.launcher.started.length, before);
  assert.deepEqual(await open(t.screen), [{ id: "agentv.tube", role: "web", paused: false, front: true }]);
});

test("S2.15 Home leaves alone what the viewer paused, and it stays paused", async () => {
  const t = await tv();
  const page = await openApp(t, "agentv.tube", "0xb");
  t.launcher.browser.playing.set(page, false);
  await t.screen.home();
  await t.screen.fromHome({ cmd: "open-app", app: "agentv.tube" });
  assert.equal(t.launcher.browser.playing.get(page), false);
});

test("S2.15 up to two apps stay open, and a third closes the oldest", async () => {
  let clock = 1_000;
  const t = await tv({ now: () => clock });
  const tube = await openApp(t, "agentv.tube", "0xb");
  clock += 1000;
  await t.screen.home();
  clock += 1000;
  await openApp(t, "someone.radio", "0xc");
  clock += 1000;
  await t.screen.home();
  clock += 1000;
  // Tube was used longest ago.
  const mytv = await openApp(t, "local.mytv", "0xd");
  assert.deepEqual(t.launcher.browser.closed, [tube]);
  t.hypr.close("0xb");
  await t.screen.idle();
  assert.deepEqual((await open(t.screen)).map((o) => o.id), ["someone.radio", "local.mytv"]);
  // Choosing Radio again makes My TV the oldest, so it's the next to go.
  clock += 1000;
  await t.screen.home();
  clock += 1000;
  await t.screen.fromHome({ cmd: "open-app", app: "someone.radio" });
  clock += 1000;
  await t.screen.home();
  clock += 1000;
  await openApp(t, "agentv.sample", "0xe");
  assert.equal(t.launcher.browser.closed.length, 2);
  assert.equal(t.launcher.browser.closed[1], mytv);
});

test("S2.15 a game keeps running under home, with Quit, and doesn't count as one of the two", async () => {
  const t = await tv();
  t.launcher.targets.set("agentv.games", { runtime: "native", exec: ["steam", "-gamepadui"] });
  assert.deepEqual(await t.screen.fromHome({ cmd: "open-app", app: "agentv.games" }), { ok: true });
  const steam = t.launcher.last("steam");
  t.hypr.open("0xf", steam.pid, "gamescope");
  await t.screen.idle();
  assert.equal(t.screen.front()?.role, "steam");
  await t.screen.home();
  assert.equal(t.screen.front()?.role, "home");
  assert.equal(steam.stopped, false);
  assert.equal(t.hypr.get("0xf").workspace.name, HELD_WORKSPACE);
  assert.deepEqual(await t.screen.fromHome({ cmd: "running" }), { ok: true, apps: [{ id: "agentv.games", game: true, paused: false }] });
  // Two web apps open beside it, and nothing closes.
  await openApp(t, "agentv.tube", "0xb");
  await t.screen.home();
  await openApp(t, "someone.radio", "0xc");
  assert.deepEqual(t.launcher.browser.closed, []);
  // Choosing the game again brings it back; Quit closes it.
  await t.screen.home();
  await t.screen.fromHome({ cmd: "open-app", app: "agentv.games" });
  assert.equal(t.screen.front()?.address, "0xf");
  await t.screen.home();
  assert.deepEqual(await t.screen.fromHome({ cmd: "quit", app: "agentv.games" }), { ok: true });
  assert.equal(steam.stopped, true);
  assert.equal(t.hypr.windows.some((w) => w.address === "0xf"), false);
  assert.deepEqual((await open(t.screen)).map((o) => o.id), ["agentv.tube", "someone.radio"]);
  assert.equal(((await t.screen.fromHome({ cmd: "quit", app: "agentv.games" })) as { ok: boolean }).ok, false);
});

test("S2.16 holding Back for a second goes home; a tap stays with the app", async () => {
  const t = await tv({ backHoldMs: 80 });
  await openApp(t, "agentv.tube", "0xb");
  const now = Date.now();
  t.screen.back("down", now);
  t.screen.back("up", now + 30);
  await sleep(150);
  await t.screen.idle();
  assert.equal(t.screen.front()?.address, "0xb");
  // A release that arrives before its press still counts.
  t.screen.back("up", now + 230);
  t.screen.back("down", now + 200);
  await sleep(150);
  await t.screen.idle();
  assert.equal(t.screen.front()?.address, "0xb");
  // Held.
  t.screen.back("down", Date.now());
  await sleep(150);
  await t.screen.idle();
  assert.equal(t.screen.front()?.role, "home");
});

test("S2.16 the guide button is a game's own; on the home screen Home goes to its home page", async () => {
  const t = await tv();
  t.launcher.targets.set("agentv.games", { runtime: "native", exec: ["steam", "-gamepadui"] });
  await t.screen.fromHome({ cmd: "open-app", app: "agentv.games" });
  t.hypr.open("0xf", t.launcher.last("steam").pid, "gamescope");
  await t.screen.idle();
  await t.screen.handle({ cmd: "home", from: "guide" });
  assert.equal(t.screen.front()?.role, "steam");
  await t.screen.handle({ cmd: "home", from: "key" });
  assert.equal(t.screen.front()?.role, "home");
  await t.screen.handle({ cmd: "home" });
  assert.ok(t.launcher.homeBrowser.evaluated.includes("window.agentvHome?.()"));
});

test("a page the daemon opened by address comes back the same way", async () => {
  const t = await tv();
  assert.deepEqual(await t.screen.handle({ cmd: "open", url: "data:text/html,hello" }), { ok: true });
  await sleep(20);
  t.hypr.open("0xb", t.launcher.last("web").pid);
  await t.screen.idle();
  await t.screen.home();
  const before = t.launcher.started.length;
  await t.screen.handle({ cmd: "open", url: "data:text/html,hello" });
  assert.equal(t.screen.front()?.address, "0xb");
  assert.equal(t.launcher.started.length, before);
});
