// What the TV is for (board 08, ADR-006): streaming, music, photos or
// gaming. It orders the apps setup suggests, picks home's top rail, and with
// music, puts Music on home from the start. OK on one picks it and moves on.

import { h } from "../launcher/dom.ts";
import { glyph, type Glyph } from "../launcher/glyphs.ts";
import { setup, type Goal } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

const GOALS: { goal: Goal; name: string; note: string; icon: Glyph }[] = [
  { goal: "streaming", name: "streaming", note: "films and shows", icon: "film" },
  { goal: "music", name: "music", note: "albums and playlists", icon: "music" },
  { goal: "media", name: "photos", note: "photos and videos", icon: "photo" },
  { goal: "gaming", name: "gaming", note: "steam and more", icon: "gamepad" },
];

export function goal(ctx: Ctx): View {
  const chosen = () => ctx.info.setup.goal ?? "streaming";
  const pick = async (goal: Goal) => {
    try {
      ctx.info.setup = await setup.goal(goal);
    } catch (error) {
      ctx.toast((error as Error).message, "fail");
      ctx.sounds.play("failure");
      return;
    }
    await ctx.finish("goal");
  };
  const cards = GOALS.map((g, i) =>
    h(
      "button",
      { class: "goal", "data-focus": true, "data-goal": g.goal, onclick: () => void pick(g.goal) },
      h("span", { class: "goal-text" }, h("span", { class: "goal-index" }, `0${i + 1}`), h("span", { class: "goal-name" }, g.name), h("span", { class: "goal-note" }, g.note)),
      glyph(g.icon, 120),
    ),
  );
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "continue", onclick: () => void pick(chosen()) }, "↵ continue");
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", { class: "setup-top" }, h("div", {}, ...heading("what is this tv for?", "pick one.", ctx.reduced())), go),
    h("div", { class: "goals" }, ...cards),
  );
  return { el, first: cards.find((card) => card.dataset.goal === chosen()), info: "←↑↓→ move · ↵ pick" };
}
