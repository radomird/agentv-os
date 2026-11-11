// The phone's side of daemon/phone-channel.ts, with Node's own crypto: it
// pairs, says hello, signs each request and seals what it sends. The page on
// a real phone does the same in companion-web/channel.ts. This one is for
// the box's own checks (bin/agentv-phone-call) and for the tests.

import { randomBytes } from "node:crypto";
import { answerExtra, b64u, HEADERS, hmac, INFO, open, phoneKey, requestExtra, seal, SEALED, same, sessionKeys, sha256hex, signed, unb64u, x25519Pair, x25519Shared, type SessionKeys } from "./phone-channel.ts";

// What a paired phone keeps: its id on the box, and its key in base64.
export interface Kept {
  id: string;
  key: string;
}

export interface Answer {
  status: number;
  ok: boolean;
  type: string;
  headers: Record<string, string>;
  // The answer's body, opened when it came sealed.
  body: Buffer;
  // Whether it came sealed.
  sealed: boolean;
  // The body as JSON, or {} when it isn't.
  data: Record<string, any>;
}

export interface CallOptions {
  grant?: string;
  // A body that goes as it is, with this content type: an upload.
  type?: string;
  headers?: Record<string, string>;
  // The answer may be a picture or a file, which comes as it is.
  file?: boolean;
}

// The code as the box holds it: upper case, with no spaces or dashes.
export const normalise = (code: string): string => code.replace(/[\s-]/g, "").toUpperCase();

// Pairs with the box at `base`, with the QR code's secret (base64url) or
// the code on the TV. Throws with the box's words when it says no.
export async function pair(base: string, proofOf: { secret: string } | { code: string }, name = "a phone"): Promise<Kept> {
  const k = "secret" in proofOf ? unb64u(proofOf.secret) : Buffer.from(normalise(proofOf.code));
  if (!k) throw new Error("that secret isn't base64url");
  const mine = x25519Pair();
  const response = await fetch(`${base}/api/phone/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: b64u(mine.public), name, proof: b64u(hmac(k, INFO.pair, mine.public)) }),
  });
  const data = (await response.json().catch(() => ({}))) as { id?: string; key?: string; confirm?: string; error?: string };
  if (!response.ok) throw new Error(data.error ?? `pairing answered ${response.status}`);
  const theirs = unb64u(data.key, 32);
  const shared = theirs && x25519Shared(mine.secret, theirs);
  if (!theirs || !shared || typeof data.id !== "string") throw new Error("the box's answer isn't a pairing");
  const key = phoneKey(shared, k, mine.public, theirs);
  const confirm = unb64u(data.confirm, 32);
  if (!confirm || !same(confirm, hmac(key, INFO.pairBox, mine.public, theirs))) throw new Error("the box didn't come to the same key");
  return { id: data.id, key: key.toString("base64") };
}

export class PhoneClient {
  // Where the box's phone port is. It may move, as a test's daemon does.
  base: string;
  readonly kept: Kept;
  private session: { id: string; keys: SessionKeys } | null = null;
  private counter = 0;

  constructor(base: string, kept: Kept) {
    this.base = base;
    this.kept = kept;
  }

  // Opens a session. False when the box doesn't know this phone, or isn't
  // the box that holds its key.
  async hello(): Promise<boolean> {
    const nonce = randomBytes(16);
    const response = await fetch(`${this.base}/api/phone/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: this.kept.id, nonce: b64u(nonce) }) });
    const data = (await response.json().catch(() => ({}))) as { session?: string; nonce?: string; proof?: string };
    const boxNonce = unb64u(data.nonce, 16);
    const proof = unb64u(data.proof, 32);
    const key = Buffer.from(this.kept.key, "base64");
    if (!response.ok || !boxNonce || !proof || typeof data.session !== "string" || !same(proof, hmac(key, INFO.helloBox, nonce, boxNonce))) {
      this.session = null;
      return false;
    }
    this.session = { id: data.session, keys: sessionKeys(key, nonce, boxNonce) };
    this.counter = 0;
    return true;
  }

  // The address as fetch puts it on the wire. It escapes a few characters
  // the caller may have left as they are, an apostrophe for one, and the box
  // checks the signature against what arrived.
  sent(address: string): string {
    const url = new URL(`${this.base}${address}`);
    return url.pathname + url.search;
  }

  // The headers and the body of one signed request, as they go on the wire.
  // A JSON body is sealed. With a type, the body goes as it is.
  sign(method: string, path: string, body?: unknown, options: CallOptions = {}): { headers: Record<string, string>; body: Buffer | undefined; counter: number } {
    if (!this.session) throw new Error("say hello first");
    const address = this.sent(path);
    const counter = ++this.counter;
    const headers: Record<string, string> = { ...options.headers, [HEADERS.session]: this.session.id, [HEADERS.counter]: String(counter) };
    if (options.grant) headers[HEADERS.grant] = options.grant;
    let sent: Buffer | undefined;
    let digest: string;
    if (options.type !== undefined) {
      sent = Buffer.from(body as Uint8Array);
      headers["content-type"] = options.type;
      digest = `length:${sent.length}`;
    } else if (body !== undefined) {
      // Bytes are taken as JSON text already.
      sent = seal(this.session.keys.up, body instanceof Uint8Array ? body : Buffer.from(JSON.stringify(body)), requestExtra(method, address, counter));
      headers["content-type"] = SEALED;
      digest = sha256hex(sent);
    } else {
      digest = sha256hex(Buffer.alloc(0));
    }
    headers[HEADERS.sig] = b64u(hmac(this.session.keys.sign, signed(method, address, counter, options.grant ?? "", digest)));
    return { headers, body: sent, counter };
  }

  // One request, signed and sealed, and its answer opened. When the box
  // doesn't know the session (it restarted, say), it says hello and tries
  // once more.
  //
  // Anyone on the network can write an answer that isn't sealed, so only two
  // of them are taken: the box wanting a hello first, which it can't seal,
  // and a picture or a file, which is never read as JSON and only the one
  // who asked for a file (options.file) takes. Anything else throws. A phone the box doesn't know gets a 401 with
  // `pair` from here, once its hello has failed.
  async call(method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<Answer> {
    const address = this.sent(path);
    for (let attempt = 0; ; attempt++) {
      if (!this.session && !(await this.hello())) return { status: 401, ok: false, type: "application/json", headers: {}, body: Buffer.alloc(0), sealed: false, data: { ok: false, pair: true } };
      const keys = this.session!.keys;
      const request = this.sign(method, address, body, options);
      const response = await fetch(`${this.base}${address}`, { method, headers: request.headers, body: request.body === undefined ? undefined : new Uint8Array(request.body) });
      const raw = Buffer.from(await response.arrayBuffer());
      const type = response.headers.get("content-type") ?? "";
      const headers = Object.fromEntries(response.headers);
      if (type === SEALED) {
        const opened = open(keys.down, raw, answerExtra(method, address, request.counter, response.status));
        if (!opened) throw new Error("the box's answer couldn't be opened");
        let data: Record<string, any> = {};
        try {
          data = JSON.parse(opened.toString("utf8"));
        } catch {
          // Sealed, but not JSON.
        }
        return { status: response.status, ok: response.ok, type: "application/json", headers, body: opened, sealed: true, data };
      }
      const json = type.startsWith("application/json");
      if (response.status === 401 && json && attempt === 0) {
        let data: Record<string, any> = {};
        try {
          data = JSON.parse(raw.toString("utf8"));
        } catch {
          // Not the box's.
        }
        if (data.session === true || data.pair === true) {
          this.session = null;
          continue;
        }
      }
      if (options.file && method === "GET" && response.status === 200 && !json) return { status: 200, ok: true, type, headers, body: raw, sealed: false, data: {} };
      throw new Error("the box's answer wasn't sealed");
    }
  }
}
