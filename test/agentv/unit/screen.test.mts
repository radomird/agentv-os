// Guards daemon/screen.ts, AgenTV's screen daemon (ADR-031), against a fake
// Hyprland that moves, focuses and closes windows the way the real one does.
// Run by screen-test.sh with Node's own test runner.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client, Hyprland, Layer, Monitor } from "../../../daemon/hyprland.ts";
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

class FakeApp implements App {
  role: Role;
  pid: number;
  startedAt = Date.now();
  stopped = false;
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

  async homeReady() {}
  private launch(role: Role, url?: string) {
    const app = new FakeApp(role, this.pid++);
    this.started.push({ role, app, url });
    return app;
  }
  home() {
    return this.launch("home");
  }
  web(url: string) {
    return this.launch("web", url);
  }
  steam() {
    if (!this.steamInstalled) throw new Error("Steam isn't installed.");
    return this.launch("steam");
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

async function tv() {
  const hypr = new FakeHyprland();
  const launcher = new FakeLauncher();
  const lines: string[] = [];
  const screen = new Screen({ hyprland: hypr, launcher, log: (line) => lines.push(line), homeRestartMs: 10 });
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
