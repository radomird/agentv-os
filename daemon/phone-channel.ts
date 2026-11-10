// How a paired phone talks to the box (ADR-008 keeps the home network on
// plain HTTP until 1.0, so the phone's requests carry their own protection).
//
// Pairing gives the phone and the box a key that never crosses the network:
// each makes an X25519 pair, and the key comes from what the two pairs share
// and from the secret in the TV's QR code (or the code typed from the TV).
//
// After that the phone says hello, and the two derive a session's keys from
// the phone's key and a fresh number from each side. Every request is signed
// with the session's signing key: the method, the address, a counter that
// never repeats, the PIN grant and the body. JSON bodies are sealed with
// ChaCha20-Poly1305 both ways, so the PIN, a key, a sign-in or what's typed
// on the phone can't be read on the way. Sessions live in memory only, so a
// request someone recorded is worth nothing after the daemon restarts, and
// nothing within a session works twice.
//
// The page does the same in companion-web/seal.ts and channel.ts, and
// daemon/phone-client.ts is the phone's side for the box's own checks.

import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

// What each derived value is for, so no two uses share a key or a proof.
export const INFO = {
  pair: "agentv pair v1",
  pairBox: "agentv pair box v1",
  key: "agentv phone key v1",
  helloBox: "agentv hello box v1",
  session: "agentv session v1",
};

export const HEADERS = { session: "x-agentv-session", counter: "x-agentv-counter", sig: "x-agentv-sig", grant: "x-agentv-grant" };

// A sealed JSON body, either way: a 12-byte nonce, the sealed text, and the
// 16-byte tag.
export const SEALED = "application/agentv-sealed";

const NONCE = 12;
const TAG = 16;
// A sealed request is JSON, which the daemon takes up to 64 KiB of.
const MAX_SEALED = 64 * 1024 + NONCE + TAG;
// How far behind the newest counter a request may be. The phone's long wait
// for the state and its other requests overlap, so they don't arrive in
// order.
export const WINDOW = 128;
// A phone keeps a session per open page. An idle one ends after a day.
const SESSIONS_PER_PHONE = 8;
const SESSION_MS = 24 * 3600_000;

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

// The bytes of a base64url string, or null when it isn't one or isn't the
// length asked for.
export function unb64u(value: unknown, length?: number): Buffer | null {
  if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return length !== undefined && bytes.length !== length ? null : bytes;
}

export const hmac = (key: Uint8Array, ...parts: (Uint8Array | string)[]): Buffer => {
  const mac = createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return mac.digest();
};

export const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array | string, length: number): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, salt, typeof info === "string" ? Buffer.from(info) : info, length));

export const sha256hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// Node takes X25519 keys as DER, which is these few bytes and then the key.
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");

export function x25519Pair(): { secret: Buffer; public: Buffer } {
  const pair = generateKeyPairSync("x25519");
  return {
    secret: pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8.length),
    public: pair.publicKey.export({ format: "der", type: "spki" }).subarray(SPKI.length),
  };
}

// What a private key and the other side's public key share, or null for a
// public key that gives nothing (all zeros, which a few crafted keys do).
export function x25519Shared(secret: Uint8Array, other: Uint8Array): Buffer | null {
  if (secret.length !== 32 || other.length !== 32) return null;
  try {
    const shared = diffieHellman({
      privateKey: createPrivateKey({ key: Buffer.concat([PKCS8, secret]), format: "der", type: "pkcs8" }),
      publicKey: createPublicKey({ key: Buffer.concat([SPKI, other]), format: "der", type: "spki" }),
    });
    return shared.every((byte) => byte === 0) ? null : shared;
  } catch {
    return null;
  }
}

// The phone's key, from what the two key pairs share and the secret the TV
// showed.
export function phoneKey(shared: Uint8Array, secret: Uint8Array, phonePublic: Uint8Array, boxPublic: Uint8Array): Buffer {
  return hkdf(shared, secret, Buffer.concat([Buffer.from(INFO.key), phonePublic, boxPublic]), 32);
}

export interface SessionKeys {
  sign: Buffer;
  // Sealing what the phone sends, and what the box answers: two keys, so a
  // request can't be played back as an answer.
  up: Buffer;
  down: Buffer;
}

export function sessionKeys(key: Uint8Array, phoneNonce: Uint8Array, boxNonce: Uint8Array): SessionKeys {
  const keys = hkdf(key, Buffer.concat([phoneNonce, boxNonce]), INFO.session, 96);
  return { sign: keys.subarray(0, 32), up: keys.subarray(32, 64), down: keys.subarray(64, 96) };
}

// What a request's signature covers. The address is the path with its
// query, as sent. The last line is the body's SHA-256 in hex, or for an
// upload "length:" and its Content-Length (see `digest` below).
export function signed(method: string, address: string, counter: number | string, grant: string, digest: string): string {
  return [method, address, counter, grant, digest].join("\n");
}

export const requestExtra = (method: string, address: string, counter: number | string): Buffer => Buffer.from(`${method}\n${address}\n${counter}`);
// An answer is tied to its request and to its own status.
export const answerExtra = (method: string, address: string, counter: number | string, status: number): Buffer => Buffer.from(`${method}\n${address}\n${counter}\n${status}`);

export function seal(key: Uint8Array, plain: Uint8Array, extra: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG });
  cipher.setAAD(extra, { plaintextLength: plain.length });
  return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function open(key: Uint8Array, sealed: Uint8Array, extra: Uint8Array): Buffer | null {
  if (sealed.length < NONCE + TAG) return null;
  try {
    const decipher = createDecipheriv("chacha20-poly1305", key, sealed.subarray(0, NONCE), { authTagLength: TAG });
    decipher.setAAD(extra, { plaintextLength: sealed.length - NONCE - TAG });
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    return Buffer.concat([decipher.update(sealed.subarray(NONCE, sealed.length - TAG)), decipher.final()]);
  } catch {
    return null;
  }
}

// --- The box's side ---------------------------------------------------------------

interface Session {
  id: string;
  phone: string;
  keys: SessionKeys;
  // The newest counter seen, and the ones seen within the window behind it.
  newest: number;
  seen: Set<number>;
  // Whether a signed request ever came on it, and when the last one did.
  used: boolean;
  at: number;
}

export interface ChannelOptions<P> {
  // A paired phone and its key, by its id, or null once it's forgotten.
  phone: (id: string) => { phone: P; key: Buffer } | null;
  now?: () => number;
}

export class PhoneChannel<P> {
  private sessions = new Map<string, Session>();
  private now: () => number;
  private options: ChannelOptions<P>;

  constructor(options: ChannelOptions<P>) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  // A phone opening a session: its id and a number of its own. The answer
  // proves the box holds the phone's key, and null means the box doesn't
  // know the phone. Nothing here is secret, and a session is worth nothing
  // without the key.
  hello(body: unknown): { session: string; nonce: string; proof: string } | null {
    const { id, nonce } = (body ?? {}) as { id?: unknown; nonce?: unknown };
    const phoneNonce = unb64u(nonce, 16);
    const known = typeof id === "string" && phoneNonce ? this.options.phone(id) : null;
    if (!known || !phoneNonce || typeof id !== "string") return null;
    const boxNonce = randomBytes(16);
    const session: Session = { id: b64u(randomBytes(16)), phone: id, keys: sessionKeys(known.key, phoneNonce, boxNonce), newest: 0, seen: new Set(), used: false, at: this.now() };
    this.sessions.set(session.id, session);
    this.trim(id);
    return { session: session.id, nonce: b64u(boxNonce), proof: b64u(hmac(known.key, INFO.helloBox, phoneNonce, boxNonce)) };
  }

  // A phone keeps a few sessions. Past that, one that never carried a signed
  // request goes first, so hellos from someone without the key can't push
  // the phone's own sessions out. Then the one used longest ago.
  private trim(phone: string): void {
    const now = this.now();
    for (const [id, session] of this.sessions) if (session.at + SESSION_MS <= now) this.sessions.delete(id);
    const mine = [...this.sessions.values()].filter((session) => session.phone === phone);
    while (mine.length > SESSIONS_PER_PHONE) {
      const newest = mine[mine.length - 1];
      const rest = mine.filter((session) => session !== newest);
      const drop = rest.filter((session) => !session.used)[0] ?? rest.sort((a, b) => a.at - b.at)[0];
      this.sessions.delete(drop.id);
      mine.splice(mine.indexOf(drop), 1);
    }
  }

  // Settings → Phones forgot a phone: its sessions end with it.
  forget(phone: string): void {
    for (const [id, session] of this.sessions) if (session.phone === phone) this.sessions.delete(id);
  }

  // Checks a request's signature and opens its body. With null, it has
  // answered 401 itself: `pair` when the box doesn't know the phone, and
  // `session` when the phone should say hello again. Those two answers
  // aren't sealed, since there may be no key to seal them with. Otherwise
  // it gives the phone and the request for the routes to read, with a
  // sealed body opened, and from here on every JSON answer written to the
  // response is sealed on its way out.
  async open(request: IncomingMessage, response: ServerResponse): Promise<{ phone: P; request: IncomingMessage } | null> {
    const refuse = (what: "pair" | "session") => {
      const body = JSON.stringify(what === "pair" ? { ok: false, error: "this phone isn't paired: pair it from the tv", pair: true } : { ok: false, error: "this phone has to say hello again", session: true });
      response.writeHead(401, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(body);
      return null;
    };
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === "string" ? value : "";
    };

    const id = header(HEADERS.session);
    // With no session named, the phone holds nothing this box knows: a page
    // from before signing, or anything else.
    if (!id) return refuse("pair");
    const session = this.sessions.get(id);
    if (!session) return refuse("session");
    if (session.at + SESSION_MS <= this.now()) {
      this.sessions.delete(id);
      return refuse("session");
    }
    const known = this.options.phone(session.phone);
    if (!known) {
      this.forget(session.phone);
      return refuse("pair");
    }

    const counterText = header(HEADERS.counter);
    const counter = /^[1-9][0-9]{0,14}$/.test(counterText) ? Number(counterText) : 0;
    const fresh = () => counter > 0 && counter > session.newest - WINDOW && !session.seen.has(counter);
    if (!fresh()) return refuse("session");

    const method = request.method ?? "";
    const address = request.url ?? "/";
    const sealed = header("content-type") === SEALED;
    const length = header("content-length");
    const chunked = request.headers["transfer-encoding"] !== undefined;
    let body = Buffer.alloc(0);
    let digest: string;
    if (sealed) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_SEALED) throw new Error("the request is too big");
        chunks.push(chunk as Buffer);
      }
      body = Buffer.concat(chunks);
      digest = sha256hex(body);
    } else if (chunked || (length !== "" && length !== "0")) {
      // An upload: a photo or a video, up to gigabytes, written to disk as
      // it arrives. Hashing it on the phone first would mean reading it all
      // twice there, so the signature covers its length in place of its
      // hash, and it isn't sealed. Someone in the middle could swap the
      // picture for another of the same length, but can't send one of their
      // own, change where it goes, or send it again.
      // JSON never goes this way: it's always sealed.
      if (chunked || !/^[0-9]{1,15}$/.test(length) || header("content-type").startsWith("application/json")) return refuse("session");
      digest = `length:${Number(length)}`;
    } else {
      digest = sha256hex(body);
    }

    const sig = unb64u(header(HEADERS.sig), 32);
    const expected = hmac(session.keys.sign, signed(method, address, counter, header(HEADERS.grant), digest));
    if (!sig || !same(sig, expected)) return refuse("session");
    // Reading the body took a moment, and the same request may have come
    // twice meanwhile.
    if (!fresh()) return refuse("session");
    session.seen.add(counter);
    if (counter > session.newest) {
      session.newest = counter;
      for (const old of session.seen) if (old <= counter - WINDOW) session.seen.delete(old);
    }
    session.used = true;
    session.at = this.now();

    sealAnswers(response, (status, plain) => seal(session.keys.down, plain, answerExtra(method, address, counter, status)));
    if (!sealed) return { phone: known.phone, request };

    const plain = open(session.keys.up, body, requestExtra(method, address, counter));
    if (!plain) {
      const answer = JSON.stringify({ ok: false, error: "that request couldn't be opened" });
      response.writeHead(400, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(answer), "Cache-Control": "no-store" });
      response.end(answer);
      return null;
    }
    // The routes read the opened JSON as they'd read any request's body.
    const inner = Readable.from([plain], { objectMode: false }) as unknown as IncomingMessage;
    Object.assign(inner, {
      headers: { ...request.headers, "content-type": "application/json", "content-length": String(plain.length) },
      method: request.method,
      url: request.url,
      socket: request.socket,
      httpVersion: request.httpVersion,
    });
    return { phone: known.phone, request: inner };
  }
}

// From here on, an answer written to this response as JSON goes out sealed.
// Anything else (a picture, a download) goes as it is. It holds the JSON
// back until the answer ends, since a sealed answer is sealed whole.
function sealAnswers(response: ServerResponse, sealer: (status: number, plain: Buffer) => Buffer): void {
  const writeHead = response.writeHead.bind(response) as (status: number, headers?: Record<string, string | number | string[]>) => ServerResponse;
  const write = response.write.bind(response) as (...args: unknown[]) => boolean;
  const end = response.end.bind(response) as (...args: unknown[]) => ServerResponse;
  let held: { status: number; headers: Record<string, string | number | string[]> } | null = null;
  const chunks: Buffer[] = [];
  const isJson = (type: unknown) => String(type ?? "").startsWith("application/json");
  const bytes = (chunk: unknown) => (typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));

  response.writeHead = ((status: number, ...rest: unknown[]) => {
    const given = (rest.find((part) => part !== null && typeof part === "object" && !Array.isArray(part)) ?? {}) as Record<string, string | number | string[]>;
    const type = Object.entries(given).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? response.getHeader("content-type");
    if (!isJson(type)) return writeHead(status, given);
    held = { status, headers: Object.fromEntries(Object.entries(given).filter(([name]) => !["content-type", "content-length"].includes(name.toLowerCase()))) };
    return response;
  }) as typeof response.writeHead;

  response.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (!held && !response.headersSent && isJson(response.getHeader("content-type"))) held = { status: response.statusCode, headers: {} };
    if (!held) return write(chunk, ...rest);
    chunks.push(bytes(chunk));
    return true;
  }) as typeof response.write;

  response.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (!held && !response.headersSent && isJson(response.getHeader("content-type"))) held = { status: response.statusCode, headers: {} };
    if (!held) return end(chunk, ...rest);
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") chunks.push(bytes(chunk));
    const sealed = sealer(held.status, Buffer.concat(chunks));
    response.removeHeader("content-type");
    response.removeHeader("content-length");
    writeHead(held.status, { ...held.headers, "Content-Type": SEALED, "Content-Length": sealed.length });
    held = null;
    return end(sealed);
  }) as typeof response.end;
}
