// Cinema's bar (D1): tabs along the top for Home, Apps and Ask, with the
// page's own one filled, and Settings, the time and the profile's picture at
// the top right.

import { h } from "../../dom.ts";
import type { Ctx } from "../../main.ts";
import { avatar, time } from "../chrome.ts";
import { icon } from "../icons.ts";
import { keyHints, sections } from "../parts.ts";

export function bar(ctx: Ctx, mode: string, info = "", step?: (HTMLElement | string)[]): HTMLElement {
  const all = sections(ctx);
  const tab = (key: string) => {
    const section = all.find((one) => one.key === key);
    if (!section) return null;
    return h(
      "button",
      { class: `bar-link bar-tab${key === mode ? " on" : ""}`, "data-focus": true, "data-action": `bar-${key}`, onclick: section.open },
      key === "ask" ? icon("ask", 26) : null,
      h("span", {}, section.label),
    );
  };
  const settings = all.find((one) => one.key === "settings")!;
  const note = keyHints(info) ? "" : info;
  return h(
    "div",
    { class: "bar cinema-bar" },
    h("div", { class: "bar-left" }, tab("home"), tab("apps"), tab("ask")),
    h(
      "div",
      { class: "bar-right" },
      note ? h("span", { class: "bar-note" }, note) : null,
      h(
        "button",
        { class: `bar-link bar-icon${mode === "settings" ? " on" : ""}`, "data-focus": true, "data-action": "bar-settings", "aria-label": settings.label, onclick: settings.open },
        icon("settings", 30),
        settings.label.endsWith("●") ? h("span", { class: "bar-dot" }) : null,
      ),
      time(),
      avatar(ctx),
    ),
    step ? h("div", { class: "bar-step-row" }, ...step) : null,
  );
}
