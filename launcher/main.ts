// AgenTV's launcher, the home screen PWA (ADR-012, ADR-014, ADR-015): it draws
// what the daemon keeps, in the Terminal look and the Omarchy theme's colours,
// and takes the same actions from every input. Pages: home, apps, an app's
// details and settings. Forward slides in, back slides out, and each plays
// its sound (ADR-024).

import { daemon, listen, type HomeState, type Settings } from "./api.ts";
import { h } from "./dom.ts";
import { Focus } from "./focus.ts";
import { listen as listenInput, type Action } from "./input.ts";
import type { Placed } from "./layout.ts";
import { apps } from "./pages/apps.ts";
import { details } from "./pages/details.ts";
import { home } from "./pages/home.ts";
import { settings } from "./pages/settings.ts";
import { Sounds } from "./sounds.ts";

export interface View {
  el: HTMLElement;
  first?: HTMLElement;
  act?(action: Action): boolean;
  focused?(el: HTMLElement): void;
}

export interface Ctx {
  state: HomeState;
  sounds: Sounds;
  focus: Focus;
  go(route: string): void;
  back(): void;
  render(route: string, action?: string): void;
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
  const again = action ? el.querySelector<HTMLElement>(`[data-action="${action}"]`) : null;
  focus.setRoot(el, again ?? view.first);
}

function apply(settings: Settings): void {
  sounds.on = settings.sound.on;
  sounds.volume = settings.sound.volume;
  document.documentElement.classList.toggle("reduce-motion", settings.reduceMotion);
}

function act(action: Action): void {
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

// A mouse moves the focus by hovering, and a click is OK (ADR-015).
document.addEventListener("pointermove", (event) => {
  const el = (event.target as Element | null)?.closest<HTMLElement>("[data-focus]");
  if (el && view?.el.contains(el)) focus.set(el);
});
document.addEventListener("click", (event) => {
  if (event.detail === 0) return; // a click from the keyboard, already played
  const el = (event.target as Element | null)?.closest<HTMLElement>("[data-focus]");
  if (el) sounds.play("select");
});

async function refresh(): Promise<void> {
  ctx.state = await daemon.home();
  apply(ctx.state.settings);
  show(history[history.length - 1], undefined, focus.get()?.dataset.action);
}

async function start(): Promise<void> {
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
  });
  void sounds.load();
  // For the UI checks: the sounds that played, and the focus.
  (window as unknown as { agentvLauncher: object }).agentvLauncher = { sounds, focus };
}

void start();
