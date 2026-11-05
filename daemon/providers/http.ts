// What every provider's request shares: one POST of JSON, its errors in
// one line that never holds the key, the answer's JSON, and what it cost.

import type { Provider } from "../ai.ts";
import { cost, rateFor, type Usage } from "../../builder/sandbox/prices.ts";

// What one request to a provider needs.
export interface Call {
  key: string;
  model: string;
  base: string; // the provider's address, or a test's
  fetch: typeof fetch;
  timeoutMs: number;
}

// A provider that didn't answer, in one line that never holds the key.
export class ProviderError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
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
    throw new ProviderError(e.name === "TimeoutError" ? "the provider didn't answer in time" : `the provider couldn't be reached: ${e.message}`);
  }
  const text = await response.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {}
  if (!response.ok) {
    const said = typeof json.error === "string" ? json.error : (json.error?.message ?? json.message);
    const why =
      response.status === 401 || response.status === 403
        ? "the provider refused the key"
        : response.status === 429
          ? "the provider is busy, or the key is out of credit"
          : response.status >= 500
            ? "the provider had a problem"
            : "the provider refused the request";
    const words = typeof said === "string" ? `: ${said.replace(call.key, "the key").slice(0, 160)}` : "";
    throw new ProviderError(`${why} (${response.status})${words}`, response.status);
  }
  return json;
}

// An answer's JSON, from the text the model gave.
export function json(text: unknown): unknown {
  if (typeof text !== "string") throw new ProviderError("the provider's answer had no text");
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
