// The household's two models (ADR-103, Q312), from Settings, AI:
// - PUT /api/ai/models with { use: "ask" | "build", model }: the model the TV
//   asks on, for every sentence, or the one each new app starts on. One from
//   the provider's list, for the way in it uses now. An adult's, past the
//   PIN, as the rest of the AI's settings are. It answers with the AI as it
//   stands, and the event `ai` tells the pages.
// GET /api/ai and GET /api/key already carry them, with the list.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Ai, AiState } from "../ai.ts";

export interface AiModelRoutes {
  ai: Ai;
  // Past the PIN, once there is one, and an adult's: false once it has
  // answered the refusal.
  adult: (request: IncomingMessage, response: ServerResponse, what: string) => Promise<boolean>;
  body: (request: IncomingMessage) => Promise<unknown>;
  json: (response: ServerResponse, status: number, data: unknown) => void;
  changed: (state: AiState) => void;
  log: (line: string) => void;
}

// True when the request was this one, and has been answered.
export async function aiModelRoutes(kit: AiModelRoutes, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  if (path !== "/api/ai/models") return false;
  if (request.method !== "PUT") {
    kit.json(response, 405, { ok: false, error: "PUT a model for asking or for building" });
    return true;
  }
  if (!(await kit.adult(request, response, "the AI's models"))) return true;
  const body = (await kit.body(request)) as { use?: unknown; model?: unknown } | undefined;
  const result = await kit.ai.setModel(body?.use, body?.model);
  if (!result.state) {
    kit.json(response, 400, { ok: false, error: result.error });
    return true;
  }
  kit.log(`the AI's model for ${body?.use === "ask" ? "asking" : "building"} is ${String(body?.model)}`);
  kit.changed(result.state);
  kit.json(response, 200, { ok: true, ...result.state });
  return true;
}
