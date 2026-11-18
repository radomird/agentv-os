// Makes vectors.json, next to this file: one pairing by the QR code's
// secret, one by the code typed from the TV, one with a TV that has an id,
// answers to a pairing that a phone has to refuse, a hello, and a run of
// signed and sealed requests with their answers, some of which the TV
// refuses.
// docs/phone-api.md says what each value is.
//
//   node test/origaitv/fixtures/phone-channel/make-vectors.mts
//
// Everything here is worked out by hand, with Node's crypto and the strings
// as the doc has them, and none of the daemon's own channel code. The test
// (test/origaitv/unit/phone-channel-vectors.test.mts) then replays the file
// through the daemon's code and through the phone's page, so the three have
// to agree. It also makes the vectors again and holds them against the
// file, so a change here without a new file fails.
//
// Nothing in the file is a real key. Each "random" value is the start of
// the SHA-256 of a label, so it comes out the same every time.

import { createCipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SEALED = "application/origaitv-sealed";
const JSON_TYPE = "application/json";
const LABELS = { pair: "origaitv pair v1", pairBox: "origaitv pair box v1", pairBoxId: "origaitv pair box id v1", key: "origaitv phone key v1", helloBox: "origaitv hello box v1", session: "origaitv session v1" };
// The letters a code is made of, as the TV shows it.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
// Where the TV answers phones in these vectors.
const HOST = "192.168.1.20:3001";
const NOW = "2026-01-01T00:00:00.000Z";

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | string): Buffer => createHash("sha256").update(bytes).digest();
const fixed = (label: string, length: number): Buffer => sha256(`origaitv phone channel test vector: ${label}`).subarray(0, length);
const hmac = (key: Uint8Array, ...parts: (Uint8Array | string)[]): Buffer => {
  const mac = createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return mac.digest();
};
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array | string, length: number): Buffer => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

// X25519 keys as Node takes them: a few bytes of DER, then the key.
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const privateKey = (raw: Uint8Array) => createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: "der", type: "pkcs8" });
const publicOf = (raw: Uint8Array): Buffer => createPublicKey(privateKey(raw)).export({ format: "der", type: "spki" }).subarray(SPKI.length);
const shared = (mine: Uint8Array, theirs: Uint8Array): Buffer => diffieHellman({ privateKey: privateKey(mine), publicKey: createPublicKey({ key: Buffer.concat([SPKI, theirs]), format: "der", type: "spki" }) });

// ChaCha20-Poly1305: the nonce, the sealed text, the tag.
function seal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, extra: string): Buffer {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(extra), { plaintextLength: plain.length });
  return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

// The same bytes with the last one changed: a tag that no longer fits.
function spoiled(bytes: Uint8Array): Buffer {
  const copy = Buffer.from(bytes);
  copy[copy.length - 1] ^= 1;
  return copy;
}

// --- Pairing ---------------------------------------------------------------------

// One pairing: the TV shows a code and a QR code, and the phone proves it
// has one of the two. `typed` is the code as someone typed it, or nothing
// for the QR code. `boxId` is the TV's id, when it has one: the answer then
// says it, and the TV's proof covers it under a label of its own.
function pairing(tag: string, name: string, phoneName: string, typed?: string, boxId?: string) {
  const code = Array.from(fixed(`${tag} code`, 6), (byte) => ALPHABET[byte % ALPHABET.length]).join("");
  const secret = fixed(`${tag} qr secret`, 16);
  const phonePrivate = fixed(`${tag} phone x25519`, 32);
  const phonePublic = publicOf(phonePrivate);
  const boxPrivate = fixed(`${tag} tv x25519`, 32);
  const boxPublic = publicOf(boxPrivate);
  const id = `p-${fixed(`${tag} phone id`, 4).toString("hex")}`;
  // What the phone proves it has, and what the phone's key is salted with:
  // the QR code's 16 bytes, or the code's six letters as text.
  const k = typed === undefined ? secret : Buffer.from(code);
  const proof = hmac(k, LABELS.pair, phonePublic);
  const dh = shared(phonePrivate, boxPublic);
  const phoneKey = hkdf(dh, k, Buffer.concat([Buffer.from(LABELS.key), phonePublic, boxPublic]), 32);
  const confirm = boxId === undefined ? hmac(phoneKey, LABELS.pairBox, phonePublic, boxPublic) : hmac(phoneKey, LABELS.pairBoxId, phonePublic, boxPublic, boxId);
  return {
    name,
    by: typed === undefined ? "secret" : "code",
    tv: {
      code,
      secret: b64u(secret),
      qrAddress: `http://${HOST}/#pair=${b64u(secret)}`,
      x25519Private: b64u(boxPrivate),
      x25519Public: b64u(boxPublic),
      phoneId: id,
      now: NOW,
      ...(boxId === undefined ? {} : { boxId }),
    },
    phone: {
      ...(typed === undefined ? {} : { typed }),
      name: phoneName,
      x25519Private: b64u(phonePrivate),
      x25519Public: b64u(phonePublic),
    },
    k: b64u(k),
    request: { method: "POST", address: "/api/phone/pair", type: JSON_TYPE, text: JSON.stringify({ key: b64u(phonePublic), name: phoneName, proof: b64u(proof) }) },
    answer: { status: 200, type: JSON_TYPE, text: JSON.stringify({ ok: true, id, key: b64u(boxPublic), confirm: b64u(confirm), phone: { id, name: phoneName, pairedAt: NOW }, ...(boxId === undefined ? {} : { boxId }) }) },
    x25519Shared: b64u(dh),
    // The 32 bytes both sides now hold: the phone's key.
    phoneKey: b64u(phoneKey),
    // The phone's key as the page keeps it, under "origaitv-phone-key".
    kept: JSON.stringify({ id, key: b64u(phoneKey) }),
  };
}

// --- The session -----------------------------------------------------------------

interface Step {
  name: string;
  method: string;
  // The address as code might write it, when the wire has it another way.
  written?: string;
  address: string;
  counter: number;
  grant?: string;
  // A JSON body, which goes sealed, or an upload, which goes as it is.
  json?: unknown;
  upload?: { type: string; bytes: Buffer };
  // What the TV's route answers, before it's sealed.
  status: number;
  answer: unknown;
}

function session(phoneId: string, phoneKey: Buffer) {
  const phoneNonce = fixed("hello phone nonce", 16);
  const boxNonce = fixed("hello tv nonce", 16);
  const id = b64u(fixed("session id", 16));
  const keys = hkdf(phoneKey, Buffer.concat([phoneNonce, boxNonce]), LABELS.session, 96);
  const sign = keys.subarray(0, 32);
  const up = keys.subarray(32, 64);
  const down = keys.subarray(64, 96);
  const grant = b64u(fixed("pin grant", 24));

  const signature = (method: string, address: string, counter: number | string, grantSent: string, digest: string) => {
    const signed = [method, address, counter, grantSent, digest].join("\n");
    return { signed, sig: b64u(hmac(sign, signed)) };
  };
  const headers = (counter: number | string, sig: string, grantSent: string, type?: string, length?: number) => ({
    "X-OrigaiTV-Session": id,
    "X-OrigaiTV-Counter": String(counter),
    ...(grantSent ? { "X-OrigaiTV-Grant": grantSent } : {}),
    ...(type ? { "Content-Type": type } : {}),
    ...(length === undefined ? {} : { "Content-Length": String(length) }),
    "X-OrigaiTV-Sig": sig,
  });
  const sealedAnswer = (step: Pick<Step, "method" | "address" | "counter" | "status">, text: string) => {
    const nonce = fixed(`answer nonce ${step.counter}`, 12);
    const extra = `${step.method}\n${step.address}\n${step.counter}\n${step.status}`;
    return { status: step.status, type: SEALED, text, nonce: b64u(nonce), extra, body: b64u(seal(down, nonce, Buffer.from(text), extra)) };
  };

  // One request the TV takes, as it goes on the wire, and its answer.
  const taken = (step: Step) => {
    const grantSent = step.grant ?? "";
    const base = { name: step.name, method: step.method, ...(step.written ? { written: step.written } : {}), address: step.address, counter: step.counter, grant: grantSent };
    const answer = sealedAnswer(step, JSON.stringify(step.answer));
    if (step.upload) {
      const digest = `length:${step.upload.bytes.length}`;
      const { signed, sig } = signature(step.method, step.address, step.counter, grantSent, digest);
      return { ...base, upload: { type: step.upload.type, length: step.upload.bytes.length }, digest, signed, headers: headers(step.counter, sig, grantSent, step.upload.type, step.upload.bytes.length), body: b64u(step.upload.bytes), answer };
    }
    if (step.json !== undefined) {
      const text = JSON.stringify(step.json);
      const nonce = fixed(`request nonce ${step.counter}`, 12);
      const extra = `${step.method}\n${step.address}\n${step.counter}`;
      const body = seal(up, nonce, Buffer.from(text), extra);
      const digest = sha256(body).toString("hex");
      const { signed, sig } = signature(step.method, step.address, step.counter, grantSent, digest);
      return { ...base, json: { text, nonce: b64u(nonce), extra }, digest, signed, headers: headers(step.counter, sig, grantSent, SEALED, body.length), body: b64u(body), answer };
    }
    const digest = sha256("").toString("hex");
    const { signed, sig } = signature(step.method, step.address, step.counter, grantSent, digest);
    return { ...base, digest, signed, headers: headers(step.counter, sig, grantSent), body: null, answer };
  };

  const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), fixed("photo", 28)]);
  const steps = [
    taken({ name: "a key on the remote: JSON, sealed", method: "POST", address: "/api/phone/remote", counter: 1, json: { key: "up" }, status: 200, answer: { ok: true } }),
    taken({ name: "the long poll: a GET with a query and no body", method: "GET", address: "/api/phone/state?since=7", counter: 2, status: 200, answer: { ok: true, version: 8 } }),
    taken({ name: "the PIN, for a grant", method: "POST", address: "/api/phone/pin", counter: 3, json: { pin: "1234" }, status: 200, answer: { ok: true, grant, until: "2026-01-01T00:05:00.000Z" } }),
    taken({ name: "a guarded request, sent again with the grant", method: "POST", address: "/api/phone/updates/install", counter: 4, grant, json: {}, status: 200, answer: { ok: true } }),
    taken({
      name: "an upload: not sealed, signed by its length, with an address the wire escapes",
      method: "POST",
      written: "/api/phone/share/photo?credit=ana's día",
      address: "/api/phone/share/photo?credit=ana%27s%20d%C3%ADa",
      counter: 5,
      upload: { type: "image/jpeg", bytes: photo },
      status: 200,
      answer: { ok: true, waits: false },
    }),
    taken({ name: "a guarded request with no grant: the refusal comes sealed, tied to its 403", method: "POST", address: "/api/phone/updates/install", counter: 6, json: {}, status: 403, answer: { ok: false, error: "That needs the PIN", pin: true } }),
  ];

  // Requests the TV refuses, in the order the test sends them, after the
  // six above. `counts` says whether the counter is used up by it.
  const SESSION_AGAIN = JSON.stringify({ ok: false, error: "this phone has to say hello again", session: true });
  const PAIR_AGAIN = JSON.stringify({ ok: false, error: "This phone isn't paired. Pair it from your TV.", pair: true });
  const again = { status: 401, type: JSON_TYPE, text: SESSION_AGAIN };
  const first = steps[0];

  // Counter 7, changed on the way: the signature no longer fits the body.
  const seven = taken({ name: "", method: "POST", address: "/api/phone/remote", counter: 7, json: { key: "down" }, status: 200, answer: { ok: true } });
  // Counter 7 again, sealed wrong by the phone itself: the signature fits,
  // the tag doesn't.
  const badBody = spoiled(Buffer.from(seven.body!, "base64url"));
  const badSigned = signature("POST", "/api/phone/remote", 7, "", sha256(badBody).toString("hex"));
  // JSON that isn't sealed, signed by its length as an upload is.
  const bare = Buffer.from(JSON.stringify({ key: "up" }));
  const bareSigned = signature("POST", "/api/phone/remote", 8, "", `length:${bare.length}`);
  const get = (counter: number | string, name: string) => ({ ...taken({ name, method: "GET", address: "/api/phone/state", counter: counter as number, status: 200, answer: { ok: true, version: 8 } }) });
  const late = get(72, "");
  const zero = signature("GET", "/api/phone/state", "0", "", sha256("").toString("hex"));
  const padded = signature("GET", "/api/phone/state", "074", "", sha256("").toString("hex"));

  const refused = [
    { name: "the first request, sent again: its counter is used", method: first.method, address: first.address, headers: first.headers, body: first.body, counts: false, answer: again },
    { name: "counter 7 with a byte changed on the way: the signature doesn't fit", method: seven.method, address: seven.address, headers: seven.headers, body: b64u(badBody), counts: false, answer: again },
    {
      name: "counter 7 signed over a body whose tag is wrong: the TV can't open it",
      method: "POST",
      address: "/api/phone/remote",
      headers: headers(7, badSigned.sig, "", SEALED, badBody.length),
      body: b64u(badBody),
      counts: true,
      answer: sealedAnswer({ method: "POST", address: "/api/phone/remote", counter: 7, status: 400 }, JSON.stringify({ ok: false, error: "that request couldn't be opened" })),
    },
    { name: "JSON that isn't sealed", method: "POST", address: "/api/phone/remote", headers: headers(8, bareSigned.sig, "", JSON_TYPE, bare.length), body: b64u(bare), counts: false, answer: again },
    { name: "a counter of 0", method: "GET", address: "/api/phone/state", headers: headers("0", zero.sig, ""), body: null, counts: false, answer: again },
    { name: "a counter with a 0 in front", method: "GET", address: "/api/phone/state", headers: headers("074", padded.sig, ""), body: null, counts: false, answer: again },
    { name: "a session the TV doesn't know", method: "GET", address: "/api/phone/state", headers: { ...get(8, "").headers, "X-OrigaiTV-Session": b64u(fixed("no such session", 16)) }, body: null, counts: false, answer: again },
    { name: "no session named at all", method: "GET", address: "/api/phone/state", headers: {}, body: null, counts: false, answer: { status: 401, type: JSON_TYPE, text: PAIR_AGAIN } },
  ];

  // The window: with 200 the newest counter, 72 is too far behind (it has
  // to be above 200 - 128) and 73 is still taken.
  const window = {
    size: 128,
    newest: get(200, "counter 200, far ahead of the last: taken, and now the newest"),
    tooOld: { name: "counter 72: 128 behind the newest, so refused", method: late.method, address: late.address, headers: late.headers, body: null, counts: false, answer: again },
    oldest: get(73, "counter 73: 127 behind the newest, so still taken"),
  };

  // Answers to the first request that the phone has to refuse.
  const good = Buffer.from(first.answer.body, "base64url");
  const answersToRefuse = [
    { name: "the right answer with a byte of its tag changed", status: 200, type: SEALED, body: b64u(spoiled(good)) },
    { name: "the right answer under another status", status: 403, type: SEALED, body: first.answer.body },
    { name: "the answer to the second request", status: 200, type: SEALED, body: steps[1].answer.body },
    { name: "the phone's own sealed request, played back as the answer", status: 200, type: SEALED, body: first.body! },
    { name: "the same JSON, not sealed", status: 200, type: JSON_TYPE, body: b64u(Buffer.from(first.answer.text)) },
    { name: "a refusal that isn't sealed", status: 403, type: JSON_TYPE, body: b64u(Buffer.from(JSON.stringify({ ok: false, error: "That needs the PIN", pin: true }))) },
  ];

  return {
    hello: {
      request: { method: "POST", address: "/api/phone/hello", type: JSON_TYPE, text: JSON.stringify({ id: phoneId, nonce: b64u(phoneNonce) }) },
      phoneNonce: b64u(phoneNonce),
      tvNonce: b64u(boxNonce),
      session: id,
      answer: { status: 200, type: JSON_TYPE, text: JSON.stringify({ ok: true, session: id, nonce: b64u(boxNonce), proof: b64u(hmac(phoneKey, LABELS.helloBox, phoneNonce, boxNonce)) }) },
      // A phone the TV doesn't know.
      unknown: { request: { method: "POST", address: "/api/phone/hello", type: JSON_TYPE, text: JSON.stringify({ id: "p-00000000", nonce: b64u(phoneNonce) }) }, answer: { status: 401, type: JSON_TYPE, text: PAIR_AGAIN } },
    },
    derived: { sign: b64u(sign), up: b64u(up), down: b64u(down) },
    requests: steps,
    refused,
    window,
    answersToRefuse,
  };
}

export function make() {
  const bySecret = pairing("by secret", "by the QR code's secret", "Ana's iPhone");
  const byCode = pairing("by code", "by the code typed from the TV", "Living room iPad", "");
  // Typed in lower case with a dash and a space, as a person might.
  byCode.phone.typed = `${byCode.tv.code.slice(0, 3).toLowerCase()}-${byCode.tv.code.slice(3).toLowerCase()} `;
  // A TV with an id, which it only has while it announces itself.
  const withId = pairing("with id", "by the QR code's secret, with a TV that has an id", "Kitchen phone", undefined, fixed("with id box id", 16).toString("hex"));
  // What somebody between the phone and the TV can do to a pairing's answer
  // without the secret, and one thing only an older TV does. A phone has to
  // refuse each, and keep no key from it.
  const answered = (p: typeof bySecret, change: (answer: Record<string, unknown>) => Record<string, unknown>) => ({ status: 200, type: JSON_TYPE, text: JSON.stringify(change(JSON.parse(p.answer.text))) });
  const oldProof = b64u(hmac(Buffer.from(withId.phoneKey, "base64url"), LABELS.pairBox, Buffer.from(withId.phone.x25519Public, "base64url"), Buffer.from(withId.tv.x25519Public, "base64url")));
  const pairingAnswersToRefuse = [
    { name: "the id changed on the way", pairing: 2, answer: answered(withId, (answer) => ({ ...answer, boxId: fixed("another box id", 16).toString("hex") })) },
    { name: "the id taken out on the way, and the proof the TV made", pairing: 2, answer: answered(withId, ({ boxId: _taken, ...answer }) => answer) },
    { name: "the id, and the proof of a pairing without one", pairing: 2, answer: answered(withId, (answer) => ({ ...answer, confirm: oldProof })) },
    { name: "an id put into the answer of a TV that has none", pairing: 0, answer: answered(bySecret, (answer) => ({ ...answer, boxId: withId.tv.boxId })) },
  ];
  // A proof made with a code the TV isn't showing.
  const wrong = b64u(hmac(Buffer.from("ZZZZZZ"), LABELS.pair, Buffer.from(bySecret.phone.x25519Public, "base64url")));
  return {
    about: "Test vectors for the channel between a paired phone and the TV. docs/phone-api.md says what each value is. Made by make-vectors.mts, next to this file. None of these is a real key.",
    encoding: "Bytes are base64url with no padding. A field named text, signed, extra, digest, code, typed or boxId is plain text, and so is every header.",
    labels: LABELS,
    alphabet: ALPHABET,
    host: HOST,
    pairings: [bySecret, byCode, withId],
    // Each answers the request of the pairing at that place in `pairings`.
    pairingAnswersToRefuse,
    pairingRefused: {
      name: "a proof made with a code the TV isn't showing",
      request: { method: "POST", address: "/api/phone/pair", type: JSON_TYPE, text: JSON.stringify({ key: bySecret.phone.x25519Public, name: "Ana's iPhone", proof: wrong }) },
      answer: { status: 403, type: JSON_TYPE, text: JSON.stringify({ ok: false, error: "That isn't the code on your TV" }) },
    },
    // The session is the first pairing's phone.
    session: session(bySecret.tv.phoneId, Buffer.from(bySecret.phoneKey, "base64url")),
  };
}

export const FILE = join(import.meta.dirname, "vectors.json");
export const text = (): string => `${JSON.stringify(make(), null, 2)}\n`;

if (process.argv[1] === import.meta.filename) {
  writeFileSync(FILE, text());
  console.log(`wrote ${FILE}`);
}
