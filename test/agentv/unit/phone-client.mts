// A paired phone for the tests: it pairs with a daemon's phone port as the
// companion's page does, and signs and seals each request with Node's own
// crypto (daemon/phone-client.ts). `fetch` takes what the tests used to give
// to the real fetch, so a test reads as it did when a phone sent a token.

import { pair, PhoneClient, type Kept } from "../../../daemon/phone-client.ts";

export interface PhoneInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export class TestPhone extends PhoneClient {
  // A request to a path on the phone port. A JSON body is sealed, any other
  // body goes as an upload, and the answer comes back opened.
  async fetch(path: string, init: PhoneInit = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) headers[name.toLowerCase()] = value;
    const { "content-type": type, "x-agentv-grant": grant, authorization: _old, ...rest } = headers;
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : typeof init.body === "string" ? Buffer.from(init.body) : init.body;
    const json = type === undefined || type.startsWith("application/json");
    const answer = await this.call(method, path, body, { grant, headers: rest, type: body !== undefined && !json ? type : undefined });
    return new Response(answer.body.length || ![204, 304].includes(answer.status) ? new Uint8Array(answer.body) : null, { status: answer.status, headers: { ...answer.headers, "content-type": answer.type, "content-length": String(answer.body.length) } });
  }

  // The answer's JSON, for the short asks.
  async json(method: string, path: string, body?: unknown, grant?: string): Promise<Record<string, any>> {
    return (await this.call(method, path, body, { grant })).data;
  }
}

// Pairs with the code on the TV, or with the secret in its QR code.
export async function pairPhone(lan: string, how: string | { code: string } | { secret: string }, name = "a phone"): Promise<TestPhone> {
  return new TestPhone(lan, await pair(lan, typeof how === "string" ? { code: how } : how, name));
}

// Has the TV show a code (the local port, as Settings does) and pairs with it.
export async function pairFromTv(tv: string, lan: string, name = "a phone"): Promise<TestPhone> {
  const { pairing } = (await (await fetch(`${tv}/api/phones/pair`, { method: "POST" })).json()) as { pairing: { code: string } };
  return pairPhone(lan, pairing.code, name);
}

// The phone a page in the tests' browser paired as, from what the page keeps.
export async function phoneOfPage(page: { evaluate<T>(run: () => T): Promise<T> }, lan: string): Promise<TestPhone> {
  const kept = JSON.parse((await page.evaluate(() => localStorage.getItem("agentv-phone-key"))) ?? "null") as Kept;
  return new TestPhone(lan, { id: kept.id, key: Buffer.from(kept.key, "base64url").toString("base64") });
}

export type { Kept };
