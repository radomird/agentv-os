// How this phone talks to the box once it's paired. The page comes over
// plain HTTP, so it protects what it sends itself:
//
// - Pairing gives the phone a key of its own that never crosses the network.
//   The phone and the box each make an X25519 pair, and the key comes from
//   what the pairs share and from the secret in the TV's QR code (or the
//   code typed from the TV).
// - Each time the page opens it says hello, and a session's keys come from
//   the phone's key and a fresh number from each side.
// - Every request is signed: the method, the address, a counter, the PIN
//   grant and the body. JSON is sealed both ways. A photo or a video goes as
//   it is, with its length signed.
//
// The box's side is daemon/phone-channel.ts, and seal.ts has the arithmetic.

import { concat, decode, encode, hex, hkdf, hmac, open, random, same, seal, sha256, text, utf8, x25519, x25519Public, type Bytes } from "./seal.ts";

const INFO = {
  pair: "agentv pair v1",
  pairBox: "agentv pair box v1",
  key: "agentv phone key v1",
  helloBox: "agentv hello box v1",
  session: "agentv session v1",
};
const SEALED = "application/agentv-sealed";

// The box said this phone isn't paired, or not any more. Nothing proves that
// answer is the box's, so the phone keeps its key all the same: only a new
// pairing that worked puts another in its place.
export class Unpaired extends Error {}
const UNPAIRED = "This phone isn't paired. Pair it from your TV.";

const KEPT = "agentv-phone-key";
// What a phone paired before requests were signed still holds. Nothing takes
// it any more.
const OLD = "agentv-phone-token";

interface Kept {
  id: string;
  key: string;
}

// A private window keeps the key only while the page is open.
let held: Kept | null = null;

function kept(): Kept | null {
  if (held) return held;
  try {
    localStorage.removeItem(OLD);
    const value = JSON.parse(localStorage.getItem(KEPT) ?? "null") as Kept | null;
    if (value && typeof value.id === "string" && typeof value.key === "string") held = value;
  } catch {}
  return held;
}

function keep(value: Kept | null): void {
  held = value;
  session = null;
  live = null;
  try {
    if (value) localStorage.setItem(KEPT, JSON.stringify(value));
    else localStorage.removeItem(KEPT);
  } catch {}
}

export const paired = (): boolean => kept() !== null;

async function plain(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

// Pairs this phone with the QR code's secret, or with the code on the TV.
// Neither is sent: the box gets proof that the phone has it.
export async function pair(how: { secret: string } | { code: string }, name: string): Promise<void> {
  const k = "secret" in how ? (decode(how.secret) ?? new Uint8Array(0)) : utf8(how.code.replace(/[\s-]/g, "").toUpperCase());
  const mine = random(32);
  const mineOpen = x25519Public(mine);
  const { status, data } = await plain("/api/phone/pair", { key: encode(mineOpen), name, proof: encode(hmac(k, concat(utf8(INFO.pair), mineOpen))) });
  if (status !== 200) throw new Error(typeof data.error === "string" ? data.error : "Couldn't reach your TV");
  const theirs = typeof data.key === "string" ? decode(data.key) : null;
  const confirm = typeof data.confirm === "string" ? decode(data.confirm) : null;
  if (!theirs || theirs.length !== 32 || !confirm || typeof data.id !== "string") throw new Error("Couldn't reach your TV");
  const key = hkdf(x25519(mine, theirs), k, concat(utf8(INFO.key), mineOpen, theirs), 32);
  // Only the box that saw the same secret comes to the same key.
  if (!same(confirm, hmac(key, concat(utf8(INFO.pairBox), mineOpen, theirs)))) throw new Error("Couldn't reach your TV");
  keep({ id: data.id, key: encode(key) });
}

interface Session {
  id: string;
  sign: Bytes;
  up: Bytes;
  down: Bytes;
  counter: number;
}

// The session being opened or in use, and the one that's open.
let session: Promise<Session> | null = null;
let live: Session | null = null;

async function hello(): Promise<Session> {
  const mine = kept();
  const key = mine ? decode(mine.key) : null;
  if (!mine || !key) throw new Unpaired("This phone isn't paired");
  const nonce = random(16);
  const { status, data } = await plain("/api/phone/hello", { id: mine.id, nonce: encode(nonce) });
  // Anyone on the network can write this answer, so its own words aren't
  // shown: the phone says what the box does.
  if (status === 401) throw new Unpaired(UNPAIRED);
  const boxNonce = typeof data.nonce === "string" ? decode(data.nonce) : null;
  const proof = typeof data.proof === "string" ? decode(data.proof) : null;
  // The proof says the answer is from the box that holds this phone's key.
  if (status !== 200 || !boxNonce || !proof || typeof data.session !== "string" || !same(proof, hmac(key, concat(utf8(INFO.helloBox), nonce, boxNonce)))) throw new Error("Couldn't reach your TV");
  const keys = hkdf(key, concat(nonce, boxNonce), utf8(INFO.session), 96);
  return { id: data.session, sign: keys.subarray(0, 32), up: keys.subarray(32, 64), down: keys.subarray(64, 96), counter: 0 };
}

function current(): Promise<Session> {
  if (!session) {
    const starting = hello();
    session = starting;
    starting.then(
      (opened) => {
        if (session === starting) live = opened;
      },
      () => {
        if (session === starting) session = null;
      },
    );
  }
  return session;
}

export interface Signed {
  headers: Record<string, string>;
  // A JSON body, sealed.
  body?: Bytes;
  // The answer's status, content type and bytes, opened: its JSON, or {}
  // for a picture or a file, which only the one who asked for a file takes.
  // Null when the box wants a hello first, and the request should be signed
  // and sent again. It throws for an answer that should have come sealed
  // and didn't.
  answer(status: number, type: string, bytes: Bytes, file?: boolean): Record<string, any> | null;
}

// The address as the browser puts it on the wire. It escapes a few
// characters the caller may have left as they are, an apostrophe in a file's
// name for one, and the box checks the signature against what arrived.
function sent(path: string): string {
  const url = new URL(path, location.origin);
  return url.pathname + url.search;
}

const isJson = (type: string): boolean => type.startsWith("application/json");

// One request's headers, and its body sealed when it's JSON. An upload
// gives its content type and its length in place of a body: it goes as it
// is, and the signature covers how long it is.
export async function sign(method: string, address: string, body: { json: unknown } | { type: string; length: number } | undefined, grant = ""): Promise<Signed> {
  const path = sent(address);
  const now = await current();
  const counter = ++now.counter;
  const headers: Record<string, string> = { "X-AgenTV-Session": now.id, "X-AgenTV-Counter": String(counter) };
  if (grant) headers["X-AgenTV-Grant"] = grant;
  let sealed: Bytes | undefined;
  let digest: string;
  if (body && "json" in body) {
    const nonce = random(12);
    sealed = concat(nonce, seal(now.up, nonce, utf8(JSON.stringify(body.json)), utf8(`${method}\n${path}\n${counter}`)));
    headers["Content-Type"] = SEALED;
    digest = hex(sha256(sealed));
  } else if (body) {
    headers["Content-Type"] = body.type;
    digest = `length:${body.length}`;
  } else {
    digest = hex(sha256(new Uint8Array(0)));
  }
  headers["X-AgenTV-Sig"] = encode(hmac(now.sign, utf8([method, path, counter, grant, digest].join("\n"))));
  return {
    headers,
    body: sealed,
    answer(status, type, bytes, file = false) {
      if (type === SEALED) {
        const opened = bytes.length < 28 ? null : open(now.down, bytes.subarray(0, 12), bytes.subarray(12), utf8(`${method}\n${path}\n${counter}\n${status}`));
        if (!opened) throw new Error("Couldn't reach your TV");
        try {
          return JSON.parse(text(opened));
        } catch {
          return {};
        }
      }
      // Anyone on the network can write an answer that isn't sealed, so the
      // phone takes only two of them. One is the box wanting a hello first,
      // which it can't seal: it may have no key to seal with. All that does
      // is start a new session, and the hello says whether the box still
      // knows this phone.
      if (status === 401 && isJson(type)) {
        let data: Record<string, any> = {};
        try {
          data = JSON.parse(text(bytes));
        } catch {}
        if (data.session === true || data.pair === true) {
          if (live === now) {
            session = null;
            live = null;
          }
          return null;
        }
      }
      // The other is a picture or a file the phone asked for, which goes as
      // it is. It's never read as JSON, and nothing that asked for JSON
      // takes it: a sign-in page some network put in the box's place isn't
      // an answer with nothing in it.
      if (file && method === "GET" && status === 200 && !isJson(type)) return {};
      throw new Error("Couldn't reach your TV");
    },
  };
}

export interface Answer {
  status: number;
  ok: boolean;
  type: string;
  bytes: Bytes;
  data: Record<string, any>;
}

// A request to the box and its answer. When the box doesn't know the
// session (it restarted, or the page sat a day), the phone says hello again
// and asks once more, and nobody sees a thing.
export function call(method: string, path: string, body?: { json: unknown } | { type: string; blob: Blob }, grant = ""): Promise<Answer> {
  return ask(method, path, body, grant, false);
}

// A picture or a file from the box, which comes as it is, in bytes. When the
// box says no, that comes sealed, as every answer to call does.
export function file(path: string): Promise<Answer> {
  return ask("GET", path, undefined, "", true);
}

async function ask(method: string, path: string, body: { json: unknown } | { type: string; blob: Blob } | undefined, grant: string, wantsFile: boolean): Promise<Answer> {
  for (let attempt = 0; ; attempt++) {
    const signed = await sign(method, path, body && "blob" in body ? { type: body.type, length: body.blob.size } : body, grant);
    const response = await fetch(path, { method, headers: signed.headers, body: body && "blob" in body ? body.blob : (signed.body as BodyInit | undefined) });
    const type = response.headers.get("content-type") ?? "";
    let bytes = new Uint8Array(await response.arrayBuffer());
    const data = signed.answer(response.status, type, bytes, wantsFile);
    if (data === null) {
      // The session is cleared by now: the next sign says hello.
      if (attempt === 0) continue;
      throw new Error("Couldn't reach your TV");
    }
    if (type === SEALED) bytes = new Uint8Array(0);
    return { status: response.status, ok: response.ok, type, bytes, data };
  }
}
