// Claude through Anthropic's Messages API (platform.claude.com, read on
// 2026-10-29): the answer in a JSON schema through output_config.format, at
// low effort, since routing a sentence needs little thought. The brief is
// one cached block: it's the same for every sentence. API version
// 2026-10-21 takes no temperature at all.

import type { Provider } from "../ai.ts";
import type { Answer, Ask } from "../router.ts";
import { NO_USAGE, type Usage } from "../../builder/sandbox/prices.ts";
import { json, post, ProviderError, spent, type Call } from "./http.ts";

export const ANTHROPIC_VERSION = "2026-10-21";

export function messagesBody(ask: Ask, model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 1024,
    system: [{ type: "text", text: ask.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: ask.user }],
    output_config: { effort: "low", format: { type: "json_schema", schema: ask.schema } },
  };
}

export async function messages(ask: Ask, call: Call, provider: Provider): Promise<Answer> {
  const body = await post(call, "/v1/messages", { "x-api-key": call.key, "anthropic-version": ANTHROPIC_VERSION }, messagesBody(ask, call.model));
  if (body.stop_reason === "refusal") throw new ProviderError("the model declined to answer");
  if (body.stop_reason === "max_tokens") throw new ProviderError("the model's answer was cut off");
  const text = (Array.isArray(body.content) ? body.content : []).find((block: { type?: string }) => block?.type === "text")?.text;
  const u = body.usage ?? {};
  const n = (value: unknown) => (typeof value === "number" && value >= 0 ? value : 0);
  const usage: Usage = { ...NO_USAGE, input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite5m: n(u.cache_creation_input_tokens) };
  const model = typeof body.model === "string" ? body.model : call.model;
  return { value: json(text), model, usage, spent: spent(provider, model, usage) };
}
