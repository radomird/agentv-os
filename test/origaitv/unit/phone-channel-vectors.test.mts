// The phone channel's test vectors (test/origaitv/fixtures/phone-channel/),
// replayed through both sides: the daemon's own code (daemon/phones.ts and
// phone-channel.ts), and the phone's page (companion-web/channel.ts). Each
// is given the vectors' "random" bytes and has to come to the vectors' exact
// bytes, so a client written from docs/phone-api.md can use the same file.
//
// The vectors are worked out by make-vectors.mts with none of this code, and
// the first test holds the file against what that script makes now.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { answerExtra, HEADERS, INFO, open, PhoneChannel, phoneKey, requestExtra, seal, SEALED, sessionKeys, sha256hex, signed, WINDOW, x25519Pair, x25519Shared } from "../../../daemon/phone-channel.ts";
import { Phones } from "../../../daemon/phones.ts";
import { FILE, make, text } from "../fixtures/phone-channel/make-vectors.mts";

const ROOT = join(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "origaitv-phone-vectors-"));
const V = JSON.parse(readFileSync(FILE, "utf8")) as ReturnType<typeof make>;
const S = V.session;
const un = (value: string) => Buffer.from(value, "base64url");
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

// The "random" bytes a side draws, in the order it draws them. Each draw has
// to ask for the length the vectors have next.
function drawn(...values: Uint8Array[]) {
  const left = [...values];
  const draw = (length: number): Buffer => {
    const next = left.shift();
    assert.ok(next, `nothing left to draw for ${length} random bytes`);
    assert.equal(next.length, length, "a draw of another length than the vectors have next");
    return Buffer.from(next);
  };
  return Object.assign(draw, { left: () => left.length });
}

after(() => rmSync(dir, { recursive: true, force: true }));

test("vectors.json is what make-vectors.mts makes", () => {
  assert.equal(readFileSync(FILE, "utf8"), text(), "run node test/origaitv/fixtures/phone-channel/make-vectors.mts");
  assert.deepEqual(V.labels, INFO);
  assert.equal(S.window.size, WINDOW);
});

test("T28.4 the two pairings with a TV that has no id are what they were before a TV could have one, byte for byte", () => {
  const before = V.pairings.slice(0, 2);
  assert.deepEqual(before.map((p) => "boxId" in p.tv || "boxId" in JSON.parse(p.answer.text)), [false, false]);
  // The SHA-256 of the two as the file had them then.
  assert.equal(createHash("sha256").update(JSON.stringify(before)).digest("hex"), "8eef38bcd63e36cbda9e7b7029d8a57edd3deeb782c00253112aa1fb8f09b41a");
  // And the one with an id is there, with its id in the answer.
  assert.deepEqual(V.pairings.slice(2).map((p) => JSON.parse(p.answer.text).boxId), [V.pairings[2].tv.boxId]);
  assert.match(V.pairings[2].tv.boxId!, /^[0-9a-f]{32}$/);
});

// --- The TV's side -----------------------------------------------------------------

for (const [n, p] of V.pairings.entries()) {
  test(`the TV's side: pairing ${p.name}`, () => {
    const letters = [...p.tv.code].map((letter) => V.alphabet.indexOf(letter));
    const random = drawn(un(p.tv.secret), un(p.tv.x25519Private), Buffer.from(p.tv.phoneId.slice(2), "hex"));
    const phones = new Phones({
      path: join(dir, `phones-${n}.json`),
      now: () => Date.parse(p.tv.now),
      random,
      randomInt: (max) => {
        assert.equal(max, V.alphabet.length);
        return letters.shift()!;
      },
    });
    assert.equal(phones.code().code, p.tv.code);
    assert.equal(phones.secret(), p.tv.secret);
    assert.equal(p.tv.qrAddress, `http://${V.host}/#pair=${phones.secret()}`);
    // One wrong try doesn't end the code.
    assert.equal(JSON.stringify({ ok: false, ...phones.pair(JSON.parse(V.pairingRefused.request.text)) }), V.pairingRefused.answer.text);
    // The TV's id is handed in when it has one, and it's in the answer then.
    const paired = phones.pair(JSON.parse(p.request.text), p.tv.boxId);
    assert.equal(JSON.stringify({ ok: true, ...paired }), p.answer.text);
    assert.equal(random.left(), 0);
    assert.deepEqual(phones.key(p.tv.phoneId)?.key, un(p.phoneKey), "the key the TV keeps");
    assert.equal(phones.showing(), null, "a code pairs one phone");

    // The same arithmetic, a step at a time.
    assert.deepEqual(x25519Pair(un(p.phone.x25519Private)).public, un(p.phone.x25519Public));
    assert.deepEqual(x25519Shared(un(p.tv.x25519Private), un(p.phone.x25519Public)), un(p.x25519Shared));
    assert.deepEqual(x25519Shared(un(p.phone.x25519Private), un(p.tv.x25519Public)), un(p.x25519Shared));
    assert.deepEqual(un(p.k), p.by === "secret" ? un(p.tv.secret) : Buffer.from(p.tv.code));
    assert.deepEqual(phoneKey(un(p.x25519Shared), un(p.k), un(p.phone.x25519Public), un(p.tv.x25519Public)), un(p.phoneKey));
  });
}

interface Wire {
  method: string;
  address: string;
  headers: Record<string, string>;
  body: string | null;
}

interface Answer {
  status: number;
  type: string;
  text: string;
  nonce?: string;
  body?: string;
}

// Every request of the session, in the order the TV gets them here: the six
// it takes, the ones it refuses, then the window's three.
const SENT: { wire: Wire; answer: Answer; name: string }[] = [
  ...S.requests.map((r) => ({ wire: r, answer: r.answer, name: r.name })),
  ...S.refused.map((r) => ({ wire: r, answer: r.answer as Answer, name: r.name })),
  { wire: S.window.newest, answer: S.window.newest.answer, name: S.window.newest.name },
  { wire: S.window.tooOld, answer: S.window.tooOld.answer, name: S.window.tooOld.name },
  { wire: S.window.oldest, answer: S.window.oldest.answer, name: S.window.oldest.name },
];

let server: Server;
let base = "";
// What the route saw of each request the channel let through, by counter.
const reached = new Map<string, { type: string; body: Buffer }>();
const phone = V.pairings[0];
const channel = new PhoneChannel({
  phone: (id) => (id === phone.tv.phoneId ? { phone: { id }, key: un(phone.phoneKey) } : null),
  now: () => Date.parse(phone.tv.now),
  // The hello's two, then a nonce for each answer that goes out sealed.
  random: drawn(un(S.hello.tvNonce), un(S.hello.session), ...SENT.flatMap(({ answer }) => (answer.nonce ? [un(answer.nonce)] : []))),
});

before(async () => {
  // What a route answers to each counter, as the vectors have it.
  const routes = new Map([...S.requests, S.window.newest, S.window.oldest].map((r) => [String(r.counter), r.answer]));
  server = createServer((request, response) => {
    void (async () => {
      const opened = await channel.open(request, response);
      if (!opened) return;
      const chunks: Buffer[] = [];
      for await (const chunk of opened.request) chunks.push(chunk as Buffer);
      const counter = String(request.headers[HEADERS.counter]);
      if (routes.has(counter)) reached.set(counter, { type: String(opened.request.headers["content-type"] ?? ""), body: Buffer.concat(chunks) });
      // A request the vectors say is refused has no answer here: if the
      // channel lets one through, the test fails on this 500.
      const answer = routes.get(counter) ?? { status: 500, text: "{}" };
      response.writeHead(answer.status, { "Content-Type": "application/json" });
      response.end(answer.text);
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(() => {
  server?.close();
  server?.closeAllConnections();
});

async function send(wire: Wire): Promise<{ status: number; type: string; body: Buffer }> {
  const body = wire.body === null ? undefined : un(wire.body);
  const { "Content-Length": length, ...headers } = wire.headers;
  if (length !== undefined) assert.equal(Number(length), body?.length, "the vectors' Content-Length");
  const response = await fetch(`${base}${wire.address}`, { method: wire.method, headers, body });
  return { status: response.status, type: response.headers.get("content-type") ?? "", body: Buffer.from(await response.arrayBuffer()) };
}

test("the TV's side: a hello gives the session and its keys", () => {
  assert.equal(channel.hello(JSON.parse(S.hello.unknown.request.text)), null, "a phone the TV doesn't know");
  assert.equal(JSON.stringify({ ok: true, ...channel.hello(JSON.parse(S.hello.request.text)) }), S.hello.answer.text);
  const keys = sessionKeys(un(phone.phoneKey), un(S.hello.phoneNonce), un(S.hello.tvNonce));
  assert.deepEqual({ sign: b64u(keys.sign), up: b64u(keys.up), down: b64u(keys.down) }, S.derived);
});

test("the TV's side: each request is taken or refused as the vectors say, and each answer is the vectors' bytes", async () => {
  for (const { wire, answer, name } of SENT) {
    const got = await send(wire);
    assert.deepEqual([got.status, got.type], [answer.status, answer.type], name);
    if (answer.type === SEALED) assert.equal(b64u(got.body), answer.body, name);
    else assert.equal(got.body.toString(), answer.text, name);
  }
  // What the routes read: the JSON opened, and an upload as it was sent.
  for (const r of S.requests) {
    const saw = reached.get(String(r.counter));
    assert.ok(saw, r.name);
    if ("json" in r) assert.deepEqual([saw.type, saw.body.toString()], ["application/json", r.json.text], r.name);
    else if ("upload" in r) assert.deepEqual([saw.type, b64u(saw.body)], [r.upload.type, r.body], r.name);
    else assert.equal(saw.body.length, 0, r.name);
  }
  assert.deepEqual([...reached.keys()], [...S.requests, S.window.newest, S.window.oldest].map((r) => String(r.counter)), "nothing the TV refused reached a route");
  // A refusal that used its counter up: the same request again isn't opened.
  const used = S.refused.find((r) => r.counts)!;
  const again = await send(used);
  assert.deepEqual([again.status, again.type, JSON.parse(again.body.toString()).session], [401, "application/json", true]);
});

test("the channel's own arithmetic comes to the vectors' strings and bytes", () => {
  const keys = { sign: un(S.derived.sign), up: un(S.derived.up), down: un(S.derived.down) };
  for (const r of [...S.requests, S.window.newest, S.window.oldest]) {
    let digest = sha256hex(Buffer.alloc(0));
    if ("json" in r) {
      assert.equal(requestExtra(r.method, r.address, r.counter).toString(), r.json.extra, r.name);
      const sealed = seal(keys.up, Buffer.from(r.json.text), requestExtra(r.method, r.address, r.counter), un(r.json.nonce));
      assert.equal(b64u(sealed), r.body, r.name);
      assert.equal(open(keys.up, sealed, requestExtra(r.method, r.address, r.counter))?.toString(), r.json.text, r.name);
      digest = sha256hex(sealed);
    } else if ("upload" in r) {
      digest = `length:${r.upload.length}`;
    }
    assert.equal(digest, r.digest, r.name);
    assert.equal(signed(r.method, r.address, r.counter, r.grant, digest), r.signed, r.name);
    const extra = answerExtra(r.method, r.address, r.counter, r.answer.status);
    assert.equal(extra.toString(), r.answer.extra, r.name);
    assert.equal(b64u(seal(keys.down, Buffer.from(r.answer.text), extra, un(r.answer.nonce))), r.answer.body, r.name);
    assert.equal(open(keys.down, un(r.answer.body), extra)?.toString(), r.answer.text, r.name);
  }
  // Answers to the first request that don't open with its key and its extra.
  const first = S.requests[0];
  for (const bad of S.answersToRefuse.filter((answer) => answer.type === SEALED)) {
    assert.equal(open(keys.down, un(bad.body), answerExtra(first.method, first.address, first.counter, bad.status)), null, bad.name);
  }
});

// --- The phone's page --------------------------------------------------------------

interface Signed {
  headers: Record<string, string>;
  body?: Uint8Array;
  answer(status: number, type: string, bytes: Uint8Array, file?: boolean): Record<string, any> | null;
}

interface Page {
  paired(): boolean;
  pair(how: { secret: string } | { code: string }, name: string): Promise<void>;
  sign(method: string, address: string, body: { json: unknown } | { type: string; length: number } | undefined, grant?: string): Promise<Signed>;
}

// What the page's client has of a browser, as companion-channel.test.mts
// gives it: where it came from, what it keeps, fetch, and here its random
// numbers too.
const kept = new Map<string, string>();
const realFetch = globalThis.fetch;
const realRandom = globalThis.crypto.getRandomValues;
// What the TV answers in these tests, by path, and what it was sent.
let tv: Record<string, { status: number; type: string; text: string }> = {};
let asked: { path: string; type: string; text: string }[] = [];
let pages = 0;
const page = async (): Promise<Page> => (await import(`${join(ROOT, "companion-web/channel.ts")}?vectors=${pages++}`)) as Page;

function browser(random: ReturnType<typeof drawn>): void {
  kept.clear();
  asked = [];
  Object.defineProperty(globalThis, "location", { value: { origin: `http://${V.host}` }, configurable: true });
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: (name: string) => kept.get(name) ?? null, setItem: (name: string, value: string) => void kept.set(name, value), removeItem: (name: string) => void kept.delete(name) },
    configurable: true,
  });
  globalThis.crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    const bytes = array as unknown as Uint8Array;
    bytes.set(random(bytes.length));
    return array;
  }) as typeof realRandom;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    asked.push({ path, type: new Headers(init?.headers).get("content-type") ?? "", text: String(init?.body) });
    const answer = tv[path];
    assert.ok(answer, `the page asked for ${path}`);
    return new Response(answer.text, { status: answer.status, headers: { "Content-Type": answer.type } });
  }) as typeof fetch;
}

function browserGone(): void {
  globalThis.fetch = realFetch;
  globalThis.crypto.getRandomValues = realRandom;
}

// A header by its name, in whatever case it was written.
const header = (headers: Record<string, string>, name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

for (const p of V.pairings) {
  test(`the phone's page: pairing ${p.name}`, async () => {
    const random = drawn(un(p.phone.x25519Private));
    browser(random);
    try {
      tv = { "/api/phone/pair": p.answer };
      const channel = await page();
      // The QR code's secret is what's after "#pair=" in its address.
      const how = p.by === "secret" ? { secret: new URLSearchParams(new URL(p.tv.qrAddress).hash.slice(1)).get("pair")! } : { code: (p.phone as { typed: string }).typed };
      await channel.pair(how, p.phone.name);
      assert.deepEqual(asked, [{ path: p.request.address, type: p.request.type, text: p.request.text }]);
      assert.equal(kept.get("origaitv-phone-key"), p.kept);
      assert.equal(random.left(), 0);
      assert.equal(channel.paired(), true);
    } finally {
      browserGone();
    }
  });
}

test("the phone's page: an answer to a pairing that doesn't prove the TV's key pairs nothing", async () => {
  const p = V.pairings[0];
  browser(drawn(un(p.phone.x25519Private)));
  try {
    // The other pairing's TV key and proof, as someone in the middle might
    // answer.
    tv = { "/api/phone/pair": V.pairings[1].answer };
    const channel = await page();
    await assert.rejects(channel.pair({ secret: p.tv.secret }, p.phone.name), /Couldn't reach your TV/);
    assert.equal(channel.paired(), false);
  } finally {
    browserGone();
  }
});

// The vectors' answers a phone has to refuse, and one more that the page
// refuses: an id that isn't text. It isn't in the file, because a client
// that reads it as no id at all is as safe: the TV that answered has none.
const noId = V.pairings[0].answer;
const notText = { name: "an id that isn't text, put into the answer of a TV that has none", pairing: 0, answer: { ...noId, text: JSON.stringify({ ...JSON.parse(noId.text), boxId: null }) } };
for (const bad of [...V.pairingAnswersToRefuse, notText]) {
  test(`T28.4 the phone's page keeps no key from a pairing answer with ${bad.name}`, async () => {
    const p = V.pairings[bad.pairing];
    browser(drawn(un(p.phone.x25519Private)));
    try {
      tv = { "/api/phone/pair": bad.answer };
      const channel = await page();
      await assert.rejects(channel.pair({ secret: p.tv.secret }, p.phone.name), /Couldn't reach your TV/);
      assert.deepEqual(asked, [{ path: p.request.address, type: p.request.type, text: p.request.text }], "it asked as the vectors have it, so only the answer is what's wrong");
      assert.equal(channel.paired(), false);
      assert.equal(kept.size, 0, "and no key is kept");
    } finally {
      browserGone();
    }
  });
}

test("the phone's page: the hello, then each request and each answer, as the vectors have them", async () => {
  const p = V.pairings[0];
  browser(drawn(un(p.phone.x25519Private), un(S.hello.phoneNonce), ...S.requests.flatMap((r) => ("json" in r ? [un(r.json.nonce)] : []))));
  try {
    tv = { "/api/phone/pair": p.answer, "/api/phone/hello": S.hello.answer };
    const channel = await page();
    await channel.pair({ secret: p.tv.secret }, p.phone.name);
    let last: Signed | null = null;
    for (const r of S.requests) {
      const body = "json" in r ? { json: JSON.parse(r.json.text) } : "upload" in r ? { type: r.upload.type, length: r.upload.length } : undefined;
      // The address as code writes it: the page signs what goes on the wire.
      const made = await channel.sign(r.method, "written" in r && r.written ? r.written : r.address, body, r.grant);
      for (const [name, value] of Object.entries(r.headers)) {
        // The browser adds the length itself.
        if (name !== "Content-Length") assert.equal(header(made.headers, name), value, `${r.name}: ${name}`);
      }
      assert.equal(Object.keys(made.headers).length, Object.keys(r.headers).filter((name) => name !== "Content-Length").length, r.name);
      assert.equal("json" in r ? b64u(made.body!) : made.body, "json" in r ? r.body : undefined, r.name);
      assert.deepEqual(made.answer(r.answer.status, r.answer.type, un(r.answer.body)), JSON.parse(r.answer.text), r.name);

      if (r === S.requests[0]) for (const bad of S.answersToRefuse) assert.throws(() => made.answer(bad.status, bad.type, un(bad.body)), /Couldn't reach your TV/, bad.name);
      last = made;
    }
    // The one answer that isn't sealed and still counts: say hello again.
    // It ends the session on the page, so it comes last here.
    const again = S.refused[0].answer;
    assert.equal(last!.answer(again.status, again.type, Buffer.from(again.text)), null);
    assert.deepEqual(asked[1], { path: S.hello.request.address, type: S.hello.request.type, text: S.hello.request.text });
  } finally {
    browserGone();
  }
});
