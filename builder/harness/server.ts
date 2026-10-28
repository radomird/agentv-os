// The harness for one step of one build, as an MCP server on standard input
// and output (ADR-046). The builder names the build and the step when it
// starts the provider's CLI, and the CLI starts this with them: the step's
// tools are the recipe's, read from the build's own recipe.json, which the
// agent has no tool to change. The understanding and the plan are AgenTV's
// own steps, defined here.
//
// Usage: node server.ts <build-dir> <step>

import { join, resolve } from "node:path";
import { Build } from "../build.ts";
import type { Recipe, Step } from "../recipe.ts";
import { serve } from "./mcp.ts";
import { stepTools, type Extra } from "./tools.ts";

// AgenTV's own steps around a recipe's: what the request is, and with no
// recipe, a plan for an adult.
export const UNDERSTAND: Step = { id: "understand", does: "Say what the request is, and which recipe fits it.", tools: ["understood"] };
export const PLAN: Step = { id: "plan", does: "Write a plan for a page app no recipe covers, for an adult to approve.", tools: ["read", "list", "submit_plan"], reads: ["kit"] };

export function findStep(build: Build, id: string): Step | null {
  if (id === UNDERSTAND.id) return UNDERSTAND;
  if (id === PLAN.id) return PLAN;
  return build.recipe().steps.find((step) => step.id === id) ?? null;
}

export async function harness(dir: string, stepId: string, extra?: Extra): Promise<void> {
  const build = new Build(dir);
  const step = findStep(build, stepId);
  if (!step) throw new Error(`there's no step ${stepId} in this build`);
  const root = process.env.AGENTV_PATH ?? join(import.meta.dirname, "../..");
  const omarchy = process.env.OMARCHY_PATH ?? "/usr/share/omarchy";
  // Before a recipe is chosen, AgenTV's own steps stand alone, with a page
  // app's template folder for a recipe.
  const own: Recipe = {
    kind: "plan",
    name: step.id,
    fits: step.does,
    runtime: "page",
    bounds: { origins: false, media: [], tile: false, notices: false },
    steps: [step],
    template: "template",
    tests: "template",
    cost: { low: 0, high: 0 },
    minutes: 10,
    dir: join(root, "builder/recipes/page"),
  };
  const recipe = step === UNDERSTAND || step === PLAN ? own : build.recipe();
  const tools = stepTools({ build, recipe, step, root, omarchy, extra });
  build.log({ step: step.id, harness: "started", tools: tools.map((tool) => tool.name) });
  await serve(tools, {
    name: "agentv",
    seen: (call) => {
      if (!call.ok) build.log({ step: step.id, tool: call.tool, refused: call.answer });
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [dir, step] = process.argv.slice(2);
  if (!dir || !step) {
    console.error("Usage: node server.ts <build-dir> <step>");
    process.exit(2);
  }
  // Type stripping is still marked experimental in Node; its warning would
  // land in the CLI's view of the server.
  process.removeAllListeners("warning");
  const { extraTools } = await import("./extra.ts");
  await harness(dir, step, await extraTools(dir, step));
}
