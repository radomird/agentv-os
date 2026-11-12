// The listening bar on home (ADR-054): along the bottom while someone talks
// to the TV from their phone. It says it's listening as the phone's box
// opens, shows the words as the phone's dictation fills them in, says it's
// thinking once the sentence is sent, then shows what came of it in place
// of a toast. "Which one?" brings its card over home as well (said.ts).
// Closing the box on the phone, Back here, or a while with no new words
// takes it away. Over an app in front, the TV session's overlay draws the
// same bar.
//
// It moves to say it's listening, not to show a sound level: the phone's
// keyboard does the listening. Opacity only, and still with reduce motion.

import { daemon, type Said } from "./api.ts";
import { h } from "./dom.ts";

export interface Heard {
  state: "open" | "words" | "closed";
  text: string;
}

let el: HTMLElement | null = null;
let words: HTMLElement | null = null;
let says: HTMLElement | null = null;
// What the bar is showing, and for which sentence once one was sent.
let state: "off" | "listening" | "thinking" | "said" = "off";
let sentence = 0;
let done: ReturnType<typeof setTimeout> | undefined;

function ensure(): HTMLElement {
  if (el) return el;
  words = h("div", { class: "listening-words" });
  says = h("div", { class: "listening-says" });
  el = h("div", { id: "listening", "aria-live": "polite" }, h("div", { class: "listening-dots", "aria-hidden": "true" }, h("span", {}), h("span", {}), h("span", {})), words, says);
  document.body.append(el);
  return el;
}

function show(next: typeof state, text: string): void {
  const bar = ensure();
  clearTimeout(done);
  done = undefined;
  state = next;
  bar.dataset.state = next;
  bar.classList.add("on");
  words!.textContent = tail(text);
  says!.textContent = next === "thinking" ? "Thinking" : "";
}

// The newest words, as many as fit on the bar at the TV's size.
function tail(text: string): string {
  return text.length > 64 ? `…${text.slice(-63).replace(/^\S*\s/, "")}` : text;
}

function hide(): void {
  clearTimeout(done);
  done = undefined;
  state = "off";
  sentence = 0;
  el?.classList.remove("on");
  if (el) delete el.dataset.state;
}

export function listeningUp(): boolean {
  return state !== "off";
}

// The phone's box opened, its words changed, or it closed unsent.
export function listeningHeard(heard: Heard): void {
  if (heard.state === "closed") {
    if (state === "listening") hide();
    return;
  }
  // A new box after a sentence: listening again, and what comes of the
  // last one is a toast.
  sentence = 0;
  show("listening", heard.state === "words" ? heard.text : "Listening");
}

// A sentence as the daemon tells it. True when the bar showed it, so it
// isn't a toast too.
export function barTakes(said: Said | null): boolean {
  if (!said) {
    if (state === "said" || state === "thinking") hide();
    return false;
  }
  if (said.state === "routing") {
    if (state !== "listening") return false;
    sentence = said.n;
    show("thinking", said.sentence);
    return true;
  }
  if (sentence !== said.n || !said.outcome) return false;
  show("said", said.outcome.say);
  // "Which one?" stays as long as its card; anything else a moment.
  if (said.outcome.kind !== "choose") done = setTimeout(hide, 6000);
  return true;
}

// The card was put away, or a pick from it failed: a bar waiting on it goes
// too. A pick that went through leaves the bar to its outcome.
export function cardClosed(): void {
  if (state === "said" && !done) hide();
}

// Back with the bar up and no card over it: the bar goes.
export function listeningAct(action: string): boolean {
  if (state === "off" || action !== "back") return false;
  const listening = state === "listening";
  hide();
  if (listening) void daemon.closeListening().catch(() => {});
  return true;
}
