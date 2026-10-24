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
// Home pauses the app in front and shows the home screen; choosing the app
// again brings it back where it was. Up to two apps stay open like that, and
// a third closes the oldest. A game keeps running under home until it's
// quit. Back goes to the app in front, and holding it for a second goes home
// (ADR-031).
//
// With nothing playing and no input for the time Settings gives (10 minutes
// at first), the home screen shows its ambient screen over whatever was in
// front, which stays open behind it, and any key goes back there. When the
// TV goes off, playback pauses at once; after 2 minutes every app closes and
// the home screen waits on its ambient screen, where any key goes home.
//
// An update asked for tonight, or any with "update overnight on its own" on,
// installs between 02:00 and 05:00 once nothing has played for 30 minutes
// (ADR-025).
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
import { CdpPipe, type DevTools } from "./cdp.ts";
import { connect, lua, type Client, type Hyprland } from "./hyprland.ts";
import { PAUSE, RESUME } from "./media.ts";
import { tvOn } from "./tv-power.ts";

export type Role = "home" | "web" | "steam";

export const TV_WORKSPACE = "1";
export const HELD_WORKSPACE = "special:agentv-held";
export const HOME_URL = "http://127.0.0.1:3000/";

// True once home's page has loaded and its own script has run: the
// launcher's start, or the welcome page's.
export const HOME_UP = `document.readyState === "complete" && ("agentvLauncher" in window || "agentvWelcome" in window)`;
export const HOME_PROFILE = "/var/lib/agentv/chromium-home";
export const SERVICES_PROFILE = "/var/lib/agentv/chromium";
// Apps kept open behind home, besides a game (ADR-031).
export const KEEP_OPEN = 2;

// A process the daemon started.
export interface App {
  role: Role;
  pid: number;
  startedAt: number;
  cdp?: DevTools;
  stop(): void;
  onExit(callback: () => void): void;
}

// What the daemon knows about updates, for the night (ADR-025): what the
// check found, how an install is going, an install asked for tonight, and
// Settings' "update overnight on its own".
export interface NightUpdates {
  status: any;
  progress: any;
  tonight: { version: string } | null;
  overnight: boolean;
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
  // running, it hands the window to that one and exits. A browser this
  // starts has a DevTools pipe, and the daemon opens later windows with it.
  web(url: string): App;
  steam(mode: MonitorMode): App;
  toast(text: string): Promise<void>;
  // What opening an installed app means, from AgenTV's daemon, or null.
  appTarget(id: string): Promise<{ runtime: "web"; url: string } | { runtime: "native"; exec: string[] } | null>;
  // Settings → Omarchy desktop: agentv desktop, which ends this session.
  desktop(): void;
  // Starts one of AgenTV's update units (ADR-025), which polkit lets the
  // person at the TV start: the check, or an install.
  startUnit(name: "agentv-update-check.service" | "agentv-update-tv.service" | "agentv-go-back.service"): Promise<boolean>;
  // What there is to install at night, or null when the daemon doesn't
  // answer, and the install asked for tonight is done with.
  nightUpdates(): Promise<NightUpdates | null>;
  clearTonight(): Promise<void>;
  // How long the TV waits before its ambient screen, from Settings, or null
  // while setup is on the screen, which has no ambient screen.
  idleMinutes(): Promise<number | null>;
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

// An app open on the TV: in front, or out of sight behind home.
interface Open {
  // The app's id, or the address it opened, for one opened by address.
  id: string;
  role: Role;
  // Its page in the services' Chromium, when the daemon started that one.
  target?: string;
  // Its window, once it has one.
  address?: string;
  usedAt: number;
  // Home paused it, so choosing it again plays it.
  paused: boolean;
}

interface Options {
  hyprland: Hyprland;
  launcher: Launcher;
  now?: () => number;
  log?: (line: string) => void;
  homeRestartMs?: number;
  backHoldMs?: number;
  // Whether the TV is on, or null when the box can't tell (tv-power.ts).
  tvPoll?: () => boolean | null;
  tvPollMs?: number;
  // How long after the TV goes off every app closes.
  tvOffCloseMs?: number;
  // How long the overlay's idle monitor waits before it says so.
  idleReportMs?: number;
  // How soon after the ambient screen comes up input on the seat is taken
  // for bringing home to the front.
  ambientSettleMs?: number;
  // How long home's page has to come up after its Chromium starts.
  homeCheckMs?: number;
  // How often it looks at the night's updates, and how long nothing must
  // have played before one installs.
  nightTickMs?: number;
  nightQuietMs?: number;
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
  private opens: Open[] = [];
  private want: { role: Role; until: number; app?: string } | null = null;
  private backHoldMs: number;
  private backDown = 0;
  private backUp = 0;
  private backTimer: ReturnType<typeof setTimeout> | null = null;
  // The ambient screen, and the window to go back to after it.
  ambient = false;
  private ambientFrom: string | null = null;
  private ambientAt = 0;
  private ambientSettleMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleGeneration = 0;
  private idleAfter: number | null = null;
  private idleReportMs: number;
  // The TV's power, as the box last read it, and what was done about it.
  tvOff = false;
  private tvSeen: boolean | null = null;
  private tvPoll?: () => boolean | null;
  private tvPollMs: number;
  private tvOffCloseMs: number;
  private tvTimer: ReturnType<typeof setTimeout> | null = null;
  private tvWatch: ReturnType<typeof setInterval> | null = null;
  private ending = false;
  private chain: Promise<void> = Promise.resolve();
  private homeRestartMs: number;
  private homeDelay: number;
  private homeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRefocus = 0;
  private homeStarting = false;
  private homeCheckMs: number;
  homeRestarts = 0;
  // Updates at night: when something last played, and the night it last
  // checked for updates.
  private lastPlayed: number;
  private nightChecked = "";
  private nightCheckAt = 0;
  private nightTickMs: number;
  private nightQuietMs: number;
  private nightWatch: ReturnType<typeof setInterval> | null = null;

  constructor(options: Options) {
    this.hypr = options.hyprland;
    this.launcher = options.launcher;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(line));
    this.homeRestartMs = options.homeRestartMs ?? 500;
    this.homeDelay = this.homeRestartMs;
    this.backHoldMs = options.backHoldMs ?? 1000;
    this.tvPoll = options.tvPoll;
    this.tvPollMs = options.tvPollMs ?? 2000;
    this.tvOffCloseMs = options.tvOffCloseMs ?? 120_000;
    this.idleReportMs = options.idleReportMs ?? 30_000;
    this.ambientSettleMs = options.ambientSettleMs ?? 3000;
    this.homeCheckMs = options.homeCheckMs ?? 30_000;
    this.nightTickMs = options.nightTickMs ?? 60_000;
    this.nightQuietMs = options.nightQuietMs ?? 30 * 60_000;
    this.lastPlayed = this.now();
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
    if (this.tvPoll) {
      this.tvSeen = this.tvPoll();
      this.tvWatch = setInterval(() => this.pollTv(), this.tvPollMs);
    }
    this.nightWatch = setInterval(() => void this.night(), this.nightTickMs);
    this.nightWatch.unref?.();
  }

  // Stops the timers, for the tests.
  stop(): void {
    this.idleGeneration++;
    for (const timer of [this.backTimer, this.idleTimer, this.tvTimer, this.homeTimer]) if (timer) clearTimeout(timer);
    if (this.tvWatch) clearInterval(this.tvWatch);
    if (this.nightWatch) clearInterval(this.nightWatch);
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
      const app = wanted ? this.want?.app : undefined;
      if (wanted) this.want = null;
      this.log(`in front: ${describe(window)}`);
      await this.toFront(address);
      const entry = app ? this.opens.find((o) => o.id === app && !o.address) : undefined;
      if (entry) {
        entry.address = address;
        this.running();
      }
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
    if (this.opens.some((o) => o.address === address)) {
      this.opens = this.opens.filter((o) => o.address !== address);
      this.running();
    }
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
    void this.bridge(app);
    void this.watchHome(app);
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

  // Home's window in front isn't enough: a page that hangs or never starts
  // leaves the TV blank. If home's page hasn't come up a while after its
  // Chromium started, it starts again.
  private async watchHome(app: App): Promise<void> {
    if (!app.cdp) return;
    const every = Math.min(1000, this.homeCheckMs / 5);
    const started = Date.now();
    while (Date.now() - started < this.homeCheckMs) {
      if (this.ending || this.apps.get("home") !== app) return;
      const up = await Promise.race([app.cdp.evaluate(HOME_URL, HOME_UP).catch(() => false), sleep(every).then(() => false)]);
      if (up === true) return;
      await sleep(every);
    }
    if (this.ending || this.apps.get("home") !== app) return;
    this.log(`the home screen's page didn't come up in ${Math.round(this.homeCheckMs / 1000)} s; starting it again`);
    app.stop();
  }

  // Gives the home screen window.agentvScreen, over its DevTools pipe, once
  // its page is there (launcher/api.ts).
  private async bridge(app: App): Promise<void> {
    if (!app.cdp) return;
    for (let tries = 0; tries < 60 && this.apps.get("home") === app; tries++) {
      try {
        await app.cdp.bind(HOME_URL, "agentvScreen", (request) => this.fromHome(request));
        return;
      } catch {
        await sleep(500);
      }
    }
    this.log("the home screen's page never came, so it can't open apps");
  }

  // What the home screen asks for: an app in front, the apps open, quitting
  // one, or Omarchy's desktop.
  async fromHome(request: any): Promise<object> {
    switch (request?.cmd) {
      case "open-app": {
        const id = String(request.app ?? "");
        if (this.opens.some((o) => o.id === id && o.address && this.windows.has(o.address))) {
          return this.reopen(id);
        }
        const target = await this.launcher.appTarget(id).catch(() => null);
        if (!target) return { ok: false, error: "that app can't be opened yet" };
        if (target.runtime === "web") return this.openWeb(target.url, id);
        if (target.exec[0] === "steam") return this.openSteam(id);
        return { ok: false, error: "that app can't be opened from the tv yet" };
      }
      case "running":
        await this.chain;
        return { ok: true, apps: this.runningApps() };
      case "quit":
        return this.quit(String(request.app ?? ""));
      case "wake":
        return this.wake("a key or the mouse on home");
      // Settings → Updates: Check now, and Install now (ADR-025).
      case "update-check":
        return (await this.launcher.startUnit("agentv-update-check.service")) ? { ok: true } : { ok: false, error: "couldn't check for updates" };
      case "update-install":
        return (await this.launcher.startUnit("agentv-update-tv.service")) ? { ok: true } : { ok: false, error: "couldn't start the update" };
      case "update-go-back":
        return (await this.launcher.startUnit("agentv-go-back.service")) ? { ok: true } : { ok: false, error: "couldn't go back" };
      case "desktop":
        this.launcher.desktop();
        return { ok: true };
      default:
        return { ok: false, error: `unknown request: ${request?.cmd}` };
    }
  }

  // Home, from any input (ADR-031): the app in front pauses and goes out of
  // sight, and the home screen comes to the front. With the home screen
  // already there, it goes back to its own home page. A game's guide button
  // is the game's own.
  home(from = ""): Promise<object> {
    return this.queue(async () => {
      const front = this.front();
      if (from === "guide" && front?.role === "steam") return;
      const entry = front && this.opens.find((o) => o.address === front.address);
      if (entry) {
        entry.usedAt = this.now();
        if (entry.role === "web") entry.paused = (await this.media(entry, PAUSE)) > 0;
      }
      const home = this.homeWindow();
      if (home && front?.address === home.address) {
        await this.inHome("window.agentvHome?.()");
      } else if (home) {
        await this.toFront(home.address);
      } else {
        this.want = { role: "home", until: Infinity };
        this.startHome();
      }
      this.running();
    }).then(() => ({ ok: true }));
  }

  // Back is the app's own, but holding it for a second goes home. The
  // session's Hyprland reports each press and release with the time it
  // happened, since the two can arrive out of order.
  back(edge: "down" | "up", at: number): object {
    if (edge === "up") {
      this.backUp = Math.max(this.backUp, at);
      if (at >= this.backDown && this.backTimer) {
        clearTimeout(this.backTimer);
        this.backTimer = null;
      }
      return { ok: true };
    }
    if (at <= this.backUp || at <= this.backDown) return { ok: true };
    this.backDown = at;
    if (this.backTimer) clearTimeout(this.backTimer);
    this.backTimer = setTimeout(
      () => {
        this.backTimer = null;
        if (this.backUp < this.backDown) void this.home("back");
      },
      Math.max(0, at + this.backHoldMs - this.now()),
    );
    return { ok: true };
  }

  // An app open behind home comes back where it was, playing again if Home
  // paused it.
  private reopen(id: string): Promise<object> {
    return this.queue(async () => {
      const entry = this.opens.find((o) => o.id === id);
      if (!entry?.address || !this.windows.has(entry.address)) return;
      await this.toFront(entry.address);
      entry.usedAt = this.now();
      if (entry.paused) await this.media(entry, RESUME);
      entry.paused = false;
      this.running();
    }).then(() => ({ ok: true }));
  }

  // Runs PAUSE or RESUME in an app's page. 0 when it can't: a page the
  // daemon didn't open, or one that doesn't answer in half a second, so Home
  // never waits on an app.
  private async media(entry: Open, script: string): Promise<number> {
    const cdp = this.apps.get("web")?.cdp;
    if (!cdp || !entry.target) return 0;
    const answer = await Promise.race([cdp.evaluateIn(entry.target, script).catch(() => 0), sleep(500).then(() => 0)]);
    return Number(answer) || 0;
  }

  // Closes the oldest apps past KEEP_OPEN; a game doesn't count.
  private async makeRoom(keep: string): Promise<void> {
    const apps = this.opens.filter((o) => o.role !== "steam");
    for (const oldest of apps.filter((o) => o.id !== keep).sort((a, b) => a.usedAt - b.usedAt)) {
      if (this.opens.filter((o) => o.role !== "steam").length <= KEEP_OPEN) break;
      this.log(`closing ${oldest.id}, the oldest of ${KEEP_OPEN + 1} apps open`);
      await this.closeOpen(oldest);
    }
  }

  private async closeOpen(entry: Open): Promise<void> {
    this.opens = this.opens.filter((o) => o !== entry);
    if (entry.role === "steam") {
      for (const window of [...this.windows.values()].filter((w) => w.role === "steam")) {
        await this.hypr.dispatch(`hl.dsp.window.close({ window = ${lua(`address:${window.address}`)} })`);
      }
      this.apps.get("steam")?.stop();
    } else {
      if (entry.target && this.apps.get("web")?.cdp) await this.apps.get("web")!.cdp!.close(entry.target).catch(() => {});
      // Its window too, in case the page didn't take it with it.
      if (entry.address && this.windows.has(entry.address)) {
        await this.hypr.dispatch(`hl.dsp.window.close({ window = ${lua(`address:${entry.address}`)} })`).catch(() => {});
      }
    }
    this.running();
  }

  quit(id: string): Promise<object> {
    let found = false;
    return this.queue(async () => {
      const entry = this.opens.find((o) => o.id === id);
      if (!entry) return;
      found = true;
      await this.closeOpen(entry);
    }).then(() => (found ? { ok: true } : { ok: false, error: `${id} isn't open` }));
  }

  private runningApps(): { id: string; game: boolean; paused: boolean }[] {
    return this.opens.filter((o) => o.address).map((o) => ({ id: o.id, game: o.role === "steam", paused: o.paused }));
  }

  // Tells the home screen which apps are open, for their tiles.
  private running(): void {
    const apps = JSON.stringify(JSON.stringify(this.runningApps()));
    void this.inHome(`window.agentvRunning?.(${apps})`);
  }

  // --- The ambient screen and TV off (ADR-031) ------------------------------

  // The overlay's idle monitor (session/toast/shell.qml) says the seat has had
  // no input for a while, or has again. Something playing keeps it from
  // saying so; a page that plays sound only is checked here too.
  seatIdle(idle: boolean): object {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // Each report starts over; anything still waiting from an older one stops.
    const generation = ++this.idleGeneration;
    // Input again: the ambient screen ends, as with a key on the home screen.
    // Bringing home to the front for it counts as input on the seat too, at
    // once, so a report that soon after it came up is that, and it stays. A
    // key or the mouse still ends it through the home screen itself.
    if (!idle && this.ambient) {
      if (this.now() - this.ambientAt < this.ambientSettleMs) this.log("input as the ambient screen came up; it stays");
      else void this.wake("input again");
    }
    if (!idle || this.ambient) return { ok: true };
    void (async () => {
      const minutes = await this.launcher.idleMinutes().catch(() => 10);
      if (minutes === null) return;
      const seconds = this.idleAfter ?? 60 * minutes;
      const arm = (ms: number) => {
        if (generation !== this.idleGeneration) return;
        this.idleTimer = setTimeout(async () => {
          this.idleTimer = null;
          if (await this.playing()) arm(seconds * 1000);
          else if (generation === this.idleGeneration) void this.showAmbient();
        }, ms);
      };
      arm(Math.max(0, seconds * 1000 - this.idleReportMs));
    })();
    return { ok: true };
  }

  // For the checks: the ambient screen after this many seconds, not Settings'.
  idleAfterSeconds(seconds: number | null): object {
    this.idleAfter = seconds;
    return { ok: true };
  }

  // --- Updates at night (ADR-025) ------------------------------------------

  // Tonight, or every night with "update overnight on its own" on, an update
  // installs between 02:00 and 05:00, once nothing has played for 30
  // minutes. The first look each night checks for updates; a later one
  // installs. Runs every minute, and notes when something last played.
  async night(): Promise<void> {
    if (await this.playing()) this.lastPlayed = this.now();
    const at = new Date(this.now());
    if (at.getHours() < 2 || at.getHours() >= 5) return;
    const updates = await this.launcher.nightUpdates().catch(() => null);
    if (!updates || (!updates.tonight && !updates.overnight)) return;
    const night = at.toDateString();
    if (this.nightChecked !== night) {
      this.nightChecked = night;
      this.nightCheckAt = this.now();
      this.log("night: checking for updates before installing");
      await this.launcher.startUnit("agentv-update-check.service");
      return;
    }
    const progress = updates.progress;
    if (progress && ["running", "restarting", "going-back"].includes(progress.state)) return;
    const status = updates.status;
    // The check from a moment ago may still be running: up to 10 minutes,
    // its answer first.
    const checked = Date.parse(status?.checked_at ?? "") || 0;
    if (checked < this.nightCheckAt - 1000 && this.now() - this.nightCheckAt < 10 * 60_000) return;
    const pending = Boolean(status && (status.agentv?.available || status.omarchy?.available || status.packages > 0));
    if (!pending) {
      if (updates.tonight) await this.launcher.clearTonight().catch(() => {});
      return;
    }
    // On stable, one the nightly run hasn't passed waits for another night.
    if (status.waiting) return;
    const quiet = this.now() - this.lastPlayed;
    if (quiet < this.nightQuietMs) return;
    this.log(`night: installing the update, nothing has played for ${Math.round(quiet / 60_000)} min`);
    if (await this.launcher.startUnit("agentv-update-tv.service")) {
      if (updates.tonight) await this.launcher.clearTonight().catch(() => {});
    }
  }

  // Whether an open app's page is playing.
  private async playing(): Promise<boolean> {
    const cdp = this.apps.get("web")?.cdp;
    if (!cdp) return false;
    for (const entry of this.opens.filter((o) => o.target)) {
      const answer = await Promise.race([
        cdp.evaluateIn(entry.target!, `[...document.querySelectorAll("audio, video")].some((m) => !m.paused && !m.ended)`).catch(() => false),
        sleep(500).then(() => false),
      ]);
      if (answer === true) return true;
    }
    return false;
  }

  // The home screen in front on its ambient screen. What was in front stays
  // open behind it, unless the TV went off and it closed.
  showAmbient(): Promise<object> {
    return this.queue(async () => {
      if (this.ambient) return;
      const front = this.front();
      this.ambientFrom = front && front.role !== "home" ? front.address : null;
      const home = this.homeWindow();
      if (home && front?.address !== home.address) await this.toFront(home.address);
      this.ambient = true;
      this.ambientAt = this.now();
      this.log(`the ambient screen${this.ambientFrom ? `, over ${this.ambientFrom}` : ""}`);
      await this.inHome("window.agentvAmbient?.(true)");
    }).then(() => ({ ok: true }));
  }

  // A key on the ambient screen: back to what was in front, or home.
  wake(why = "asked"): Promise<object> {
    return this.queue(async () => {
      if (!this.ambient) return;
      this.ambient = false;
      this.log(`the ambient screen ends: ${why}`);
      const back = this.ambientFrom && this.windows.has(this.ambientFrom) ? this.ambientFrom : null;
      this.ambientFrom = null;
      await this.inHome("window.agentvAmbient?.(false)");
      if (back) await this.toFront(back);
    }).then(() => ({ ok: true }));
  }

  private pollTv(): void {
    const on = this.tvPoll?.() ?? null;
    if (on === null || on === this.tvSeen) return;
    this.tvSeen = on;
    void this.tv(on);
  }

  // The TV went off or came back. Off: everything playing pauses at once, and
  // after tvOffCloseMs every app closes and home waits on its ambient screen.
  tv(on: boolean): Promise<object> {
    return this.queue(async () => {
      if (!on) {
        if (this.tvOff) return;
        this.tvOff = true;
        this.log("the TV went off; pausing");
        for (const entry of this.opens.filter((o) => o.role === "web")) {
          if ((await this.media(entry, PAUSE)) > 0) entry.paused = true;
        }
        this.tvTimer = setTimeout(() => {
          this.tvTimer = null;
          void this.offTooLong();
        }, this.tvOffCloseMs);
        this.running();
        return;
      }
      if (!this.tvOff) return;
      this.tvOff = false;
      if (this.tvTimer) clearTimeout(this.tvTimer);
      this.tvTimer = null;
      this.log("the TV came back on");
    }).then(() => ({ ok: true }));
  }

  private offTooLong(): Promise<void> {
    return this.queue(async () => {
      if (!this.tvOff) return;
      this.log("the TV has been off for a while; closing every app");
      for (const entry of [...this.opens]) await this.closeOpen(entry);
      this.ambient = false;
    }).then(() => void this.showAmbient());
  }

  openWeb(url: string, id = url): Promise<object> {
    if (!/^(https?|data):/.test(url)) {
      return Promise.resolve({ ok: false, error: "only http, https and data URLs open on the TV" });
    }
    if (this.opens.some((o) => o.id === id && o.address && this.windows.has(o.address))) return this.reopen(id);
    return this.queue(async () => {
      this.opens = this.opens.filter((o) => o.id !== id);
      const entry: Open = { id, role: "web", usedAt: this.now(), paused: false };
      this.opens.push(entry);
      this.want = { role: "web", until: this.now() + 30_000, app: id };
      const running = this.apps.get("web");
      if (running?.cdp) {
        entry.target = await running.cdp.open(url).catch(() => undefined);
      }
      if (!entry.target) {
        const app = this.launcher.web(url);
        if (!running) {
          this.apps.set("web", app);
          app.onExit(() => {
            if (this.apps.get("web") === app) this.apps.delete("web");
          });
          if (app.cdp) void this.firstPage(app.cdp, entry);
        }
      }
      this.log(`opening ${id === url ? url : `${id} at ${url}`} in the services' Chromium`);
      await this.makeRoom(id);
    }).then(() => ({ ok: true }));
  }

  // The page a new services' Chromium opened with.
  private async firstPage(cdp: DevTools, entry: Open): Promise<void> {
    for (let tries = 0; tries < 50 && !entry.target; tries++) {
      const pages = await cdp.pages().catch(() => []);
      if (pages.length > 0) {
        entry.target = pages[0].targetId;
        return;
      }
      await sleep(100);
    }
  }

  openSteam(id = "steam"): Promise<object> {
    let result: object = { ok: true };
    return this.queue(async () => {
      const running = [...this.windows.values()].filter((w) => w.role === "steam").pop();
      if (running) {
        await this.toFront(running.address);
        const entry = this.opens.find((o) => o.role === "steam");
        if (entry) entry.usedAt = this.now();
        return;
      }
      this.opens = this.opens.filter((o) => o.role !== "steam");
      this.opens.push({ id, role: "steam", usedAt: this.now(), paused: false });
      if (this.apps.has("steam")) {
        this.want = { role: "steam", until: this.now() + 120_000, app: id };
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
          this.opens = this.opens.filter((o) => o.role !== "steam");
          this.running();
        });
        this.want = { role: "steam", until: this.now() + 120_000, app: id };
        this.log(`started Steam in its gamescope (pid ${app.pid})`);
      } catch (error) {
        this.opens = this.opens.filter((o) => o.role !== "steam");
        result = { ok: false, error: (error as Error).message };
      }
    }).then(() => result);
  }

  close(role: Role): Promise<object> {
    return this.queue(async () => {
      this.opens = this.opens.filter((o) => o.role !== role);
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
      open: this.opens.map((o) => ({ id: o.id, role: o.role, paused: o.paused, front: o.address !== undefined && o.address === front?.address })),
      home_restarts: this.homeRestarts,
      ambient: this.ambient,
      tv: this.tvOff ? "off" : "on",
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
        return this.home(String(request.from ?? ""));
      case "back":
        if (!["down", "up"].includes(request.edge) || !Number.isFinite(request.at)) return { ok: false, error: "back down or up, and when" };
        return this.back(request.edge, Number(request.at));
      case "open":
        if (request.app === "steam") return this.openSteam();
        return this.openWeb(String(request.url ?? ""));
      case "quit":
        return this.quit(String(request.app ?? ""));
      case "idle":
        return this.seatIdle(request.idle === true);
      case "idle-after":
        return this.idleAfterSeconds(Number.isFinite(request.seconds) && request.seconds > 0 ? Number(request.seconds) : null);
      case "ambient":
        return this.showAmbient();
      case "wake":
        return this.wake("agentv screen wake");
      case "tv":
        if (typeof request.on !== "boolean") return { ok: false, error: "tv on or off" };
        return this.tv(request.on);
      case "update":
        if (!["check", "install", "go-back"].includes(request.what)) return { ok: false, error: "update check, install or go-back" };
        return this.fromHome({ cmd: `update-${request.what}` });
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
      // The home screen's sounds play without waiting for a first key press.
      [...CHROMIUM_FLAGS, `--user-data-dir=${HOME_PROFILE}`, `--app=${HOME_URL}`, "--remote-debugging-pipe", "--autoplay-policy=no-user-gesture-required"],
      { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] },
    );
    const cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
    return track("home", child, false, cdp);
  },

  web(url) {
    const child = spawn(chromium(), [...CHROMIUM_FLAGS, `--user-data-dir=${SERVICES_PROFILE}`, `--app=${url}`, "--remote-debugging-pipe"], {
      stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"],
    });
    const cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
    return track("web", child, false, cdp);
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

  async appTarget(id) {
    const response = await fetch(`${HOME_URL}api/apps/${encodeURIComponent(id)}/launch`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const target = await response.json();
    if (target.runtime === "web" && typeof target.url === "string") return { runtime: "web", url: target.url };
    if (target.runtime === "native" && Array.isArray(target.exec)) return { runtime: "native", exec: target.exec.map(String) };
    return null;
  },

  desktop() {
    spawn("agentv-desktop", [], { stdio: "ignore", detached: true }).unref();
  },

  async nightUpdates() {
    const get = async (path: string) => (await fetch(`${HOME_URL}${path}`, { signal: AbortSignal.timeout(5000) })).json();
    const [updates, home] = await Promise.all([get("api/updates"), get("api/home")]);
    return {
      status: updates?.status ?? null,
      progress: updates?.progress ?? null,
      tonight: updates?.tonight ?? null,
      overnight: home?.settings?.updateOvernight === true,
    };
  },

  async clearTonight() {
    await fetch(`${HOME_URL}api/updates/tonight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: null }),
      signal: AbortSignal.timeout(5000),
    });
  },

  startUnit(name) {
    return new Promise((resolve) => {
      execFile("systemctl", ["start", "--no-block", name], { timeout: 10_000 }, (error) => resolve(!error));
    });
  },

  async idleMinutes() {
    const health = await (await fetch(`${HOME_URL}health`, { signal: AbortSignal.timeout(5000) })).json();
    if (health?.screen !== "home") return null;
    const response = await fetch(`${HOME_URL}api/home`, { signal: AbortSignal.timeout(5000) });
    const minutes = (await response.json())?.settings?.idleMinutes;
    return typeof minutes === "number" && minutes > 0 ? minutes : 10;
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
  const screen = new Screen({ hyprland: connect(), launcher, tvPoll: () => tvOn() });
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
