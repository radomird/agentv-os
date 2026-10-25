// Guards daemon/screen.ts, AgenTV's screen daemon (ADR-031), against a fake
// Hyprland that moves, focuses and closes windows the way the real one does.
// Run by screen-test.sh with Node's own test runner.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Client, Hyprland, Layer, Monitor } from "../../../daemon/hyprland.ts";
import type { DevTools } from "../../../daemon/cdp.ts";
import { PAUSE, RESUME } from "../../../daemon/media.ts";
import type { PageBroker } from "../../../daemon/apps/loader.ts";
import { HELD_WORKSPACE, HOME_UP, SERVICES_PROFILE, Screen, type App, type Launcher, type NightUpdates, type Playback,
  type SignIn, type Sound, type Role } from "../../../daemon/screen.ts";

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
    } else if ((m = expression.match(/^hl\.dsp\.window\.fullscreen_state\(\{ window = "address:(0x\w+)", internal = (\d)/))) {
      this.get(m[1]).fullscreen = Number(m[2]);
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
  // Whether the page has come up, for the screen daemon's check on home.
  up = true;
  closed: string[] = [];
  private next = 1;
  addPage(url: string): string {
    const targetId = `t${this.next++}`;
    this.pageList.push({ targetId, url });
    return targetId;
  }
  async bind() {}
  async evaluate(_prefix: string, expression: string) {
    if (expression === HOME_UP) return this.up;
    this.evaluated.push(expression);
    // The launcher's own go, for agentv screen settings.
    if (expression.includes("window.agentvLauncher?.go")) return { went: true };
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
    if (expression.includes("some((m) => !m.paused")) return this.playing.get(targetId) ?? false;
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
  corners: boolean[] = [];
  cornerFails = 0;
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
  targets = new Map<string, { runtime: "web"; url: string; name?: string } | { runtime: "native"; exec: string[] }>();
  bars: (string | null)[] = [];
  async signInBar(name: string | null) {
    this.bars.push(name);
  }
  desktops = 0;
  async appTarget(id: string) {
    return this.targets.get(id) ?? null;
  }
  desktop() {
    this.desktops++;
  }
  units: string[] = [];
  async startUnit(name: string) {
    this.units.push(name);
    return true;
  }
  // Settings → Power (ADR-033): whether an update runs, what the PIN says,
  // and what powering off was asked for.
  updateRunning = false;
  pinOk = true;
  pins: string[] = [];
  powered: string[] = [];
  powerWorks = true;
  async updating() {
    return this.updateRunning;
  }
  async pinCheck(action: string) {
    this.pins.push(action);
    return this.pinOk;
  }
  async power(what: "restart" | "shutdown") {
    this.powered.push(what);
    return this.powerWorks;
  }
  // What the daemon says about updates, for the night.
  night: NightUpdates | null = null;
  tonightCleared = 0;
  async nightUpdates() {
    return this.night;
  }
  async clearTonight() {
    this.tonightCleared++;
    if (this.night) this.night.tonight = null;
  }
  minutes: number | null = 10;
  async idleMinutes() {
    return this.minutes;
  }
  async toast(text: string) {
    this.toasts.push(text);
  }
  async corner(on: boolean) {
    if (this.cornerFails > 0) {
      this.cornerFails--;
      throw new Error("no overlay yet");
    }
    this.corners.push(on);
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

// Every screen a test made stops its timers at the end, even after a failure.
const screens: Screen[] = [];
after(() => {
  for (const screen of screens) screen.stop();
});

async function tv(
  options: {
    now?: () => number;
    backHoldMs?: number;
    tvPoll?: () => boolean | null;
    tvPollMs?: number;
    tvOffCloseMs?: number;
    idleReportMs?: number;
    ambientSettleMs?: number;
    homeCheckMs?: number;
    homeUp?: boolean;
    playback?: Playback;
    signIn?: SignIn;
    sound?: Sound;
    running?: string;
  } = {},
) {
  const { homeUp = true, ...rest } = options;
  const hypr = new FakeHyprland();
  const launcher = new FakeLauncher();
  launcher.homeBrowser.up = homeUp;
  const lines: string[] = [];
  const screen = new Screen({ hyprland: hypr, launcher, log: (line) => lines.push(line), homeRestartMs: 10, ...rest });
  screens.push(screen);
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

test("S1.1 home that comes up stays as it is", async () => {
  const { launcher, lines } = await tv({ homeCheckMs: 50 });
  await sleep(120);
  assert.equal(launcher.last("home").stopped, false);
  assert.ok(!lines.some((line) => /didn't come up/.test(line)), lines.join("\n"));
});

test("S1.1 home whose page doesn't come up starts again, so the TV isn't left blank", async () => {
  const { launcher, screen, lines } = await tv({ homeCheckMs: 50, homeUp: false });
  const first = launcher.last("home");
  await sleep(120);
  assert.equal(first.stopped, true);
  assert.ok(lines.some((line) => line === "the home screen's page didn't come up in 0 s; starting it again"), lines.join("\n"));
  // Its Chromium goes, and home starts again.
  launcher.homeBrowser.up = true;
  first.exit();
  await sleep(50);
  assert.notEqual(launcher.last("home"), first);
  assert.equal(screen.homeRestarts, 1);
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

test("the mouse's Home button is in the corner while an app is in front, and only then", async () => {
  const { hypr, launcher, screen, lines } = await tv();
  assert.deepEqual(launcher.corners, [false], "home is in front");
  await screen.handle({ cmd: "open", url: "https://example.org/" });
  hypr.open("0xd", launcher.last("web").pid);
  await screen.idle();
  assert.deepEqual(launcher.corners, [false, true]);
  // A second window of the app in front changes nothing.
  hypr.open("0xe", launcher.last("web").pid);
  await screen.idle();
  assert.deepEqual(launcher.corners, [false, true]);
  assert.deepEqual(await screen.handle({ cmd: "home" }), { ok: true });
  assert.deepEqual(launcher.corners, [false, true, false]);
  // An overlay that doesn't answer is told again at the next change.
  launcher.cornerFails = 1;
  await screen.handle({ cmd: "open", url: "https://example.org/b" });
  hypr.open("0xf", launcher.last("web").pid);
  await screen.idle();
  await sleep(10);
  assert.deepEqual(launcher.corners, [false, true, false]);
  assert.ok(lines.some((line) => line.startsWith("the corner's Home button: no overlay yet")), lines.join("\n"));
  assert.deepEqual(await screen.handle({ cmd: "home" }), { ok: true });
  assert.deepEqual(launcher.corners, [false, true, false, false]);
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

test("S3.3 an installed app's playback is watched while it's open, from its own page, and not a page opened by address", async () => {
  const opened: [string, PageBroker | undefined][] = [];
  const closed: string[] = [];
  const t = await tv({ playback: { opened: (id, page) => void opened.push([id, page]), closed: (id) => void closed.push(id) } });
  await openApp(t, "agentv.tube", "0xd");
  assert.deepEqual(opened.map(([id]) => id), ["agentv.tube"]);
  assert.ok(opened[0][1], "a web app gets its page");
  assert.deepEqual(await t.screen.quit("agentv.tube"), { ok: true });
  assert.deepEqual(closed, ["agentv.tube"]);
  assert.deepEqual(await t.screen.openWeb("https://elsewhere.example/"), { ok: true });
  assert.equal(opened.length, 1, "an address isn't an app with playback");
  // agentv screen app opens an installed app the way its tile does.
  t.launcher.targets.set("agentv.player", { runtime: "web", url: "https://player.example/" });
  assert.deepEqual(await t.screen.handle({ cmd: "app", app: "agentv.player" }), { ok: true });
  assert.deepEqual(opened.map(([id]) => id), ["agentv.tube", "agentv.player"]);
  // A window that closes by itself stops its app's watch too.
  t.hypr.open("0xe", t.launcher.last("web").pid);
  await t.screen.idle();
  t.hypr.close("0xe");
  await t.screen.idle();
  assert.deepEqual(closed, ["agentv.tube", "agentv.player"]);
});

test("S3.10 an item chosen on a tile opens the app, then the item through its playback.open", async () => {
  const played: [string, unknown][] = [];
  const t = await tv({ playback: { opened() {}, closed() {}, play: (id, item) => void played.push([id, item]) } });
  const item = { id: "ledger:1", kind: "film", title: "Spring" };
  t.launcher.targets.set("agentv.tube", { runtime: "web", url: "https://tube.example/" });
  assert.deepEqual(await t.screen.fromHome({ cmd: "open-app", app: "agentv.tube", item }), { ok: true });
  assert.deepEqual(played, [["agentv.tube", item]]);
  t.hypr.open("0xd", t.launcher.last("web").pid);
  await t.screen.idle();
  // Open behind home already, it comes back, then opens the item.
  await t.screen.home();
  assert.deepEqual(await t.screen.fromHome({ cmd: "open-app", app: "agentv.tube", item }), { ok: true });
  assert.equal(played.length, 2);
  // Without an item, nothing is played.
  await t.screen.home();
  await t.screen.fromHome({ cmd: "open-app", app: "agentv.tube" });
  assert.equal(played.length, 2);
});

// A stand-in for signin.ts: what it was asked, and its answers.
function fakeSignIn(answer: { now?: boolean | null; starts?: boolean } = {}) {
  const calls = {
    checked: [] as [string, PageBroker][],
    started: [] as string[],
    stopped: [] as string[],
    done: null as ((signedIn: boolean) => void) | null,
  };
  const signIn: SignIn = {
    async check(id, page) {
      calls.checked.push([id, page]);
      return true;
    },
    async start(id, _page, done) {
      calls.started.push(id);
      calls.done = done;
      return answer.starts ?? true;
    },
    async now() {
      return answer.now ?? null;
    },
    stop(id) {
      calls.stopped.push(id);
    },
  };
  return { signIn, calls };
}

test("ADR-032 a tile that says Sign in opens the app maximized over AgenTV's sign-in bar, until the app says it's signed in", async () => {
  const { signIn, calls } = fakeSignIn();
  const t = await tv({ signIn });
  t.launcher.targets.set("agentv.tube", { runtime: "web", url: "https://tube.example/", name: "Tube" });
  assert.deepEqual(await t.screen.fromHome({ cmd: "sign-in", app: "agentv.tube" }), { ok: true });
  assert.deepEqual(t.launcher.bars, ["Tube"]);
  assert.deepEqual(calls.started, ["agentv.tube"]);
  t.hypr.open("0xd", t.launcher.last("web").pid);
  await t.screen.idle();
  assert.equal(t.screen.front()?.address, "0xd");
  assert.equal(t.hypr.get("0xd").fullscreen, 1, "maximized, above the bar");
  // Opening it for a sign-in doesn't also ask it whether it's signed in.
  assert.deepEqual(calls.checked, []);
  calls.done!(true);
  await t.screen.idle();
  assert.deepEqual(t.launcher.bars, ["Tube", null]);
  assert.equal(t.hypr.get("0xd").fullscreen, 2, "full screen again once it's signed in");
  assert.deepEqual(t.launcher.toasts, ["signed in to tube"]);
});

test("ADR-032 Home or the app closing ends the sign-in screen, and i'm signed in asks the app now", async () => {
  const { signIn, calls } = fakeSignIn({ now: false });
  const t = await tv({ signIn });
  assert.deepEqual(await t.screen.handle({ cmd: "signed-in" }), { ok: false, error: "nothing is signing in" });
  t.launcher.targets.set("agentv.tube", { runtime: "web", url: "https://tube.example/", name: "Tube" });
  await t.screen.handle({ cmd: "sign-in", app: "agentv.tube" });
  t.hypr.open("0xd", t.launcher.last("web").pid);
  await t.screen.idle();
  assert.deepEqual(await t.screen.handle({ cmd: "signed-in" }), { ok: true, signedIn: false });
  assert.deepEqual(t.launcher.toasts, ["tube still says you're signed out"]);
  await t.screen.home();
  assert.deepEqual(calls.stopped, ["agentv.tube"]);
  assert.deepEqual(t.launcher.bars, ["Tube", null]);
  assert.equal(t.screen.front()?.role, "home");
  // Again, with the app open behind home: it comes back maximized.
  await t.screen.fromHome({ cmd: "sign-in", app: "agentv.tube" });
  await t.screen.idle();
  assert.equal(t.screen.front()?.address, "0xd");
  assert.equal(t.hypr.get("0xd").fullscreen, 1);
  t.hypr.close("0xd");
  await t.screen.idle();
  assert.deepEqual(calls.stopped, ["agentv.tube", "agentv.tube"]);
  assert.deepEqual(t.launcher.bars, ["Tube", null, "Tube", null]);
});

test("ADR-032 an installed web app is asked once as it opens whether it's signed in, and only a web app with signIn signs in", async () => {
  const { signIn, calls } = fakeSignIn({ starts: false });
  const t = await tv({ signIn });
  await openApp(t, "agentv.tube", "0xd");
  assert.deepEqual(calls.checked.map(([id]) => id), ["agentv.tube"]);
  assert.ok(calls.checked[0][1], "from its own page");
  await t.screen.openWeb("https://elsewhere.example/");
  assert.equal(calls.checked.length, 1, "not a page opened by address");
  t.launcher.targets.set("agentv.player", { runtime: "native", exec: ["player"] });
  assert.deepEqual(await t.screen.handle({ cmd: "sign-in", app: "agentv.player" }), { ok: false, error: "only a web app signs in on the tv" });
  // An app with no signIn can't say, so the bar goes again.
  assert.deepEqual(await t.screen.handle({ cmd: "sign-in", app: "agentv.tube" }), { ok: false, error: "that app can't tell whether it's signed in" });
  assert.deepEqual(t.launcher.bars, ["agentv.tube", null], "named by its id when the daemon gives no name");
  assert.equal(t.hypr.get("0xd").fullscreen, 2);
});

test("the home screen's Settings → Omarchy desktop runs agentv desktop", async () => {
  const { launcher, screen } = await tv();
  assert.deepEqual(await screen.fromHome({ cmd: "desktop" }), { ok: true });
  assert.equal(launcher.desktops, 1);
  assert.equal((await screen.fromHome({ cmd: "rm" }) as { ok: boolean }).ok, false);
});

test("S2.19 Settings → Sound and agentv screen audio reach the box's sound output", async () => {
  const asked: Record<string, unknown>[] = [];
  const sound: Sound = {
    async handle(request) {
      asked.push(request);
      if (request.volume === 2) throw new Error("pactl set-sink-volume: no such sink");
      return { ok: true, output: "hdmi", volume: request.volume ?? 1 };
    },
  };
  const { screen } = await tv({ sound });
  assert.deepEqual(await screen.fromHome({ cmd: "audio", volume: 0.6 }), { ok: true, output: "hdmi", volume: 0.6 });
  assert.deepEqual(await screen.handle({ cmd: "audio", output: "analog" }), { ok: true, output: "hdmi", volume: 1 });
  assert.deepEqual(await screen.handle({ cmd: "audio", volume: 2 }), { ok: false, error: "pactl set-sink-volume: no such sink" });
  assert.deepEqual(asked.map((r) => r.volume ?? r.output), [0.6, "analog", 2]);
  const { screen: none } = await tv();
  assert.deepEqual(await none.fromHome({ cmd: "audio" }), { ok: false, error: "sound isn't here" });
});

test("S2.18 Settings → Power restarts and shuts down through Omarchy's commands, past the PIN, never during an update", async () => {
  const { launcher, screen } = await tv();
  assert.deepEqual(await screen.fromHome({ cmd: "power", what: "restart" }), { ok: true });
  assert.deepEqual(await screen.fromHome({ cmd: "power", what: "shutdown" }), { ok: true });
  assert.deepEqual(launcher.powered, ["restart", "shutdown"]);
  assert.deepEqual(launcher.pins, ["power", "power"], "each asks agentv-pin-check first");
  // agentv screen power does the same, over SSH too.
  assert.deepEqual(await screen.handle({ cmd: "power", what: "restart" }), { ok: true });
  assert.deepEqual(await screen.handle({ cmd: "power", what: "off" }), { ok: false, error: "power restart or shutdown" });
  // Not while an update runs (ADR-025), and not past a PIN that says no.
  launcher.powered = [];
  launcher.updateRunning = true;
  assert.deepEqual(await screen.fromHome({ cmd: "power", what: "shutdown" }), { ok: false, error: "not while an update runs" });
  launcher.updateRunning = false;
  launcher.pinOk = false;
  assert.deepEqual(await screen.fromHome({ cmd: "power", what: "shutdown" }), { ok: false, error: "that needs the pin" });
  assert.deepEqual(launcher.powered, []);
  // When Omarchy's command couldn't start, the TV says so.
  launcher.pinOk = true;
  launcher.powerWorks = false;
  assert.deepEqual(await screen.fromHome({ cmd: "power", what: "restart" }), { ok: false, error: "the box couldn't restart" });
});

test("agentv screen status says which agentv this screen daemon runs, from when it started", async () => {
  const { screen } = await tv({ running: "0.3.0-99" });
  assert.equal(((await screen.handle({ cmd: "status" })) as { running?: string }).running, "0.3.0-99");
});

test("agentv screen settings opens Settings at a section on the home screen", async () => {
  const { launcher, screen } = await tv();
  assert.deepEqual(await screen.handle({ cmd: "settings", section: "power" }), { ok: true });
  assert.ok(launcher.homeBrowser.evaluated.includes("window.agentvHome?.()"), "home comes to the front first");
  assert.ok(launcher.homeBrowser.evaluated.some((e) => e.includes('go("settings/power")')));
  assert.deepEqual(await screen.handle({ cmd: "settings", section: "../x" }), { ok: false, error: "which section of settings" });
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
  assert.equal(t.hypr.windows.some((w) => w.address === "0xb"), false);
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

test("S2.16 a tap whose release read the clock a moment before its press is still a tap", async () => {
  // Hyprland starts agentv screen back down and back up as two processes at
  // almost the same moment, each reading the clock itself. A remote's or
  // the phone's tap is a press and a release back to back, so the release's
  // time can come out a few milliseconds before the press's, and either
  // can arrive first.
  const t = await tv({ backHoldMs: 80 });
  await openApp(t, "agentv.tube", "0xb");
  const now = Date.now();
  t.screen.back("down", now);
  t.screen.back("up", now - 3);
  await sleep(150);
  await t.screen.idle();
  assert.equal(t.screen.front()?.address, "0xb", "the release arrived second");
  t.screen.back("up", now + 197);
  t.screen.back("down", now + 200);
  await sleep(150);
  await t.screen.idle();
  assert.equal(t.screen.front()?.address, "0xb", "the release arrived first");
  // A release from long before doesn't end a new hold.
  t.screen.back("down", Date.now());
  t.screen.back("up", now + 197);
  await sleep(150);
  await t.screen.idle();
  assert.equal(t.screen.front()?.role, "home");
  assert.ok(t.lines.some((line) => line.startsWith("Back held")), t.lines.join("\n"));
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

// --- The ambient screen and TV off (ADR-031, stage 2) ------------------------

test("S2.17 with no input and nothing playing, the ambient screen starts, and the paused app stays open behind it", async () => {
  const t = await tv({ idleReportMs: 0 });
  // Settings' time, here a few hundred milliseconds.
  t.launcher.minutes = 0.003;
  const page = await openApp(t, "agentv.tube", "0xb");
  t.launcher.browser.playing.set(page, false);
  t.screen.seatIdle(true);
  await sleep(300);
  await t.screen.idle();
  assert.equal(t.screen.ambient, true);
  assert.equal(t.screen.front()?.role, "home");
  assert.ok(t.launcher.homeBrowser.evaluated.includes("window.agentvAmbient?.(true)"));
  assert.equal(t.hypr.get("0xb").workspace.name, HELD_WORKSPACE);
  assert.deepEqual((await open(t.screen)).map((o) => o.id), ["agentv.tube"]);
  // Any key: the film comes back where it was.
  assert.deepEqual(await t.screen.fromHome({ cmd: "wake" }), { ok: true });
  assert.equal(t.screen.ambient, false);
  assert.equal(t.screen.front()?.address, "0xb");
  assert.ok(t.launcher.homeBrowser.evaluated.includes("window.agentvAmbient?.(false)"));
});

test("S2.17 something playing, or input again, keeps the ambient screen away", async () => {
  const t = await tv({ idleReportMs: 0 });
  t.launcher.minutes = 0.003;
  const page = await openApp(t, "agentv.tube", "0xb");
  t.launcher.browser.playing.set(page, true);
  t.screen.seatIdle(true);
  await sleep(300);
  assert.equal(t.screen.ambient, false);
  t.launcher.browser.playing.set(page, false);
  t.screen.seatIdle(false);
  t.screen.seatIdle(true);
  t.screen.seatIdle(false);
  await sleep(300);
  assert.equal(t.screen.ambient, false);
  assert.equal(t.screen.front()?.address, "0xb");
  t.screen.stop();
});

test("S2.17 Settings changes the time, and a check can set its own", async () => {
  const t = await tv({ idleReportMs: 0 });
  t.launcher.minutes = 10;
  t.screen.seatIdle(true);
  await sleep(200);
  assert.equal(t.screen.ambient, false);
  t.screen.seatIdle(false);
  assert.deepEqual(await t.screen.handle({ cmd: "idle-after", seconds: 0.1 }), { ok: true });
  t.screen.seatIdle(true);
  await sleep(250);
  await t.screen.idle();
  assert.equal(t.screen.ambient, true);
  t.screen.stop();
});

test("S2.8 with the TV off, playback pauses at once, every app closes after a while, and home waits on its ambient screen", async () => {
  let on = true;
  const t = await tv({ tvPoll: () => on, tvPollMs: 20, tvOffCloseMs: 200 });
  const page = await openApp(t, "agentv.tube", "0xb");
  t.launcher.browser.playing.set(page, true);
  on = false;
  await sleep(80);
  await t.screen.idle();
  assert.equal(t.launcher.browser.playing.get(page), false, "paused at once");
  assert.equal(t.launcher.browser.closed.length, 0, "not closed yet");
  await sleep(250);
  await t.screen.idle();
  assert.deepEqual(t.launcher.browser.closed, [page]);
  assert.equal(t.screen.ambient, true);
  assert.equal(t.screen.front()?.role, "home");
  // S2.9: the TV comes back on the ambient screen, and a key goes home.
  on = true;
  await sleep(60);
  await t.screen.idle();
  assert.equal(((await t.screen.handle({ cmd: "status" })) as any).tv, "on");
  assert.equal(t.screen.ambient, true);
  await t.screen.fromHome({ cmd: "wake" });
  assert.equal(t.screen.ambient, false);
  assert.equal(t.screen.front()?.role, "home");
  t.screen.stop();
});

test("S2.8 a TV back on within two minutes keeps the paused app open", async () => {
  let on = true;
  const t = await tv({ tvPoll: () => on, tvPollMs: 20, tvOffCloseMs: 300 });
  const page = await openApp(t, "agentv.tube", "0xb");
  t.launcher.browser.playing.set(page, true);
  on = false;
  await sleep(80);
  on = true;
  await sleep(400);
  await t.screen.idle();
  assert.deepEqual(t.launcher.browser.closed, []);
  assert.equal(t.screen.ambient, false);
  assert.equal(t.screen.front()?.address, "0xb");
  assert.deepEqual(await open(t.screen), [{ id: "agentv.tube", role: "web", paused: true, front: true }]);
  t.screen.stop();
});

test("agentv screen tv off and on do the same, for a box that can't tell", async () => {
  const t = await tv({ tvOffCloseMs: 100 });
  await openApp(t, "agentv.tube", "0xb");
  assert.deepEqual(await t.screen.handle({ cmd: "tv", on: false }), { ok: true });
  await sleep(200);
  await t.screen.idle();
  assert.equal(t.screen.ambient, true);
  assert.deepEqual(await t.screen.handle({ cmd: "tv", on: true }), { ok: true });
  assert.equal(((await t.screen.handle({ cmd: "tv" })) as { ok: boolean }).ok, false);
});

test("S2.17 no ambient screen during setup, and input on the seat ends one", async () => {
  const t = await tv({ idleReportMs: 0, ambientSettleMs: 50 });
  t.launcher.minutes = null;
  assert.deepEqual(await t.screen.handle({ cmd: "idle-after", seconds: 0.05 }), { ok: true });
  t.screen.seatIdle(true);
  await sleep(150);
  assert.equal(t.screen.ambient, false);
  t.launcher.minutes = 10;
  await openApp(t, "agentv.tube", "0xb");
  await t.screen.handle({ cmd: "ambient" });
  assert.equal(t.screen.ambient, true);
  // Bringing home to the front counts as input on the seat, at once (as on
  // an installed box): that doesn't end it.
  t.screen.seatIdle(false);
  await sleep(20);
  await t.screen.idle();
  assert.equal(t.screen.ambient, true);
  assert.ok(t.lines.includes("input as the ambient screen came up; it stays"), t.lines.join("\n"));
  // Input after that does.
  await sleep(60);
  t.screen.seatIdle(true);
  t.screen.seatIdle(false);
  await sleep(20);
  await t.screen.idle();
  assert.equal(t.screen.ambient, false);
  assert.equal(t.screen.front()?.address, "0xb");
});

test("S2.12 Settings → Updates checks and installs through the update units", async () => {
  const t = await tv();
  assert.deepEqual(await t.screen.fromHome({ cmd: "update-check" }), { ok: true });
  assert.deepEqual(await t.screen.fromHome({ cmd: "update-install" }), { ok: true });
  assert.deepEqual(t.launcher.units, ["agentv-update-check.service", "agentv-update-tv.service"]);
  // agentv screen update check|install does the same, over SSH too.
  assert.deepEqual(await t.screen.handle({ cmd: "update", what: "install" }), { ok: true });
  assert.equal(((await t.screen.handle({ cmd: "update", what: "rm" })) as { ok: boolean }).ok, false);
  assert.equal(t.launcher.units.length, 3);
});

test("S2.14 Go back goes through its unit, from home and over SSH", async () => {
  const t = await tv();
  assert.deepEqual(await t.screen.fromHome({ cmd: "update-go-back" }), { ok: true });
  assert.deepEqual(await t.screen.handle({ cmd: "update", what: "go-back" }), { ok: true });
  assert.deepEqual(t.launcher.units, ["agentv-go-back.service", "agentv-go-back.service"]);
});

// The box's clock, at a time of day today.
function at(hours: number, minutes = 0): number {
  const day = new Date();
  day.setHours(hours, minutes, 0, 0);
  return day.getTime();
}

const READY = { agentv: { installed: "0.2.1-1", available: "0.3.0-1" }, omarchy: { installed: "4.0.6-1", available: null }, packages: 3, waiting: false };

test("S2.12 Tonight installs between 02:00 and 05:00, after checking, once nothing has played for 30 minutes", async () => {
  let clock = at(1, 20);
  const t = await tv({ now: () => clock });
  t.launcher.night = { status: { ...READY, checked_at: new Date(at(1, 0)).toISOString() }, progress: null, tonight: { version: "0.3.0-1" }, overnight: false };
  // Before 02:00, nothing.
  clock = at(1, 50);
  await t.screen.night();
  assert.deepEqual(t.launcher.units, []);
  // At 02:00 it checks first, and installs once that check has answered.
  clock = at(2, 0);
  await t.screen.night();
  assert.deepEqual(t.launcher.units, ["agentv-update-check.service"]);
  clock = at(2, 1);
  await t.screen.night();
  assert.deepEqual(t.launcher.units, ["agentv-update-check.service"], "the check hasn't answered yet");
  t.launcher.night!.status.checked_at = new Date(at(2, 1)).toISOString();
  clock = at(2, 2);
  await t.screen.night();
  assert.deepEqual(t.launcher.units, ["agentv-update-check.service", "agentv-update-tv.service"]);
  assert.equal(t.launcher.tonightCleared, 1, "tonight is done with once it starts");
  assert.ok(t.lines.some((line) => line === "night: installing the update, nothing has played for 42 min"), t.lines.join("\n"));
  // Asked for once: the next night, nothing.
  t.launcher.units = [];
  clock = at(2, 30) + 86_400_000;
  await t.screen.night();
  await t.screen.night();
  assert.deepEqual(t.launcher.units, []);
});

test("S2.12 something playing holds the night's update off, and so do the hours outside 02:00 to 05:00", async () => {
  let clock = at(2, 0);
  const t = await tv({ now: () => clock });
  t.launcher.night = { status: { ...READY }, progress: null, tonight: null, overnight: true };
  const target = await openApp(t, "agentv.tube", "0xb");
  t.launcher.browser.playing.set(target, true);
  await t.screen.night();
  assert.deepEqual(t.launcher.units, ["agentv-update-check.service"], "overnight checks too");
  clock = at(2, 40);
  await t.screen.night();
  assert.deepEqual(t.launcher.units, ["agentv-update-check.service"], "a film playing at 02:40 holds it off");
  t.launcher.browser.playing.set(target, false);
  clock = at(3, 5);
  await t.screen.night();
  assert.deepEqual(t.launcher.units, ["agentv-update-check.service"], "only 25 quiet minutes");
  clock = at(5, 0);
  await t.screen.night();
  assert.deepEqual(t.launcher.units, ["agentv-update-check.service"], "05:00 is too late");
});

test("S2.12 at night, nothing installs without Tonight or overnight, while waiting for the nightly run, or with nothing new", async () => {
  let clock = at(1, 0);
  const t = await tv({ now: () => clock });
  clock = at(3, 0);
  // What the night's check says, half a minute after it starts.
  const answered = new Date(at(3, 0) + 30_000).toISOString();
  t.launcher.night = { status: { ...READY, checked_at: answered }, progress: null, tonight: null, overnight: false };
  await t.screen.night();
  await t.screen.night();
  assert.deepEqual(t.launcher.units, [], "neither asked for");
  t.launcher.night = { status: { ...READY, waiting: true, checked_at: answered }, progress: null, tonight: { version: "0.3.0-1" }, overnight: false };
  await t.screen.night();
  await t.screen.night();
  assert.deepEqual(t.launcher.units, ["agentv-update-check.service"], "on stable, an update the nightly run hasn't passed waits");
  assert.equal(t.launcher.tonightCleared, 0, "and stays asked for");
  // Nothing new.
  t.launcher.night = { status: { agentv: { installed: "0.3.0-1", available: null }, omarchy: { installed: "4.0.6-1", available: null }, packages: 0, checked_at: answered }, progress: null, tonight: { version: "0.3.0-1" }, overnight: false };
  await t.screen.night();
  assert.equal(t.launcher.tonightCleared, 1, "with nothing to install, tonight is done with");
  t.launcher.night = { status: { ...READY, checked_at: answered }, progress: { state: "running" }, tonight: null, overnight: true };
  await t.screen.night();
  assert.deepEqual(t.launcher.units, ["agentv-update-check.service"], "not while an install runs");
});
