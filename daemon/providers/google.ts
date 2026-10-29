// Gemini through Google's generateContent (ai.google.dev, read on
// 2026-10-29): the answer as JSON in a JSON schema through
// responseJsonSchema, thinking at its lowest level. Gemini 3.6 and newer
// ignore temperature, so it's never sent.

import type { Provider } from "../ai.ts";
import type { Answer, Ask } from "../router.ts";
import { NO_USAGE, type Usage } from "../../builder/sandbox/prices.ts";
import { json, post, ProviderError, spent, type Call } from "./http.ts";

export function generateBody(ask: Ask): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: ask.system }] },
    contents: [{ role: "user", parts: [{ text: ask.user }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: ask.schema,
      thinkingConfig: { thinkingLevel: "low" },
      maxOutputTokens: 1024,
    },
  };
}

export async function generate(ask: Ask, call: Call, provider: Provider): Promise<Answer> {
  const model = call.model.replace(/^models\//, "");
  if (!/^[\w.-]+$/.test(model)) throw new ProviderError("that isn't a model's name");
  const body = await post(call, `/v1beta/models/${model}:generateContent`, { "x-goog-api-key": call.key }, generateBody(ask));
  const candidate = Array.isArray(body.candidates) ? body.candidates[0] : undefined;
  if (!candidate) throw new ProviderError(body.promptFeedback?.blockReason ? "the model declined to answer" : "the provider's answer had no text");
  if (candidate.finishReason === "MAX_TOKENS") throw new ProviderError("the model's answer was cut off");
  if (candidate.finishReason === "SAFETY" || candidate.finishReason === "RECITATION") throw new ProviderError("the model declined to answer");
  // The answer's own parts, without its thoughts.
  const text = (Array.isArray(candidate.content?.parts) ? candidate.content.parts : [])
    .filter((part: { thought?: boolean; text?: unknown }) => part?.thought !== true && typeof part?.text === "string")
    .map((part: { text: string }) => part.text)
    .join("");
  const u = body.usageMetadata ?? {};
  const n = (value: unknown) => (typeof value === "number" && value >= 0 ? value : 0);
  const cached = n(u.cachedContentTokenCount);
  const usage: Usage = { ...NO_USAGE, input: Math.max(0, n(u.promptTokenCount) - cached), cacheRead: cached, output: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount) };
  const answered = typeof body.modelVersion === "string" ? body.modelVersion : model;
  return { value: json(text || undefined), model: answered, usage, spent: spent(provider, answered, usage) };
}
