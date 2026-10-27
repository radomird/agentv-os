// AgenTV's own steps around a recipe's (ADR-046): what the request is, and
// with no recipe a plan for an adult. And a build's step by its id, whoever
// asks: the harness, or the tools it gets from beyond it.

import type { Build } from "../build.ts";
import type { Step } from "../recipe.ts";

export const UNDERSTAND: Step = { id: "understand", does: "Say what the request is, and which recipe fits it.", tools: ["understood"] };
export const PLAN: Step = { id: "plan", does: "Write a plan for a page app no recipe covers, for an adult to approve.", tools: ["read", "list", "submit_plan"], reads: ["kit"] };

export function findStep(build: Build, id: string): Step | null {
  if (id === UNDERSTAND.id) return UNDERSTAND;
  if (id === PLAN.id) return PLAN;
  return build.recipe().steps.find((step) => step.id === id) ?? null;
}
