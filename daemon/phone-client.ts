// The phone's side of daemon/phone-channel.ts, with Node's own crypto: it
// pairs, says hello, signs each request and seals what it sends. The page on
// a real phone does the same in companion-web/channel.ts. This one is for
// the box's own checks (bin/origaitv-phone-call) and for the tests.

import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { acceptKey, closeFrame, frame, Frames, OP, packState, unpackTook, type PadState } from "./pad-wire.ts";
import { answerExtra, b64u, HEADERS, hmac, INFO, open, phoneKey, requestExtra, seal, SEALED, same, sessionKeys, sha256hex, signed, streamExtra, streamMessage, streamParts, unb64u, x25519Pair, x25519Shared, type SessionKeys } from "./phone-channel.ts";

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

// The box said no to game mode: its status, and its answer when that came
// sealed.
export class PadRefused extends Error {
  status: number;
  data: Record<string, any>;

  constructor(status: number, data: Record<string, any>) {
    super(typeof data.error === "string" ? data.error : `the box answered ${status}`);
    this.status = status;
    this.data = data;
  }
}

// Game mode as a phone has it (docs/phone-api.md, "Game mode"): the open
// connection, on which each state of the controller is one sealed,
// numbered message, and the box says which ones its controller has taken.
export class PhonePad {
  // Which controller this phone is, 1 to 4.
  slot = 0;
  // The number of the last message sent, and of the newest the box's
  // controller took.
  sent = 0;
  took = 0;
  // How the connection ended, once it has.
  readonly closed: Promise<{ code: number; why: string }>;
  private socket: Socket;
  private keys: SessionKeys;
  private address: string;
  private opened: number;
  private heard = 0;
  private waiting: { n: number; done: () => void }[] = [];
  private end!: (how: { code: number; why: string }) => void;
  private ready!: () => void;
  // Settled once the box's first sealed message has come: the controller
  // is there.
  readonly there: Promise<void>;

  constructor(socket: Socket, keys: SessionKeys, address: string, opened: number, rest: Uint8Array) {
    this.socket = socket;
    this.keys = keys;
    this.address = address;
    this.opened = opened;
    this.closed = new Promise((resolve) => (this.end = resolve));
    this.there = new Promise((resolve) => (this.ready = resolve));
    const frames = new Frames(false);
    let said: { code: number; why: string } | null = null;
    const data = (chunk: Uint8Array) => {
      for (const got of frames.push(chunk)) {
        if ("broken" in got) {
          socket.destroy();
          return;
        }
        if (got.opcode === OP.binary) this.hear(got.payload);
        else if (got.opcode === OP.ping) socket.write(frame(OP.pong, got.payload, randomBytes(4)));
        else if (got.opcode === OP.close) {
          said = { code: got.payload.length >= 2 ? got.payload.readUInt16BE(0) : 1005, why: got.payload.subarray(2).toString() };
          if (socket.writable) socket.end(closeFrame(said.code, "", randomBytes(4)));
        }
      }
    };
    socket.on("data", data);
    socket.on("error", () => {});
    socket.on("close", () => {
      this.end(said ?? { code: 1006, why: "the connection ended" });
      for (const { done } of this.waiting.splice(0)) done();
    });
    if (rest.length) data(rest);
  }

  // A message from the box: taken only if it opens for this connection and
  // its number is above the last one.
  private hear(message: Uint8Array): void {
    const parts = streamParts(message);
    if (!parts || parts.n <= this.heard) return;
    const plain = open(this.keys.down, parts.sealed, streamExtra("down", this.address, this.opened, parts.n));
    const said = plain && unpackTook(plain);
    if (!said) return;
    this.heard = parts.n;
    this.slot = said.slot;
    this.took = Math.max(this.took, said.took);
    this.ready();
    for (const wait of this.waiting.filter((w) => w.n <= this.took)) {
      this.waiting.splice(this.waiting.indexOf(wait), 1);
      wait.done();
    }
  }

  // The message for a state, sealed and numbered n. A test gives the nonce.
  message(n: number, state: PadState, nonce: Uint8Array = randomBytes(12)): Buffer {
    return streamMessage(n, seal(this.keys.up, packState(state), streamExtra("up", this.address, this.opened, n), nonce));
  }

  // Any bytes as one message, as they are.
  raw(message: Uint8Array, opcode: number = OP.binary): void {
    this.socket.write(frame(opcode, message, randomBytes(4)));
  }

  // The controller as it is now. Gives the message's number.
  send(state: PadState): number {
    const n = ++this.sent;
    this.raw(this.message(n, state));
    return n;
  }

  // Sends a state and waits until the box's controller has taken it. Gives
  // how long that took, in milliseconds, there and back. Rejects when the
  // connection ended first, or nothing came in time.
  async timed(state: PadState, timeoutMs = 5000): Promise<number> {
    const started = performance.now();
    const n = this.send(state);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the box didn't say it took that")), timeoutMs);
      this.waiting.push({
        n,
        done: () => {
          clearTimeout(timer);
          if (this.took >= n) resolve();
          else reject(new Error("game mode closed"));
        },
      });
    });
    return performance.now() - started;
  }

  // Closes game mode, as the phone does when it's turned upright.
  close(): Promise<{ code: number; why: string }> {
    if (this.socket.writable) this.socket.write(closeFrame(1000, "", randomBytes(4)));
    return this.closed;
  }

  // The connection cut, with no word: a phone that walked out of range.
  cut(): void {
    this.socket.destroy();
  }
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

  // Opens game mode: a signed request that asks for a WebSocket. It gives
  // the connection once the box's first sealed message has come, which is
  // what says the box made this phone a controller. Throws PadRefused with
  // the box's status when it says no.
  async pad(options: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<PhonePad> {
    for (let attempt = 0; ; attempt++) {
      if (!this.session && !(await this.hello())) throw new PadRefused(401, { ok: false, pair: true });
      const keys = this.session!.keys;
      const address = "/api/phone/pad";
      const request = this.sign("GET", address, undefined, { headers: options.headers });
      const key = randomBytes(16).toString("base64");
      const url = new URL(this.base);
      const socket = connect(Number(url.port || 80), url.hostname);
      socket.setNoDelay(true);
      const head = [`GET ${address} HTTP/1.1`, `Host: ${url.host}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${key}`, ...Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`)];
      const answer = await new Promise<{ status: number; headers: Record<string, string>; rest: Buffer }>((resolve, reject) => {
        let got = Buffer.alloc(0);
        const timer = setTimeout(() => socket.destroy(new Error("the box didn't answer")), options.timeoutMs ?? 10_000);
        const data = (chunk: Buffer) => {
          got = Buffer.concat([got, chunk]);
          const end = got.indexOf("\r\n\r\n");
          if (end < 0) return;
          const [first, ...lines] = got.subarray(0, end).toString("latin1").split("\r\n");
          const headers = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
          const status = Number(first.split(" ")[1]);
          const rest = got.subarray(end + 4);
          // An answer that isn't a yes has a body, which may come later.
          if (status !== 101 && rest.length < Number(headers["content-length"] ?? 0)) return;
          clearTimeout(timer);
          socket.off("data", data);
          resolve({ status, headers, rest });
        };
        socket.on("data", data);
        socket.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.on("close", () => {
          clearTimeout(timer);
          reject(new Error("the box closed the connection"));
        });
        socket.on("connect", () => socket.write(`${head.join("\r\n")}\r\n\r\n`));
      });
      if (answer.status === 101) {
        if (answer.headers["sec-websocket-accept"] !== acceptKey(key)) {
          socket.destroy();
          throw new Error("the box's answer isn't a WebSocket's");
        }
        const pad = new PhonePad(socket, keys, address, request.counter, answer.rest);
        // Anyone on the network can write a 101. The first message has to
        // open with this session's key before the phone believes it.
        const timer = setTimeout(() => pad.cut(), options.timeoutMs ?? 10_000);
        const how = await Promise.race([pad.there.then(() => null), pad.closed]);
        clearTimeout(timer);
        if (how) throw new Error(`game mode closed before the box said the controller is there (${how.code})`);
        return pad;
      }
      socket.destroy();
      let data: Record<string, any> = {};
      const sealed = answer.headers["content-type"] === SEALED;
      const body = sealed ? open(keys.down, answer.rest, answerExtra("GET", address, request.counter, answer.status)) : answer.rest;
      if (sealed && !body) throw new Error("the box's answer couldn't be opened");
      try {
        data = JSON.parse(body!.toString("utf8"));
      } catch {
        // Not JSON.
      }
      if (!sealed && answer.status === 401 && attempt === 0 && (data.session === true || data.pair === true)) {
        this.session = null;
        continue;
      }
      // Only a sealed answer is the box's own word.
      throw new PadRefused(answer.status, sealed ? data : {});
    }
  }
}
