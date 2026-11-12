// What every provider's request shares: one POST of JSON, its errors in
// one line that never holds the key, the answer's JSON, and what it cost.

import type { Provider } from "../ai.ts";
import { cost, rateFor, type Usage } from "../../builder/sandbox/prices.ts";
import { NO_ANSWER } from "./no-answer.ts";

// What one request to a provider needs.
export interface Call {
  key: string;
  model: string;
  base: string; // the provider's address, or a test's
  fetch: typeof fetch;
  timeoutMs: number;
}

// A provider that didn't answer, in one line that never holds the key. For
// a kind the TV has a plain line for (no-answer.ts), that line is the
// message, and what the provider itself said is in raw, for the log.
export class ProviderError extends Error {
  readonly status?: number;
  readonly raw?: string;
  constructor(message: string, status?: number, raw?: string) {
    super(message);
    this.status = status;
    this.raw = raw;
  }
}

// One POST of JSON, and its answer as JSON, or a ProviderError that says
// why not in the provider's own words where it gives some.
export async function post(call: Call, path: string, headers: Record<string, string>, body: unknown): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await call.fetch(`${call.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(call.timeoutMs),
    });
  } catch (error) {
    const e = error as Error;
    if (e.name === "TimeoutError") throw new ProviderError(NO_ANSWER.slow(), undefined, "the provider didn't answer in time");
    throw new ProviderError(NO_ANSWER.unreachable(), undefined, `the provider couldn't be reached: ${e.message}`);
  }
  const text = await response.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {}
  if (!response.ok) {
    const said = typeof json.error === "string" ? json.error : (json.error?.message ?? json.message);
    const refused = response.status === 401 || response.status === 403;
    const busy = response.status === 429;
    const why = refused ? "the provider refused the key" : busy ? "the provider is busy, or the key is out of credit" : response.status >= 500 ? "the provider had a problem" : "the provider refused the request";
    const words = typeof said === "string" ? `: ${said.replace(call.key, "the key").slice(0, 160)}` : "";
    const raw = `${why} (${response.status})${words}`;
    throw new ProviderError(refused ? NO_ANSWER.key() : busy ? NO_ANSWER.busy() : raw, response.status, raw);
  }
  return json;
}

// An answer's JSON, from the text the model gave.
export function json(text: unknown): unknown {
  if (typeof text !== "string") throw new ProviderError(NO_ANSWER.empty(), undefined, "the provider's answer had no text");
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("the provider's answer wasn't JSON");
  }
}

// What an answer cost, from the price table the builder's relay uses, or
// undefined for a model it doesn't price.
export function spent(provider: Provider, model: string, usage: Usage): number | undefined {
  const rate = rateFor(provider, model);
  const dollars = rate ? cost(rate, usage) : null;
  return dollars === null ? undefined : Math.round(dollars * 1e8) / 1e8;
}
