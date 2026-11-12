// Controllers on the TV (ADR-084): Settings, Phones and controllers has a
// row for each game controller the TV has, paired over Bluetooth or on a
// cable, and "Pair a controller" opens this page, which lists them with the
// ones nearby, pairs one with OK and removes one. Only game controllers ever
// show: the TV checks that itself, so a keyboard nearby is never offered.
// The TV looks for controllers only while this page is on screen: it asks
// every couple of seconds, and the looking stops soon after it stops asking.
//
// The words are written in sentence case with real names, as D8 has them.
// Terminal shows them in lower case with its own CSS rule, and a
// controller's own name is marked so it's left as it is in every look.

import { asWritten, h } from "../dom.ts";
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

// A line with a controller's name in it, which keeps its own capitals.
function withName(text: string, name: string): Node {
  const [before, after = ""] = text.split("{name}");
  return h("span", {}, before, asWritten(name), after);
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

// One ask at a time: with the TV's own session away, an answer takes a few
// seconds, and Settings draws itself again in the meantime.
let asking: Promise<void> | null = null;

// Which controllers the TV has, without looking for more, for the rows in
// Settings. Settings never waits on the TV's Bluetooth to draw itself.
export function loadControllers(): Promise<void> {
  asking ??= call("GET", "/api/controllers")
    .then((answer) => {
      // The page, while it's open, knows better.
      if (!live && Array.isArray(answer.controllers)) state = answer;
    })
    .catch(() => {})
    .finally(() => (asking = null));
  return asking;
}

const named = (name: string) => h("span", { class: "with-icon" }, glyph("gamepad", 32), h("span", { "data-own-case": true }, name));

// Settings' rows: one for each controller that's paired, which opens the
// page on it, and one for each on a cable.
export function controllerRows(open?: (action: string) => void): HTMLElement[] {
  if (!state || state.bluetooth === "away") return [];
  return [
    ...state.controllers
      .filter((one) => one.paired)
      .map((one) =>
        h(
          "button",
          { class: "button wide", "data-focus": true, "data-action": `controller-${one.id}`, "data-controller": "paired", onclick: () => open?.(`controller-${one.id}`) },
          named(one.name),
          h("span", { class: "button-value" }, one.connected ? "Connected" : "Not connected"),
        ),
      ),
    ...state.usb.map((name) => h("div", { class: "button wide", "data-controller": "usb" }, named(name), h("span", { class: "button-value" }, "Plugged in"))),
  ];
}

export function controllersPanel(ctx: Ctx): HTMLElement[] {
  const me = {};
  live = me;
  let els: HTMLElement[] = [];
  let busy: string | null = null; // the controller pairing or going, or "power"
  let drawn = "";

  const failed = (text: string | Node) => {
    ctx.sounds.play("failure");
    ctx.toast(text, "fail");
  };
  // An answer that asks for the PIN: the grant it came with has run out.
  const refused = (answer: State): boolean => {
    if (!answer.pin) return false;
    ctx.forgetGrant();
    failed("That needs the PIN. Try again.");
    return true;
  };
  const take = (answer: State) => {
    if (Array.isArray(answer.controllers)) state = answer;
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
    if (!answer) failed("Your TV isn't ready yet. Try again in a moment.");
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
          ctx.toast(withName("Paired {name}", one.name), "ok");
        } else if (answer.why === "code") failed(withName("Couldn't pair {name}. If it asks for a code, use a cable instead.", one.name));
        else if (answer.why === "not-a-controller") failed(withName("Couldn't pair {name}. Only game controllers pair here.", one.name));
        else if (answer.bluetooth === "away") failed("Your TV isn't ready yet. Try again in a moment.");
        else failed(withName("Couldn't pair {name}. Put it in pairing mode and try again.", one.name));
      },
    );
  const remove = (one: ControllerInfo) =>
    act(
      one.id,
      (grant) => call("DELETE", `/api/controllers/${one.id}`, undefined, grant),
      (answer) => {
        if (answer.ok) {
          ctx.sounds.play("confirm");
          ctx.toast(withName("Removed {name}", one.name), "ok");
        } else failed(withName("Couldn't remove {name}. Try again.", one.name));
      },
    );
  const power = () =>
    act(
      "power",
      (grant) => call("POST", "/api/controllers/power", {}, grant),
      (answer) => {
        if (answer.ok) ctx.sounds.play("confirm");
        else failed("Couldn't turn on Bluetooth. Try again.");
      },
    );

  const note = (text: string) => h("p", { class: "panel-note", "data-note": "controllers" }, text);

  function build(): HTMLElement[] {
    const parts: HTMLElement[] = [h("div", { class: "panel-title" }, "Controllers")];
    if (!state) return parts;
    if (state.bluetooth === "away") return [...parts, note("Your TV isn't ready yet. Try again in a moment.")];
    const usb = state.usb.map((name) => h("div", { class: "button wide", "data-controller": "usb" }, named(name), h("span", { class: "button-value" }, "Plugged in")));
    if (state.bluetooth === "none") return [...parts, ...usb, note("Your TV has no Bluetooth. Plug a controller in with a cable.")];
    if (state.bluetooth === "off") {
      return [
        ...parts,
        ...usb,
        h(
          "button",
          { class: "button primary", "data-focus": true, "data-action": "bluetooth-on", onclick: () => void power() },
          h("span", {}, "Turn on Bluetooth"),
          h("span", { class: "button-value" }, busy === "power" ? "Turning on…" : ""),
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
          h("span", { class: "button-value" }, busy === one.id ? "Removing…" : one.connected ? "Connected · Remove" : "Not connected · Remove"),
        ),
      ),
      ...usb,
      ...nearby.map((one) =>
        h(
          "button",
          { class: "button wide", "data-focus": true, "data-action": `controller-${one.id}`, "data-controller": "nearby", onclick: () => void pair(one) },
          named(one.name),
          h("span", { class: "button-value" }, busy === one.id ? "Pairing…" : "Pair"),
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
    const to = rows.find((el) => el.getAttribute("data-action") === action) ?? rows[0] ?? document.querySelector<HTMLElement>(".menu-item.open");
    if (to) ctx.focus.set(to, false);
  }

  // Asks while this panel is the one on screen, and tells the TV to stop
  // looking once it's gone, unless a panel drawn since has taken over.
  const again = async () => {
    // Whether the last round found an app in front of home.
    let rested = false;
    await new Promise((done) => setTimeout(done, 0));
    for (;;) {
      if (live !== me) return;
      if (!els[0]?.isConnected) {
        live = null;
        void call("POST", "/api/controllers/look", { on: false }).catch(() => {});
        return;
      }
      // Under the screen saver nobody is pairing anything, and nor is
      // anyone with an app in front of home, opened from a phone. So the
      // asking rests: the TV stops looking a few seconds later under the
      // screen saver, and at once under an app.
      const behind = document.documentElement.hasAttribute("data-behind-app");
      if (behind && !rested) void call("POST", "/api/controllers/look", { on: false }).catch(() => {});
      rested = behind;
      if (!busy && !behind && !document.querySelector("#ambient.on")) {
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
