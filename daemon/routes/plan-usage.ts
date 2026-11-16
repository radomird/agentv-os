// How much of the household's plan is used (ADR-103, Q313):
// - GET /api/ai/usage: { ok, plan, usage }. plan is whether a plan is in
//   use, its terms accepted; usage its windows (daemon/plan-usage.ts), with
//   asOf when they're the numbers kept while the plan's limits are paused, or
//   no windows and signIn where the plan's sign-in ran out or was never
//   done, and then the TV offers signing in. usage is null where the check
//   can't answer with today's numbers, and then the TV says it's using the
//   plan. ?fresh asks again now rather than keep the last answer.
// Adults only, as the rest of AI in Settings is. Never a dollar amount.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AiState } from "../ai.ts";
import type { PlanUsages } from "../plan-usage.ts";

export interface PlanUsageRoutes {
  ai: () => Promise<AiState>;
  usages: PlanUsages;
  adult: () => Promise<boolean>;
  json: (response: ServerResponse, status: number, data: unknown) => void;
}

// True when the request was this one, and has been answered.
export async function planUsageRoutes(kit: PlanUsageRoutes, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/ai/usage") return false;
  if (request.method !== "GET") {
    kit.json(response, 405, { ok: false, error: "GET how much of the plan is used" });
    return true;
  }
  if (!(await kit.adult())) {
    kit.json(response, 403, { ok: false, error: "Only an adult can see this" });
    return true;
  }
  const ai = await kit.ai();
  const plan = ai.path === "plan" && ai.accepted !== null && ai.provider !== null;
  const usage = plan ? await kit.usages.get(ai.provider, url.searchParams.has("fresh")) : null;
  kit.json(response, 200, { ok: true, plan, usage });
  return true;
}
