// Page apps on home (contract 2, ADR-043): an app that is its own page,
// full screen in a sandboxed frame over home, served from an origin of its
// own. The frame has scripts and nothing else: no storage of the browser's,
// no forms, popups or leaving home, and the policy its files come with. It
// reaches the box only through AgenTV's app kit (kit-host.ts).
//
// Home pauses it and keeps it open behind home, two at most, as it does a
// web app (ADR-031). Back goes to the app first; one that doesn't keep it,
// or doesn't answer in time, is left and closed. Holding Back and Home
// always go home.

import { daemon, screen, type Running } from "../api.ts";
import { h } from "../dom.ts";
import type { Action } from "../input.ts";
import { BACK_KEYS, KEY_BUTTONS, KitHost, padChanges } from "../kit-host.ts";
import type { Ctx, View } from "../main.ts";

// How many page apps stay open behind home.
const KEEP = 2;
// How long a page may take to say it's drawn before it's shown anyway.
const READY_MS = 15_000;

interface Open {
  id: string;
  name: string;
  wrap: HTMLElement;
  frame: HTMLIFrameElement;
  host: KitHost;
  usedAt: number;
  ready: boolean;
}

const open = new Map<string, Open>();
let front: Open | null = null;
let backing = false;
let listening = false;
const pads = new Map<number, Set<string>>();

// The address a page app is served at: its own host on the daemon's port.
export function pageUrl(id: string, port = location.port): string {
  return `http://${id}.app.localhost${port ? `:${port}` : ""}/`;
}

function layer(): HTMLElement {
  let el = document.getElementById("page-apps");
  if (!el) {
    el = h("div", { id: "page-apps" });
    document.getElementById("page")!.after(el);
  }
  return el;
}

// The page apps open behind home, for home's tiles: paused unless in front.
export function pageRunning(): Running[] {
  return [...open.values()].map((entry) => ({ id: entry.id, game: false, paused: entry !== front }));
}

function close(ctx: Ctx, entry: Open): void {
  entry.host.close();
  entry.wrap.remove();
  open.delete(entry.id);
  if (front === entry) front = null;
  ctx.running.delete(entry.id);
}

function start(ctx: Ctx, id: string, name: string): Open {
  const frame = h("iframe", {
    class: "page-app-frame",
    src: pageUrl(id),
    sandbox: "allow-scripts",
    allow: "autoplay",
    referrerpolicy: "no-referrer",
    title: name,
  }) as HTMLIFrameElement;
  const wrap = h("div", { class: "page-app loading", "data-app": id }, h("div", { class: "page-app-cover" }, h("span", {}, `${name.toLowerCase()}…`)), frame);
  layer().append(wrap);
  const entry: Open = {
    id,
    name,
    wrap,
    frame,
    host: undefined as unknown as KitHost,
    usedAt: Date.now(),
    ready: false,
  };
  const shown = () => {
    entry.ready = true;
    wrap.classList.remove("loading");
  };
  entry.host = new KitHost(frame, id, {
    daemon: (app, call, args) => daemon.kit(app, call, args),
    media: (app, call, args) => screen.kit(app, call, args),
    ready: shown,
    exit: () => leave(ctx, entry),
  });
  setTimeout(() => !entry.ready && shown(), READY_MS);
  // A page that goes elsewhere, or comes again, is no longer the app the
  // box approved: it's closed.
  let loads = 0;
  frame.addEventListener("load", () => {
    if (++loads > 1) {
      ctx.toast(`${name.toLowerCase()} tried to leave its page, so it was closed`, "fail");
      leave(ctx, entry);
    }
  });
  open.set(id, entry);
  // A third one closes the one used longest ago.
  const others = [...open.values()].filter((o) => o !== entry).sort((a, b) => a.usedAt - b.usedAt);
  while (open.size > KEEP && others.length) close(ctx, others.shift()!);
  return entry;
}

// Leaves the app for good: closed, and home back where it was.
function leave(ctx: Ctx, entry: Open): void {
  const wasFront = front === entry;
  close(ctx, entry);
  if (wasFront) ctx.back();
}

// Home, or another page, is in front now: the app in front pauses, and its
// tile says so.
export function hidePages(ctx: Ctx): void {
  if (!front) return;
  front.host.pause();
  ctx.running.set(front.id, { id: front.id, game: false, paused: true });
  front.wrap.classList.remove("on");
  front = null;
  document.getElementById("page-apps")?.classList.remove("on");
}

function blocked(): boolean {
  return ["pin", "ambient", "updating"].some((id) => document.getElementById(id)?.classList.contains("on"));
}

// The remote's, the keyboard's and the phone's keys go to the app in front,
// pressed and let go, except Back and Home, which home handles.
function listenKeys(): void {
  if (listening) return;
  listening = true;
  const key = (down: boolean) => (event: KeyboardEvent) => {
    if (!front || blocked() || BACK_KEYS.includes(event.key)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const button = KEY_BUTTONS[event.key];
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (down && event.repeat) return;
    front.host.input({ button, down, source: "remote" });
  };
  window.addEventListener("keydown", key(true), true);
  window.addEventListener("keyup", key(false), true);
  // Gamepads are read each frame while an app is in front. B and the guide
  // button are home's: Back and Home.
  const poll = () => {
    if (!front) {
      pads.clear();
      return;
    }
    const found = navigator.getGamepads().filter((pad): pad is Gamepad => pad !== null);
    if (!blocked()) {
      for (const change of padChanges(found, pads)) {
        if (change.button === "back" || change.button === "home") continue;
        front.host.input({ button: change.button, down: change.down, source: "gamepad", pad: change.pad });
      }
    }
    requestAnimationFrame(poll);
  };
  window.addEventListener("gamepadconnected", () => front && requestAnimationFrame(poll));
  (window as unknown as { agentvPadPoll?: () => void }).agentvPadPoll = () => requestAnimationFrame(poll);
}

// Opens a page app, or brings back the one open behind home, from its tile,
// Apps, or the screen daemon.
export function openPage(ctx: Ctx, id: string): void {
  const app = ctx.state.apps.find((a) => a.id === id);
  if (!app || app.runtime !== "page") {
    ctx.toast("that app isn't on this tv", "fail");
    return;
  }
  ctx.go(`app/${id}`);
}

// The page app as home's page: the frame over everything else of home's,
// with the keys and gamepads going to it.
export function pageView(ctx: Ctx, id: string): View {
  const app = ctx.state.apps.find((a) => a.id === id && a.runtime === "page");
  const el = h("div", { class: "page-app-view" });
  if (!app) return { el, act: () => false };
  listenKeys();
  const existed = open.get(id);
  const entry = existed ?? start(ctx, id, app.name);
  for (const other of open.values()) other.wrap.classList.toggle("on", other === entry);
  layer().classList.add("on");
  front = entry;
  entry.usedAt = Date.now();
  ctx.running.set(id, { id, game: false, paused: false });
  if (existed) entry.host.resume();
  entry.frame.focus();
  requestAnimationFrame(() => (window as unknown as { agentvPadPoll?: () => void }).agentvPadPoll?.());
  return {
    el,
    act(action: Action) {
      if (action === "home") return false;
      if (action === "back") {
        if (!backing) {
          backing = true;
          void entry.host.back().then((kept) => {
            backing = false;
            if (!kept && front === entry) leave(ctx, entry);
          });
        }
        return true;
      }
      // Everything else reaches the app through the kit, as pressed and let
      // go, not as home's own actions.
      return true;
    },
  };
}
