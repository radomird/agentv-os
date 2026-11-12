// The typing bar on home (ADR-065): low on the screen while someone types on
// their phone, with whose phone it is and what's arriving, so the TV shows
// it as it's typed. A password arrives as dots from the daemon, which never
// sends it here. It goes after a few seconds with nothing new, on Enter, and
// when the field loses the focus. Over an app in front, the TV session's
// overlay draws the same bar.

import { h } from "./dom.ts";

export interface Typing {
  from: string;
  text: string;
  password: boolean;
}

const IDLE_MS = 6000;

let el: HTMLElement | null = null;
let who: HTMLElement | null = null;
let text: HTMLElement | null = null;
let done: ReturnType<typeof setTimeout> | undefined;

function ensure(): HTMLElement {
  if (el) return el;
  who = h("span", { class: "typing-who" });
  // What someone types keeps its capitals in every look.
  text = h("span", { class: "typing-text", "data-own-case": true });
  el = h("div", { id: "typing", "aria-live": "polite" }, who, h("span", { class: "typing-value" }, text, h("span", { class: "typing-caret", "aria-hidden": "true" })));
  document.body.append(el);
  return el;
}

function hide(): void {
  clearTimeout(done);
  done = undefined;
  el?.classList.remove("on");
}

// What the daemon says is arriving, or null when it's done.
export function typingHeard(data: unknown): void {
  const typing = data as Typing | null;
  if (!typing || typeof typing.text !== "string") {
    hide();
    return;
  }
  const bar = ensure();
  bar.classList.toggle("password", typing.password === true);
  who!.textContent = String(typing.from ?? "");
  text!.textContent = typing.text;
  bar.classList.add("on");
  clearTimeout(done);
  done = setTimeout(hide, IDLE_MS);
}

// The field lost the focus: nothing more arrives for it.
export function typingField(field: unknown): void {
  if (!field) hide();
}
