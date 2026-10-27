// What each model costs, for the key relay to keep a build inside its cap
// (ADR-011, ADR-045): dollars per million tokens, at each provider's
// standard rate. Read on the providers' own pages on 2026-10-27:
// - https://platform.claude.com/docs/en/about-claude/pricing
// - https://developers.openai.com/api/docs/pricing
// - https://ai.google.dev/gemini-api/docs/pricing (Gemini 3's prices are
//   to roughly double on 2027-01-01, so read it again before then)
//
// A model that isn't here isn't priced, so the relay refuses it rather than
// guess what a build spent.

import type { Provider } from "../build.ts";

export interface Rate {
  in: number; // input, not cached
  out: number; // output, thinking included
  cacheRead: number;
  // Above this many prompt tokens, the long prompt's rate. With no rate,
  // a prompt this long isn't priced, and counts as the build's whole cap.
  above?: { tokens: number; rate?: Omit<Rate, "above"> };
}

// A model's id starts with one of these; the longest that fits wins, so
// claude-opus-5-5 isn't read as claude-opus-5.
export const PRICES: Record<Provider, Record<string, Rate>> = {
  claude: {
    "claude-fable-5-1": { in: 10, out: 50, cacheRead: 0.25 },
    "claude-mythos-5-1": { in: 10, out: 50, cacheRead: 0.25 },
    "claude-fable-5": { in: 10, out: 50, cacheRead: 1 },
    "claude-mythos-5": { in: 10, out: 50, cacheRead: 1 },
    "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
    "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5 },
    "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.5 },
    "claude-opus-4-7": { in: 5, out: 25, cacheRead: 0.5 },
    "claude-opus-4-6": { in: 5, out: 25, cacheRead: 0.5 },
    "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2 },
    "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2 },
    "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3 },
    "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, above: { tokens: 100_000, rate: { in: 0.5, out: 2.5, cacheRead: 0.05 } } },
    "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1 },
  },
  chatgpt: {
    "gpt-5.6-sol": { in: 4, out: 20, cacheRead: 0.4 },
    "gpt-5.6-terra": { in: 2, out: 12, cacheRead: 0.2 },
    "gpt-5.6-luna": { in: 0.2, out: 1.2, cacheRead: 0.02 },
    "gpt-5.5": { in: 5, out: 30, cacheRead: 0.5, above: { tokens: 272_000 } },
    "gpt-5.4": { in: 2.5, out: 15, cacheRead: 0.25, above: { tokens: 272_000 } },
    "gpt-5.4-mini": { in: 0.75, out: 4.5, cacheRead: 0.075 },
    "gpt-5.4-nano": { in: 0.2, out: 1.25, cacheRead: 0.02 },
    "gpt-5.3-codex": { in: 1.75, out: 14, cacheRead: 0.175 },
    "gpt-5.2": { in: 1.75, out: 14, cacheRead: 0.175 },
    "gpt-5.1": { in: 1.25, out: 10, cacheRead: 0.125 },
    "gpt-5": { in: 1.25, out: 10, cacheRead: 0.125 },
    "gpt-5-mini": { in: 0.25, out: 2, cacheRead: 0.025 },
    "gpt-5-nano": { in: 0.05, out: 0.4, cacheRead: 0.005 },
  },
  gemini: {
    "gemini-3.8-flash": { in: 0.75, out: 3.75, cacheRead: 0.075 },
    "gemini-3.6-flash": { in: 0.75, out: 3.75, cacheRead: 0.075 },
    "gemini-3.5-flash-lite": { in: 0.3, out: 2.5, cacheRead: 0.03 },
    "gemini-3.1-pro-preview": { in: 2, out: 12, cacheRead: 0.2, above: { tokens: 200_000, rate: { in: 4, out: 18, cacheRead: 0.4 } } },
    "gemini-3.1-flash-lite": { in: 0.25, out: 1.5, cacheRead: 0.025 },
    "gemini-3-flash-preview": { in: 0.5, out: 3, cacheRead: 0.05 },
    "gemini-2.5-pro": { in: 1.25, out: 10, cacheRead: 0.125, above: { tokens: 200_000, rate: { in: 2.5, out: 15, cacheRead: 0.25 } } },
    "gemini-2.5-flash": { in: 0.3, out: 2.5, cacheRead: 0.03 },
    "gemini-2.5-flash-lite": { in: 0.1, out: 0.4, cacheRead: 0.01 },
  },
};

// Models whose own names carry a suffix the table doesn't: a date, or a
// "-pro" that costs far more than the model it starts with. A suffix this
// lists is priced; any other isn't.
const SUFFIX = /^(-\d{4}-?\d{2}-?\d{2}|-latest|-customtools)?$/;

export function rateFor(provider: Provider, model: string): Rate | null {
  const table = PRICES[provider];
  const name = model.toLowerCase().replace(/^models\//, "");
  const found = Object.keys(table)
    .filter((id) => name.startsWith(id) && SUFFIX.test(name.slice(id.length)))
    .sort((a, b) => b.length - a.length)[0];
  return found ? table[found] : null;
}

// What one request used, in tokens. Input is what wasn't cached; a cache
// write is billed as input at 1.25 times for five minutes and twice for an
// hour (Claude's), and a read at its own rate.
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

// Dollars for a request, or null when it can't be priced. fast is Claude's
// fast mode, at twice the price.
export function cost(rate: Rate, usage: Usage, fast = false): number | null {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
  let r: Omit<Rate, "above"> = rate;
  if (rate.above && prompt > rate.above.tokens) {
    if (!rate.above.rate) return null;
    r = rate.above.rate;
  }
  const dollars = (usage.input * r.in + usage.cacheWrite5m * r.in * 1.25 + usage.cacheWrite1h * r.in * 2 + usage.cacheRead * r.cacheRead + usage.output * r.out) / 1_000_000;
  return fast ? dollars * 2 : dollars;
}
