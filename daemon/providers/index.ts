// The provider layer (ADR-013, ADR-047): one way to ask each of the five
// providers for an answer in a JSON schema, with the household's key. Each
// provider's own API, with its own structured output:
// - Anthropic's Messages, with output_config's json_schema (anthropic.ts);
// - OpenAI's Responses, with text.format's json_schema, strict (openai.ts);
// - Google's generateContent, with responseJsonSchema (google.ts);
// - xAI's and Meta's Chat Completions, with response_format's json_schema,
//   strict (chat.ts).
// A plan goes through the provider's CLI instead (cli.ts).
//
// Each request goes straight to the provider: nothing here holds a key past
// the request, logs one, or says one in an error.

import type { Provider } from "../ai.ts";
import { UPSTREAM } from "../../builder/sandbox/relay.ts";
import type { Answer, Ask, Backend } from "../router.ts";
import { messages } from "./anthropic.ts";
import { chat } from "./chat.ts";
import { generate } from "./google.ts";
import type { Call } from "./http.ts";
import { responses } from "./openai.ts";

export { UPSTREAM };
export { ProviderError } from "./http.ts";

// The model each provider routes with: its quickest, read on each provider's
// models page on 2026-10-29. The eval set (test/agentv/evals/router) runs on
// these, and any other can be named for it.
export const ROUTER_MODELS: Record<Provider, string> = {
  claude: "claude-haiku-5-5",
  chatgpt: "gpt-5.6-luna",
  gemini: "gemini-3.8-flash",
  grok: "grok-4.7",
  muse: "muse-spark-1.3",
};

// The key's name in /etc/agentv/env, and in the evals' environment.
export const KEY_VARS: Record<Provider, string> = { claude: "ANTHROPIC_API_KEY", chatgpt: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY", grok: "XAI_API_KEY", muse: "META_API_KEY" };

export interface ApiOptions {
  key: string;
  model?: string;
  base?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const ASK: Record<Provider, (ask: Ask, call: Call, provider: Provider) => Promise<Answer>> = {
  claude: messages,
  chatgpt: responses,
  gemini: generate,
  grok: chat,
  muse: chat,
};

// A provider's API, with the household's key.
export function apiBackend(provider: Provider, options: ApiOptions): Backend {
  const model = options.model ?? ROUTER_MODELS[provider];
  const call: Call = { key: options.key, model, base: options.base ?? UPSTREAM[provider], fetch: options.fetch ?? fetch, timeoutMs: options.timeoutMs ?? 15_000 };
  return { provider, via: "api", model, ask: (ask) => ASK[provider](ask, call, provider) };
}
