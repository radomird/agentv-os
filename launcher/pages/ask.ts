// The TV's Ask (ADR-068, D5): one box for everything you'd say to the TV.
// You type in it here, on a keyboard on the box, or on your phone, whose
// keyboard comes up by itself while the box has focus. "continue" and
// "what's new" do what they always did, and "make me a game like tetris"
// or "change blocks: make the pieces fall faster" ask your agent to build.
//
// What comes of a sentence shows under the box. A make opens its build's
// page, which shows what your agent understood for you to confirm, and a
// change waits for an adult's ok on its own page here (said.ts opens both,
// whether the sentence came from this box or a phone).
//
// It's behind the askbuilds switch. With it off, the bar's Ask is an
// adult's and opens "make an app", as it did.

import { daemon, type Outcome, type Said } from "../api.ts";
import { h } from "../dom.ts";
import { onFeatures } from "../features.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

let on = false;

// Whether the Ask box builds, as the askbuilds switch says, followed
// without a reload.
export function askBuilds(): boolean {
  return on;
}

export function followAskBuilds(changed: () => void): void {
  onFeatures((all) => {
    const now = all.askbuilds === true;
    if (now === on) return;
    on = now;
    changed();
  });
}

// What the box starts with, once: "change blocks: " from an app's "change
// it", or one of Apps' examples.
let prefill = "";

export function askWith(ctx: Ctx, text: string): void {
  prefill = text;
  ctx.go("ask");
}

// Whether the Ask page is up, saying what came of a sentence in its own
// line, so said.ts leaves out the toasts.
let page: HTMLElement | null = null;
let heardLine: HTMLElement | null = null;

export function askShowing(): boolean {
  return page?.isConnected === true;
}

// Any sentence, this box's or a phone's, as the daemon tells it: the page's
// line says it's thinking, then what came of it.
export function askHeard(said: Said): void {
  if (!askShowing() || !heardLine) return;
  heardLine.textContent = said.state === "routing" ? "thinking" : line(said.outcome);
  // Why nothing happened stands out: a child's "ask a grown-up", or where
  // to set up an AI.
  heardLine.classList.toggle("ask-no", said.state === "done" && said.outcome?.kind === "none");
}

// Examples of what to make, for Apps with nothing your agent made yet, and
// the box's own suggestions.
export const EXAMPLES = ["make a game like tetris", "make a slideshow of the photos on my nas", "make a better weather app"];

export function askPage(ctx: Ctx): View {
  const adult = ctx.state.viewer.role === "adult";
  const field = h("input", {
    class: "music-search build-ask ask-field",
    "data-focus": true,
    "data-field": "ask",
    type: "text",
    maxlength: "300",
    value: prefill,
    placeholder: adult ? "make me a game like tetris" : "continue my show",
    "aria-label": "what do you want",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  prefill = "";
  // A box that starts with words takes the caret after them.
  field.addEventListener("focus", () => field.setSelectionRange(field.value.length, field.value.length), { once: true });
  const said = h("p", { class: "panel-note ask-said", "aria-live": "polite" }, adult ? "type here, or on your phone. your agent can make apps too." : "type here, or on your phone.");
  let asking = false;
  const send = async (sentence: string) => {
    const words = sentence.trim();
    if (!words || asking) return;
    asking = true;
    said.textContent = "thinking";
    said.classList.remove("ask-no");
    let heard: Said;
    try {
      heard = await daemon.say(words);
    } catch (error) {
      ctx.sounds.play("failure");
      said.textContent = (error as Error).message;
      said.classList.add("ask-no");
      return;
    } finally {
      asking = false;
    }
    if (!said.isConnected) return;
    field.value = "";
    askHeard(heard);
  };
  // Your agent's newest app, for "change <it>: ".
  const made = ctx.state.apps.filter((app) => app.tier === "local");
  const newest = made[made.length - 1];
  const suggestions: { label: string; run: () => void }[] = [
    { label: "continue", run: () => void send("continue") },
    { label: "what's new", run: () => void send("what's new") },
    ...(adult ? [{ label: EXAMPLES[0], run: () => void send(EXAMPLES[0]) }] : []),
    ...(adult && newest
      ? [
          {
            label: `change ${newest.name.toLowerCase()}`,
            run: () => {
              field.value = `change ${newest.name.toLowerCase()}: `;
              ctx.focus.set(field);
            },
          },
        ]
      : []),
  ];
  const chips = suggestions.map((s) => h("button", { class: "button", "data-focus": true, "data-suggestion": s.label, onclick: s.run }, s.label));
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page profile ask-page" },
      ...heading(adult ? "ask" : `ask · ${ctx.state.viewer.name.toLowerCase()}`, "what do you want?"),
      field,
      said,
      h("div", { class: "check-actions ask-suggestions" }, ...chips),
    ),
    bar(ctx, "ask", "↵ ask · esc back"),
  );
  page = el;
  heardLine = said;
  return {
    el,
    first: field,
    act(action) {
      if (action !== "ok" || ctx.focus.get() !== field) return false;
      void send(field.value);
      return true;
    },
  };
}

// What came of it, in the box's own line.
function line(outcome: Outcome | undefined): string {
  if (!outcome) return "";
  if (outcome.kind === "choose") return `${outcome.say} pick one below`;
  return outcome.say;
}

// --- A change, waiting for an adult's ok -----------------------------------

let waiting: { n: number; app: string; name: string; what: string; recipe: string | null } | null = null;

// said.ts sets it as the daemon tells it, then opens the page.
export function changeWaiting(n: number, outcome: Extract<Outcome, { kind: "change" }>): void {
  waiting = { n, app: outcome.app, name: outcome.name, what: outcome.what, recipe: outcome.recipe };
}

// The kind of recipe an app is built from, as the confirm says it (ADR-046).
export function recipeLine(recipe: string | null): string {
  return recipe ? `recipe: ${recipe}` : "no recipe yet: a plan for your ok";
}

export function askChangePage(ctx: Ctx): View {
  const change = waiting;
  if (!change) {
    const el = h("div", { class: "screen" }, h("div", { class: "page profile" }, ...heading("agentv change", "nothing to change.")), bar(ctx, "ask", "esc back"));
    return { el };
  }
  const name = change.name.toLowerCase();
  let busy = false;
  const act = async (what: "confirm" | "cancel") => {
    if (busy) return;
    busy = true;
    try {
      if (what === "confirm") await daemon.askConfirm(change.n);
      else await daemon.askCancel(change.n);
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      busy = false;
      return;
    }
    waiting = null;
    ctx.sounds.play(what === "confirm" ? "confirm" : "back");
    // A change that's building opens its page as the daemon tells it
    // (said.ts); "not this" goes back.
    if (what === "cancel") ctx.back();
  };
  const build = h("button", { class: "button primary", "data-focus": true, "data-action": "confirm", onclick: () => void act("confirm") }, "↵ build it");
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page profile build-page ask-change", "data-state": "confirm" },
      ...heading(`agentv change ${change.app.replace(/^local\./, "")} "${change.what.toLowerCase()}"`, `change ${name}?`),
      h("p", { class: "panel-note" }, `${recipeLine(change.recipe)} · it stays on this tv`),
      h("div", { class: "check-actions" }, build, h("button", { class: "button", "data-focus": true, "data-action": "forget", onclick: () => void act("cancel") }, "not this")),
    ),
    bar(ctx, "ask", "↵ build it · esc back"),
  );
  return { el, first: build };
}
