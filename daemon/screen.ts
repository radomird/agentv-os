// AgenTV's screen daemon (ADR-031): it decides what's on the TV.
//
// The TV session's Hyprland (session/hypr.lua) opens every window out of
// sight, on a special workspace that's never shown. This daemon brings the
// one it wants to workspace 1, full screen and focused, and sends whatever
// was there back out of sight. A window comes to the front only when:
//   - the daemon is waiting for that app, because it just opened it;
//   - the app already in front opened it, such as a sign-in window;
//   - it's the home screen, and nothing else is in front.
// Anything else stays out of sight, and focus always goes back to the window
// in front.
//
// It also starts the home screen, the session's main app, in a Chromium of
// its own (/var/lib/agentv/chromium-home, ADR-030's kiosk app window), and
// starts it again when it stops. Web apps open in the services' Chromium
// (/var/lib/agentv/chromium, with Widevine and the sign-ins), and Steam in a
// gamescope of its own.
//
// Home and Back, up to two apps kept open, the ambient screen and the TV-off
// policy come in stage 2, on top of this.
//
// Run by agentv-screen.service in the TV session. Other commands talk to it
// over $XDG_RUNTIME_DIR/agentv/screen.sock, one JSON request and one JSON
// answer per connection (daemon/screen-call.ts, agentv screen).

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { CdpPipe } from "./cdp.ts";
import { connect, lua, type Client, type Hyprland } from "./hyprland.ts";

export type Role = "home" | "web" | "steam";

export const TV_WORKSPACE = "1";
export const HELD_WORKSPACE = "special:agentv-held";
export const HOME_URL = "http://127.0.0.1:3000/";
export const HOME_PROFILE = "/var/lib/agentv/chromium-home";
export const SERVICES_PROFILE = "/var/lib/agentv/chromium";

// A process the daemon started.
export interface App {
  role: Role;
  pid: number;
  startedAt: number;
  cdp?: CdpPipe;
  stop(): void;
  onExit(callback: () => void): void;
}

export interface MonitorMode {
  width: number;
  height: number;
  refreshRate: number;
}

export interface Launcher {
  // Resolves once the home screen's page answers, or after a while anyway.
  homeReady(): Promise<void>;
  home(): App;
  // A new process each time. When the services' Chromium is already
  // running, it hands the window to that one and exits.
  web(url: string): App;
  steam(mode: MonitorMode): App;
  toast(text: string): Promise<void>;
  // The parent of a process, or null.
  parent(pid: number): number | null;
  // The Chromium profile a process runs, or null.
  profile(pid: number): string | null;
}

interface Window {
  address: string;
  pid: number;
  role: Role | null;
  class: string;
  title: string;
}

interface Options {
  hyprland: Hyprland;
  launcher: Launcher;
  now?: () => number;
  log?: (line: string) => void;
  homeRestartMs?: number;
}

export class Screen {
  private hypr: Hyprland;
  private launcher: Launcher;
  private now: () => number;
  private log: (line: string) => void;
  private windows = new Map<string, Window>();
  // Windows that have been in front, the one in front last.
  private stack: string[] = [];
  private apps = new Map<Role, App>();
  private want: { role: Role; until: number } | null = null;
  private ending = false;
  private chain: Promise<void> = Promise.resolve();
  private homeRestartMs: number;
  private homeDelay: number;
  private homeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRefocus = 0;
  private homeStarting = false;
  homeRestarts = 0;

  constructor(options: Options) {
    this.hypr = options.hyprland;
    this.launcher = options.launcher;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(line));
    this.homeRestartMs = options.homeRestartMs ?? 500;
    this.homeDelay = this.homeRestartMs;
  }

  // Runs one step at a time, in the order things happened.
  private queue(step: () => Promise<void>): Promise<void> {
    const next = this.chain.then(step).catch((error) => this.log(`error: ${error.message}`));
    this.chain = next;
    return next;
  }

  idle(): Promise<void> {
    return this.chain;
  }

  async start(onGone: () => void = () => {}): Promise<void> {
    this.hypr.events((name, data) => this.event(name, data), onGone);
    await this.queue(async () => {
      for (const client of await this.hypr.clients()) {
        this.remember(client);
      }
      const home = [...this.windows.values()].find((w) => w.role === "home");
      if (home) {
        await this.toFront(home.address);
      }
    });
    this.startHome();
  }

  event(name: string, data: string): void {
    const address = normalize(data.split(",")[0]);
    switch (name) {
      case "openwindow":
        this.queue(() => this.opened(address));
        break;
      case "closewindow":
        this.queue(() => this.closed(address));
        break;
      case "activewindowv2":
        this.queue(() => this.activated(address));
        break;
      case "movewindowv2":
        this.queue(() => this.moved(address, data.split(",")[2] ?? ""));
        break;
      case "activespecial":
        if (data.split(",")[0] === HELD_WORKSPACE) {
          this.queue(() => this.hideHeld());
        }
        break;
      case "fullscreen":
        if (data === "0") {
          this.queue(() => this.keepFullscreen());
        }
        break;
    }
  }

  // --- What the windows are -------------------------------------------------

  roleOf(pid: number): Role | null {
    let current: number | null = pid;
    for (let depth = 0; current && depth < 10; depth++) {
      for (const app of this.apps.values()) {
        if (app.pid === current) {
          return app.role;
        }
      }
      current = this.launcher.parent(current);
    }
    // A services' Chromium that was already running when a web app opened,
    // or one from before the daemon restarted, is known by its profile.
    const profile = this.launcher.profile(pid);
    if (profile === HOME_PROFILE) return "home";
    if (profile === SERVICES_PROFILE) return "web";
    return null;
  }

  private remember(client: Client): Window {
    const window: Window = {
      address: client.address,
      pid: client.pid,
      role: this.roleOf(client.pid),
      class: client.class,
      title: client.title,
    };
    this.windows.set(client.address, window);
    return window;
  }

  front(): Window | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const window = this.windows.get(this.stack[i]);
      if (window) return window;
    }
    return null;
  }

  private homeWindow(): Window | null {
    const homes = [...this.windows.values()].filter((w) => w.role === "home");
    return homes[homes.length - 1] ?? null;
  }

  // --- Events ---------------------------------------------------------------

  private async opened(address: string): Promise<void> {
    const client = (await this.hypr.clients()).find((c) => c.address === address);
    if (!client) return;
    const window = this.remember(client);
    const front = this.front();
    const wanted = this.want && window.role === this.want.role && this.now() <= this.want.until;

    if (wanted || (window.role && front?.role === window.role) || (window.role === "home" && !front)) {
      if (wanted) this.want = null;
      this.log(`in front: ${describe(window)}`);
      await this.toFront(address);
      return;
    }

    this.log(`kept out of sight: ${describe(window)}`);
    if (client.workspace.name !== HELD_WORKSPACE) {
      await this.hold(address);
    }
    // A window that opens takes focus unless it's told not to; keep it on
    // the one in front.
    if (front) await this.focus(front.address);
  }

  private async closed(address: string): Promise<void> {
    const window = this.windows.get(address);
    const wasFront = this.front()?.address === address;
    this.windows.delete(address);
    this.stack = this.stack.filter((a) => a !== address);
    if (!window || !wasFront || this.ending) return;

    // Another window of the same app, such as the one a sign-in window
    // opened from, comes back. Otherwise the home screen does.
    const same = [...this.stack].reverse().map((a) => this.windows.get(a)).find((w) => w && w.role === window.role);
    if (same && window.role !== "home") {
      await this.toFront(same.address);
      return;
    }
    const home = this.homeWindow();
    if (home && window.role !== "home") {
      await this.toFront(home.address);
    } else {
      // The home screen itself went; it comes back in front when it's
      // started again.
      this.want = { role: "home", until: Infinity };
    }
  }

  private async activated(address: string): Promise<void> {
    const front = this.front();
    if (!front || this.ending || address === front.address) return;
    // Something else got focus. Give it back, but don't fight in a loop.
    if (this.now() - this.lastRefocus < 100) return;
    this.lastRefocus = this.now();
    this.log(`focus went to ${address}; back to ${describe(front)}`);
    // Focusing a window out of sight shows its workspace too.
    await this.hideHeld();
  }

  private async moved(address: string, workspace: string): Promise<void> {
    const front = this.front();
    if (workspace === TV_WORKSPACE && address !== front?.address && this.windows.has(address)) {
      this.log(`moved onto the TV without the daemon: ${address}; out of sight again`);
      await this.hold(address);
      if (front) await this.focus(front.address);
    }
  }

  // The windows out of sight are on a special workspace, which Hyprland
  // shows over the TV if something focuses one of them. Hide it again, and
  // put focus back on the window in front. Hyprland only has a toggle, so
  // it looks first: one event too many must not show it again.
  private async hideHeld(): Promise<void> {
    for (const monitor of await this.hypr.monitors()) {
      if (monitor.specialWorkspace?.name === HELD_WORKSPACE) {
        this.log(`the workspace of windows out of sight was shown on ${monitor.name}; hiding it again`);
        await this.hypr.dispatch(`hl.dsp.workspace.toggle_special(${lua(HELD_WORKSPACE.slice("special:".length))})`);
      }
    }
    const front = this.front();
    if (front && !this.ending) await this.focus(front.address);
  }

  private async keepFullscreen(): Promise<void> {
    const front = this.front();
    if (front && !this.ending) await this.fullscreen(front.address);
  }

  // --- Hyprland -------------------------------------------------------------

  private async toFront(address: string): Promise<void> {
    const window = lua(`address:${address}`);
    await this.hypr.dispatch(`hl.dsp.window.move({ window = ${window}, workspace = ${lua(TV_WORKSPACE)}, follow = false })`);
    await this.focus(address);
    await this.fullscreen(address);
    // Whatever else is on the TV goes out of sight, after the new one is
    // covering it.
    for (const client of await this.hypr.clients()) {
      if (client.address !== address && client.workspace.name === TV_WORKSPACE) {
        await this.hold(client.address);
      }
    }
    this.stack = this.stack.filter((a) => a !== address);
    this.stack.push(address);
  }

  private hold(address: string): Promise<void> {
    return this.hypr.dispatch(
      `hl.dsp.window.move({ window = ${lua(`address:${address}`)}, workspace = ${lua(HELD_WORKSPACE)}, follow = false })`,
    );
  }

  private focus(address: string): Promise<void> {
    return this.hypr.dispatch(`hl.dsp.focus({ window = ${lua(`address:${address}`)} })`);
  }

  private fullscreen(address: string): Promise<void> {
    return this.hypr.dispatch(
      `hl.dsp.window.fullscreen_state({ window = ${lua(`address:${address}`)}, internal = 2, client = 2, action = "set" })`,
    );
  }

  // --- The apps -------------------------------------------------------------

  // Waits for the home screen's page first, so the TV never shows a page
  // that couldn't load.
  startHome(): void {
    if (this.ending || this.apps.has("home") || this.homeStarting) return;
    this.homeStarting = true;
    this.launcher.homeReady().finally(() => {
      this.homeStarting = false;
      this.launchHome();
    });
  }

  private launchHome(): void {
    if (this.ending || this.apps.has("home")) return;
    const app = this.launcher.home();
    this.apps.set("home", app);
    const front = this.front();
    if (!front || front.role === "home") {
      this.want = { role: "home", until: Infinity };
    }
    this.log(`started the home screen (pid ${app.pid})`);
    app.onExit(() => {
      if (this.apps.get("home") === app) this.apps.delete("home");
      if (this.ending) return;
      const ran = this.now() - app.startedAt;
      this.homeDelay = ran > 60_000 ? this.homeRestartMs : Math.min(this.homeDelay * 2, 30_000);
      this.homeRestarts++;
      this.log(`the home screen stopped after ${Math.round(ran / 1000)} s; starting it again in ${this.homeDelay} ms`);
      this.homeTimer = setTimeout(() => {
        this.homeTimer = null;
        this.startHome();
      }, this.homeDelay);
    });
  }

  home(): Promise<object> {
    return this.queue(async () => {
      const home = this.homeWindow();
      if (home) {
        await this.toFront(home.address);
      } else {
        this.want = { role: "home", until: Infinity };
        this.startHome();
      }
    }).then(() => ({ ok: true }));
  }

  openWeb(url: string): Promise<object> {
    if (!/^(https?|data):/.test(url)) {
      return Promise.resolve({ ok: false, error: "only http, https and data URLs open on the TV" });
    }
    return this.queue(async () => {
      const app = this.launcher.web(url);
      this.want = { role: "web", until: this.now() + 30_000 };
      const running = this.apps.get("web");
      if (!running) {
        this.apps.set("web", app);
        app.onExit(() => {
          if (this.apps.get("web") === app) this.apps.delete("web");
        });
      }
      this.log(`opening ${url} in the services' Chromium`);
    }).then(() => ({ ok: true }));
  }

  openSteam(): Promise<object> {
    let result: object = { ok: true };
    return this.queue(async () => {
      const running = [...this.windows.values()].filter((w) => w.role === "steam").pop();
      if (running) {
        await this.toFront(running.address);
        return;
      }
      if (this.apps.has("steam")) {
        this.want = { role: "steam", until: this.now() + 120_000 };
        return;
      }
      const monitor = (await this.hypr.monitors()).find((m) => m.focused) ?? (await this.hypr.monitors())[0];
      if (!monitor) {
        result = { ok: false, error: "no screen to show Steam on" };
        return;
      }
      try {
        const app = this.launcher.steam(monitor);
        this.apps.set("steam", app);
        app.onExit(() => {
          if (this.apps.get("steam") === app) this.apps.delete("steam");
        });
        this.want = { role: "steam", until: this.now() + 120_000 };
        this.log(`started Steam in its gamescope (pid ${app.pid})`);
      } catch (error) {
        result = { ok: false, error: (error as Error).message };
      }
    }).then(() => result);
  }

  close(role: Role): Promise<object> {
    return this.queue(async () => {
      for (const window of [...this.windows.values()].filter((w) => w.role === role)) {
        await this.hypr.dispatch(`hl.dsp.window.close({ window = ${lua(`address:${window.address}`)} })`);
      }
      if (role === "steam") this.apps.get("steam")?.stop();
    }).then(() => ({ ok: true }));
  }

  // Closes every window and ends the TV session, for the switch to
  // Omarchy's desktop (agentv desktop). The login manager logs back in.
  end(): Promise<object> {
    return this.queue(async () => {
      this.ending = true;
      if (this.homeTimer) clearTimeout(this.homeTimer);
      for (const window of this.windows.values()) {
        await this.hypr.dispatch(`hl.dsp.window.close({ window = ${lua(`address:${window.address}`)} })`).catch(() => {});
      }
      // Give Chromium a moment to save its profile, then go.
      const deadline = this.now() + 3000;
      while (this.now() < deadline && (await this.hypr.clients()).length > 0) {
        await sleep(100);
      }
      for (const app of this.apps.values()) app.stop();
      // After the answer has gone back: the daemon stops with Hyprland.
      setTimeout(() => this.hypr.dispatch("hl.dsp.exit()").catch(() => {}), 300);
    }).then(() => ({ ok: true }));
  }

  async status(): Promise<object> {
    await this.chain;
    const front = this.front();
    const clients = await this.hypr.clients();
    const monitors = await this.hypr.monitors();
    const layers = await this.hypr.layers();
    return {
      ok: true,
      front: front ? summary(front, clients) : null,
      windows: [...this.windows.values()].map((w) => ({ ...summary(w, clients), front: w.address === front?.address })),
      apps: [...this.apps.values()].map((a) => ({ role: a.role, pid: a.pid, started_at: new Date(a.startedAt).toISOString() })),
      home_restarts: this.homeRestarts,
      monitors: monitors.map((m) => ({ name: m.name, width: m.width, height: m.height, refresh_rate: m.refreshRate })),
      layers: layers.map((l) => l.namespace),
    };
  }

  // How smoothly the home screen draws: frames counted with
  // requestAnimationFrame for a few seconds (S1.5).
  frames(seconds: number): Promise<object> {
    const ms = Math.round(Math.min(Math.max(seconds, 1), 30) * 1000);
    return this.inHome(`new Promise((resolve) => {
      let start = 0, last = 0, frames = 0, worst = 0, slow = 0;
      const tick = (t) => {
        if (!start) start = t;
        if (last) { const d = t - last; worst = Math.max(worst, d); if (d > 25) slow++; }
        last = t;
        frames++;
        if (t - start < ${ms}) requestAnimationFrame(tick);
        else resolve({ frames, seconds: (t - start) / 1000, fps: Math.round((frames - 1) / ((t - start) / 1000) * 10) / 10,
          worst_ms: Math.round(worst * 10) / 10, slow_frames: slow, visible: document.visibilityState });
      };
      requestAnimationFrame(tick);
    })`);
  }

  // The keys the home screen gets for a few seconds, to check the virtual
  // input device end to end.
  keys(seconds: number): Promise<object> {
    const ms = Math.round(Math.min(Math.max(seconds, 1), 30) * 1000);
    return this.inHome(`new Promise((resolve) => {
      const keys = [];
      const on = (e) => keys.push(e.key);
      window.addEventListener("keydown", on, true);
      setTimeout(() => { window.removeEventListener("keydown", on, true); resolve({ keys }); }, ${ms});
    })`);
  }

  private async inHome(expression: string): Promise<object> {
    const cdp = this.apps.get("home")?.cdp;
    if (!cdp) return { ok: false, error: "the home screen isn't running" };
    try {
      return { ok: true, ...(await cdp.evaluate(HOME_URL, expression)) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  async toast(text: string): Promise<object> {
    try {
      await this.launcher.toast(text.slice(0, 200));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  // One request from agentv screen.
  async handle(request: any): Promise<object> {
    switch (request?.cmd) {
      case "status":
        return this.status();
      case "home":
        return this.home();
      case "open":
        if (request.app === "steam") return this.openSteam();
        return this.openWeb(String(request.url ?? ""));
      case "close":
        if (!["home", "web", "steam"].includes(request.role)) return { ok: false, error: "close what: home, web or steam" };
        return this.close(request.role);
      case "toast":
        return this.toast(String(request.text ?? ""));
      case "frames":
        return this.frames(Number(request.seconds ?? 5));
      case "keys":
        return this.keys(Number(request.seconds ?? 5));
      case "end":
        return this.end();
      default:
        return { ok: false, error: `unknown command: ${request?.cmd}` };
    }
  }
}

function normalize(address: string): string {
  return address.startsWith("0x") ? address : `0x${address}`;
}

function describe(window: Window): string {
  return `${window.role ?? "unknown"} ${window.class} "${window.title}" (${window.address}, pid ${window.pid})`;
}

function summary(window: Window, clients: Client[]) {
  const client = clients.find((c) => c.address === window.address);
  return {
    address: window.address,
    role: window.role,
    class: client?.class ?? window.class,
    title: client?.title ?? window.title,
    pid: window.pid,
    workspace: client?.workspace.name ?? null,
    fullscreen: client?.fullscreen ?? 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- On the box -------------------------------------------------------------

const AGENTV_PATH = process.env.AGENTV_PATH ?? "/usr/share/agentv";

// Chromium itself, not Arch's launcher, which would add the flags in the
// owner's ~/.config/chromium-flags.conf: those are Omarchy's desktop's, such
// as its extensions, and the TV session has nothing of the desktop.
function chromium(): string {
  if (process.env.AGENTV_CHROMIUM) return process.env.AGENTV_CHROMIUM;
  return existsSync("/usr/lib/chromium/chromium") ? "/usr/lib/chromium/chromium" : "chromium";
}

const CHROMIUM_FLAGS = [
  "--ozone-platform=wayland",
  "--kiosk",
  "--no-first-run",
  "--no-default-browser-check",
  "--noerrdialogs",
  "--disable-session-crashed-bubble",
  "--password-store=basic",
];

function track(role: Role, child: ChildProcess, group = false, cdp?: CdpPipe): App {
  const exits: Array<() => void> = [];
  let exited = false;
  child.on("exit", () => {
    exited = true;
    for (const callback of exits) callback();
  });
  child.on("error", (error) => console.log(`${role}: ${error.message}`));
  return {
    role,
    pid: child.pid ?? -1,
    startedAt: Date.now(),
    cdp,
    stop() {
      if (exited || !child.pid) return;
      try {
        process.kill(group ? -child.pid : child.pid, "SIGTERM");
      } catch {
        // Gone already.
      }
    },
    onExit(callback) {
      if (exited) callback();
      else exits.push(callback);
    },
  };
}

export const launcher: Launcher = {
  async homeReady() {
    for (let tries = 0; tries < 60; tries++) {
      try {
        const response = await fetch(`${HOME_URL}health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return;
      } catch {
        // Not up yet.
      }
      await sleep(500);
    }
    console.log(`${HOME_URL} didn't answer in 30 s; starting the home screen anyway`);
  },

  home() {
    const child = spawn(
      chromium(),
      [...CHROMIUM_FLAGS, `--user-data-dir=${HOME_PROFILE}`, `--app=${HOME_URL}`, "--remote-debugging-pipe"],
      { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] },
    );
    const cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
    return track("home", child, false, cdp);
  },

  web(url) {
    const child = spawn(chromium(), [...CHROMIUM_FLAGS, `--user-data-dir=${SERVICES_PROFILE}`, `--app=${url}`], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    return track("web", child);
  },

  steam(mode) {
    const which = (process.env.PATH ?? "/usr/bin").split(":").some((dir) => existsSync(join(dir, "steam")));
    if (!which) {
      throw new Error("Steam isn't installed. On Omarchy's desktop: Install > Gaming > Steam.");
    }
    // Its own gamescope, for Steam's frame pacing (ADR-031), at the TV's mode.
    const child = spawn(
      "gamescope",
      ["-f", "-e", "-W", String(mode.width), "-H", String(mode.height), "-r", String(Math.round(mode.refreshRate)), "--", "steam", "-gamepadui"],
      { stdio: ["ignore", "ignore", "inherit"], detached: true },
    );
    return track("steam", child, true);
  },

  toast(text) {
    return new Promise((resolve, reject) => {
      execFile("qs", ["ipc", "-n", "-p", join(AGENTV_PATH, "session", "toast"), "call", "--", "toast", "show", text], { timeout: 5000 }, (error, stdout) => {
        if (error) reject(new Error(`the toast overlay didn't answer: ${error.message}`));
        else if (stdout.trim() !== "ok") reject(new Error(`the toast overlay said: ${stdout.trim()}`));
        else resolve();
      });
    });
  },

  parent(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return ppid > 1 ? ppid : null;
    } catch {
      return null;
    }
  },

  profile(pid) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const flag = args.find((a) => a.startsWith("--user-data-dir="));
      return flag ? flag.slice("--user-data-dir=".length) : null;
    } catch {
      return null;
    }
  },
};

function serve(screen: Screen): void {
  const dir = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`, "agentv");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "screen.sock");
  rmSync(path, { force: true });
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let answer: object;
      try {
        answer = await screen.handle(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        answer = { ok: false, error: (error as Error).message };
      }
      socket.end(JSON.stringify(answer) + "\n");
    });
    socket.on("error", () => socket.destroy());
  });
  server.listen(path, () => chmodSync(path, 0o600));
}

async function main(): Promise<void> {
  const screen = new Screen({ hyprland: connect(), launcher });
  // When Hyprland goes, so does the TV session, and this with it.
  await screen.start(() => {
    console.log("Hyprland went away; stopping");
    process.exit(0);
  });
  serve(screen);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => process.exit(0));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`agentv screen: ${error.message}`);
    process.exit(1);
  });
}
