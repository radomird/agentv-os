// Controllers on the TV (ADR-084): Settings, controllers lists the game
// controllers paired over Bluetooth, the ones nearby and the ones on a cable,
// pairs one with OK and removes one. Only game controllers ever show: the TV
// checks that itself, so a keyboard nearby is never offered. The TV looks
// for controllers only while this section is on screen: the page asks every
// couple of seconds, and the looking stops soon after it stops asking.
//
// The words here are written in sentence case with real names, as D8 has
// them. Terminal shows lower case, so they're lowered as they're drawn
// there, and a controller's own name is left as it is in every look.

import { h } from "../dom.ts";
import { glyph } from "../glyphs.ts";
import type { Ctx } from "../main.ts";

export interface ControllerInfo {
  id: string;
  name: string;
  paired: boolean;
  connected: boolean;
}

interface State {
  ok: boolean;
  // "away": the TV's own session didn't answer, as right after it starts.
  bluetooth: "on" | "off" | "none" | "away";
  looking: boolean;
  controllers: ControllerInfo[];
  usb: string[];
  why?: "none" | "off" | "not-a-controller" | "gone" | "code" | "failed";
  error?: string;
  pin?: boolean;
}

// How often the open page asks again, which keeps the TV looking.
const AGAIN_MS = 2000;

// Terminal's words are lower case, as part of its look. A name put in for
// {name} keeps its own capitals.
function words(text: string, name?: string): string {
  const look = document.documentElement.dataset.look;
  const said = !look || look === "terminal" ? text.toLowerCase() : text;
  return name === undefined ? said : said.replace("{name}", name);
}

// Pairing and removing are an adult's: with a PIN set, they send its grant.
async function call(method: string, path: string, body?: unknown, grant?: string): Promise<State> {
  const response = await fetch(path, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive: true,
  });
  return (await response.json()) as State;
}

// Kept between visits so Settings draws at once.
let state: State | null = null;
// The panel on screen. A panel drawn since takes over the asking.
let live: object | null = null;

const count = () => (state ? state.controllers.filter((one) => one.connected).length + state.usb.length : null);

function showCount(): void {
  const item = document.querySelector<HTMLElement>('.menu-item[data-key="controllers"] .menu-value');
  if (item) item.textContent = String(count() ?? "");
}

export const controllersLabel = () => words("Controllers");

// How many are connected, for Settings' list, once the section has been
// opened. Settings never waits on the TV's Bluetooth to draw itself.
export const controllersValue = () => String(count() ?? "");

export function controllersPanel(ctx: Ctx): HTMLElement[] {
  const me = {};
  live = me;
  let els: HTMLElement[] = [];
  let busy: string | null = null; // the controller pairing or going, or "power"
  let drawn = "";

  const failed = (text: string) => {
    ctx.sounds.play("failure");
    ctx.toast(text, "fail");
  };
  // An answer that asks for the PIN: the grant it came with has run out.
  const refused = (answer: State): boolean => {
    if (!answer.pin) return false;
    ctx.forgetGrant();
    failed(words("That needs the PIN. Try again."));
    return true;
  };
  const take = (answer: State) => {
    if (Array.isArray(answer.controllers)) state = answer;
    showCount();
  };

  // One adult action: the grant, the call, and the list as it is after.
  const act = async (key: string, send: (grant: string) => Promise<State>, done: (answer: State) => void) => {
    if (busy) return;
    const grant = await ctx.grant("settings");
    if (grant === null) return;
    busy = key;
    draw();
    let answer: State | null = null;
    try {
      answer = await send(grant);
    } catch {
      answer = null;
    }
    busy = null;
    if (!answer) failed(words("Your TV isn't ready yet. Try again in a moment."));
    else if (!refused(answer)) {
      take(answer);
      done(answer);
    }
    draw();
  };

  const pair = (one: ControllerInfo) =>
    act(
      one.id,
      (grant) => call("POST", "/api/controllers/pair", { id: one.id }, grant),
      (answer) => {
        if (answer.ok) {
          ctx.sounds.play("confirm");
          ctx.toast(words("Paired {name}", one.name), "ok");
        } else if (answer.why === "code") failed(words("Couldn't pair {name}. If it asks for a code, use a cable instead.", one.name));
        else if (answer.why === "not-a-controller") failed(words("Couldn't pair {name}. Only game controllers pair here.", one.name));
        else if (answer.bluetooth === "away") failed(words("Your TV isn't ready yet. Try again in a moment."));
        else failed(words("Couldn't pair {name}. Put it in pairing mode and try again.", one.name));
      },
    );
  const remove = (one: ControllerInfo) =>
    act(
      one.id,
      (grant) => call("DELETE", `/api/controllers/${one.id}`, undefined, grant),
      (answer) => {
        if (answer.ok) {
          ctx.sounds.play("confirm");
          ctx.toast(words("Removed {name}", one.name), "ok");
        } else failed(words("Couldn't remove {name}. Try again.", one.name));
      },
    );
  const power = () =>
    act(
      "power",
      (grant) => call("POST", "/api/controllers/power", {}, grant),
      (answer) => {
        if (answer.ok) ctx.sounds.play("confirm");
        else failed(words("Couldn't turn on Bluetooth. Try again."));
      },
    );

  const named = (name: string) => h("span", { class: "with-icon" }, glyph("gamepad", 32), h("span", { "data-own-case": true }, name));
  const note = (text: string) => h("p", { class: "panel-note", "data-note": "controllers" }, words(text));

  function build(): HTMLElement[] {
    const parts: HTMLElement[] = [h("div", { class: "panel-title" }, words("Controllers"))];
    if (!state) return parts;
    if (state.bluetooth === "away") return [...parts, note("Your TV isn't ready yet. Try again in a moment.")];
    const usb = state.usb.map((name) => h("div", { class: "button wide", "data-controller": "usb" }, named(name), h("span", { class: "button-value" }, words("Plugged in"))));
    if (state.bluetooth === "none") return [...parts, ...usb, note("Your TV has no Bluetooth. Plug a controller in with a cable.")];
    if (state.bluetooth === "off") {
      return [
        ...parts,
        ...usb,
        h(
          "button",
          { class: "button primary", "data-focus": true, "data-action": "bluetooth-on", onclick: () => void power() },
          h("span", {}, words("Turn on Bluetooth")),
          h("span", { class: "button-value" }, busy === "power" ? words("Turning on…") : ""),
        ),
      ];
    }
    const paired = state.controllers.filter((one) => one.paired);
    const nearby = state.controllers.filter((one) => !one.paired);
    parts.push(
      ...paired.map((one) =>
        h(
          "button",
          { class: "button wide", "data-focus": true, "data-action": `controller-${one.id}`, "data-controller": "paired", onclick: () => void remove(one) },
          named(one.name),
          h("span", { class: "button-value" }, busy === one.id ? words("Removing…") : words(one.connected ? "Connected · Remove" : "Not connected · Remove")),
        ),
      ),
      ...usb,
      ...nearby.map((one) =>
        h(
          "button",
          { class: "button wide", "data-focus": true, "data-action": `controller-${one.id}`, "data-controller": "nearby", onclick: () => void pair(one) },
          named(one.name),
          h("span", { class: "button-value" }, busy === one.id ? words("Pairing…") : words("Pair")),
        ),
      ),
      note("To add one, hold its pairing button until it blinks"),
    );
    return parts;
  }

  // Draws the list again where it changed, with the focus where it was: on
  // the same controller, or the row that took its place.
  function draw(): void {
    const next = JSON.stringify([state, busy]);
    if (next === drawn && els.length) return;
    const parent = els[0]?.parentElement;
    const built = build();
    if (!els.length || !parent) {
      // Not on screen yet: Settings puts these in its panel.
      if (!els.length) els = built;
      drawn = next;
      return;
    }
    const at = ctx.focus.get();
    const inside = at ? els.findIndex((el) => el === at || el.contains(at)) : -1;
    const action = inside >= 0 ? at?.getAttribute("data-action") : null;
    els = built;
    drawn = next;
    parent.replaceChildren(...els);
    if (inside < 0) return;
    const rows = els.filter((el) => el.hasAttribute("data-focus"));
    const to = rows.find((el) => el.getAttribute("data-action") === action) ?? rows[0] ?? document.querySelector<HTMLElement>('.menu-item[data-key="controllers"]');
    if (to) ctx.focus.set(to, false);
  }

  // Asks while this panel is the one on screen, and tells the TV to stop
  // looking once it's gone, unless a panel drawn since has taken over.
  const again = async () => {
    await new Promise((done) => setTimeout(done, 0));
    for (;;) {
      if (live !== me) return;
      if (!els[0]?.isConnected) {
        live = null;
        void call("POST", "/api/controllers/look", { on: false }).catch(() => {});
        return;
      }
      // Under the screen saver nobody is pairing anything, so the asking
      // rests, and the TV stops looking a few seconds later.
      if (!busy && !document.querySelector("#ambient.on")) {
        const answer = await call("POST", "/api/controllers/look", { on: true }).catch(() => null);
        if (live !== me) return;
        if (answer && !busy) {
          take(answer);
          draw();
        }
      }
      await new Promise((done) => setTimeout(done, AGAIN_MS));
    }
  };

  draw();
  void again();
  return els;
}
