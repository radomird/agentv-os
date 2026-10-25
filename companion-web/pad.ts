// The parent PIN on the phone (ADR-009, board 07): four boxes and a pad,
// over the page. The box checks it and gives a grant for what asked.

import { glyph } from "../launcher/glyphs.ts";
import { api, h, NeedsPin, prompt } from "./lib.ts";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

// The grant for an action, or null when the pad was closed.
export function askPin(what: string): Promise<string | null> {
  return new Promise((resolve) => {
    let digits = "";
    let busy = false;
    const boxes = Array.from({ length: 4 }, () => h("span", { class: "pin-box" }));
    const message = h("p", { class: "note" }, `for ${what}.`);
    const draw = () => boxes.forEach((box, i) => box.classList.toggle("filled", i < digits.length));
    const done = (grant: string | null) => {
      overlay.remove();
      resolve(grant);
    };
    const enter = async () => {
      busy = true;
      try {
        const reply = await api<{ grant: string }>("POST", "/api/phone/pin", { pin: digits });
        done(reply.grant);
      } catch (error) {
        digits = "";
        draw();
        message.textContent = `${(error as Error).message}.`;
        message.classList.add("bad");
        navigator.vibrate?.([30, 40, 30]);
      }
      busy = false;
    };
    const type = (key: string) => {
      if (busy) return;
      if (key === "⌫") digits = digits.slice(0, -1);
      else if (digits.length < 4) digits += key;
      draw();
      if (digits.length === 4) void enter();
    };
    const overlay = h(
      "div",
      { class: "overlay", role: "dialog", "aria-label": "the parent pin" },
      h(
        "div",
        { class: "page" },
        prompt("tv pin"),
        h("h1", {}, "enter the parent pin"),
        message,
        h("div", { class: "pin-boxes" }, ...boxes),
        h(
          "div",
          { class: "pin-keys" },
          ...KEYS.map((key) =>
            key === "⌫"
              ? h("button", { type: "button", class: "pin-key pin-delete", "aria-label": "delete", "data-pin": "delete", onclick: () => type(key) }, glyph("backspace", 28))
              : key
                ? h("button", { type: "button", class: "pin-key", "data-pin": key, onclick: () => type(key) }, key)
                : h("span", {}),
          ),
        ),
        h("button", { type: "button", class: "button", "data-action": "cancel", onclick: () => done(null) }, "cancel"),
      ),
    );
    document.body.append(overlay);
  });
}

// Runs a request, and once more with the grant when the box says it needs
// the PIN. Null when the pad was closed.
export async function withPin<T>(what: string, run: (grant?: string) => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof NeedsPin)) throw error;
    const grant = await askPin(what);
    return grant === null ? null : run(grant);
  }
}
