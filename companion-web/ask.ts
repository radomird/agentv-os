// The phone's Ask (ADR-068, D5), with the askbuilds switch on: the same box
// as the TV's. What you type shows on the TV as you type it, the keyboard's
// microphone works, and its send key asks. A few suggestions sit under it.
//
// When your agent is on something you asked for, the sheet shows it:
// - a make it's reading, then what it understood, with its recipe or a
//   plan, for you to build or turn down;
// - a change waiting for your ok;
// - a build's steps, until it's ready for your ok, which comes as a notice
//   and is approved with the PIN as before.

import { api, h } from "./lib.ts";
import { icon } from "./icons.ts";
import { sayBox, type Said } from "./say.ts";

// What the Ask box waits on (daemon/routes/ask.ts).
export type AskView =
  | { kind: "build"; n: number; build: string; app: string | null; what: string; state: string; phase: string; name: string | null; recipe: string | null; says: string | null; done: number; steps: number }
  | { kind: "change"; n: number; app: string; name: string; what: string; recipe: string | null };

// A request that's new to the TV gets its steps checked before it's made.
const STEPS_FIRST = "You'll check the steps first";

export function askSheet(said: Said | null | undefined, ask: AskView | null | undefined, adult: boolean, failed: (error: unknown) => void, done: () => void): HTMLElement[] {
  let value = "";
  const box = () => sayBox(said, failed, done, { bare: true, placeholder: adult ? "make me a puzzle game" : "continue my show", value });
  let field = box();
  const send = (sentence: string) => {
    void api("POST", "/api/phone/say", { sentence }).then(done, failed);
  };
  // A suggestion to make something fills the box and leaves the keyboard
  // up, to change it or send it.
  const fill = (text: string) => {
    value = text;
    const fresh = box();
    field.replaceWith(fresh);
    field = fresh;
    const input = field.querySelector("input");
    input?.focus();
    input?.setSelectionRange(text.length, text.length);
  };
  const chips = [
    h("button", { type: "button", class: "chip", "data-suggestion": "continue", onclick: () => send("continue") }, "Continue my show"),
    h("button", { type: "button", class: "chip", "data-suggestion": "what's new", onclick: () => send("what's new") }, "What's new this week?"),
    adult ? h("button", { type: "button", class: "chip", "data-suggestion": "make a game", onclick: () => fill("make a puzzle game") }, "Make a puzzle game") : null,
  ];
  requestAnimationFrame(() => field.querySelector("input")?.focus());
  return [
    h("p", { class: "r2-label ask-label" }, icon("ask", 16), h("span", {}, "Ask")),
    h("h1", {}, "What would you like?"),
    field,
    h("p", { class: "note" }, "Shows on your TV as you type · your keyboard's mic works too"),
    h("div", { class: "ask-chips" }, ...chips),
    ...(ask && adult ? [waiting(ask, failed, done)] : []),
  ].filter((el): el is HTMLElement => el !== null);
}

// The sheet's card for what your agent is on, drawn again as it moves on,
// without touching the box someone may be typing in.
export function refreshAsk(ask: AskView | null | undefined, adult: boolean, failed: (error: unknown) => void, done: () => void): void {
  const chips = document.querySelector(".ask-chips");
  if (!chips) return;
  document.querySelector(".ask-waiting")?.remove();
  if (ask && adult) chips.after(waiting(ask, failed, done));
}

// What your agent is on, from what was asked.
function waiting(ask: AskView, failed: (error: unknown) => void, done: () => void): HTMLElement {
  const answer = (what: "confirm" | "cancel") => () => void api("POST", `/api/phone/ask/${what}`, { n: ask.n }).then(done, failed);
  const buttons = (yes: string) =>
    h(
      "div",
      { class: "build-buttons" },
      h("button", { type: "button", class: "button primary", "data-action": "ask-confirm", onclick: answer("confirm") }, yes),
      h("button", { type: "button", class: "button", "data-action": "ask-cancel", onclick: answer("cancel") }, "Not this"),
    );
  if (ask.kind === "change") {
    return h("div", { class: "ask-waiting", "data-ask": "change" }, h("p", { class: "r2-label" }, "Your own app"), h("h1", {}, `Change ${ask.name}?`), h("p", { class: "note" }, ask.what), ask.recipe ? null : h("p", { class: "note" }, STEPS_FIRST), buttons("Make it"));
  }
  const name = ask.name ?? ask.what;
  if (ask.state === "confirm") {
    return h("div", { class: "ask-waiting", "data-ask": "confirm" }, h("p", { class: "r2-label" }, "Your own app"), h("h1", {}, `Make ${name}?`), h("p", { class: "note" }, ask.recipe ? "It stays on this TV" : STEPS_FIRST), buttons("Make it"));
  }
  if ((ask.state === "starting" || ask.state === "running") && ask.phase === "understand") {
    return h("div", { class: "ask-waiting", "data-ask": "reading" }, h("p", { class: "r2-label" }, "Your own app"), h("p", { class: "note" }, "Working out what you'd like…"));
  }
  if (ask.state === "starting" || ask.state === "running") {
    const bar = h("div", { class: "ask-bar", role: "img", "aria-label": `${ask.done} of ${ask.steps} steps done` }, h("span", {}));
    (bar.firstElementChild as HTMLElement).style.width = `${ask.steps ? Math.round((ask.done / ask.steps) * 100) : 0}%`;
    return h(
      "div",
      { class: "ask-waiting", "data-ask": "building" },
      h("p", { class: "r2-label" }, "Your own app"),
      h("h1", {}, `Making ${name}`),
      bar,
      h("p", { class: "note" }, ask.steps ? `${ask.done} of ${ask.steps} steps. You'll hear when it's ready.` : "You'll hear when it's ready"),
    );
  }
  // A plan or a finished app waits for the PIN in its notice, and a build
  // that failed says why on the TV.
  return h("div", { class: "ask-waiting", "data-ask": ask.state }, h("p", { class: "note" }, ask.state === "failed" ? `Couldn't make ${name}. See your TV.` : `${name}: see your notices`));
}
