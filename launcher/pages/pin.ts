// The parent PIN on the TV (ADR-009, S4.5, board 07): four boxes that fill
// as the digits come, and a pad of 1 to 9, 0 and delete, picked with the
// arrows or typed with a keyboard's number keys, which the phone's keyboard
// sends too. It's drawn over everything but the Updating screen, and asks for
// the PIN before an adult action, chooses a new one in Settings → Parental,
// and locks the TV after the box starts and after the TV has been off.

import { h } from "../dom.ts";
import type { Action } from "../input.ts";

export interface PadOptions {
  command: string; // the prompt: "tv settings · pin"
  title: string; // "enter the parent pin"
  note: string; // what it's for
  // Four digits, checked: null when they're right, else what to say.
  submit(pin: string): Promise<string | null>;
  // Whether Back cancels it. The lock screen can't be cancelled.
  cancel: boolean;
  // Gives up after this long with no key, as when agentv-pin-check asks.
  idleMs?: number;
}

export interface Pad {
  el: HTMLElement;
  first: HTMLElement;
  act(action: Action): void;
  key(key: string): boolean;
  // True once the PIN was right, false when it was cancelled or gave up.
  done: Promise<boolean>;
  close(): void;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

export function pad(options: PadOptions, played: (sound: "select" | "confirm" | "failure") => void): Pad {
  let digits = "";
  let busy = false;
  let finish: (ok: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => (finish = resolve));
  const boxes = Array.from({ length: 4 }, () => h("span", { class: "pin-box" }));
  const message = h("p", { class: "panel-note pin-message" }, options.note);
  const draw = () => boxes.forEach((box, i) => box.classList.toggle("filled", i < digits.length));

  let timer = 0;
  const idle = () => {
    clearTimeout(timer);
    if (options.idleMs) timer = window.setTimeout(() => end(false), options.idleMs);
  };
  const end = (ok: boolean) => {
    clearTimeout(timer);
    finish(ok);
  };

  const enter = async () => {
    if (digits.length !== 4 || busy) return;
    busy = true;
    const why = await options.submit(digits).catch((error: Error) => error.message);
    busy = false;
    if (why === null) {
      played("confirm");
      end(true);
      return;
    }
    played("failure");
    digits = "";
    draw();
    message.textContent = `${why}.`;
    message.classList.add("bad");
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
  };

  const type = (key: string) => {
    idle();
    if (busy) return;
    if (key === "⌫") digits = digits.slice(0, -1);
    else if (/^\d$/.test(key) && digits.length < 4) digits += key;
    draw();
    if (digits.length === 4) void enter();
  };

  const buttons = KEYS.map((key) =>
    key
      ? h(
          "button",
          { class: `pin-key${key === "⌫" ? " pin-delete" : ""}`, "data-focus": true, "data-key": key === "⌫" ? "delete" : key, "aria-label": key === "⌫" ? "delete" : key, onclick: () => type(key) },
          key,
        )
      : h("span", {}),
  );
  const el = h(
    "div",
    { class: "pin-pad", role: "dialog", "aria-label": options.title },
    h("div", { class: "prompt" }, h("b", {}, "~"), ` $ ${options.command}`),
    h("h1", { class: "headline" }, options.title),
    message,
    h("div", { class: "pin-boxes", role: "img", "aria-label": "the digits entered" }, ...boxes),
    h("div", { class: "pin-keys" }, ...buttons),
  );
  idle();

  return {
    el,
    first: buttons[0],
    done,
    act(action) {
      idle();
      if (action === "back" && options.cancel) end(false);
    },
    // A number key or Backspace from a keyboard or the phone. True when the
    // pad took it.
    key(key) {
      if (/^\d$/.test(key)) {
        played("select");
        type(key);
        return true;
      }
      if (key === "Backspace" || key === "Delete") {
        type("⌫");
        return true;
      }
      return false;
    },
    close() {
      end(false);
    },
  };
}
