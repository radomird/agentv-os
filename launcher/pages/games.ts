// Games in Settings (ADR-103): every game platform Omarchy's menu has is
// one of OrigaiTV's own apps, and this page adds and removes them. Home and
// apps has a Games row that opens it. Each game is a row: its name, then
// what OK does or how it's going. Adding one installs it in the background,
// as Add an app does, and several wait their turn. Removing one takes it
// off the TV and leaves its games and saves. Both are an adult's, past the
// PIN when there is one, and a child's profile only sees the list.
//
// Phones and controllers gets the Xbox controller row from here too: the
// driver that makes an Xbox controller's buttons work over Bluetooth.
//
// The words are written in sentence case with real names, as D8 has them.

import { asWritten, h } from "../dom.ts";
import { glyph } from "../glyphs.ts";
import type { Ctx } from "../main.ts";

export interface GameApp {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  state: "queued" | "installing" | "installed" | "failed" | "removing" | null;
  error?: string;
}

interface Games {
  ok?: boolean;
  apps: GameApp[];
  error?: string;
  pin?: boolean;
}

export interface Driver {
  installed: boolean;
  state: "queued" | "installing" | "installed" | "failed" | null;
  error?: string;
  restart?: boolean;
}

// What the daemon answers, with whether it needs the PIN.
type Answer<T> = { status: number; data: T & { ok?: boolean; error?: string; pin?: boolean } };

// Adding and removing are an adult's: with a PIN set, they send its grant.
async function call<T>(method: string, path: string, body?: unknown, grant?: string): Promise<Answer<T>> {
  const response = await fetch(path, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-OrigaiTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive: true,
  });
  return { status: response.status, data: await response.json() };
}

// Kept between visits so Settings draws at once.
let games: Games | null = null;
let driver: Driver | null = null;
// The page on screen, which draws itself again as installs move on.
let live: (() => void) | null = null;

export function loadGames(): Promise<void> {
  return call<Games>("GET", "/api/games")
    .then(({ data }) => {
      if (Array.isArray(data.apps)) games = data;
    })
    .catch(() => {});
}

export function loadDriver(): Promise<void> {
  return call<{ driver: Driver }>("GET", "/api/games/driver")
    .then(({ data }) => {
      if (data.driver) driver = data.driver;
    })
    .catch(() => {});
}

// Games' row in Home and apps: how many are on the TV.
export function gamesValue(): string {
  if (!games) return "";
  const here = games.apps.filter((app) => app.installed).length;
  return here === 0 ? "None yet" : `${here} on this TV`;
}

// An install or a removal moved on: the page again, and the rows.
export function gamesMoved(redraw: () => void): void {
  void Promise.all([loadGames(), loadDriver()]).then(() => {
    if (live) live();
    else redraw();
  });
}

// What a game's row says: what OK does, or how it's going.
function value(app: GameApp): string {
  if (app.state === "queued") return "Waiting…";
  if (app.state === "installing") return "Installing…";
  if (app.state === "removing") return "Removing…";
  if (app.installed) return "Remove";
  if (app.state === "failed") return "Couldn't install · Try again";
  return "Add";
}

// The line over the list: which games need a mouse and keyboard, from what
// each one's description says after its first sentence.
export function needsLine(apps: { name: string; description: string }[]): string | null {
  const needs = apps.filter((app) => /^Needs a mouse and keyboard\.?$/.test(app.description.split(/(?<=\.)\s+/).slice(1).join(" ")));
  if (!needs.length) return null;
  const names = needs.map((app) => app.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? "needs" : "need"} a mouse and keyboard`;
}

export function gamesPanel(ctx: Ctx): HTMLElement[] {
  const adult = ctx.state.viewer.role === "adult";
  let els: HTMLElement[] = [];
  let busy: string | null = null;

  const failed = (text: string) => {
    ctx.sounds.play("failure");
    ctx.toast(text, "fail");
  };

  const act = async (app: GameApp, path: string, words: { done: string; fail: string }) => {
    if (busy) return;
    const grant = await ctx.grant("settings");
    if (grant === null) return;
    busy = app.id;
    let answer: Answer<Games> | null = null;
    try {
      answer = await call<Games>("POST", path, { id: app.id }, grant || undefined);
    } catch {
      answer = null;
    }
    busy = null;
    if (!answer) failed("Your TV isn't ready yet. Try again in a moment.");
    else if (answer.data.pin) {
      ctx.forgetGrant();
      failed("That needs the PIN. Try again.");
    } else if (!answer.data.ok) failed(answer.data.error ?? words.fail);
    else {
      ctx.sounds.play("confirm");
      ctx.toast(words.done, "ok");
    }
    await loadGames();
    draw();
  };

  const choose = (app: GameApp) => {
    if (!adult) return;
    if (app.state === "queued" || app.state === "installing") return ctx.toast(`Installing ${app.name}…`);
    if (app.state === "removing") return ctx.toast(`Removing ${app.name}…`);
    if (app.installed) return void act(app, "/api/games/remove", { done: `Removing ${app.name}. Your games and saves stay.`, fail: `Couldn't remove ${app.name}` });
    return void act(app, "/api/apps/add", { done: `Adding ${app.name}…`, fail: `Couldn't add ${app.name}` });
  };

  function build(): HTMLElement[] {
    const parts: HTMLElement[] = [h("div", { class: "panel-title" }, "Games")];
    if (!games) return parts;
    if (!games.apps.length) return [...parts, h("p", { class: "panel-note" }, games.error ? "Couldn't load the games. Try again later." : "No games to add yet")];
    // Which need a mouse and keyboard, at the top, where it's always in
    // view while the list scrolls.
    const needs = needsLine(games.apps);
    if (needs) parts.push(h("p", { class: "panel-note", "data-note": "games" }, needs));
    parts.push(
      ...games.apps.map((app) =>
        h(
          adult ? "button" : "div",
          { class: "button wide", "data-focus": adult ? true : undefined, "data-action": `game-${app.id}`, "data-game": app.installed ? "on" : "off", onclick: () => choose(app) },
          h("span", { class: "with-icon" }, glyph("gamepad", 32), asWritten(app.name)),
          h("span", { class: "button-value" }, adult ? value(app) : app.installed ? "On this TV" : ""),
        ),
      ),
    );
    return parts;
  }

  // Draws the list again with the focus where it was.
  function draw(): void {
    const parent = els[0]?.parentElement;
    const built = build();
    if (!parent) {
      els = built;
      return;
    }
    const at = ctx.focus.get();
    const action = at && els.some((el) => el === at || el.contains(at)) ? at.getAttribute("data-action") : null;
    els = built;
    parent.replaceChildren(...els);
    if (!action) return;
    const to = els.find((el) => el.getAttribute("data-action") === action) ?? els.find((el) => el.hasAttribute("data-focus"));
    if (to) ctx.focus.set(to, false);
  }

  draw();
  live = () => {
    if (els[0]?.isConnected) draw();
    else live = null;
  };
  // Asked for again as the page opens.
  void loadGames().then(() => live?.());
  return els;
}

// --- The Xbox controller driver ------------------------------------------------

function driverValue(state: Driver): string {
  if (state.state === "queued") return "Waiting…";
  if (state.state === "installing") return "Adding…";
  if (state.state === "failed") return "Couldn't add · Try again";
  if (state.installed) return state.restart ? "Restart to finish" : "On";
  return "Add";
}

// Phones and controllers' row: the driver that makes an Xbox controller's
// buttons work over Bluetooth. A cable needs none.
export function xboxRow(ctx: Ctx, redraw: () => void): HTMLElement | null {
  if (!driver) return null;
  const adult = ctx.state.viewer.role === "adult";
  const state = driver;
  const add = async () => {
    if (!adult || state.state === "queued" || state.state === "installing") return;
    if (state.installed && state.state !== "failed") {
      if (state.restart) ctx.toast("Restart your TV to finish. It's in Settings, under System.");
      return;
    }
    const grant = await ctx.grant("settings");
    if (grant === null) return;
    const answer = await call<{ driver?: Driver }>("POST", "/api/games/driver", {}, grant || undefined).catch(() => null);
    if (!answer) {
      ctx.sounds.play("failure");
      ctx.toast("Your TV isn't ready yet. Try again in a moment.", "fail");
    } else if (answer.data.pin) {
      ctx.forgetGrant();
      ctx.sounds.play("failure");
      ctx.toast("That needs the PIN. Try again.", "fail");
    } else if (!answer.data.ok) {
      ctx.sounds.play("failure");
      ctx.toast(answer.data.error ?? "Couldn't add the driver", "fail");
    } else {
      if (answer.data.driver) driver = answer.data.driver;
      ctx.sounds.play("confirm");
      ctx.toast("Adding Xbox controller support…", "ok");
    }
    redraw();
  };
  return h(
    adult ? "button" : "div",
    { class: "button wide", "data-focus": adult ? true : undefined, "data-action": "xbox-driver", onclick: () => void add() },
    h("span", { class: "with-icon" }, glyph("gamepad", 32), h("span", {}, "Xbox controllers")),
    h("span", { class: "button-value" }, driverValue(state)),
  );
}
