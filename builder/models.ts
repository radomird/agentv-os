// The models a build or an ask can run on (ADR-103, Q311, Q312): each
// provider's short list, strongest first, named the way the provider names
// them, with the one asking starts on and the one building starts on.
// Settings, AI picks the household's two, and "Make X?" can pick another
// for one build. Root's hand-over takes a build's model only from here, and
// with a key only one the relay prices (builder/sandbox/prices.ts), since a
// model it can't price is one it refuses.
//
// Checked on 2026-11-16 against each provider's models page and its CLI's
// own reference:
// - Claude Code takes `--model` with the API's ids, and every Claude plan
//   offers all four (code.claude.com/docs/en/model-config). Fable 5.2 isn't
//   in the relay's prices yet, so it's a plan's only.
// - Codex takes `-m`. With a ChatGPT sign-in its models are the GPT-6 line
//   (learn.chatgpt.com/docs/models); the relay prices GPT-5.6, so a key
//   gets that line.
// - Gemini CLI takes `-m`. It isn't made for Gemini 4 yet, and Google's
//   plan isn't offered, so the list is Gemini 3's, by key.
// - Grok Build takes `-m` and `--model` (docs.x.ai/build/cli/headless-
//   scripting). xAI's line has no middle model of its own, so asking and
//   building both start on its flagship, as before.
// - Muse Code takes `--model`. Ember isn't in the relay's prices yet, and
//   Meta's plan isn't offered, so it waits.

import type { Provider } from "./build.ts";
import { rateFor } from "./sandbox/prices.ts";

export interface Model {
  id: string; // as the API and the CLI take it
  name: string; // as the provider names it
  only?: "plan" | "key"; // offered one way in only
  // On a plan, it can use extra usage, billed past the plan's own limits
  // (Q324): the TV says so on its row, and it's never a default.
  costsExtra?: "plan";
}

export const MODELS: Record<Provider, Model[]> = {
  claude: [
    { id: "claude-fable-5-2", name: "Fable 5.2", costsExtra: "plan" },
    { id: "claude-opus-5-5", name: "Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    { id: "claude-haiku-5-5", name: "Haiku 5.5" },
  ],
  chatgpt: [
    { id: "gpt-6-astra", name: "GPT-6 Astra", only: "plan" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", only: "plan" },
    { id: "gpt-6-luna", name: "GPT-6 Luna", only: "plan" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", only: "key" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", only: "key" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", only: "key" },
  ],
  gemini: [
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite" },
  ],
  grok: [
    { id: "grok-4.7", name: "Grok 4.7" },
    { id: "grok-4.3", name: "Grok 4.3" },
    { id: "grok-build-0.1", name: "Grok Build 0.1" },
  ],
  muse: [
    { id: "muse-wonder-1.0", name: "Muse Wonder 1.0" },
    { id: "muse-spark-1.3", name: "Muse Spark 1.3" },
    { id: "muse-ember-1.0", name: "Muse Ember 1.0" },
  ],
};

type Pair = { ask: string; build: string };

// Where each provider starts, by plan or key: its quickest for asking, as
// the router has asked on a key since its evals (daemon/providers/index.ts),
// and its middle one for building.
export const DEFAULT_MODELS: Record<Provider, Record<"plan" | "key", Pair>> = {
  claude: { plan: { ask: "claude-haiku-5-5", build: "claude-sonnet-5-5" }, key: { ask: "claude-haiku-5-5", build: "claude-sonnet-5-5" } },
  chatgpt: { plan: { ask: "gpt-6-luna", build: "gpt-6.1-sol" }, key: { ask: "gpt-5.6-luna", build: "gpt-5.6-terra" } },
  gemini: { plan: { ask: "gemini-3.8-flash", build: "gemini-3.8-flash" }, key: { ask: "gemini-3.8-flash", build: "gemini-3.8-flash" } },
  grok: { plan: { ask: "grok-4.7", build: "grok-4.7" }, key: { ask: "grok-4.7", build: "grok-4.7" } },
  muse: { plan: { ask: "muse-spark-1.3", build: "muse-spark-1.3" }, key: { ask: "muse-spark-1.3", build: "muse-spark-1.3" } },
};

// The models on offer for a provider, by plan or key: with a key, only the
// ones the relay prices.
export function modelsFor(provider: Provider, path: "plan" | "key"): Model[] {
  return MODELS[provider]
    .filter((model) => (!model.only || model.only === path) && (path === "plan" || rateFor(provider, model.id) !== null))
    .map(({ id, name, costsExtra }) => ({ id, name, ...(costsExtra === path ? { costsExtra } : {}) }));
}

// Whether a model is one this provider offers by this path.
export function offered(provider: Provider, path: "plan" | "key", model: unknown): model is string {
  return typeof model === "string" && modelsFor(provider, path).some((m) => m.id === model);
}

// The model a provider starts on for asking or building, by plan or key.
export function defaultModel(provider: Provider, path: "plan" | "key", use: "ask" | "build"): string {
  return DEFAULT_MODELS[provider][path][use];
}

// A model's name as the provider writes it, or its id when it has none.
export function modelName(provider: Provider, model: string): string {
  return MODELS[provider].find((m) => m.id === model)?.name ?? model;
}
