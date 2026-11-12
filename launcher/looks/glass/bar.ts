// Glass's bar (D1): one glass pill at the top right, with Ask, Apps and
// Settings as icons, then the time and the profile's picture. The page it's
// on lights its own icon. Home is Back or the remote's Home key.

import { h } from "../../dom.ts";
import type { Ctx } from "../../main.ts";
import { avatar, time } from "../chrome.ts";
import { icon } from "../icons.ts";
import { keyHints, sections } from "../parts.ts";

export function bar(ctx: Ctx, mode: string, info = "", step?: (HTMLElement | string)[], hint = ""): HTMLElement {
  const all = sections(ctx);
  // Ask, Apps and Settings, in that order (D1).
  const buttons = (["ask", "apps", "settings"] as const)
    .map((key) => all.find((section) => section.key === key))
    .filter((section) => section !== undefined)
    .map((section) =>
      h(
        "button",
        { class: `bar-link bar-icon${section.key === mode ? " on" : ""}`, "data-focus": true, "data-action": `bar-${section.key}`, "aria-label": section.label, onclick: section.open },
        icon(section.key === "ask" ? "ask" : section.key === "apps" ? "apps" : "settings", 30),
        section.label.endsWith("●") ? h("span", { class: "bar-dot" }) : null,
      ),
    );
  const note = keyHints(info) ? "" : info;
  return h(
    "div",
    { class: "bar glass-bar" },
    h("div", { class: "bar-pill" }, ...buttons, time(), avatar(ctx)),
    note ? h("div", { class: "bar-note" }, note) : hint ? h("div", { class: "bar-note bar-hint" }, hint) : null,
    step ? h("div", { class: "bar-step-row" }, ...step) : null,
  );
}
