// How a paired phone's requests are signed and sealed (daemon/phone-channel.ts,
// F1 of the 2026-11-10 audit). The phone's side is worked out by hand here,
// with Node's crypto and the strings as the design has them, so the wire
// format is pinned by something other than the code that reads it.

import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { PhoneChannel } from "../../../daemon/phone-channel.ts";
import { Daemon } from "../../../daemon/server.ts";
import { pairFromTv } from "./phone-client.mts";

const ROOT = join(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "agentv-phone-channel-"));
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const un = (text: unknown) => Buffer.from(String(text), "base64url");
const mac = (key: Uint8Array, ...parts: (string | Uint8Array)[]) => {
  const h = createHmac("sha256", key);
  for (const part of parts) h.update(part);
  return h.digest();
};
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const SEALED = "application/agentv-sealed";

// --- The phone's side, by hand -------------------------------------------------------

interface Keys {
  session: string;
  sign: Buffer;
  up: Buffer;
  down: Buffer;
}

// Pairs over HTTP and gives the phone's id and its key, and what went over
// the wire each way.
async function handPair(lan: string, k: Buffer, name = "hand") {
  const mine = generateKeyPairSync("x25519");
  const A = mine.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const sent = JSON.stringify({ key: b64u(A), name, proof: b64u(mac(k, "agentv pair v1", A)) });
  const response = await fetch(`${lan}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: sent });
  const text = await response.text();
  if (response.status !== 200) return { status: response.status, sent, text, id: "", key: Buffer.alloc(0) };
  const data = JSON.parse(text);
  const B = un(data.key);
  const shared = diffieHellman({ privateKey: mine.privateKey, publicKey: createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), B]), format: "der", type: "spki" }) });
  const key = Buffer.from(hkdfSync("sha256", shared, k, Buffer.concat([Buffer.from("agentv phone key v1"), A, B]), 32));
  assert.deepEqual(un(data.confirm), mac(key, "agentv pair box v1", A, B), "the box came to the same key");
  return { status: 200, sent, text, id: data.id as string, key };
}

async function handHello(base: string, id: string, key: Buffer): Promise<Keys> {
  const nonce = randomBytes(16);
  const response = await fetch(`${base}/api/phone/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, nonce: b64u(nonce) }) });
  assert.equal(response.status, 200);
  const data = (await response.json()) as Record<string, string>;
  const boxNonce = un(data.nonce);
  assert.equal(boxNonce.length, 16);
  assert.deepEqual(un(data.proof), mac(key, "agentv hello box v1", nonce, boxNonce), "the box holds the phone's key");
  const keys = Buffer.from(hkdfSync("sha256", key, Buffer.concat([nonce, boxNonce]), "agentv session v1", 96));
  return { session: data.session, sign: keys.subarray(0, 32), up: keys.subarray(32, 64), down: keys.subarray(64, 96) };
}

function sealUp(keys: Keys, method: string, address: string, counter: number, body: unknown): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", keys.up, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${method}\n${address}\n${counter}`), { plaintextLength: Buffer.byteLength(JSON.stringify(body)) });
  return Buffer.concat([nonce, cipher.update(JSON.stringify(body)), cipher.final(), cipher.getAuthTag()]);
}

function openWith(key: Buffer, sealed: Buffer, extra: string): string | null {
  try {
    const decipher = createDecipheriv("chacha20-poly1305", key, sealed.subarray(0, 12), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(extra), { plaintextLength: sealed.length - 28 });
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString();
  } catch {
    return null;
  }
}

interface Ask {
  method?: string;
  address?: string;
  counter: number;
  grant?: string;
  // A JSON body, sealed, or bytes sent as they are with a content type.
  body?: unknown;
  upload?: { type: string; bytes: Buffer };
  // What goes on the wire in place of what was signed.
  wire?: { method?: string; address?: string; counter?: number | string; grant?: string; body?: Buffer; sig?: string; session?: string; headers?: Record<string, string> };
}

// One request, signed as the design says, and the answer as it came and
// as it opens.
async function ask(base: string, keys: Keys, a: Ask) {
  const method = a.method ?? "GET";
  const address = a.address ?? "/echo";
  const headers: Record<string, string> = {};
  let body: Buffer | undefined;
  let digest = sha(Buffer.alloc(0));
  if (a.body !== undefined) {
    body = sealUp(keys, method, address, a.counter, a.body);
    headers["Content-Type"] = SEALED;
    digest = sha(body);
  } else if (a.upload) {
    body = a.upload.bytes;
    headers["Content-Type"] = a.upload.type;
    digest = `length:${body.length}`;
  }
  const sig = b64u(mac(keys.sign, [method, address, a.counter, a.grant ?? "", digest].join("\n")));
  const grant = a.wire?.grant ?? a.grant;
  Object.assign(headers, { "X-AgenTV-Session": a.wire?.session ?? keys.session, "X-AgenTV-Counter": String(a.wire?.counter ?? a.counter), "X-AgenTV-Sig": a.wire?.sig ?? sig }, grant ? { "X-AgenTV-Grant": grant } : {}, a.wire?.headers ?? {});
  const sentBody = a.wire?.body ?? body;
  const response = await fetch(`${base}${a.wire?.address ?? address}`, { method: a.wire?.method ?? method, headers, body: sentBody === undefined ? undefined : new Uint8Array(sentBody) });
  const raw = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "";
  const opened = type === SEALED ? openWith(keys.down, raw, `${method}\n${address}\n${a.counter}\n${response.status}`) : null;
  return { status: response.status, type, raw, opened, data: JSON.parse(opened ?? (type.startsWith("application/json") ? raw.toString() : "{}")) as Record<string, any>, headers, sentBody };
}

// --- The channel alone, behind a small server, with a clock of the test's -------------

const clock = { now: 1_800_000_000_000 };
const known = new Map<string, Buffer>();
let channel: PhoneChannel<{ id: string }>;
let small: Server;
let base = "";

before(async () => {
  channel = new PhoneChannel({ phone: (id) => (known.has(id) ? { phone: { id }, key: known.get(id)! } : null), now: () => clock.now });
  small = createServer((request, response) => {
    void (async () => {
      if (request.url === "/api/phone/hello") {
        let text = "";
        for await (const chunk of request) text += chunk;
        const hello = channel.hello(JSON.parse(text));
        response.writeHead(hello ? 200 : 401, { "Content-Type": "application/json" });
        response.end(JSON.stringify(hello ?? { pair: true }));
        return;
      }
      const opened = await channel.open(request, response);
      if (!opened) return;
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of opened.request) {
        size += chunk.length;
        if (size < 1_000_000) chunks.push(chunk);
      }
      const got = Buffer.concat(chunks).toString();
      if (opened.request.url === "/picture") {
        response.writeHead(200, { "Content-Type": "image/png", "Content-Length": 3 });
        response.end(Buffer.from([1, 2, 3]));
        return;
      }
      const answer = JSON.stringify({ phone: opened.phone.id, method: opened.request.method, url: opened.request.url, type: opened.request.headers["content-type"] ?? null, grant: opened.request.headers["x-agentv-grant"] ?? null, got, size });
      // A route may write its answer in pieces.
      response.writeHead(opened.request.url === "/no" ? 403 : 200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(answer), "Cache-Control": "no-store" });
      response.write(answer.slice(0, 5));
      response.end(answer.slice(5));
    })().catch((error: Error) => {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error.message);
    });
  });
  await new Promise<void>((resolve) => small.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(small.address() as { port: number }).port}`;
});

after(async () => {
  small?.close();
  small?.closeAllConnections();
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

function phone(id: string): Buffer {
  const key = randomBytes(32);
  known.set(id, key);
  return key;
}

const refused = (answer: { status: number; type: string; data: Record<string, any> }, what: "session" | "pair" = "session") => {
  assert.equal(answer.status, 401);
  assert.match(answer.type, /^application\/json/, "readable with no key");
  assert.equal(answer.data[what], true, JSON.stringify(answer.data));
};

test("F1 hello opens a session for a phone the box knows, and proves the box holds its key", async () => {
  const key = phone("p-hello");
  const keys = await handHello(base, "p-hello", key);
  assert.equal(un(keys.session).length, 16);
  const other = await handHello(base, "p-hello", key);
  assert.notEqual(other.session, keys.session);
  assert.notDeepEqual(other.sign, keys.sign, "each session has keys of its own");
  for (const body of [{ id: "p-nobody", nonce: b64u(randomBytes(16)) }, { id: "p-hello", nonce: b64u(randomBytes(8)) }, { id: "p-hello" }, {}, { id: 7, nonce: "x" }]) {
    const response = await fetch(`${base}/api/phone/hello`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 401, JSON.stringify(body));
  }
});

test("F1 a signed request passes, its JSON goes sealed, and the answer comes back sealed for that request alone", async () => {
  const keys = await handHello(base, "p-hello", known.get("p-hello")!);
  const got = await ask(base, keys, { counter: 1, address: "/echo?since=4" });
  assert.equal(got.status, 200);
  assert.equal(got.type, SEALED);
  assert.deepEqual(got.data, { phone: "p-hello", method: "GET", url: "/echo?since=4", type: null, grant: null, got: "", size: 0 });
  assert.ok(!got.raw.includes("p-hello"), "the answer can't be read on the way");
  assert.equal(got.raw.length, 12 + Buffer.byteLength(JSON.stringify(got.data)) + 16, "a nonce, the text and a tag");
  // It opens only as the answer to this request, with this status.
  assert.equal(openWith(keys.up, got.raw, "GET\n/echo?since=4\n1\n200"), null, "not with the key requests are sealed with");
  assert.equal(openWith(keys.down, got.raw, "GET\n/echo?since=4\n2\n200"), null, "not as another request's answer");
  assert.equal(openWith(keys.down, got.raw, "GET\n/echo?since=4\n1\n403"), null, "not with another status");
  assert.equal(openWith(keys.down, got.raw, "GET\n/echo\n1\n200"), null);

  const sent = await ask(base, keys, { counter: 2, method: "POST", address: "/echo", body: { pin: "2468" }, grant: "g-1" });
  assert.equal(sent.status, 200);
  assert.deepEqual([sent.data.got, sent.data.type, sent.data.grant], ['{"pin":"2468"}', "application/json", "g-1"], "the route reads JSON as it always did");
  assert.ok(!sent.sentBody!.includes("2468") && !sent.raw.includes("2468"), "the PIN isn't readable either way");
  assert.equal(openWith(keys.down, sent.sentBody!, "POST\n/echo\n2\n200"), null, "a request can't be sent back as an answer");

  // An error is sealed too, and what isn't JSON goes as it is.
  const no = await ask(base, keys, { counter: 3, address: "/no" });
  assert.deepEqual([no.status, no.type, no.data.url], [403, SEALED, "/no"]);
  const picture = await ask(base, keys, { counter: 4, address: "/picture" });
  assert.deepEqual([picture.status, picture.type, [...picture.raw]], [200, "image/png", [1, 2, 3]]);
});

test("F1 a request whose method, address, body, counter or grant changed on the way is refused", async () => {
  const keys = await handHello(base, "p-hello", known.get("p-hello")!);
  let n = 0;
  refused(await ask(base, keys, { counter: ++n, wire: { method: "DELETE" } }));
  refused(await ask(base, keys, { counter: ++n, wire: { address: "/other" } }));
  refused(await ask(base, keys, { counter: ++n, address: "/echo?a=1", wire: { address: "/echo?a=2" } }));
  refused(await ask(base, keys, { counter: ++n, wire: { counter: 99 } }));
  refused(await ask(base, keys, { counter: ++n, wire: { grant: "stolen" } }));
  refused(await ask(base, keys, { counter: ++n, grant: "mine", wire: { grant: "other" } }));
  // Another body, sealed right for this very request, under the first one's signature.
  const counter = ++n;
  refused(await ask(base, keys, { counter, method: "POST", body: { key: "up" }, wire: { body: sealUp(keys, "POST", "/echo", counter, { key: "down" }) } }));
  refused(await ask(base, keys, { counter: ++n, method: "POST", wire: { body: sealUp(keys, "POST", "/echo", n, {}), headers: { "Content-Type": SEALED } } }), "session");
  // No signature, a wrong one, one from another session, and no counter.
  refused(await ask(base, keys, { counter: ++n, wire: { sig: "" } }));
  refused(await ask(base, keys, { counter: ++n, wire: { sig: b64u(randomBytes(32)) } }));
  const other = await handHello(base, "p-hello", known.get("p-hello")!);
  refused(await ask(base, keys, { counter: ++n, wire: { session: other.session } }));
  for (const counter of ["", "0", "-1", "1.5", "1e3", " 7", "9".repeat(17)]) refused(await ask(base, keys, { counter: ++n, wire: { counter } }), "session");
  // None of those used a counter up: the request as signed still passes.
  assert.equal((await ask(base, keys, { counter: 1 })).status, 200);
});

test("F1 a request works once: sent again it's refused, and counters may arrive out of order within the window", async () => {
  const keys = await handHello(base, "p-hello", known.get("p-hello")!);
  const first = await ask(base, keys, { counter: 10, method: "POST", body: { key: "enter" } });
  assert.equal(first.status, 200);
  // The very same bytes again.
  const again = await fetch(`${base}/echo`, { method: "POST", headers: first.headers, body: new Uint8Array(first.sentBody!) });
  assert.equal(again.status, 401);
  assert.equal(((await again.json()) as Record<string, unknown>).session, true);
  // Behind the newest, but not seen yet.
  assert.equal((await ask(base, keys, { counter: 3 })).status, 200);
  refused(await ask(base, keys, { counter: 3 }));
  assert.equal((await ask(base, keys, { counter: 9 })).status, 200);
  // Far ahead moves the window: 128 behind the newest is too old, seen or not.
  assert.equal((await ask(base, keys, { counter: 300 })).status, 200);
  refused(await ask(base, keys, { counter: 172 }));
  refused(await ask(base, keys, { counter: 5 }));
  assert.equal((await ask(base, keys, { counter: 173 })).status, 200);
  refused(await ask(base, keys, { counter: 173 }));
  refused(await ask(base, keys, { counter: 300 }));
  // Many at once, as the long wait for the state and the keys overlap.
  const together = await Promise.all([305, 301, 304, 302, 303, 302].map((counter) => ask(base, keys, { counter })));
  assert.deepEqual(together.map((answer) => answer.status).sort(), [200, 200, 200, 200, 200, 401]);
});

test("F1 a sealed body that doesn't open is refused even under a right signature, and JSON is never taken unsealed", async () => {
  const keys = await handHello(base, "p-hello", known.get("p-hello")!);
  // Sealed for another address, then signed for this one by someone with the signing key only.
  const body = sealUp(keys, "POST", "/other", 1, { key: "up" });
  const sig = (digest: string, counter: number) => b64u(mac(keys.sign, ["POST", "/echo", counter, "", digest].join("\n")));
  const wrong = await ask(base, keys, { counter: 1, method: "POST", wire: { body, sig: sig(sha(body), 1), headers: { "Content-Type": SEALED } } });
  assert.equal(wrong.status, 400);
  const short = Buffer.from("too short");
  assert.equal((await ask(base, keys, { counter: 2, method: "POST", wire: { body: short, sig: sig(sha(short), 2), headers: { "Content-Type": SEALED } } })).status, 400);
  // Plain JSON, signed as an upload would be.
  const json = Buffer.from('{"key":"up"}');
  refused(await ask(base, keys, { counter: 3, method: "POST", upload: { type: "application/json", bytes: json } }));
  refused(await ask(base, keys, { counter: 4, method: "POST", wire: { body: json, sig: sig(sha(json), 4), headers: { "Content-Type": "application/json" } } }));
});

test("F1 an upload goes as it is with its length signed: another length, or no length, is refused", async () => {
  const keys = await handHello(base, "p-hello", known.get("p-hello")!);
  const bytes = randomBytes(300_000);
  const sent = await ask(base, keys, { counter: 1, method: "POST", address: "/echo?name=a.mp4", upload: { type: "video/mp4", bytes } });
  assert.equal(sent.status, 200);
  assert.deepEqual([sent.data.size, sent.data.type, sent.type], [300_000, "video/mp4", SEALED], "the route gets the bytes, and its answer is sealed");
  refused(await ask(base, keys, { counter: 2, method: "POST", upload: { type: "video/mp4", bytes }, wire: { body: Buffer.concat([bytes, Buffer.from("more")]) } }));
  refused(await ask(base, keys, { counter: 3, method: "POST", upload: { type: "video/mp4", bytes }, wire: { body: bytes.subarray(0, 100) } }));
  // Sent in chunks, there's no length to check the signature against.
  const sig = b64u(mac(keys.sign, ["POST", "/echo", 4, "", "length:5"].join("\n")));
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${base}/echo`, { method: "POST", headers: { "Content-Type": "video/mp4", "Transfer-Encoding": "chunked", "X-AgenTV-Session": keys.session, "X-AgenTV-Counter": "4", "X-AgenTV-Sig": sig } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end("12345");
  });
  assert.equal(status, 401);
});

test("F1 a phone keeps a few sessions, an idle one ends after a day, and hellos from someone without the key don't push the phone's own out", async () => {
  const key = phone("p-many");
  const mine = await handHello(base, "p-many", key);
  assert.equal((await ask(base, mine, { counter: 1 })).status, 200);
  // Sessions nobody signs anything on: only the id is needed to open one.
  const idle: Keys[] = [];
  for (let i = 0; i < 20; i++) idle.push(await handHello(base, "p-many", key));
  assert.equal((await ask(base, mine, { counter: 2 })).status, 200, "the session in use is still here");
  refused(await ask(base, idle[0], { counter: 1 }));
  assert.equal((await ask(base, idle[19], { counter: 1 })).status, 200, "the newest is too");
  // Used ones go by how long ago they were used.
  const used: Keys[] = [];
  for (let i = 0; i < 9; i++) {
    clock.now += 1000;
    used.push(await handHello(base, "p-many", key));
    assert.equal((await ask(base, used[i], { counter: 1 })).status, 200);
  }
  refused(await ask(base, mine, { counter: 3 }));
  assert.equal((await ask(base, used[8], { counter: 2 })).status, 200);
  // Another phone's sessions don't count against this one.
  const otherKey = phone("p-other");
  const theirs = await handHello(base, "p-other", otherKey);
  assert.equal((await ask(base, theirs, { counter: 1 })).status, 200);
  assert.equal((await ask(base, used[8], { counter: 3 })).status, 200);

  clock.now += 24 * 3600_000 - 1;
  assert.equal((await ask(base, theirs, { counter: 2 })).status, 200, "a day less a moment");
  clock.now += 24 * 3600_000;
  refused(await ask(base, theirs, { counter: 3 }));
  assert.equal((await ask(base, await handHello(base, "p-other", otherKey), { counter: 1 })).status, 200, "hello again, and it goes on");
});

test("F1 a forgotten phone's sessions end with it", async () => {
  const key = phone("p-gone");
  const keys = await handHello(base, "p-gone", key);
  assert.equal((await ask(base, keys, { counter: 1 })).status, 200);
  known.delete("p-gone");
  refused(await ask(base, keys, { counter: 2 }), "pair");
  known.set("p-gone", key);
  refused(await ask(base, keys, { counter: 3 }), "session");
  const again = await handHello(base, "p-gone", key);
  channel.forget("p-gone");
  refused(await ask(base, again, { counter: 1 }), "session");
});

// --- The daemon ---------------------------------------------------------------------

let daemon: Daemon;
let tv = "";
let lan = "";
const lines: string[] = [];
const start = async () => {
  daemon = new Daemon({ root: ROOT, state: join(dir, "state"), builtins: null, port: 0, log: (line) => lines.push(line), running: "0.3.0-1", lanPort: 0, lanHost: "127.0.0.1", address: () => "192.168.1.20", phoneWaitMs: 300 });
  tv = `http://127.0.0.1:${await daemon.listen()}`;
  lan = `http://127.0.0.1:${daemon.lanPort}`;
};
const local = async (method: string, path: string, body?: unknown) => (await fetch(`${tv}${path}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<Record<string, any>>;

let mine: { id: string; key: Buffer };

test("F1 pairing: neither the code nor the secret crosses the network, and the phone's key doesn't either", async () => {
  await start();
  const { pairing } = await local("POST", "/api/phones/pair");
  assert.equal(pairing.url, `http://192.168.1.20:${daemon.lanPort}/`, "the address the TV shows as text has no secret in it");
  const secret = un(daemon.phones.secret());
  assert.equal(secret.length, 16);
  // A wrong proof is a wrong try, as a wrong code was.
  assert.equal((await handPair(lan, randomBytes(16))).status, 403);
  const paired = await handPair(lan, secret, "by the qr code");
  assert.equal(paired.status, 200);
  for (const wire of [paired.sent, paired.text]) {
    for (const secretThing of [pairing.code, b64u(secret), secret.toString("base64"), secret.toString("hex"), b64u(paired.key), paired.key.toString("base64"), paired.key.toString("hex")]) assert.ok(!wire.includes(secretThing));
  }
  assert.deepEqual(Object.keys(JSON.parse(paired.text)).sort(), ["confirm", "id", "key", "ok", "phone"], "no token comes back");
  const stored = JSON.parse(readFileSync(join(dir, "state", "phones.json"), "utf8")).phones;
  assert.deepEqual([stored.length, stored[0].id, stored[0].key], [1, paired.id, paired.key.toString("base64")]);
  mine = paired;

  // The code typed from the TV pairs too, with the code as it is on the TV.
  const typed = (await local("POST", "/api/phones/pair")).pairing;
  const second = await handPair(lan, Buffer.from(typed.code), "by the code");
  assert.equal(second.status, 200);
  assert.ok(!second.sent.includes(typed.code));
  assert.deepEqual((await local("GET", "/api/phones")).phones.map((phone: { name: string }) => phone.name), ["by the qr code", "by the code"]);
  assert.ok(!lines.join("\n").includes(typed.code) && !lines.join("\n").includes(b64u(secret)));
});

test("F1 five wrong proofs over the network end the code", async () => {
  const { pairing } = await local("POST", "/api/phones/pair");
  for (let i = 0; i < 5; i++) assert.equal((await handPair(lan, randomBytes(16))).status, 403);
  const late = await handPair(lan, Buffer.from(pairing.code));
  assert.equal(late.status, 403);
  assert.match(late.text, /That code ran out/);
});

test("F1 the daemon's own routes: the state comes sealed, the PIN goes sealed, and a wrong PIN's answer is sealed too", async () => {
  await local("PUT", "/api/pin", { pin: "4826" });
  const keys = await handHello(lan, mine.id, mine.key);
  const state = await ask(lan, keys, { counter: 1, address: "/api/phone/state" });
  assert.deepEqual([state.status, state.type, state.data.phone.name], [200, SEALED, "by the qr code"]);
  assert.ok(!state.raw.includes("by the qr code"));
  const wrong = await ask(lan, keys, { counter: 2, method: "POST", address: "/api/phone/pin", body: { pin: "0000" } });
  assert.deepEqual([wrong.status, wrong.type, wrong.data.ok], [403, SEALED, false]);
  const right = await ask(lan, keys, { counter: 3, method: "POST", address: "/api/phone/pin", body: { pin: "4826" } });
  assert.equal(right.status, 200);
  assert.equal(typeof right.data.grant, "string");
  assert.ok(!right.sentBody!.includes("4826") && !right.raw.includes(right.data.grant), "neither the PIN nor its grant can be read on the way");
  // The grant is in the signature: it can't be put on another request.
  const onTv = (await local("POST", "/api/pin/check", { pin: "4826" })).grant;
  const child = (await (await fetch(`${tv}/api/viewers`, { method: "POST", headers: { "Content-Type": "application/json", "X-AgenTV-Grant": onTv }, body: JSON.stringify({ name: "mila", role: "child" }) })).json()) as Record<string, any>;
  const to = (id: string, counter: number, how: Partial<Ask> = {}) => ask(lan, keys, { counter, method: "POST", address: "/api/phone/viewer", body: { id }, ...how });
  assert.equal((await to(child.profile.id, 4)).status, 200);
  const owner = (await ask(lan, keys, { counter: 5, address: "/api/phone/state" })).data.viewers.find((viewer: { role: string }) => viewer.role === "adult");
  assert.equal((await to(owner.id, 6)).status, 403, "a child's profile to an adult's needs the PIN");
  refused(await to(owner.id, 7, { wire: { grant: right.data.grant } }));
  assert.equal((await to(owner.id, 8, { grant: right.data.grant })).status, 200);
  // The long wait for the state and a key at once, out of order.
  const version = (await ask(lan, keys, { counter: 9, address: "/api/phone/state" })).data.version;
  const waiting = ask(lan, keys, { counter: 11, address: `/api/phone/state?since=${version}` });
  const key = await ask(lan, keys, { counter: 10, method: "POST", address: "/api/phone/remote", body: { key: "up" } });
  assert.equal(key.type, SEALED);
  assert.equal((await waiting).status, 200);
  // What's open before pairing still is, and isn't sealed.
  for (const path of ["/", "/companion-web/seal.ts", "/companion-web/channel.ts", "/api/theme.css"]) {
    const open = await fetch(`${lan}${path}`);
    assert.equal(open.status, 200, path);
    assert.notEqual(open.headers.get("content-type"), SEALED);
  }
});

test("F1 a token no longer does anything: the old header gets 401, and so does a request with nothing", async () => {
  for (const headers of [{}, { Authorization: `Bearer ${"x".repeat(43)}` }, { Authorization: `Bearer ${mine.key.toString("base64url")}` }, { Authorization: `Bearer ${mine.id}` }] as Record<string, string>[]) {
    const response = await fetch(`${lan}/api/phone/state`, { headers });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: "This phone isn't paired. Pair it from your TV.", pair: true });
  }
  const sent = await fetch(`${lan}/api/phone/remote`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${"x".repeat(43)}` }, body: '{"key":"up"}' });
  assert.equal(sent.status, 401);
});

test("F1 what was recorded before the daemon restarted is worth nothing after: the session is gone, and hello opens a new one", async () => {
  const keys = await handHello(lan, mine.id, mine.key);
  const before = await ask(lan, keys, { counter: 1, method: "POST", address: "/api/phone/remote", body: { key: "up" } });
  assert.notEqual(before.status, 401);
  const port = daemon.lanPort;
  await daemon.close();
  await start();
  assert.notEqual(daemon.lanPort, port);
  // The recorded request, and a new one signed with the old session's keys.
  const replayed = await fetch(`${lan}/api/phone/remote`, { method: "POST", headers: before.headers, body: new Uint8Array(before.sentBody!) });
  assert.equal(replayed.status, 401);
  assert.equal(((await replayed.json()) as Record<string, unknown>).session, true);
  refused(await ask(lan, keys, { counter: 2, address: "/api/phone/state" }));
  // The phone's key is still good: it says hello and goes on, with nothing to see.
  const fresh = await handHello(lan, mine.id, mine.key);
  assert.equal((await ask(lan, fresh, { counter: 1, address: "/api/phone/state" })).status, 200);
  const replayedAgain = await fetch(`${lan}/api/phone/remote`, { method: "POST", headers: { ...before.headers, "X-AgenTV-Session": fresh.session }, body: new Uint8Array(before.sentBody!) });
  assert.equal(replayedAgain.status, 401, "nor under the new session's name");
});

test("F1 the client the tests and the box's checks use says hello again by itself after a restart", async () => {
  const phone = await pairFromTv(tv, lan, "the client");
  assert.equal((await phone.json("GET", "/api/phone/state")).phone.name, "the client");
  await daemon.close();
  await start();
  phone.base = lan;
  const state = await phone.call("GET", "/api/phone/state");
  assert.deepEqual([state.status, state.sealed, state.data.phone.name], [200, true, "the client"]);
});

test("F1 a phone paired before phones had keys can't do anything, and the file ends up without it", async () => {
  await daemon.close();
  const path = join(dir, "state", "phones.json");
  const kept = JSON.parse(readFileSync(path, "utf8")).phones;
  const token = randomBytes(32).toString("base64url");
  const old = { id: "p-0badc0de", name: "old phone", pairedAt: "2026-10-01T00:00:00.000Z", token: createHash("sha256").update(token).digest("hex") };
  writeFileSync(path, JSON.stringify({ phones: [old, ...kept] }));
  await start();
  assert.equal((await fetch(`${lan}/api/phone/state`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  const hello = await fetch(`${lan}/api/phone/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: old.id, nonce: b64u(randomBytes(16)) }) });
  assert.equal(hello.status, 401);
  assert.equal(((await hello.json()) as Record<string, unknown>).pair, true);
  assert.deepEqual((await local("GET", "/api/phones")).phones.map((phone: { name: string }) => phone.name), ["by the qr code", "by the code", "the client"]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).phones, kept);
  // The ones with keys go on as they were.
  assert.equal((await ask(lan, await handHello(lan, mine.id, mine.key), { counter: 1, address: "/api/phone/state" })).status, 200);
});

test("agentv-phone-call pairs with a code, sends a request as that phone, and fails as curl -f does", async () => {
  // Not spawnSync: the daemon it talks to is in this very process.
  const run = (...args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      execFile(join(ROOT, "bin/agentv-phone-call"), args, { encoding: "utf8", env: { ...process.env, AGENTV_PATH: ROOT, AGENTV_PHONE_URL: lan, AGENTV_URL: tv } }, (error, stdout, stderr) =>
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: stdout.trim(), err: stderr.trim() }),
      );
    });
  const { pairing } = await local("POST", "/api/phones/pair");
  const none = await run("pair", "ZZZZZZ");
  assert.deepEqual([none.code, none.out], [1, ""]);
  const paired = await run("pair", pairing.code, "a check");
  assert.equal(paired.code, 0, paired.err);
  const file = paired.out;
  try {
    assert.equal(statSync(file).mode & 0o777, 0o600, "the key file is its owner's only");
    assert.equal(JSON.parse((await run(file, "GET", "/api/phone/state")).out).phone.name, "a check");
    const wrong = await run(file, "POST", "/api/phone/pin", '{"pin":"0000"}');
    assert.deepEqual([wrong.code, wrong.out], [22, ""]);
    const shown = await run("--errors", file, "POST", "/api/phone/pin", '{"pin":"0000"}');
    assert.deepEqual([shown.code, JSON.parse(shown.out).ok], [22, false]);
    assert.equal(typeof JSON.parse((await run(file, "post", "/api/phone/pin", '{"pin":"4826"}')).out).grant, "string");
    // A file goes as an upload, as curl's --data-binary @file did.
    const picture = join(dir, "not-a-picture.jpg");
    writeFileSync(picture, "not a picture");
    const sent = await run("--errors", file, "POST", "/api/phone/background?credit=x", `@${picture}`, "image/jpeg");
    assert.deepEqual([sent.code, typeof JSON.parse(sent.out).error], [22, "string"], "it reached the route, which says what's wrong with it");
    assert.equal((await run(file, "GET")).code, 2);
    // It asks the box for a code itself. Before setup is done that takes no
    // PIN. After, with a PIN set, it says it needs one, and takes it from
    // the environment.
    const fresh = await run("pair-new", "another check");
    assert.equal(fresh.code, 0, fresh.err);
    rmSync(dirname(fresh.out), { recursive: true, force: true });
    await local("POST", "/api/setup", { done: true });
    const needs = await run("pair-new");
    assert.deepEqual([needs.code, needs.out], [1, ""]);
    assert.match(needs.err, /adult PIN set.*AGENTV_PIN/);
    assert.equal((await run("pair-new", "x", "y")).code, 2);
    process.env.AGENTV_PIN = "0000";
    assert.match((await run("pair-new")).err, /didn't take the PIN/);
    process.env.AGENTV_PIN = "4826";
    const withPin = await run("pair-new", "a check with the pin");
    delete process.env.AGENTV_PIN;
    assert.equal(withPin.code, 0, withPin.err);
    assert.equal(JSON.parse((await run(withPin.out, "GET", "/api/phone/state")).out).phone.name, "a check with the pin");
    rmSync(dirname(withPin.out), { recursive: true, force: true });
    // Starting setup again needs the PIN's grant, now that one is set.
    const { grant } = await local("POST", "/api/pin/check", { pin: "4826" });
    const reset = await fetch(`${tv}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", "X-AgenTV-Grant": grant }, body: JSON.stringify({ done: false }) });
    assert.equal(reset.status, 200);
    assert.equal((await run(file, "POST", "/api/phone/background", `@${picture}`)).code, 2);
  } finally {
    rmSync(dirname(file), { recursive: true, force: true });
  }
});

// The box hands Node raw keys behind these prefixes (daemon/phone-channel.ts).
test("the X25519 keys Node takes are the raw 32 bytes behind a fixed prefix", () => {
  const pair = generateKeyPairSync("x25519");
  const raw = pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(16);
  assert.equal(raw.length, 32);
  const again = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), raw]), format: "der", type: "pkcs8" });
  assert.deepEqual(createPublicKey(again).export({ format: "der", type: "spki" }), pair.publicKey.export({ format: "der", type: "spki" }));
});
