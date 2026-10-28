// AgenTV's launcher, the home screen PWA (ADR-012, ADR-014, ADR-015): it draws
// what the daemon keeps, in the Terminal look and the Omarchy theme's colours,
// and takes the same actions from every input. Pages: home, apps, an app's
// details and settings. Forward slides in, back slides out, and each plays
// its sound (ADR-024).

import { creditLine, daemon, listen, screen, shownCurrent, shownPictures, type Backgrounds, type HomeState, type Running, type Settings, type Updates } from "./api.ts";
import { fieldKind, tell } from "./context.ts";
import { clock, fit, h } from "./dom.ts";
import { Focus } from "./focus.ts";
import { listen as listenInput, type Action } from "./input.ts";
import type { Placed } from "./layout.ts";
import { addApp, installMoved } from "./pages/add-app.ts";
import { appSetup } from "./pages/app-setup.ts";
import { buildAsk, buildChange, buildPage, buildsMoved, loadBuilds } from "./pages/build.ts";
import { apps } from "./pages/apps.ts";
import { details } from "./pages/details.ts";
import { edit } from "./pages/edit.ts";
import { home } from "./pages/home.ts";
import { music } from "./pages/music.ts";
import { hidePages, openPage, pageRunning, pageView } from "./pages/page-app.ts";
import { settings } from "./pages/settings.ts";
import { power } from "./pages/power.ts";
import { checkView, drawUpdating, installing, off, release, shown, whatsNew } from "./pages/updates.ts";
import { pad as pinPad, type Pad, type PadOptions } from "./pages/pin.ts";
import { keyPage, termsHeard } from "./pages/key.ts";
import { pairPage } from "./pages/phones.ts";
import { profile } from "./pages/profiles.ts";
import { Sounds } from "./sounds.ts";
import { field } from "../setup/frame.ts";

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
  // The ambient screen, as the built-in Clock opens it.
  ambient(): void;
  saveLayout(layout: Placed[]): Promise<boolean>;
  // The grant from the PIN entered earlier in this visit, while it lasts.
  held(): string | undefined;
  saveSettings(change: Partial<Settings>, grant?: string): Promise<void>;
  // The grant for an adult action (ADR-009, S4.5): "" with no PIN set, the
  // one from the PIN entered earlier in this visit to Settings, or the PIN
  // asked for now on its pad. Null when it wasn't entered.
  grant(what: string): Promise<string | null>;
  // Drops that grant, as when the daemon refused it.
  forgetGrant(): void;
  // A PIN pad over the page, as Settings → Adult PIN chooses a new PIN with.
  // True once submit took the digits.
  pad(options: Omit<PadOptions, "cancel">): Promise<boolean>;
}

const page = document.getElementById("page")!;
const sounds = new Sounds();
const focus = new Focus(document.getElementById("ring")!);
// A text field with the focus opens the phone's keyboard (ADR-037).
focus.onSet = (el) => tell({ field: el instanceof HTMLInputElement ? { kind: fieldKind(el) } : null });
let history: string[] = ["home"];
let view: View | undefined;

const ctx: Ctx = {
  state: undefined as unknown as HomeState,
  running: new Map(),
  updates: { status: null, progress: null, toasted: null },
  sounds,
  focus,
  go(route) {
    // On a child's profile, Settings is an adult's, past the PIN (ADR-009).
    if (route.startsWith("settings") && childWithPin() && !holding()) {
      void grantFor("settings").then((grant) => grant !== null && ctx.go(route));
      return;
    }
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
  // Edit mode, on the focused tile; only adults edit home (ADR-015). On a
  // child's profile, an adult can, past the PIN.
  edit() {
    const tile = focus.get()?.dataset.id ?? "";
    if (childWithPin()) {
      void grantFor("editing home").then((grant) => grant !== null && ctx.go(`edit/${tile}`));
      return;
    }
    if (ctx.state.viewer.role !== "adult") {
      ctx.toast("only an adult can edit home", "fail");
      sounds.play("failure");
      return;
    }
    ctx.go(`edit/${tile}`);
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
  ambient() {
    setAmbient(true);
  },
  async saveLayout(layout) {
    const grant = childWithPin() ? await grantFor("changing home") : undefined;
    if (grant === null) return false;
    try {
      ctx.state.layout = (await daemon.saveLayout(layout, grant)).layout;
      return true;
    } catch (error) {
      ctx.toast((error as Error).message, "fail");
      return false;
    }
  },
  async saveSettings(change, grant) {
    ctx.state.settings = (await daemon.saveSettings(change, grant ?? ctx.held())).settings;
    apply(ctx.state.settings);
  },
  held() {
    return holding() ? held!.token : undefined;
  },
  grant(what) {
    return grantFor(what);
  },
  forgetGrant() {
    held = null;
  },
  pad(options) {
    return openPad({ ...options, cancel: true });
  },
};

// --- The adult PIN (ADR-009, S4.5) ------------------------------------------

// The pad, over the page while it's open, and the keys go to it.
const pinEl = document.getElementById("pin")!;
let pinOpen: Pad | null = null;
let pads: Promise<unknown> = Promise.resolve();
// The grant from the last PIN entered, until home or until it runs out.
let held: { token: string; until: number } | null = null;
let locking = false;
let lockPad: Pad | null = null;
// How many times the daemon has said the PIN changed, so an answer that left
// before the last time doesn't undo it.
let pinEvents = 0;

const holding = () => Boolean(held && held.until - Date.now() > 15_000);
const childWithPin = () => ctx.state.viewer.role === "child" && ctx.state.pin?.set === true;

// One pad at a time; one asked for while another is up waits its turn, and
// doesn't come at all when skip says by then it isn't needed.
function openPad(options: PadOptions, opened?: (pad: Pad | null) => void, skip?: () => boolean): Promise<boolean> {
  const run = async () => {
    if (skip?.()) return true;
    const before = focus.get();
    // The page's focused element loses its mark while the pad has the focus.
    before?.classList.remove("focused");
    // The phone's remote shows the pad too, with what it's for and how
    // many digits are in (ADR-037).
    const pin = (digits: number, error: string | null) => tell({ pin: { title: options.title, for: options.note, digits, error } });
    const pad = pinPad({ ...options, changed: pin }, (sound) => sounds.play(sound));
    pin(0, null);
    pinOpen = pad;
    opened?.(pad);
    pinEl.replaceChildren(pad.el);
    pinEl.classList.add("on");
    focus.setRoot(pad.el, pad.first);
    const ok = await pad.done;
    pinOpen = null;
    tell({ pin: null });
    opened?.(null);
    pinEl.classList.remove("on");
    pinEl.replaceChildren();
    if (view) focus.setRoot(view.el, before?.isConnected ? before : view.first);
    return ok;
  };
  const next = pads.then(run, run);
  pads = next.catch(() => {});
  return next;
}

// The PIN, checked by the daemon, which gives the grant: kept for the rest
// of this visit to Settings with hold, and for this one action without.
let checking = false;
function checkPin(hold: boolean, got?: (grant: string) => void): (pin: string) => Promise<string | null> {
  return async (pin) => {
    checking = true;
    try {
      const reply = await daemon.checkPin(pin);
      if (hold) held = { token: reply.grant, until: Date.parse(reply.until) };
      got?.(reply.grant);
      return null;
    } finally {
      checking = false;
    }
  };
}

// The launcher's own adult actions share a grant through a visit to
// Settings. agentv-pin-check's ask (one) gets a grant for its action alone,
// and always asks.
async function grantFor(what: string, options: { idleMs?: number; one?: boolean } = {}): Promise<string | null> {
  if (!ctx.state.pin?.set) return "";
  let grant: string | null = null;
  const ok = await openPad(
    { command: "tv pin", title: "enter the adult pin", note: `for ${what}.`, cancel: true, idleMs: options.idleMs, submit: checkPin(!options.one, (g) => (grant = g)) },
    undefined,
    options.one ? undefined : holding,
  );
  if (!ok) return null;
  return grant ?? held?.token ?? null;
}

// The lock: by hand from Settings → Adult PIN, and after the box starts and
// after the TV has been off, for a profile that asks for the PIN to open
// (ADR-034). The pad has no way past it but the PIN, or the phone switching
// to someone else. Unlocking is all it does: an adult action after it still
// asks.
function setLock(locked: boolean): void {
  if (locked && !locking) {
    locking = true;
    held = null;
    const viewer = ctx.state.viewer;
    void openPad(
      { command: "tv locked", title: "enter the adult pin", note: viewer.locked ? `${viewer.name}'s profile asks for it to open.` : "the tv is locked.", cancel: false, submit: checkPin(false) },
      (pad) => (lockPad = pad),
      // Unlocked elsewhere while it waited its turn.
      () => ctx.state.pin?.locked !== true,
    ).then(() => {
      locking = false;
      if (ctx.state.pin) ctx.state.pin.locked = false;
    });
  } else if (!locked && !checking) {
    // Unlocked elsewhere. The daemon says so before its answer to a PIN
    // entered here, whose pad closes itself.
    lockPad?.close();
  }
}

// What agentv-pin-check asks on the TV, by action.
const ACTIONS: Record<string, string> = {
  desktop: "omarchy's desktop",
  power: "restarting or shutting down",
  update: "installing an update",
  "go-back": "going back",
  "app-install": "installing an app",
};

function viewFor(route: string): View {
  const [name, arg] = route.split("/");
  if (name === "apps") return apps(ctx);
  // Adding an app is an adult's, and a child's profile doesn't see it (ADR-042).
  if (name === "add-app" && ctx.state.viewer.role === "adult") return addApp(ctx);
  // Your agent's builds are an adult's too (ADR-043 to ADR-046).
  if (name === "build" && ctx.state.viewer.role === "adult") return arg ? buildPage(ctx, arg) : buildAsk(ctx);
  // Look's "describe your own": a theme, made the same way (S6.4).
  if (name === "describe" && ctx.state.viewer.role === "adult") return buildAsk(ctx, "theme");
  if (name === "change" && arg && ctx.state.viewer.role === "adult") return buildChange(ctx, arg);
  if (name === "details") return details(ctx, arg);
  if (name === "app-setup") return appSetup(ctx, arg);
  if (name === "edit") return edit(ctx, arg);
  if (name === "whats-new") return whatsNew(ctx);
  if (name === "update-off") return checkView(ctx);
  if (name === "settings") return settings(ctx, arg);
  if (name === "profile") return profile(ctx, arg);
  if (name === "key") return keyPage(ctx);
  if (name === "pair") return pairPage(ctx);
  // Settings → Power's questions, for an adult only (ADR-033).
  if (name === "power" && ctx.state.viewer.role === "adult") return power(ctx, arg === "restart" ? "restart" : "shutdown");
  if (name === "music") return music(ctx, arg);
  // A page app, full screen in its frame (ADR-043).
  if (name === "app" && arg) return pageView(ctx, arg);
  return home(ctx);
}

// Draws a page. With a direction it slides in; an action names the element
// focus goes back to, after a page is redrawn in place.
function show(route: string, direction?: "forward" | "back", action?: string): void {
  // Home ends a visit to Settings, and the PIN's grant with it.
  if (route === "home") held = null;
  // Any page but a page app's puts the one in front behind home, paused.
  if (!route.startsWith("app/")) hidePages(ctx);
  tell({ screen: route === "home" ? "home" : "menu" });
  view = viewFor(route);
  document.body.classList.toggle("on-home", route === "home");
  const el = view.el;
  if (direction) {
    el.classList.add(direction === "forward" ? "page-forward" : "page-back");
    focus.hold();
    el.addEventListener("animationend", () => focus.release(), { once: true });
    setTimeout(() => focus.release(), 400);
  }
  page.replaceChildren(el);
  // Under a PIN pad, the page waits for it to close before it has the focus.
  if (pinOpen) return;
  const again = action ? el.querySelector<HTMLElement>(`[data-action="${action}"], [data-id="${action}"]`) : null;
  focus.setRoot(el, again ?? view.first);
}

function apply(settings: Settings): void {
  sounds.on = settings.sound.on;
  sounds.volume = settings.sound.volume;
  document.documentElement.classList.toggle("reduce-motion", settings.reduceMotion);
}

// The background (ADR-012, ADR-048, S5.3, S5.8): the theme's own, as on
// Omarchy's desktop, or the photo or work chosen, behind home only, dimmed so
// the tiles read over it; or the theme's own colour with none. Settings,
// Apps and the other pages keep the theme's colour.
const backdropEl = document.getElementById("backdrop")!;
let backgrounds: Backgrounds | null = null;

function drawBackdrop(): void {
  const item = shownCurrent(backgrounds);
  const shown = backdropEl.querySelector("img")?.dataset.id;
  if (item && item.id !== shown) backdropEl.replaceChildren(h("img", { class: "backdrop-picture", src: `/api/backgrounds/${item.id}`, alt: "", "data-id": item.id }));
  else if (!item) backdropEl.replaceChildren();
  document.body.classList.toggle("with-backdrop", Boolean(item));
}

async function loadBackgrounds(): Promise<void> {
  backgrounds = await daemon.backgrounds().catch(() => backgrounds);
  drawBackdrop();
}

// The ambient screen (ADR-012, ADR-031): the photos or works one after another, each
// with its credit, slowly drifting, or the theme's pixel field with none,
// and the time and the day. The screen daemon shows it after a while with
// no input, or once the TV has been off for a while; any key, click or mouse
// move ends it.
const ambientEl = document.getElementById("ambient")!;
let ambient = false;
let ambientPointer: { x: number; y: number } | null = null;
// How long each photo stays.
const PHOTO_MS = 60_000;

function setAmbient(on: boolean): void {
  if (on === ambient) return;
  ambient = on;
  tell({ screen: on ? "ambient" : history[history.length - 1] === "home" ? "home" : "menu" });
  ambientPointer = null;
  if (on) {
    const day = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).toLowerCase();
    const time = h("div", { class: "ambient-time" }, clock());
    const pictures = h("div", { class: "ambient-pictures" });
    const credit = h("div", { class: "ambient-credit" });
    const photos = shownPictures(backgrounds);
    let at = Math.max(0, photos.findIndex((item) => item.id === shownCurrent(backgrounds)?.id));
    const next = () => {
      const item = photos[at % photos.length];
      at++;
      const img = h("img", { class: "ambient-picture", src: `/api/backgrounds/${item.id}`, alt: "" });
      img.addEventListener("load", () => {
        for (const old of pictures.querySelectorAll(".ambient-picture.on")) {
          old.classList.remove("on");
          setTimeout(() => old.remove(), 2000);
        }
        requestAnimationFrame(() => img.classList.add("on"));
        credit.textContent = creditLine(item);
      });
      pictures.append(img);
    };
    if (photos.length) next();
    else pictures.append(field());
    const timer = setInterval(() => {
      if (!ambient) clearInterval(timer);
      else time.textContent = clock();
    }, 10_000);
    if (photos.length > 1) {
      const turn = setInterval(() => {
        if (!ambient) clearInterval(turn);
        else next();
      }, PHOTO_MS);
    }
    ambientEl.classList.toggle("photos", photos.length > 0);
    ambientEl.replaceChildren(pictures, h("div", { class: "ambient-drift" }, time, h("div", { class: "ambient-day" }, day)), credit);
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
  if (progress && (installing(updates) || (fresh && progress.state === "failed" && updatingShown))) {
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
  // A PIN pad has the keys while it's up.
  if (pinOpen) {
    if (action === "up" || action === "down" || action === "left" || action === "right") focus.move(action);
    else if (action === "ok") {
      sounds.play("select");
      focus.get()?.click();
    } else pinOpen.act(action);
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
  if (el && (pinOpen ? pinEl.contains(el) : view?.el.contains(el) && !view.busy?.())) focus.set(el);
});
document.addEventListener("click", (event) => {
  if (event.detail === 0) return; // a click from the keyboard, already played
  const el = (event.target as Element | null)?.closest<HTMLElement>("[data-focus]");
  if (el) sounds.play("select");
});

// The daemon's home. If it said the PIN changed while the answer was on its
// way, the lock is as it said: the answer can be older than that.
async function homeState(): Promise<HomeState> {
  const heard = pinEvents;
  const state = await daemon.home();
  if (pinEvents !== heard) state.pin = ctx.state.pin;
  return state;
}

// Draws the page again when something changed somewhere else, such as on
// the phone. A change this page made itself is already on the screen.
async function refresh(): Promise<void> {
  const state = await homeState();
  if (JSON.stringify(state) === JSON.stringify(ctx.state)) return;
  ctx.state = state;
  apply(ctx.state.settings);
  redraw();
}

// Whose home is on the TV. Word of one switch can come twice, from its own
// event and from the events' catch-up as they start, and it's made once.
let shownViewer = "";

async function switched(): Promise<void> {
  ctx.state = await homeState();
  apply(ctx.state.settings);
  if (ctx.state.viewer.id === shownViewer) return redraw();
  shownViewer = ctx.state.viewer.id;
  held = null;
  const child = ctx.state.viewer.role === "child";
  if (child) {
    for (const id of ctx.running.keys()) {
      if (!ctx.state.apps.some((app) => app.id === id)) void screen.quit(id);
    }
  }
  // Edit mode was the last viewer's home, and a child starts on their own.
  if (child || history[history.length - 1].startsWith("edit")) history = ["home"];
  await loadBuilds(ctx);
  redraw();
  // The apps still open take the service's profile for who's watching now.
  void screen.viewer();
}

// What changed while the page wasn't hearing the daemon's events: another
// viewer, as a switch from the phone, or anything else on home.
async function catchUp(): Promise<void> {
  const was = ctx.state.viewer.id;
  const state = await homeState();
  if (state.viewer.id !== was) return switched();
  await loadBuilds(ctx);
  await refresh();
  setLock(ctx.state.pin?.locked === true);
  void daemon.updates().then(setUpdates).catch(() => {});
}

// The page again, in place, with the focus where it was.
function redraw(): void {
  const current = focus.get();
  show(history[history.length - 1], undefined, current?.dataset.action ?? current?.dataset.id);
}

// Which apps are open behind home, from the screen daemon. Home's tiles show
// it; edit mode doesn't, so it isn't redrawn under the viewer's hands.
function setRunning(apps: Running[]): void {
  // The page apps open behind home are home's own, not the screen daemon's.
  const next = new Map([...apps, ...pageRunning()].map((app) => [app.id, app]));
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
  shownViewer = ctx.state.viewer.id;
  apply(ctx.state.settings);
  await loadBackgrounds();
  await loadBuilds(ctx);
  show("home");
  setLock(ctx.state.pin?.locked === true);
  window.addEventListener(
    "keydown",
    (event) => {
      if (!pinOpen || ambient || updatingShown) return;
      if (pinOpen.key(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
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
    // The weather's city changed, or the ledger has a new row for a
    // continue tile: home's tiles ask again.
    weather: () => {
      if (history[history.length - 1] === "home") redraw();
    },
    // A photo came from a phone, or another source was chosen.
    background: () => void loadBackgrounds(),
    ledger: () => {
      if (history[history.length - 1] === "home") redraw();
    },
    // An app signed in or out, or a site's icon came: the apps again.
    apps: () => void refresh(),
    // A page app set its tile (ADR-043): home's tiles ask again.
    tiles: () => {
      if (history[history.length - 1] === "home") redraw();
    },
    // A page app's notice, declared in its manifest.
    notice: (data) => {
      const notice = data as { name?: string; text?: string };
      if (notice.text) ctx.toast(`${(notice.name ?? "an app").toLowerCase()}: ${notice.text}`, "ok");
    },
    // An app added from Apps, or picked in setup, is installing.
    "setup-apps": () => installMoved(ctx, history[history.length - 1] === "add-app"),
    // A build moved on (ADR-043 to ADR-046): its tile, its page and home's bar.
    builds: () => buildsMoved(ctx, history[history.length - 1], redraw),
    // Someone else is watching (S4.2): their home, at once. A child's profile
    // closes the apps open behind home that children can't open.
    viewer: () => void switched(),
    // The phone's Settings button (ADR-037), for an adult's profile. (Not
    // "open", which EventSource sends itself.)
    page: (data) => {
      if ((data as { route?: string }).route === "settings" && ctx.state.viewer.role === "adult") ctx.go("settings");
    },
    viewers: () => void refresh(),
    // A phone was paired or forgotten: pairing is done, and Settings says so.
    // A provider's terms accepted on a phone, for a key Settings → AI waits
    // to keep (Q104).
    terms: (data) => termsHeard(data),
    phones: (data) => {
      const paired = (data as { paired?: string }).paired;
      if (paired) {
        ctx.toast(`${paired} is paired`, "ok");
        sounds.play("confirm");
      }
      const route = history[history.length - 1];
      if (route === "pair" && paired) ctx.back();
      else if (route.startsWith("settings")) redraw();
    },
    // The PIN was set or taken off, or the TV was locked or unlocked.
    pin: (data) => {
      const status = data as { set: boolean; locked: boolean };
      pinEvents++;
      ctx.state.pin = { set: status.set, locked: status.locked };
      if (!status.set) held = null;
      setLock(status.locked);
      if (history[history.length - 1].startsWith("settings")) redraw();
    },
  }, () => void catchUp().catch(() => {}));
  void daemon.updates().then(setUpdates).catch(() => {});
  void sounds.load();
  // The screen daemon calls these: Home when the home screen is already in
  // front, and the apps open behind it whenever that changes.
  const w = window as unknown as {
    agentvHome: () => void;
    agentvRunning: (json: string) => void;
    agentvAmbient: (on: boolean) => void;
    agentvPage: (id: string) => void;
    agentvLauncher: object;
  };
  w.agentvHome = () => act("home");
  w.agentvAmbient = (on) => setAmbient(on);
  // A page app opened from elsewhere, such as Apps or the phone, through
  // the screen daemon, which put home in front first. One installed a moment
  // ago may not be in home's list yet, so home reads it again first.
  w.agentvPage = (id) => {
    if (ctx.state.apps.some((app) => app.id === id)) openPage(ctx, id);
    else void refresh().then(() => openPage(ctx, id));
  };
  w.agentvRunning = (json) => setRunning(JSON.parse(json));
  void screen.running().then(setRunning);
  // For the UI checks and agentv selftest: the sounds that played, the
  // focus, and a page to go to.
  w.agentvLauncher = {
    sounds,
    focus,
    go: (route: string) => ctx.go(route),
    // agentv-pin-check, when there's no terminal to type the PIN in, as for
    // Super+Ctrl+Home: the pad, which gives up after 2 minutes with no key.
    askPin: async (action: string) => ({ grant: await grantFor(ACTIONS[action] ?? action, { idleMs: 120_000, one: true }) }),
  };
}

void start();
