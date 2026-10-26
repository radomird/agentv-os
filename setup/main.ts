// TV setup (stage 5, PHASE-1-PLAN.md "Setup flow"), on the TV until it's
// done, in the Terminal look (ADR-014) and the Omarchy theme's colours. One
// step at a time: the welcome screen (the Wi-Fi and pairing), getting ready
// (the box brings itself up to date first, board 35), the AI provider and
// its terms, who watches, what the TV is for, its apps, its look and its
// background, and home. The daemon keeps the step in setup.json, so a restart, an
// update or a reboot comes back to the same one (S5.6).
//
// Every input works here as on home: a keyboard, the phone's remote, a
// gamepad and a mouse. Pages slide 24 px, headings type out, and the UI
// sounds play (ADR-024). The phone's remote follows the screen (ADR-037).

import { daemon, listen, type Updates } from "../launcher/api.ts";
import { fieldKind, tell } from "../launcher/context.ts";
import { fit, h } from "../launcher/dom.ts";
import { Focus } from "../launcher/focus.ts";
import { listen as listenInput, type Action } from "../launcher/input.ts";
import { pad as pinPad, type Pad, type PadOptions } from "../launcher/pages/pin.ts";
import { Sounds } from "../launcher/sounds.ts";
import { aiStep, cliLine, path } from "./ai.ts";
import { setup, type AiInfo, type Installs, type Provider, type SetupInfo, type Step } from "./api.ts";
import { addYourOwn, apps, installLine } from "./apps.ts";
import { background, photos } from "./background.ts";
import { bar, field } from "./frame.ts";
import { goal } from "./goal.ts";
import { people, person } from "./people.ts";
import { Soundtrack } from "./music.ts";
import { ready } from "./ready.ts";
import { theme } from "./theme.ts";
import { welcome, wifi } from "./welcome.ts";

export interface View {
  el: HTMLElement;
  first?: HTMLElement;
  // The status bar's right side: what's going on.
  info?: string;
  // The pixel field shows at full strength behind this screen.
  bright?: boolean;
  act?(action: Action): boolean;
  // Something the daemon said, such as a phone paired or an update's
  // progress.
  heard?(event: string, data: unknown): void;
  // Back is held, as while the box updates itself.
  stay?(): boolean;
  // Back of the page's own: true when it took it.
  back?(): boolean;
  stop?(): void;
}

export interface Ctx {
  info: SetupInfo;
  // The AI provider, its terms and its CLI, once the daemon has said.
  ai?: AiInfo;
  // The apps ticked at the apps step and not handed over yet, how the ones
  // handed over are installing, and their names.
  picked?: string[];
  installs: Installs;
  names: Record<string, string>;
  updates: Updates;
  sounds: Sounds;
  focus: Focus;
  reduced(): boolean;
  // A step is finished: setup moves on to the next one, or home after the
  // last.
  finish(step: Step, change?: { keyboard?: boolean }): Promise<void>;
  // A page of the step on screen, such as the welcome screen's Wi-Fi list.
  open(route: string, direction?: "forward" | "back"): void;
  back(): void;
  toast(text: string, kind?: "ok" | "fail"): void;
  // The status bar's right side again, as what's going on changes.
  status(info: string): void;
  refresh(): Promise<SetupInfo>;
  // The grant for an adult action (ADR-009): "" with no PIN set, the one
  // from the PIN entered earlier in setup while it lasts, or the PIN asked
  // for now on its pad. Null when it wasn't entered.
  grant(what: string): Promise<string | null>;
  // Keeps a grant for the rest of setup, as after the PIN was just chosen.
  hold(grant: string, until: string): void;
  // A PIN pad over the page, as choosing the adult PIN. True once submit
  // took the digits.
  pad(options: Omit<PadOptions, "cancel" | "changed">): Promise<boolean>;
}

const page = document.getElementById("page")!;
const fieldEl = document.getElementById("field")!;
const sounds = new Sounds();
// The setup soundtrack and its player, from the welcome screen to the
// background step (S5.4).
const music = new Soundtrack();
const focus = new Focus(document.getElementById("ring")!);
// A text field with the focus opens the phone's keyboard (ADR-037).
focus.onSet = (el) => tell({ field: el instanceof HTMLInputElement ? { kind: fieldKind(el) } : null });
let route = "welcome";
let view: View | undefined;
// How many times this page has moved, and how many of its own moves are on
// their way to the daemon. What the daemon said about where setup is only
// moves the page when nothing here moved it since it was asked: an answer
// that left before Enter moved setup on mustn't take it back.
let moves = 0;
let local = 0;
let reduceMotion = false;
let barEl: HTMLElement | null = null;

// --- The adult PIN's pad (ADR-009, ADR-037) -----------------------------------

// The pad, over the page while it's open; the keys go to it, and the phone's
// remote shows it too, with how many digits are in.
const pinEl = document.getElementById("pin")!;
let pinOpen: Pad | null = null;
let pads: Promise<unknown> = Promise.resolve();
let held: { token: string; until: number } | null = null;
const holding = () => Boolean(held && held.until - Date.now() > 15_000);

function openPad(options: Omit<PadOptions, "changed">): Promise<boolean> {
  const run = async () => {
    const before = focus.get();
    before?.classList.remove("focused");
    const tellPin = (digits: number, error: string | null) => tell({ pin: { title: options.title, for: options.note, digits, error } });
    const pad = pinPad({ ...options, changed: tellPin }, (sound) => sounds.play(sound));
    tellPin(0, null);
    pinOpen = pad;
    pinEl.replaceChildren(pad.el);
    pinEl.classList.add("on");
    focus.setRoot(pad.el, pad.first);
    const ok = await pad.done;
    pinOpen = null;
    tell({ pin: null });
    pinEl.classList.remove("on");
    pinEl.replaceChildren();
    if (view) focus.setRoot(view.el, before?.isConnected ? before : view.first);
    return ok;
  };
  const next = pads.then(run, run);
  pads = next.catch(() => {});
  return next;
}

const ctx: Ctx = {
  info: undefined as unknown as SetupInfo,
  updates: { status: null, progress: null, toasted: null },
  installs: {},
  names: {},
  sounds,
  focus,
  reduced: () => reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches,
  async finish(step, change) {
    let next;
    local++;
    try {
      next = await setup.finish(step, change);
    } catch (error) {
      ctx.toast((error as Error).message, "fail");
      sounds.play("failure");
      return;
    } finally {
      local--;
    }
    ctx.info.setup = next;
    const steps = ctx.info.steps;
    if (step === steps[steps.length - 1]) {
      // The last step: setup is done, and the page loads again as home.
      sounds.play("confirm");
      await setup.done().catch((error) => ctx.toast((error as Error).message, "fail"));
      return;
    }
    show(next.step, "forward");
    sounds.play("forward");
  },
  open(to, direction = "forward") {
    show(to, direction);
    sounds.play(direction);
  },
  back() {
    if (view?.stay?.()) return;
    if (view?.back?.()) return;
    const [step, sub] = route.split("/");
    if (sub) {
      show(step, "back");
      sounds.play("back");
      return;
    }
    const steps = ctx.info.steps;
    const at = steps.indexOf(step as Step);
    if (at <= 0) return;
    local++;
    void setup
      .go(steps[at - 1])
      .then(
        (next) => {
          ctx.info.setup = next;
          show(next.step, "back");
          sounds.play("back");
        },
        () => {},
      )
      .finally(() => local--);
  },
  toast(text, kind) {
    const el = h("div", { class: `toast${kind ? ` ${kind}` : ""}` }, text);
    document.getElementById("toasts")!.append(el);
    setTimeout(() => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 200);
    }, 5000);
  },
  status(info) {
    const el = barEl?.querySelector(".bar-info");
    if (el) el.textContent = barInfo(route.split("/")[0], info);
  },
  async grant(what) {
    if (!ctx.info.pin) return "";
    if (holding()) return held!.token;
    let grant: string | null = null;
    const ok = await openPad({
      command: "tv setup · pin",
      title: "enter the adult pin",
      note: `for ${what}.`,
      cancel: true,
      submit: async (pin) => {
        const reply = await daemon.checkPin(pin);
        held = { token: reply.grant, until: Date.parse(reply.until) };
        grant = reply.grant;
        return null;
      },
    });
    return ok ? grant : null;
  },
  hold(grant, until) {
    held = { token: grant, until: Date.parse(until) };
  },
  pad(options) {
    return openPad({ ...options, cancel: true });
  },
  async refresh() {
    const at = moves;
    const info = await setup.info();
    if (moves === at) ctx.info = info;
    else ctx.info = { ...info, setup: ctx.info.setup };
    return ctx.info;
  },
};

function viewFor(to: string): View | Promise<View> {
  const [step, sub] = to.split("/");
  if (to === "welcome/wifi") return wifi(ctx);
  if (to === "ready") return ready(ctx);
  if (step === "ai" && sub) return path(ctx, sub as Provider);
  if (to === "ai") return aiStep(ctx);
  if (step === "people" && sub) return person(ctx, sub);
  if (to === "people") return people(ctx);
  if (to === "goal") return goal(ctx);
  if (to === "apps/add") return addYourOwn(ctx);
  if (to === "apps") return apps(ctx);
  if (to === "theme") return theme(ctx);
  if (to === "background/photos") return photos(ctx);
  if (to === "background") return background(ctx);
  return welcome(ctx);
}

// Draws a page. With a direction it slides in, and setup's steps take the
// slow token (ADR-024).
function show(to: string, direction?: "forward" | "back"): void {
  view?.stop?.();
  moves++;
  route = to;
  const next = viewFor(to);
  if (next instanceof Promise) {
    // A step that asks the daemon first where it picks up.
    const at = moves;
    view = undefined;
    void next.then((ready) => {
      if (moves === at) put(to, ready, direction);
      else ready.stop?.();
    });
    return;
  }
  put(to, next, direction);
}

// The status bar's right side: what the screen says, and after the AI step,
// the provider's CLI arriving in the background, as the apps do after theirs.
function barInfo(step: string, info: string): string {
  const cli = step !== "ai" && ctx.ai ? cliLine(ctx.ai) : null;
  const installing = step !== "apps" ? installLine(ctx.installs, ctx.names) : null;
  return [info, cli, installing].filter(Boolean).join(" · ");
}

function put(to: string, next: View, direction?: "forward" | "back"): void {
  view = next;
  const step = to.split("/")[0] as Step;
  barEl = bar(ctx.info.parts[step] ?? "", barInfo(step, view.info ?? ""));
  const el = h("div", { class: "screen setup-screen" }, view.el, barEl);
  fieldEl.classList.toggle("dim", !view.bright);
  tell({ screen: "menu" });
  if (direction) {
    el.classList.add(direction === "forward" ? "step-forward" : "step-back");
    focus.hold();
    el.addEventListener("animationend", () => focus.release(), { once: true });
    setTimeout(() => focus.release(), 500);
  }
  page.replaceChildren(el);
  focus.setRoot(el, view.first);
}

function act(action: Action): void {
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
  }
}

focus.onMove = () => sounds.play("move");

// A mouse moves the focus by hovering, and a click is OK (ADR-015). Only a
// real move counts: Chromium also sends one when the page changes under a
// still mouse.
let pointer = { x: -1, y: -1 };
let hide = 0;
document.body.classList.add("pointer-hidden");
document.addEventListener("pointermove", (event) => {
  if (event.clientX === pointer.x && event.clientY === pointer.y) return;
  pointer = { x: event.clientX, y: event.clientY };
  document.body.classList.remove("pointer-hidden");
  clearTimeout(hide);
  hide = setTimeout(() => document.body.classList.add("pointer-hidden"), 3000);
  const el = (event.target as Element | null)?.closest<HTMLElement>("[data-focus]");
  if (el && (pinOpen ? pinEl.contains(el) : view?.el.contains(el))) focus.set(el);
});
document.addEventListener("click", (event) => {
  if (event.detail === 0) return; // a click from the keyboard, already played
  if ((event.target as Element | null)?.closest("[data-focus]")) sounds.play("select");
});

async function start(): Promise<void> {
  fit();
  window.addEventListener("resize", () => {
    fit();
    focus.refresh();
  });
  fieldEl.append(field());
  ctx.info = await setup.info();
  // Settings → Sound and Look apply here too.
  await daemon
    .home()
    .then((home) => {
      sounds.on = home.settings.sound.on;
      sounds.volume = home.settings.sound.volume;
      reduceMotion = home.settings.reduceMotion;
      document.documentElement.classList.toggle("reduce-motion", reduceMotion);
    })
    .catch(() => {});
  ctx.updates = await daemon.updates().catch(() => ctx.updates);
  ctx.ai = await setup.ai().catch(() => undefined);
  show(ctx.info.setup.step);
  document.body.append(music.el);
  void music.start(ctx.info.setup.muted);
  // M mutes the soundtrack, or plays it again, from a keyboard or the
  // phone's keys, but not while typing.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "m" && event.key !== "M") return;
    if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return;
    const muted = !music.isMuted();
    music.mute(muted);
    void setup.music(muted).catch(() => {});
  });
  // Number keys, from a keyboard or the phone, go to the pad while it's up.
  window.addEventListener(
    "keydown",
    (event) => {
      if (pinOpen?.key(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  listenInput(act);
  listen(
    {
      // Setup done, from the last step or agentv setup skip: home takes over.
      // Started again or moved on elsewhere: the step it's on now.
      setup: (data) => {
        const next = data as SetupInfo["setup"];
        if (next.done) {
          location.reload();
          return;
        }
        ctx.info.setup = next;
        if (next.muted !== music.isMuted()) music.mute(next.muted);
        if (local === 0 && next.step !== route.split("/")[0]) show(next.step);
      },
      theme: (data) => {
        const link = document.getElementById("theme") as HTMLLinkElement;
        link.href = `/api/theme.css?at=${Date.now()}`;
        view?.heard?.("theme", data);
      },
      updates: (data) => {
        ctx.updates = data as Updates;
        view?.heard?.("updates", data);
      },
      phones: (data) => view?.heard?.("phones", data),
      pin: (data) => {
        const status = data as { set: boolean };
        ctx.info.pin = status.set;
        if (!status.set) held = null;
        view?.heard?.("pin", data);
      },
      viewers: (data) => view?.heard?.("viewers", data),
      ai: (data) => {
        if (ctx.ai) ctx.ai = { ...ctx.ai, ...(data as Partial<AiInfo>) };
        view?.heard?.("ai", data);
        if (route.split("/")[0] !== "ai" && view) ctx.status(view.info ?? "");
      },
      key: (data) => {
        if (ctx.ai) ctx.ai = { ...ctx.ai, key: data as AiInfo["key"] };
        view?.heard?.("key", data);
      },
      background: (data) => view?.heard?.("background", data),
      "setup-apps": (data) => {
        ctx.installs = data as Installs;
        view?.heard?.("setup-apps", data);
        if (route.split("/")[0] !== "apps" && view) ctx.status(view.info ?? "");
      },
      settings: () =>
        void daemon.home().then((home) => {
          sounds.on = home.settings.sound.on;
          sounds.volume = home.settings.sound.volume;
        }),
    },
    // The stream opened again, as after the daemon restarted: whatever
    // changed in between.
    () => {
      const at = moves;
      void setup.info().then(
        (info) => {
          if (info.setup.done) location.reload();
          else if (moves === at && local === 0 && info.setup.step !== route.split("/")[0]) {
            ctx.info = info;
            show(info.setup.step);
          }
        },
        () => {},
      );
    },
  );
  void sounds.load();
  // The screen daemon reads this to know the page came up, and /health says
  // the welcome screen is on the TV once it's drawn (S0.1).
  const w = window as unknown as { agentvWelcome: boolean; agentvSetup: object };
  w.agentvWelcome = true;
  // For the UI checks and the image layer: the step, and the sounds.
  w.agentvSetup = { sounds, focus, music, route: () => route };
  requestAnimationFrame(() => void fetch("/api/welcome-shown", { method: "POST" }).catch(() => {}));
}

void start();
