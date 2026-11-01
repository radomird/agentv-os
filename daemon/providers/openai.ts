// ChatGPT's models through OpenAI's Responses API (developers.openai.com,
// read on 2026-10-29): the answer in a JSON schema through text.format,
// strict, at low reasoning effort, and nothing kept on OpenAI's side.

import type { Provider } from "../ai.ts";
import type { Answer, Ask } from "../router.ts";
import { NO_USAGE, type Usage } from "../../builder/sandbox/prices.ts";
import { json, post, ProviderError, spent, type Call } from "./http.ts";

export function responsesBody(ask: Ask, model: string): Record<string, unknown> {
  return {
    model,
    instructions: ask.system,
    input: ask.user,
    text: { format: { type: "json_schema", name: ask.name, schema: ask.schema, strict: true } },
    reasoning: { effort: "low" },
    max_output_tokens: 1024,
    store: false,
  };
}

export async function responses(ask: Ask, call: Call, provider: Provider): Promise<Answer> {
  const body = await post(call, "/v1/responses", { Authorization: `Bearer ${call.key}` }, responsesBody(ask, call.model));
  if (body.status === "incomplete") throw new ProviderError("the model's answer was cut off");
  type Part = { type?: string; text?: unknown };
  const parts: Part[] = (Array.isArray(body.output) ? body.output : []).filter((item: { type?: string }) => item?.type === "message").flatMap((item: { content?: unknown }) => (Array.isArray(item.content) ? item.content : []));
  if (parts.some((part) => part?.type === "refusal")) throw new ProviderError("the model declined to answer");
  const text = parts.find((part) => part?.type === "output_text")?.text;
  const u = body.usage ?? {};
  const n = (value: unknown) => (typeof value === "number" && value >= 0 ? value : 0);
  const cached = n(u.input_tokens_details?.cached_tokens);
  const usage: Usage = { ...NO_USAGE, input: Math.max(0, n(u.input_tokens) - cached), cacheRead: cached, output: n(u.output_tokens) };
  const model = typeof body.model === "string" ? body.model : call.model;
  return { value: json(text), model, usage, spent: spent(provider, model, usage) };
}
