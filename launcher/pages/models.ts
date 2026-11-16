// Settings, AI's two models (ADR-103, Q312): "For asking", the one every
// question to the TV is answered on, and "For building", the one each new
// app starts on, which "Make X?" can change for one app. Each goes through
// the provider's short list, strongest first: left and right step along it,
// and OK goes on to the next, round to the first. An adult's, past the PIN,
// like the rest of AI. A model that can cost extra on a plan says so on its
// row (Q324).

import { daemon } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx } from "../main.ts";
import { keyState, setKeyState } from "./key.ts";
import { pinAsked } from "./pin.ts";

export type ModelUse = "ask" | "build";

// What a model that can cost extra on a plan says, on its row here and on
// "Make X?".
export const COSTS_EXTRA = "Can cost extra on your plan";

// Whether a model says so: one that costs extra on a plan, picked on one.
export function costsExtra(model: { costsExtra?: "plan" } | undefined, path: string | null | undefined): boolean {
  return model?.costsExtra === "plan" && path === "plan";
}

const ROWS: { use: ModelUse; action: string; label: string }[] = [
  { use: "ask", action: "ask-model", label: "For asking" },
  { use: "build", action: "build-model", label: "For building" },
];

// The row a left or a right is for, from its data-adjust, or null.
export function modelUse(adjust: string | undefined): ModelUse | null {
  return ROWS.find((row) => row.action === adjust)?.use ?? null;
}

// The two rows, once an AI is set up and has more than one model to pick.
export function modelRows(ctx: Ctx): HTMLElement[] {
  const models = keyState?.ai?.accepted ? keyState.ai.models : null;
  if (!models || models.list.length < 2) return [];
  return ROWS.map(({ use, action, label }) => {
    const model = models.list.find((m) => m.id === models[use]);
    const extra = costsExtra(model, keyState?.ai?.path);
    return h(
      "button",
      { class: `button${extra ? " noted" : ""}`, "data-focus": true, "data-action": action, "data-adjust": action, onclick: () => void stepModel(ctx, use, 1, true) },
      h("span", {}, label),
      h("span", { class: "button-value" }, model?.name ?? models[use]),
      ...(extra ? [h("span", { class: "button-note" }, COSTS_EXTRA)] : []),
    );
  });
}

// One model over: right is the next down the list, left the one above. OK
// goes round from the last to the first; left and right stop at the ends.
export async function stepModel(ctx: Ctx, use: ModelUse, by: 1 | -1, round = false): Promise<void> {
  const models = keyState?.ai?.models;
  if (!models || !keyState?.ai) return;
  const at = models.list.findIndex((m) => m.id === models[use]);
  let next = at + by;
  if (next < 0 || next >= models.list.length) {
    if (!round) return;
    next = (next + models.list.length) % models.list.length;
  }
  const grant = await ctx.grant("your AI");
  if (grant === null) return;
  try {
    const saved = await daemon.setModel(use, models.list[next].id, grant || undefined);
    setKeyState({ ...keyState, ai: { ...keyState.ai, models: saved.models ?? models } });
  } catch (error) {
    if (pinAsked(error)) ctx.forgetGrant();
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
    return;
  }
  ctx.sounds.play("move");
  ctx.render("settings/ai", use === "ask" ? "ask-model" : "build-model");
}
