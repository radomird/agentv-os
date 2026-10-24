// AgenTV's launcher, the home screen PWA (ADR-012, ADR-014, ADR-015): it draws
// what the daemon keeps, in the Terminal look and the Omarchy theme's colours,
// and takes the same actions from every input. Pages: home, apps, an app's
// details and settings. Forward slides in, back slides out, and each plays
// its sound (ADR-024).

import { daemon, listen, screen, type HomeState, type Running, type Settings, type Updates } from "./api.ts";
import { clock, fit, h } from "./dom.ts";
import { Focus } from "./focus.ts";
import { listen as listenInput, type Action } from "./input.ts";
import type { Placed } from "./layout.ts";
import { apps } from "./pages/apps.ts";
import { details } from "./pages/details.ts";
import { edit } from "./pages/edit.ts";
import { home } from "./pages/home.ts";
import { settings } from "./pages/settings.ts";
import { checkView, drawUpdating, off, release, shown, whatsNew } from "./pages/updates.ts";
import { Sounds } from "./sounds.ts";

export interface View {
  el: HTMLElement;
  first?: HTMLElement;
  act?(action: Action): boolean;
  focused?(el: HTMLElement): void;
  // True while the page has the pointer, as edit mode does during a drag.
  busy?(): boolean;
}

export interface Ctx {
  state: HomeState;
  // Apps open behind home, by id (ADR-031).
  running: Map<string, Running>;
  // What the update check found, and an install's progress (ADR-025).
  updates: Updates;
  sounds: Sounds;
  focus: Focus;
  go(route: string): void;
  back(): void;
  edit(): void;
  render(route: string, action?: string): void;
  // Notes where the page is now, such as a section of Settings, so Back to
  // it comes back there.
  remember(route: string): void;
  toast(text: string, kind?: "ok" | "fail"): void;
  saveLayout(layout: Placed[]): Promise<boolean>;
  saveSettings(change: Partial<Settings>): Promise<void>;
}

const page = document.getElementById("page")!;
const sounds = new Sounds();
const focus = new Focus(document.getElementById("ring")!);
let history: string[] = ["home"];
let view: View | undefined;

const ctx: Ctx = {
  state: undefined as unknown as HomeState,
  running: new Map(),
  updates: { status: null, progress: null, toasted: null },
  sounds,
  focus,
  go(route) {
    history.push(route);
    show(route, "forward");
    sounds.play("forward");
  },
  back() {
    if (history.length <= 1) return;
    history.pop();
    show(history[history.length - 1], "back");
    sounds.play("back");
  },
  // Edit mode, on the focused tile; only adults edit home (ADR-015).
  edit() {
    if (ctx.state.viewer.role !== "adult") {
      ctx.toast("only an adult can edit home", "fail");
      sounds.play("failure");
      return;
    }
    ctx.go(`edit/${focus.get()?.dataset.id ?? ""}`);
  },
  remember(route) {
    history[history.length - 1] = route;
  },
  render(route, action) {
    history[history.length - 1] = route;
    show(route, undefined, action);
  },
  toast(text, kind) {
    const el = h("div", { class: `toast${kind ? ` ${kind}` : ""}` }, text);
    document.getElementById("toasts")!.append(el);
    setTimeout(() => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 200);
    }, 5000);
  },
  async saveLayout(layout) {
    try {
      ctx.state.layout = (await daemon.saveLayout(layout)).layout;
      return true;
    } catch (error) {
      ctx.toast((error as Error).message, "fail");
      return false;
    }
  },
  async saveSettings(change) {
    ctx.state.settings = (await daemon.saveSettings(change)).settings;
    apply(ctx.state.settings);
  },
};

function viewFor(route: string): View {
  const [name, arg] = route.split("/");
  if (name === "apps") return apps(ctx);
  if (name === "details") return details(ctx, arg);
  if (name === "edit") return edit(ctx, arg);
  if (name === "whats-new") return whatsNew(ctx);
  if (name === "update-off") return checkView(ctx);
  if (name === "settings") return settings(ctx, arg);
  return home(ctx);
}

// Draws a page. With a direction it slides in; an action names the element
// focus goes back to, after a page is redrawn in place.
function show(route: string, direction?: "forward" | "back", action?: string): void {
  view = viewFor(route);
  const el = view.el;
  if (direction) {
    el.classList.add(direction === "forward" ? "page-forward" : "page-back");
    focus.hold();
    el.addEventListener("animationend", () => focus.release(), { once: true });
    setTimeout(() => focus.release(), 400);
  }
  page.replaceChildren(el);
  const again = action ? el.querySelector<HTMLElement>(`[data-action="${action}"], [data-id="${action}"]`) : null;
  focus.setRoot(el, again ?? view.first);
}

function apply(settings: Settings): void {
  sounds.on = settings.sound.on;
  sounds.volume = settings.sound.volume;
  document.documentElement.classList.toggle("reduce-motion", settings.reduceMotion);
}

// The ambient screen (ADR-031): a placeholder until the backgrounds come in
// stage 5. The screen daemon shows it after a while with no input, or once
// the TV has been off for a while; any key, click or mouse move ends it.
const ambientEl = document.getElementById("ambient")!;
let ambient = false;
let ambientPointer: { x: number; y: number } | null = null;

function setAmbient(on: boolean): void {
  if (on === ambient) return;
  ambient = on;
  ambientPointer = null;
  if (on) {
    const day = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).toLowerCase();
    const time = h("div", { class: "ambient-time" }, clock());
    const timer = setInterval(() => {
      if (!ambient) clearInterval(timer);
      else time.textContent = clock();
    }, 10_000);
    ambientEl.replaceChildren(
      h("div", { class: "ambient-drift" }, time, h("div", { class: "ambient-day" }, day), h("div", { class: "ambient-note" }, "backgrounds are coming soon. any key to go back.")),
    );
  }
  ambientEl.classList.toggle("on", on);
}

// Ends the ambient screen from this side, and asks the screen daemon to put
// back what was in front.
function wake(): void {
  setAmbient(false);
  void screen.wake();
}

// The Updating screen (ADR-025): over everything while an install from the TV
// runs, and after one that failed until a key is pressed. When one is done,
// the page loads again, from the new release.
const updatingEl = document.getElementById("updating")!;
let updatingShown = false;
let updatingFailed = false;

function setUpdates(updates: Updates): void {
  const before = ctx.updates;
  ctx.updates = updates;
  const progress = updates.progress;
  const fresh = progress && Date.now() - new Date(progress.at).getTime() < 15 * 60_000;
  const busy = progress?.state === "running" || progress?.state === "restarting" || progress?.state === "going-back";
  if (progress && fresh && (busy || (progress.state === "failed" && updatingShown))) {
    drawUpdating(updatingEl, progress);
    updatingEl.classList.add("on");
    updatingShown = true;
    updatingFailed = progress.state === "failed";
  } else if (updatingShown && progress?.state === "done") {
    location.reload();
    return;
  }
  // The notice on home: the bar says so, and one toast per release.
  if (JSON.stringify([before.status, before.tonight, before.seen?.later]) !== JSON.stringify([updates.status, updates.tonight, updates.seen?.later])) {
    const route = history[history.length - 1];
    if (route === "home" || route.startsWith("settings")) redraw();
  }
  toastRelease();
  checkAfterUpdate();
}

// Something's off after an update (board 33): home makes way for it once,
// until Go back or Keep. And after going back, one toast says so.
function checkAfterUpdate(): void {
  if (updatingShown || ambient || ctx.state.viewer.role !== "adult") return;
  const route = history[history.length - 1];
  if (off(ctx.updates) && route === "home") ctx.go("update-off");
  const went = ctx.updates.wentBack;
  if (went && ctx.updates.seen?.wentBack !== went.at && route === "home") {
    ctx.updates.seen = { kept: null, ...ctx.updates.seen, wentBack: went.at };
    ctx.toast(`back on agentv ${shown(went.to.agentv)}. the update is still in settings → updates.`, "ok");
    void daemon.seen({ wentBack: went.at }).catch(() => {});
  }
}

// One toast per release, on home, for an adult, never during setup or an
// install (ADR-025). Setup has no launcher, and nothing plays while home is
// in front.
function toastRelease(): void {
  const version = release(ctx.updates);
  if (!version || ctx.updates.toasted === version || updatingShown || ambient) return;
  if (history[history.length - 1] !== "home" || ctx.state.viewer.role !== "adult") return;
  ctx.updates.toasted = version;
  ctx.toast(`agentv ${version} is ready · settings → updates`, "ok");
  void daemon.toasted(version).catch(() => {});
}

function act(action: Action): void {
  // An install is running: keys wait. One that failed goes away on a key.
  if (updatingShown) {
    if (updatingFailed) {
      updatingShown = false;
      updatingFailed = false;
      updatingEl.classList.remove("on");
    }
    return;
  }
  // The first key on the ambient screen only ends it.
  if (ambient) {
    wake();
    return;
  }
  if (view?.act?.(action)) return;
  if (action === "up" || action === "down" || action === "left" || action === "right") {
    focus.move(action);
  } else if (action === "ok") {
    const el = focus.get();
    if (!el) return;
    el.classList.add("pressed");
    setTimeout(() => el.classList.remove("pressed"), 120);
    sounds.play("select");
    el.click();
  } else if (action === "back") {
    ctx.back();
  } else if (action === "home") {
    if (history.length > 1 || history[0] !== "home") {
      history = ["home"];
      show("home", "back");
      sounds.play("back");
    }
  }
}

focus.onMove = (el) => {
  sounds.play("move");
  view?.focused?.(el);
};

// A mouse moves the focus by hovering, and a click is OK (ADR-015). The
// pointer shows when the mouse moves and hides after 3 s. Only a real move
// counts: Chromium also sends one when the page changes under a still mouse.
let pointer = { x: -1, y: -1 };
let hide = 0;
document.body.classList.add("pointer-hidden");
document.addEventListener("pointermove", (event) => {
  // Chromium sends one as this window comes to the front for the ambient
  // screen, wherever the mouse was left. So the first move on the ambient
  // screen only says where the mouse is, and the next one ends it.
  if (ambient) {
    const last = ambientPointer;
    ambientPointer = { x: event.clientX, y: event.clientY };
    if (!last || (event.clientX === last.x && event.clientY === last.y)) return;
    wake();
  }
  if (event.clientX === pointer.x && event.clientY === pointer.y) return;
  pointer = { x: event.clientX, y: event.clientY };
  document.body.classList.remove("pointer-hidden");
  clearTimeout(hide);
  hide = setTimeout(() => document.body.classList.add("pointer-hidden"), 3000);
  const el = (event.target as Element | null)?.closest<HTMLElement>("[data-focus]");
  if (el && view?.el.contains(el) && !view.busy?.()) focus.set(el);
});
document.addEventListener("click", (event) => {
  if (event.detail === 0) return; // a click from the keyboard, already played
  const el = (event.target as Element | null)?.closest<HTMLElement>("[data-focus]");
  if (el) sounds.play("select");
});

// Draws the page again when something changed somewhere else, such as on
// the phone. A change this page made itself is already on the screen.
async function refresh(): Promise<void> {
  const state = await daemon.home();
  if (JSON.stringify(state) === JSON.stringify(ctx.state)) return;
  ctx.state = state;
  apply(ctx.state.settings);
  redraw();
}

// The page again, in place, with the focus where it was.
function redraw(): void {
  const current = focus.get();
  show(history[history.length - 1], undefined, current?.dataset.action ?? current?.dataset.id);
}

// Which apps are open behind home, from the screen daemon. Home's tiles show
// it; edit mode doesn't, so it isn't redrawn under the viewer's hands.
function setRunning(apps: Running[]): void {
  const next = new Map(apps.map((app) => [app.id, app]));
  if (JSON.stringify([...next]) === JSON.stringify([...ctx.running])) return;
  ctx.running = next;
  if (history[history.length - 1] === "home") redraw();
}

async function start(): Promise<void> {
  fit();
  window.addEventListener("resize", () => {
    fit();
    focus.refresh();
  });
  ctx.state = await daemon.home();
  apply(ctx.state.settings);
  show("home");
  listenInput(act);
  listen({
    layout: () => void refresh(),
    settings: () => void refresh(),
    theme: () => {
      const link = document.getElementById("theme") as HTMLLinkElement;
      link.href = `/api/theme.css?at=${Date.now()}`;
    },
    setup: () => location.reload(),
    updates: (data) => setUpdates(data as Updates),
  });
  void daemon.updates().then(setUpdates).catch(() => {});
  void sounds.load();
  // The screen daemon calls these: Home when the home screen is already in
  // front, and the apps open behind it whenever that changes.
  const w = window as unknown as {
    agentvHome: () => void;
    agentvRunning: (json: string) => void;
    agentvAmbient: (on: boolean) => void;
    agentvLauncher: object;
  };
  w.agentvHome = () => act("home");
  w.agentvAmbient = (on) => setAmbient(on);
  w.agentvRunning = (json) => setRunning(JSON.parse(json));
  void screen.running().then(setRunning);
  // For the UI checks: the sounds that played, and the focus.
  w.agentvLauncher = { sounds, focus };
}

void start();
