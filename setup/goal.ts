// What the TV is for (board 08, ADR-006): streaming, music, photos or
// gaming. It orders the apps setup suggests, picks home's top rail, and with
// music, puts Music on home from the start. OK on one picks it and moves on.

import { h } from "../launcher/dom.ts";
import { featureOn } from "../launcher/features.ts";
import { glyph, type Glyph } from "../launcher/glyphs.ts";
import { setup, type Goal } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

const GOALS: { goal: Goal; name: string; note: string; icon: Glyph }[] = [
  { goal: "streaming", name: "Streaming", note: "Films and shows", icon: "film" },
  { goal: "music", name: "Music", note: "Albums and playlists", icon: "music" },
  { goal: "media", name: "Photos", note: "Photos and videos", icon: "photo" },
  { goal: "gaming", name: "Gaming", note: "Your games", icon: "gamepad" },
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
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "continue", onclick: () => void pick(chosen()) }, "Continue");
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", { class: "setup-top" }, h("div", {}, ...heading("What is this TV for?", "Pick one", ctx.reduced())), go),
    h("div", { class: "goals" }, ...cards),
  );
  return { el, first: cards.find((card) => card.dataset.goal === chosen()) };
}

// The goal with setup's own switch on (design page D3, step 8 of 12): one
// line says the pick only sets up the first home, so picking media doesn't
// stop anyone playing a game. Four cards in a row, and OK on one picks it
// and moves on, with no continue. With the box check on, gaming says what
// to expect on this box.
const CARDS: { goal: Goal; name: string; note: string; icon: Glyph }[] = [
  { goal: "streaming", name: "Streaming", note: "Films and shows", icon: "film" },
  { goal: "music", name: "Music", note: "Albums and playlists", icon: "music" },
  { goal: "media", name: "Media", note: "Your own server and photos", icon: "photo" },
  { goal: "gaming", name: "Gaming", note: "Your games", icon: "gamepad" },
];

// What the box check says about games, as gaming's line.
const GAMES: Record<string, string> = {
  good: "Games run well here",
  light: "Fine for light games",
  none: "Not made for games",
};

async function games(): Promise<string | null> {
  if (!(await featureOn("boxcheck").catch(() => false))) return null;
  const box = await fetch("/api/box")
    .then((response) => (response.ok ? (response.json() as Promise<{ verdicts?: { games?: string } }>) : null))
    .catch(() => null);
  return GAMES[box?.verdicts?.games ?? ""] ?? null;
}

export async function goal2(ctx: Ctx): Promise<View> {
  const gaming = await games();
  const chosen = ctx.info.setup.goal ?? "streaming";
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
  const cards = CARDS.map((card) =>
    h(
      "button",
      { class: "goal-card", "data-focus": true, "data-goal": card.goal, onclick: () => void pick(card.goal) },
      glyph(card.icon, 64),
      h("span", { class: "goal-card-text" }, h("span", { class: "goal-card-name" }, card.name), h("span", { class: "goal-card-note" }, card.goal === "gaming" && gaming ? gaming : card.note)),
    ),
  );
  const [prompt, headline] = heading("agentv goal", "What's it for, mostly?", ctx.reduced());
  const el = h(
    "div",
    { class: "setup-page d3" },
    prompt,
    headline,
    h("p", { class: "setup-line" }, "It only arranges your home. Everything still works."),
    h("div", { class: "goal-cards" }, ...cards),
  );
  return { el, first: cards.find((card) => card.dataset.goal === chosen), info: ctx.info.phones.length ? "Phone paired" : "" };
}
