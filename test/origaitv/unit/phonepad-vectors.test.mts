// Game mode's test vectors (test/origaitv/fixtures/phone-channel/, under
// session.pad), replayed through both sides (T26.1): the request that opens
// the connection, the messages each way, and the ones each side drops.
//
// The TV's side is the daemon's own code with the vectors' "random" bytes:
// the channel (daemon/phone-channel.ts), the route that takes the WebSocket
// (daemon/routes/pad.ts) and the controllers (daemon/pads.ts), with a
// stand-in for the input helper. The phone's side is daemon/phone-client.ts.
// Each has to come to the vectors' exact bytes, so a client written from
// docs/phone-api.md can use the same file. make-vectors.mts works them out
// with none of this code, and phone-channel-vectors.test.mts holds the file
// against what that script makes.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { acceptKey, BUTTONS, frame, Frames, OP, packState, packTook, unpackState, unpackTook } from "../../../daemon/pad-wire.ts";
import { Pads } from "../../../daemon/pads.ts";
import { b64u, hmac, open, PhoneChannel, seal, sessionKeys, sha256hex, signed, streamExtra, streamMessage, streamParts } from "../../../daemon/phone-channel.ts";
import { PhonePad } from "../../../daemon/phone-client.ts";
import { PAD_PATH, PadRoutes } from "../../../daemon/routes/pad.ts";
import { FILE, type make } from "../fixtures/phone-channel/make-vectors.mts";

const V = JSON.parse(readFileSync(FILE, "utf8")) as ReturnType<typeof make>;
const S = V.session;
const P = S.pad;
const un = (value: string) => Buffer.from(value, "base64url");
const keys = { sign: un(S.derived.sign), up: un(S.derived.up), down: un(S.derived.down) };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The "random" bytes a side draws, in the order it draws them.
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

test("T26.1 the vectors' arithmetic: the open request's signature, and each message's extra data and bytes", () => {
  assert.equal(P.open.address, PAD_PATH);
  assert.deepEqual(P.buttons, BUTTONS);
  // The request that opens it is signed like any other with no body.
  assert.equal(P.open.digest, sha256hex(Buffer.alloc(0)));
  assert.equal(signed(P.open.method, P.open.address, P.open.counter, P.open.grant, P.open.digest), P.open.signed);
  assert.equal(b64u(hmac(keys.sign, P.open.signed)), P.open.headers["X-OrigaiTV-Sig"]);
  assert.equal(acceptKey(P.open.headers["Sec-WebSocket-Key"]), P.open.answer.headers["Sec-WebSocket-Accept"]);
  assert.ok(!S.requests.some((r) => r.counter === P.open.counter), "a counter the session hasn't used");

  for (const m of [...P.up, P.after]) {
    assert.equal(b64u(packState(m.state)), m.plain, m.name);
    assert.equal(streamExtra("up", P.open.address, P.open.counter, m.n).toString(), m.extra, m.name);
    assert.equal(b64u(streamMessage(m.n, seal(keys.up, un(m.plain), Buffer.from(m.extra), un(m.nonce)))), m.message, m.name);
    const parts = streamParts(un(m.message))!;
    assert.equal(parts.n, m.n, m.name);
    assert.deepEqual(unpackState(open(keys.up, parts.sealed, Buffer.from(m.extra))!), m.state, m.name);
  }
  for (const m of P.down) {
    assert.equal(b64u(packTook(m.slot, m.took)), m.plain, m.name);
    assert.equal(streamExtra("down", P.open.address, P.open.counter, m.n).toString(), m.extra, m.name);
    assert.equal(b64u(streamMessage(m.n, seal(keys.down, un(m.plain), Buffer.from(m.extra), un(m.nonce)))), m.message, m.name);
    assert.deepEqual(unpackTook(open(keys.down, streamParts(un(m.message))!.sealed, Buffer.from(m.extra))!), { slot: m.slot, took: m.took }, m.name);
  }
  // The other session's key is that session's, by the same derivation.
  assert.equal(b64u(sessionKeys(un(V.pairings[0].phoneKey), un(P.otherSession.phoneNonce), un(P.otherSession.tvNonce)).up), P.otherSession.up);
  assert.notEqual(P.otherSession.up, S.derived.up);
});

test("T26.1 the vectors through the TV: the open request, each message taken or dropped, and each answer byte for byte", async (t) => {
  const phone = V.pairings[0];
  // The hello's two, then a nonce for each message the TV sends.
  const random = drawn(un(S.hello.tvNonce), un(S.hello.session), ...P.down.map((m) => un(m.nonce)));
  const channel = new PhoneChannel({ phone: (id) => (id === phone.tv.phoneId ? { phone: { id, name: phone.phone.name }, key: un(phone.phoneKey) } : null), now: () => Date.parse(phone.tv.now), random });
  assert.equal(JSON.stringify({ ok: true, ...channel.hello(JSON.parse(S.hello.request.text)) }), S.hello.answer.text);

  // The input helper's part: it makes what it's asked for, and says it took
  // each state.
  const pads = new Pads();
  const states: { state: number[]; n: number }[] = [];
  const helper = pads.attach({
    send: (line: any) => {
      if (line.open) queueMicrotask(() => helper.line({ opened: line.open }));
      if (line.state) {
        states.push(line);
        queueMicrotask(() => helper.line({ took: [line.state[0], line.n] }));
      }
    },
    close: () => {},
  });
  const nowhere = async (_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(404);
    response.end();
  };
  const server = createServer();
  const routes = new PadRoutes<{ id: string; name: string }>({
    pads,
    on: async () => true,
    open: (request, response) => channel.open(request, response),
    phone: nowhere,
    local: nowhere,
    allowed: () => true,
    json: (response, status, data) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    },
    log: () => {},
  });
  routes.watch(server, createServer());
  routes.switched(true);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    routes.close();
    server.close();
  });
  const port = (server.address() as { port: number }).port;

  // The request as the vectors have it, on a connection of the test's own.
  const socket: Socket = connect(port, "127.0.0.1");
  let got = Buffer.alloc(0);
  let answered: { status: number; headers: Record<string, string> } | null = null;
  const frames = new Frames(false);
  const messages: string[] = [];
  socket.on("data", (chunk) => {
    got = Buffer.concat([got, chunk]);
    if (!answered) {
      const end = got.indexOf("\r\n\r\n");
      if (end < 0) return;
      const [first, ...lines] = got.subarray(0, end).toString("latin1").split("\r\n");
      answered = { status: Number(first.split(" ")[1]), headers: Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()])) };
      got = got.subarray(end + 4);
    }
    for (const frame of frames.push(got)) {
      assert.ok("opcode" in frame && frame.opcode === OP.binary, "the TV sends binary messages and nothing else");
      messages.push(b64u(frame.payload));
    }
    got = Buffer.alloc(0);
  });
  const heard = async (count: number) => {
    for (const until = Date.now() + 3000; messages.length < count; await sleep(2)) assert.ok(Date.now() < until, `the TV sent ${messages.length} messages, not ${count}`);
  };
  const request = `${P.open.method} ${P.open.address} HTTP/1.1\r\nHost: ${V.host}\r\n${Object.entries(P.open.headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`;
  socket.write(request);
  const send = (message: string) => socket.write(frame(OP.binary, un(message), Buffer.from([9, 8, 7, 6])));

  // As it opens: the 101, then the TV's first message.
  await heard(1);
  assert.deepEqual(answered, P.open.answer);
  assert.equal(messages[0], P.down[0].message, P.down[0].name);
  // Each of the phone's messages, answered by the TV's next.
  for (const [n, m] of P.up.entries()) {
    send(m.message);
    await heard(n + 2);
    assert.equal(messages[n + 1], P.down[n + 1].message, P.down[n + 1].name);
  }
  // The ones it drops: nothing reaches the controller, and nothing comes
  // back.
  for (const m of P.dropped) send(m.message);
  await sleep(100);
  assert.equal(messages.length, 3);
  assert.equal(states.length, P.up.length);
  // The next good one is taken, with the number after the one that was
  // used up.
  send(P.after.message);
  await heard(4);
  assert.equal(messages[3], P.down[3].message, P.down[3].name);
  assert.deepEqual(states, [...P.up, P.after].map((m) => ({ state: [1, m.state.buttons, m.state.x, m.state.y], n: m.n })));
  assert.equal(random.left(), 0);
  // The number a dropped message used up, and no other.
  assert.deepEqual(P.dropped.filter((m) => m.counts).map((m) => ("n" in m ? m.n : 0)), [P.after.n - 1]);

  // The same request again opens nothing: its counter is used.
  socket.destroy();
  const again = connect(port, "127.0.0.1");
  const refused = new Promise<string>((resolve) => {
    let text = "";
    again.on("data", (chunk) => (text += chunk.toString("latin1")));
    again.on("close", () => resolve(text));
  });
  again.write(request);
  assert.match(await refused, /^HTTP\/1\.1 401 [^]*"session":true\}$/);
});

test("T26.1 the vectors through the phone: each message it sends, and each of the TV's it takes or drops", () => {
  // A connection that goes nowhere, to hand the phone's side its bytes.
  const wire = Object.assign(new EventEmitter(), { writable: true, write: () => true, end: () => {}, destroy: () => {} }) as unknown as Socket;
  const pad = new PhonePad(wire, keys, P.open.address, P.open.counter, Buffer.alloc(0));
  for (const m of [...P.up, P.after]) assert.equal(b64u(pad.message(m.n, m.state, un(m.nonce))), m.message, m.name);

  const hear = (message: string) => wire.emit("data", frame(OP.binary, un(message)));
  hear(P.down[0].message);
  assert.deepEqual([pad.slot, pad.took], [1, 0], P.down[0].name);
  for (const bad of P.downToRefuse) {
    hear(bad.message);
    assert.deepEqual([pad.slot, pad.took], [1, 0], bad.name);
  }
  for (const m of P.down.slice(1)) {
    hear(m.message);
    assert.deepEqual([pad.slot, pad.took], [m.slot, m.took], m.name);
  }
  // And none of the phone's own, or the dropped ones, read as the TV's.
  for (const m of [...P.up, ...P.dropped]) hear(m.message);
  assert.deepEqual([pad.slot, pad.took], [1, P.down.at(-1)!.took]);
});
