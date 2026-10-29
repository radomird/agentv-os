// Grok and Muse through xAI's and Meta's Chat Completions (docs.x.ai and
// dev.meta.ai, read on 2026-10-29): both take OpenAI's response_format
// with a JSON schema, strict, and a reasoning effort. Their reasoning
// models can't turn it off, so it's at its lowest, low. xAI's answers say
// what they cost, which counts as it is.

import type { Provider } from "../ai.ts";
import type { Answer, Ask } from "../router.ts";
import { NO_USAGE, type Usage } from "../../builder/sandbox/prices.ts";
import { json, post, ProviderError, spent, type Call } from "./http.ts";

export function chatBody(ask: Ask, model: string): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: ask.system },
      { role: "user", content: ask.user },
    ],
    response_format: { type: "json_schema", json_schema: { name: ask.name, schema: ask.schema, strict: true } },
    reasoning_effort: "low",
  };
}

export async function chat(ask: Ask, call: Call, provider: Provider): Promise<Answer> {
  const body = await post(call, "/v1/chat/completions", { Authorization: `Bearer ${call.key}` }, chatBody(ask, call.model));
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (choice?.finish_reason === "length") throw new ProviderError("the model's answer was cut off");
  if (typeof choice?.message?.refusal === "string" && choice.message.refusal) throw new ProviderError("the model declined to answer");
  const u = body.usage ?? {};
  const n = (value: unknown) => (typeof value === "number" && value >= 0 ? value : 0);
  const cached = n(u.prompt_tokens_details?.cached_tokens);
  const usage: Usage = { ...NO_USAGE, input: Math.max(0, n(u.prompt_tokens) - cached), cacheRead: cached, output: n(u.completion_tokens) };
  const model = typeof body.model === "string" ? body.model : call.model;
  const exact = typeof u.cost_in_usd_ticks === "number" && u.cost_in_usd_ticks >= 0 ? u.cost_in_usd_ticks / 1e10 : undefined;
  return { value: json(choice?.message?.content), model, usage, spent: exact ?? spent(provider, model, usage) };
}
