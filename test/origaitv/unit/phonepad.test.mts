// Game mode on the TV's side (ADR-113, T26.1): a paired phone opens a
// connection that stays open and becomes a controller, one of four at most.
//
// Most of these run the whole way: a stand-in phone (daemon/phone-client.ts)
// against a real daemon, and the input helper's own code (daemon/input.py,
// through phonepad-helper.py) holding the daemon's connection. Only the
// uinput devices are stand-ins, since those need the box, and so is the
// screen daemon, which here only writes down when it's asked for Home. What
// the real device is made with is checked in phonepad-test.sh, and a real
// game reading a real one is the image check's (T26.2).

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { acceptKey, buttons, CLOSED, closeFrame, frame, Frames, OP, packState, packTook, type PadState, STICK, unpackState, unpackTook } from "../../../daemon/pad-wire.ts";
import { type PadLink, Pads, PADS_MOST, type PadWire, QUIET_MS } from "../../../daemon/pads.ts";
import { streamMessage } from "../../../daemon/phone-channel.ts";
import { PadRefused, type PhonePad } from "../../../daemon/phone-client.ts";
import { Daemon } from "../../../daemon/server.ts";
import { HARNESS } from "../harness.mts";
import { FIXTURES, makeBox, ROOT } from "../ui/box.mts";
import { pairFromTv, TestPhone } from "./phone-client.mts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The evdev codes of the controller it stands in for.
const KEY = 1;
const ABS = 3;
const CODE = { a: 0x130, b: 0x131, x: 0x133, y: 0x134, l1: 0x136, r1: 0x137, view: 0x13a, menu: 0x13b, home: 0x13c, thumbl: 0x13d, thumbr: 0x13e };
const AXIS = { x: 0, y: 1, l2: 2, rx: 3, ry: 4, r2: 5, hatX: 16, hatY: 17 };
const still = (held = 0): PadState => ({ buttons: held, x: 0, y: 0 });

// The input helper's own code, with stand-in devices, and what it printed.
class Helper {
  lines: Record<string, any>[] = [];
  private child: ChildProcess;

  constructor(port: number, run: string) {
    this.child = spawn("python3", ["-I", join(import.meta.dirname, "phonepad-helper.py"), join(ROOT, "daemon"), String(port)], { env: { ...process.env, XDG_RUNTIME_DIR: run }, stdio: ["ignore", "pipe", "inherit"] });
    let held = "";
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      held += chunk;
      let end;
      while ((end = held.indexOf("\n")) >= 0) {
        const line = held.slice(0, end);
        held = held.slice(end + 1);
        // What it would write to the journal isn't a controller's.
        this.lines.push(line.startsWith("{") ? JSON.parse(line) : { said: line });
      }
    });
  }

  // The first line that fits, waited for.
  async line(fits: (line: Record<string, any>) => boolean, ms = 5000): Promise<Record<string, any>> {
    for (const until = Date.now() + ms; ; await sleep(5)) {
      const found = this.lines.find(fits);
      if (found) return found;
      assert.ok(Date.now() < until, `the helper never said it: ${JSON.stringify(this.lines.slice(-5))}`);
    }
  }

  // Every report written to a controller so far, in order.
  reports(slot: number): number[][][] {
    return this.lines.filter((line) => line.slot === slot).map((line) => line.events);
  }

  stop(): void {
    this.child.kill("SIGKILL");
  }
}

interface Box {
  daemon: Daemon;
  tv: string;
  lan: string;
  helper: Helper;
  // What the screen daemon was asked, as input.py asks it for Home.
  asked: { cmd: string; from: string; at: number }[];
  logs: string[];
}

// A daemon with a few apps, the input helper holding its connection, and a
// stand-in for the screen daemon's socket, until the test is over.
async function box(t: TestContext, options: { on?: boolean; quietMs?: number } = {}): Promise<Box> {
  const { apps, state } = makeBox(FIXTURES, { features: { phonepad: options.on ?? true } });
  const logs: string[] = [];
  // On edge, where a switch can be turned on.
  writeFileSync(join(state, "..", "channel"), "edge\n");
  const daemon = new Daemon({ root: ROOT, state, apps, port: 0, builtins: null, harness: HARNESS, log: (line) => logs.push(line), lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1", channelFile: join(state, "..", "channel"), pads: { quietMs: options.quietMs } });
  const port = await daemon.listen();
  // A short folder: a socket's path has to fit in about a hundred bytes.
  const run = mkdtempSync(join(tmpdir(), "otv-pad-"));
  mkdirSync(join(run, "origaitv"));
  const asked: Box["asked"] = [];
  const screen: Server = createServer((connection) => {
    connection.on("data", (chunk) => {
      asked.push({ ...JSON.parse(chunk.toString()), at: performance.now() });
      connection.end('{"ok":true}\n');
    });
  });
  await new Promise<void>((resolve) => screen.listen(join(run, "origaitv", "screen.sock"), resolve));
  const helper = new Helper(port, run);
  t.after(async () => {
    helper.stop();
    screen.close();
    await daemon.close(50);
    rmSync(run, { recursive: true, force: true });
    rmSync(join(state, ".."), { recursive: true, force: true });
  });
  const made = { daemon, tv: `http://127.0.0.1:${port}`, lan: `http://127.0.0.1:${daemon.lanPort}`, helper, asked, logs };
  if (options.on ?? true) await until(() => daemon.pads.ready(), "the input helper connected");
  return made;
}

async function until(done: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !(await done()); await sleep(5)) assert.ok(Date.now() < end, `never: ${what}`);
}

const state = (phone: TestPhone) => phone.json("GET", "/api/phone/state");

// A request that asks for a change of protocol, written by hand, and the
// whole answer.
function ask(base: string, path: string, headers: Record<string, string>, upgrade = "websocket"): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let got = Buffer.alloc(0);
    const done = () => {
      const end = got.indexOf("\r\n\r\n");
      if (end < 0) return reject(new Error("no answer"));
      const [first, ...lines] = got.subarray(0, end).toString("latin1").split("\r\n");
      resolve({ status: Number(first.split(" ")[1]), headers: Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()])), body: got.subarray(end + 4) });
      socket.destroy();
    };
    socket.on("data", (chunk) => {
      got = Buffer.concat([got, chunk]);
      const end = got.indexOf("\r\n\r\n");
      if (end < 0) return;
      // A yes has nothing after it, and anything else says how long it is.
      const length = /^content-length: *(\d+)/im.exec(got.subarray(0, end).toString("latin1"))?.[1];
      if (got.subarray(0, 12).toString() === "HTTP/1.1 101" || (length !== undefined && got.length >= end + 4 + Number(length))) done();
    });
    socket.on("close", done);
    socket.on("error", reject);
    const all = { Host: url.host, Connection: "Upgrade", Upgrade: upgrade, "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": Buffer.alloc(16, 7).toString("base64"), ...headers };
    socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(all).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`);
  });
}

// --- The bytes ---------------------------------------------------------------------

test("T26.1 a controller's state is six bytes, and nothing else is one", () => {
  const state = { buttons: buttons("a", "home"), x: -STICK, y: 12345 };
  assert.equal(state.buttons, 0b100_0000_0001);
  const plain = packState(state);
  assert.equal(plain.toString("hex"), "040180013039");
  assert.deepEqual(unpackState(plain), state);
  assert.deepEqual(unpackState(packState({ buttons: 0x7ff, x: STICK, y: -STICK })), { buttons: 0x7ff, x: STICK, y: -STICK });
  for (const [bad, why] of [
    [Buffer.alloc(5), "too short"],
    [Buffer.alloc(7), "too long"],
    [Buffer.from("080000000000", "hex"), "a bit no button has"],
    [Buffer.from("800000000000", "hex"), "the top bit"],
    [Buffer.from("000080000000", "hex"), "the stick past its left end"],
    [Buffer.from("000000008000", "hex"), "the stick past its top end"],
    [Buffer.from('{"key":"up"}'), "a remote's key"],
  ] as const) {
    assert.equal(unpackState(bad), null, why);
  }
  assert.deepEqual(unpackTook(packTook(3, 2 ** 40 + 7)), { slot: 3, took: 2 ** 40 + 7 });
  assert.equal(packTook(1, 0).toString("hex"), "010000000000000000");
});

test("the WebSocket's frames: whole, masked from a phone, and 125 bytes at most", () => {
  const mask = Buffer.from([1, 2, 3, 4]);
  const tv = new Frames(true);
  const sent = frame(OP.binary, Buffer.from("hello"), mask);
  // A frame that comes in pieces is given once it's whole.
  assert.deepEqual(tv.push(sent.subarray(0, 3)), []);
  assert.deepEqual(tv.push(sent.subarray(3)), [{ opcode: OP.binary, payload: Buffer.from("hello") }]);
  // Two frames at once.
  assert.deepEqual(tv.push(Buffer.concat([frame(OP.ping, Buffer.from("p"), mask), closeFrame(1000, "bye", mask)])).map((got) => ("opcode" in got ? got.opcode : got)), [OP.ping, OP.close]);
  // What a TV refuses, and then gives nothing more.
  for (const [bytes, why] of [
    [frame(OP.binary, Buffer.from("x")), /no mask/],
    [Buffer.from([0x02, 0x81, 1, 2, 3, 4, 0]), /in pieces/],
    [Buffer.from([0x80, 0x81, 1, 2, 3, 4, 0]), /in pieces/],
    [Buffer.from([0xc2, 0x81, 1, 2, 3, 4, 0]), /extension/],
    [Buffer.from([0x83, 0x81, 1, 2, 3, 4, 0]), /kind of frame/],
    [Buffer.from([0x82, 0xfe, 0, 200, 1, 2, 3, 4]), /too long/],
    [Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 1, 0, 0]), /too long/],
  ] as const) {
    const frames = new Frames(true);
    const got = frames.push(bytes);
    assert.equal(got.length, 1);
    assert.match("broken" in got[0] ? got[0].broken : "taken", why);
    assert.deepEqual(frames.push(sent), [], "nothing after a broken frame");
  }
  // A phone takes the TV's frames without a mask, and no others.
  assert.deepEqual(new Frames(false).push(frame(OP.binary, Buffer.from("ok"))), [{ opcode: OP.binary, payload: Buffer.from("ok") }]);
  assert.ok("broken" in new Frames(false).push(sent)[0]);
  assert.throws(() => frame(OP.binary, Buffer.alloc(126)));
  // The handshake's answer, with the key and the answer RFC 6455 gives.
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

// --- Who has which controller (daemon/pads.ts), with a stand-in helper ----------------

function standIn(options: { answers?: boolean; fails?: string } = {}) {
  const sent: any[] = [];
  let heard: (line: unknown) => void = () => {};
  const link: PadLink = {
    send: (line: any) => {
      sent.push(line);
      if (options.answers === false) return;
      if (line.open) queueMicrotask(() => heard(options.fails ? { failed: line.open, why: options.fails } : { opened: line.open }));
      if (line.state) queueMicrotask(() => heard({ took: [line.state[0], line.n] }));
    },
    close: () => {},
  };
  const wire = () => {
    const got = { given: [] as Buffer[], ended: null as null | { code: number; why: string } };
    const wire: PadWire = { give: (plain) => void got.given.push(Buffer.from(plain)), end: (code, why) => void (got.ended ??= { code, why }) };
    return { wire, got };
  };
  return { sent, link, wire, attach: (pads: Pads) => void (heard = pads.attach(link).line) };
}

test("T26.1 one controller for each phone, four at most, and a fifth phone is refused", async () => {
  let changes = 0;
  const pads = new Pads({ changed: () => changes++ });
  const helper = standIn();
  assert.deepEqual(await pads.open({ id: "p-0", name: "early" }, helper.wire().wire), { ok: false, status: 503, error: "Your TV isn't ready yet" }, "with no helper to make one");
  helper.attach(pads);
  const wires = [];
  for (let n = 1; n <= PADS_MOST; n++) {
    const made = helper.wire();
    wires.push(made);
    const pad = await pads.open({ id: `p-${n}`, name: `phone ${n}` }, made.wire);
    assert.equal("slot" in pad && pad.slot, n);
    // The first thing the phone hears: which controller it is.
    assert.deepEqual(made.got.given.map((plain) => unpackTook(plain)), [{ slot: n, took: 0 }]);
  }
  assert.equal(PADS_MOST, 4);
  assert.equal(pads.count(), 4);
  assert.equal(changes, 4);
  const fifth = helper.wire();
  assert.deepEqual(await pads.open({ id: "p-5", name: "phone 5" }, fifth.wire), { ok: false, status: 409, error: "Four phones are playing already" });
  assert.deepEqual(helper.sent.filter((line) => line.open), [{ open: 1 }, { open: 2 }, { open: 3 }, { open: 4 }], "nothing was made for the fifth");

  // A phone that opens game mode again takes its controller over: the old
  // connection is closed, and it's still one phone, one controller.
  const again = helper.wire();
  const pad = await pads.open({ id: "p-2", name: "phone 2" }, again.wire);
  assert.equal("slot" in pad && pad.slot, 2);
  assert.equal(wires[1].got.ended?.code, CLOSED.again);
  assert.equal(pads.count(), 4);

  // Forgotten in Settings: its controller goes, and the fifth phone gets it.
  pads.forget("p-3");
  assert.equal(wires[2].got.ended?.code, CLOSED.ended);
  assert.deepEqual(helper.sent.at(-1), { close: 3 });
  const late = await pads.open({ id: "p-5", name: "phone 5" }, fifth.wire);
  assert.equal("slot" in late && late.slot, 3);
  pads.close();
  assert.equal(pads.count(), 0);
});

test("two opens at once from one phone make one controller", async () => {
  const pads = new Pads();
  const helper = standIn();
  helper.attach(pads);
  const [one, two] = [helper.wire(), helper.wire()];
  const made = await Promise.all([pads.open({ id: "p-1", name: "a phone" }, one.wire), pads.open({ id: "p-1", name: "a phone" }, two.wire)]);
  assert.deepEqual(made.map((pad) => "slot" in pad && pad.slot), [1, 1]);
  assert.equal(pads.count(), 1);
  assert.equal(one.got.ended?.code, CLOSED.again);
  assert.equal(two.got.ended, null);
  pads.close();
});

test("a controller the helper can't make, or doesn't answer for, is refused and taken back", async () => {
  const failing = standIn({ fails: "no uinput here" });
  const logs: string[] = [];
  const pads = new Pads({ log: (line) => logs.push(line) });
  failing.attach(pads);
  assert.deepEqual(await pads.open({ id: "p-1", name: "a phone" }, failing.wire().wire), { ok: false, status: 503, error: "Your TV isn't ready yet" });
  assert.match(logs.at(-1)!, /no uinput here/);
  assert.deepEqual(failing.sent.slice(-2), [{ open: 1 }, { close: 1 }]);

  const silent = standIn({ answers: false });
  const slow = new Pads({ openMs: 50 });
  silent.attach(slow);
  assert.deepEqual(await slow.open({ id: "p-1", name: "a phone" }, silent.wire().wire), { ok: false, status: 503, error: "Your TV isn't ready yet" });
  assert.deepEqual(silent.sent, [{ open: 1 }, { close: 1 }]);
  assert.equal(slow.count(), 0);
  pads.close();
  slow.close();
});

test("too many messages that aren't a controller's, or far too many at once, end the connection", async () => {
  const pads = new Pads();
  const helper = standIn();
  helper.attach(pads);
  const one = helper.wire();
  const pad = await pads.open({ id: "p-1", name: "a phone" }, one.wire);
  assert.ok("slot" in pad);
  for (let n = 0; n < 16; n++) pad.bad();
  assert.equal(pad.took(1, Buffer.from("not a state")), false);
  assert.deepEqual(one.got.ended, { code: CLOSED.refused, why: "too many messages that weren't a controller's" });
  assert.equal(pads.count(), 0);
  assert.equal(helper.sent.some((line) => line.state), false, "none of them reached the controller");

  // Within one second, on a clock that stands still.
  const stopped = new Pads({ now: () => 1_700_000_000_000 });
  helper.attach(stopped);
  const two = helper.wire();
  const fast = await stopped.open({ id: "p-2", name: "a phone" }, two.wire);
  assert.ok("slot" in fast);
  const plain = packState(still());
  let taken = 0;
  for (let n = 1; n <= 600 && two.got.ended === null; n++) if (fast.took(n, plain)) taken++;
  assert.equal(two.got.ended?.code, CLOSED.refused);
  assert.equal(taken, 500, "500 in one second, and the next one ends it");
  pads.close();
  stopped.close();
});

// --- The whole way: a phone, the daemon, and the input helper's own code ------------

test("T26.1 a stand-in phone opens game mode and a controller appears, with the right buttons and axes", async (t) => {
  const b = await box(t);
  const phone = await pairFromTv(b.tv, b.lan, "Ana's phone");
  assert.deepEqual((await state(phone)).controllers, { phones: 0, most: 4 });
  const pad = await phone.pad();
  assert.equal(pad.slot, 1);
  const made = await b.helper.line((line) => line.made === 1);
  assert.equal(made.name, "OrigaiTV phone controller");
  // One stick, A, B, X and Y, two shoulders on each side, View, Menu and
  // the guide button, laid out as the wired controller games know: the
  // back shoulders are its triggers, and the d-pad is its hat.
  assert.deepEqual(made.keys, [CODE.a, CODE.b, CODE.x, CODE.y, CODE.l1, CODE.r1, CODE.view, CODE.menu, CODE.home, CODE.thumbl, CODE.thumbr]);
  assert.deepEqual(made.axes, [
    [AXIS.x, -32768, 32767],
    [AXIS.y, -32768, 32767],
    [AXIS.l2, 0, 255],
    [AXIS.rx, -32768, 32767],
    [AXIS.ry, -32768, 32767],
    [AXIS.r2, 0, 255],
    [AXIS.hatX, -1, 1],
    [AXIS.hatY, -1, 1],
  ]);
  assert.deepEqual((await state(phone)).controllers, { phones: 1, most: 4 });
  assert.ok(b.logs.includes("phone controllers: Ana's phone is controller 1"));
});

test("T26.1 presses and stick moves arrive in order, and the stick is the d-pad too", async (t) => {
  const b = await box(t);
  const pad = await (await pairFromTv(b.tv, b.lan)).pad();
  const steps: [PadState, number[][]][] = [
    [still(buttons("a")), [[KEY, CODE.a, 1]]],
    [still(buttons("a", "b")), [[KEY, CODE.b, 1]]],
    [still(buttons("b")), [[KEY, CODE.a, 0]]],
    [still(), [[KEY, CODE.b, 0]]],
    // Each button is its own, the two back shoulders as triggers all the
    // way in.
    [
      still(buttons("x", "y", "l1", "r1", "l2", "r2", "view", "menu")),
      [
        [KEY, CODE.x, 1],
        [KEY, CODE.y, 1],
        [KEY, CODE.l1, 1],
        [KEY, CODE.r1, 1],
        [ABS, AXIS.l2, 255],
        [ABS, AXIS.r2, 255],
        [KEY, CODE.view, 1],
        [KEY, CODE.menu, 1],
      ],
    ],
    [
      still(),
      [
        [KEY, CODE.x, 0],
        [KEY, CODE.y, 0],
        [KEY, CODE.l1, 0],
        [KEY, CODE.r1, 0],
        [ABS, AXIS.l2, 0],
        [ABS, AXIS.r2, 0],
        [KEY, CODE.view, 0],
        [KEY, CODE.menu, 0],
      ],
    ],
    // The stick a little to the right: the stick only.
    [{ buttons: 0, x: 16383, y: 0 }, [[ABS, AXIS.x, 16383]]],
    // Half way and past it: the d-pad's right as well (ADR-115).
    [
      { buttons: 0, x: 16384, y: 0 },
      [
        [ABS, AXIS.x, 16384],
        [ABS, AXIS.hatX, 1],
      ],
    ],
    [{ buttons: 0, x: STICK, y: 0 }, [[ABS, AXIS.x, STICK]]],
    // Up and to the left, with A: one report, the button first.
    [
      { buttons: buttons("a"), x: -STICK, y: -STICK },
      [
        [KEY, CODE.a, 1],
        [ABS, AXIS.x, -STICK],
        [ABS, AXIS.hatX, -1],
        [ABS, AXIS.y, -STICK],
        [ABS, AXIS.hatY, -1],
      ],
    ],
    [
      { buttons: 0, x: 0, y: STICK },
      [
        [KEY, CODE.a, 0],
        [ABS, AXIS.x, 0],
        [ABS, AXIS.hatX, 0],
        [ABS, AXIS.y, STICK],
        [ABS, AXIS.hatY, 1],
      ],
    ],
    [
      still(),
      [
        [ABS, AXIS.y, 0],
        [ABS, AXIS.hatY, 0],
      ],
    ],
  ];
  // All at once, as fast as they go: they come out in the order sent.
  for (const [sent] of steps.slice(0, -1)) pad.send(sent);
  await pad.timed(steps.at(-1)![0]);
  assert.deepEqual(b.helper.reports(1), steps.map(([, events]) => events));
  // The same state again is the phone saying it's still there: nothing is
  // written, and the TV still says it took it.
  await pad.timed(still());
  assert.equal(b.helper.reports(1).length, steps.length);
  assert.equal(pad.took, steps.length + 1);
});

test("T26.1 the guide button held goes home, by the rule a real controller's has", async (t) => {
  const b = await box(t);
  const pad = await (await pairFromTv(b.tv, b.lan)).pad();
  // A tap: the screen daemon hears the press, which it leaves to a game,
  // and no hold.
  await pad.timed(still(buttons("home")));
  await sleep(300);
  await pad.timed(still());
  await sleep(1200);
  assert.deepEqual(b.asked.map((line) => [line.cmd, line.from]), [["home", "guide"]]);
  assert.deepEqual(b.helper.reports(1), [[[KEY, CODE.home, 1]], [[KEY, CODE.home, 0]]], "the game gets the button too");

  // Held: a second later, while it's still down, it's the hold, once.
  b.asked.length = 0;
  await pad.timed(still(buttons("home", "a")));
  await until(() => b.asked.length >= 2, "the hold reached the screen daemon");
  assert.deepEqual(b.asked.map((line) => [line.cmd, line.from]), [["home", "guide"], ["home", "guide-hold"]]);
  const late = b.asked[1].at - b.asked[0].at;
  assert.ok(late >= 950 && late < 1500, `the hold was said ${Math.round(late)} ms after the press`);
  await pad.timed(still(buttons("home")));
  await sleep(1200);
  await pad.timed(still());
  assert.equal(b.asked.length, 2, "held longer, and let go, it says nothing more");

  // A phone that closes game mode with the button down takes its hold along.
  b.asked.length = 0;
  await pad.timed(still(buttons("home")));
  await pad.close();
  await sleep(1300);
  assert.deepEqual(b.asked.map((line) => line.from), ["guide"]);
});

test("T26.1 closing game mode removes the controller, and so does a phone that goes quiet", async (t) => {
  assert.equal(QUIET_MS, 5000, "five seconds on a TV");
  const b = await box(t, { quietMs: 400 });
  const phone = await pairFromTv(b.tv, b.lan, "Ana's phone");
  const pad = await phone.pad();
  await pad.timed(still(buttons("a")));
  assert.deepEqual(await pad.close(), { code: CLOSED.done, why: "the phone closed game mode" });
  await b.helper.line((line) => line.gone === 1);
  assert.deepEqual((await state(phone)).controllers, { phones: 0, most: 4 });

  // A phone that says it's still there keeps its controller...
  const second = await phone.pad();
  for (let n = 0; n < 8; n++) {
    await sleep(100);
    await second.timed(still());
  }
  assert.equal((await state(phone)).controllers.phones, 1);
  // ...and one that says nothing loses it, with the button it held let go
  // with the controller.
  const made = b.helper.lines.filter((line) => line.made === 1).length;
  await second.timed(still(buttons("b")));
  const quiet = performance.now();
  assert.deepEqual(await second.closed, { code: CLOSED.quiet, why: "nothing for a while" });
  const after = performance.now() - quiet;
  assert.ok(after >= 350 && after < 900, `it went after ${Math.round(after)} ms`);
  await until(() => b.helper.lines.filter((line) => line.gone === 1).length === 2, "the second controller went");
  assert.equal(made, 2);
  assert.equal((await state(phone)).controllers.phones, 0);

  // A WebSocket ping isn't the controller saying anything.
  const third = await phone.pad();
  const ping = setInterval(() => third.raw(Buffer.from("still here"), OP.ping), 50);
  assert.equal((await third.closed).code, CLOSED.quiet);
  clearInterval(ping);

  // A connection that's cut, with no goodbye, goes at once.
  const fourth = await phone.pad();
  const before = b.helper.lines.filter((line) => line.gone === 1).length;
  fourth.cut();
  await until(() => b.helper.lines.filter((line) => line.gone === 1).length === before + 1, "the cut phone's controller went");
});

test("T26.1 four phones are four controllers, and a fifth is refused", async (t) => {
  const b = await box(t);
  const phones: TestPhone[] = [];
  for (let n = 1; n <= 5; n++) phones.push(await pairFromTv(b.tv, b.lan, `phone ${n}`));
  const pads: PhonePad[] = [];
  for (const phone of phones.slice(0, 4)) pads.push(await phone.pad());
  assert.deepEqual(pads.map((pad) => pad.slot), [1, 2, 3, 4]);
  assert.deepEqual((await state(phones[4])).controllers, { phones: 4, most: 4 });
  await assert.rejects(phones[4].pad(), (error: PadRefused) => {
    assert.equal(error.status, 409);
    // The refusal came sealed: it's the TV's own word.
    assert.deepEqual(error.data, { ok: false, error: "Four phones are playing already" });
    return true;
  });
  assert.equal(b.helper.lines.filter((line) => line.made).length, 4, "nothing was made for the fifth");
  // Each phone moves its own controller.
  await Promise.all(pads.map((pad, n) => pad.timed({ buttons: 0, x: (n + 1) * 100, y: 0 })));
  for (let n = 1; n <= 4; n++) assert.deepEqual(b.helper.reports(n), [[[ABS, AXIS.x, n * 100]]]);
  // One leaves, and the fifth gets its place.
  await pads[1].close();
  await b.helper.line((line) => line.gone === 2);
  assert.equal((await phones[4].pad()).slot, 2);
});

test("T26.1 a message that isn't sealed, is replayed, or comes from another session is dropped", async (t) => {
  const b = await box(t);
  const phone = await pairFromTv(b.tv, b.lan, "Ana's phone");
  // The same phone on a second session, and another phone altogether.
  const twin = new TestPhone(b.lan, phone.kept);
  const other = await pairFromTv(b.tv, b.lan, "Ben's phone");
  const fromTwin = await twin.pad();
  const fromOther = await other.pad();
  const earlier = await phone.pad();
  assert.equal((await fromTwin.closed).code, CLOSED.again, "one phone, one controller");
  const pad = await phone.pad();
  assert.equal((await earlier.closed).code, CLOSED.again);
  assert.equal(pad.slot, 1);

  const A = still(buttons("a"));
  const B = still(buttons("b"));
  const junk = still(buttons("x", "y", "menu"));
  const first = pad.message(1, A);
  pad.raw(first);
  // The same bytes again, and a new message with a number that's been used.
  pad.raw(first);
  pad.raw(pad.message(1, junk));
  // Not sealed: the state as it is, with a number, and as text.
  pad.raw(streamMessage(2, packState(junk)));
  pad.raw(streamMessage(2, Buffer.concat([Buffer.alloc(12), packState(junk), Buffer.alloc(16)])));
  pad.raw(packState(junk), OP.text);
  pad.raw(Buffer.from(JSON.stringify({ key: "enter" })), OP.text);
  // Sealed by another phone, by this phone's other session, and by this
  // session for the connection it had before.
  pad.raw(fromOther.message(2, junk));
  pad.raw(fromTwin.message(2, junk));
  pad.raw(earlier.message(2, junk));
  // A byte changed on the way.
  const spoiled = pad.message(2, junk);
  spoiled[spoiled.length - 1] ^= 1;
  pad.raw(spoiled);
  // Sealed right, and not a controller's state: a bit no button has, and
  // something else altogether.
  pad.raw(pad.message(2, { buttons: 0x8000, x: 0, y: 0 }));
  // The next good one, with the next number, is taken.
  pad.sent = 2;
  await pad.timed(B);
  assert.deepEqual(b.helper.reports(1), [
    [[KEY, CODE.a, 1]],
    [
      [KEY, CODE.a, 0],
      [KEY, CODE.b, 1],
    ],
  ]);
  assert.equal(pad.took, 3);
  // The other phone's controller heard none of it either.
  assert.deepEqual(b.helper.reports(fromOther.slot), []);

  // Enough of them, and the TV closes the connection.
  for (let n = 0; n < 12; n++) pad.raw(Buffer.from("not a controller"));
  assert.equal((await pad.closed).code, CLOSED.refused);
  await b.helper.line((line) => line.gone === 1);
});

test("T26.1 only a paired phone opens game mode, with a request its session signed, once", async (t) => {
  const b = await box(t);
  const phone = await pairFromTv(b.tv, b.lan, "Ana's phone");
  await phone.hello();
  // With nothing to say who's asking, and with a session the TV doesn't
  // know: the 401 any request gets.
  const nobody = await ask(b.lan, "/api/phone/pad", {});
  assert.deepEqual([nobody.status, JSON.parse(nobody.body.toString())], [401, { ok: false, error: "This phone isn't paired. Pair it from your TV.", pair: true }]);
  const signed = phone.sign("GET", "/api/phone/pad");
  const stranger = await ask(b.lan, "/api/phone/pad", { ...signed.headers, "x-origaitv-session": "AAAAAAAAAAAAAAAAAAAAAA" });
  assert.deepEqual([stranger.status, JSON.parse(stranger.body.toString()).session], [401, true]);
  // A signature for another address, or with a byte changed.
  const elsewhere = phone.sign("GET", "/api/phone/state");
  assert.equal((await ask(b.lan, "/api/phone/pad", elsewhere.headers)).status, 401);
  const forged = phone.sign("GET", "/api/phone/pad");
  assert.equal((await ask(b.lan, "/api/phone/pad", { ...forged.headers, "x-origaitv-sig": forged.headers["x-origaitv-sig"].replace(/^./, (c) => (c === "A" ? "B" : "A")) })).status, 401);
  assert.equal(b.helper.lines.length, 0, "nothing was made for any of them");

  // The real one opens it, and the same request sent again doesn't.
  const good = await ask(b.lan, "/api/phone/pad", signed.headers);
  assert.equal(good.status, 101);
  assert.equal(good.headers["sec-websocket-accept"], "CdXSYUsvsaMthlEXWDNURGWA/1o=", "the WebSocket's answer to the key this test sends");
  await b.helper.line((line) => line.made === 1);
  const replayed = await ask(b.lan, "/api/phone/pad", signed.headers);
  assert.deepEqual([replayed.status, JSON.parse(replayed.body.toString()).session], [401, true]);
  await b.helper.line((line) => line.gone === 1);

  // A page somewhere else can't open one, even with a phone's headers.
  await assert.rejects(phone.pad({ headers: { Origin: "http://evil.example" } }), (error: PadRefused) => error.status === 403);
  // Game mode is a connection: a plain request for it says so.
  const plain = await phone.call("GET", "/api/phone/pad");
  assert.deepEqual([plain.status, plain.sealed, plain.data.ok], [426, true, false]);

  // Forgotten in Settings: its controller goes at once, and it can't open
  // another.
  const pad = await phone.pad();
  const forgot = await fetch(`${b.tv}/api/phones/${phone.kept.id}`, { method: "DELETE" });
  assert.equal(forgot.status, 200);
  assert.equal((await pad.closed).code, CLOSED.ended);
  await until(() => b.helper.lines.filter((line) => line.gone === 1).length === 2, "the forgotten phone's controller went");
  await assert.rejects(phone.pad(), (error: PadRefused) => error.status === 401);
});

test("T26.1 the state says a game is in front, by its app's name, and how many phones are controllers", async (t) => {
  const b = await box(t);
  const phone = await pairFromTv(b.tv, b.lan, "Ana's phone");
  const context = (change: object) => fetch(`${b.tv}/api/tv/context`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });
  let now = await state(phone);
  assert.equal(now.tv.game, null);
  assert.deepEqual(now.controllers, { phones: 0, most: 4 });

  // The screen daemon says which app's game is in front, and the phone's
  // long wait for the state ends with it.
  const waiting = phone.json("GET", `/api/phone/state?since=${now.version}`);
  await context({ front: "app", playing: false, game: "origaitv.games" });
  now = await waiting;
  assert.deepEqual(now.tv.game, { id: "origaitv.games", name: "Games" });
  assert.equal(now.tv.front, "app");

  // A controller coming and going wakes it too.
  const opened = phone.json("GET", `/api/phone/state?since=${now.version}`);
  const pad = await phone.pad();
  assert.deepEqual((await opened).controllers, { phones: 1, most: 4 });
  const closed = phone.json("GET", `/api/phone/state?since=${(await state(phone)).version}`);
  await pad.close();
  assert.deepEqual((await closed).controllers, { phones: 0, most: 4 });

  // Home in front again: no game.
  await context({ front: "home", playing: false, game: null });
  assert.equal((await state(phone)).tv.game, null);
  // What home's own page says doesn't touch it.
  await context({ front: "app", playing: false, game: "local.blocks" });
  await context({ screen: "menu" });
  assert.deepEqual((await state(phone)).tv.game, { id: "local.blocks", name: "local.blocks" }, "an app that's gone is named by its id");
});

test("T26.1 with phonepad off, game mode's addresses answer as ones that aren't there, and the state says nothing new", async (t) => {
  const b = await box(t, { on: false });
  const phone = await pairFromTv(b.tv, b.lan, "Ana's phone");
  const features = await (await fetch(`${b.tv}/api/features`)).json();
  assert.equal(features.phonepad, false, "it lands off");

  // To a paired phone: the sealed 404 of any address that isn't there.
  const off = await phone.call("GET", "/api/phone/pad");
  const nowhere = await phone.call("GET", "/api/phone/nothing-here");
  assert.deepEqual([off.status, off.sealed, off.data], [404, true, { ok: false, error: "not found" }]);
  assert.deepEqual([off.status, off.sealed, off.data], [nowhere.status, nowhere.sealed, nowhere.data]);
  await assert.rejects(phone.pad(), (error: PadRefused) => error.status === 404 && error.data.error === "not found");
  // To anybody else: the 401 any address gives.
  const nobody = await ask(b.lan, "/api/phone/pad", {});
  const nobodyElsewhere = await ask(b.lan, "/api/phone/nothing-here", {});
  assert.deepEqual([nobody.status, nobody.body.toString()], [nobodyElsewhere.status, nobodyElsewhere.body.toString()]);
  assert.equal(nobody.status, 401);
  // The helper's address on the TV's own port isn't there either, so no
  // controller can be made.
  const helper = await ask(b.tv, "/api/pads", { "X-OrigaiTV-Screen": "1" }, "origaitv-pads");
  assert.deepEqual([helper.status, JSON.parse(helper.body.toString())], [404, { ok: false, error: "not found" }]);
  assert.equal(b.daemon.pads.ready(), false);
  const said = await state(phone);
  assert.equal("controllers" in said, false);
  assert.equal("game" in said.tv, false);

  // Turned on, the helper's next ask is taken, and game mode opens.
  const put = (on: boolean) => fetch(`${b.tv}/api/features`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phonepad: on }) });
  assert.equal((await put(true)).status, 200);
  await until(() => b.daemon.pads.ready(), "the helper connected once it was on");
  const pad = await phone.pad();
  await pad.timed(still(buttons("a")));
  assert.deepEqual((await state(phone)).controllers, { phones: 1, most: 4 });

  // Turned off again: the controller goes with it, and so do the addresses.
  assert.equal((await put(false)).status, 200);
  assert.equal((await pad.closed).code, CLOSED.away);
  await b.helper.line((line) => line.gone === 1);
  assert.equal((await phone.call("GET", "/api/phone/pad")).status, 404);
  assert.equal("controllers" in (await state(phone)), false);
});

test("the TV's own port: only the input helper holds the controllers' connection", async (t) => {
  const b = await box(t);
  // No screen header, as a page's request has none.
  const page = await ask(b.tv, "/api/pads", {}, "origaitv-pads");
  assert.deepEqual([page.status, JSON.parse(page.body.toString()).ok], [403, false]);
  // Named as some other host, as a page elsewhere would name it.
  assert.equal((await ask(b.tv, "/api/pads", { Host: "evil.example", "X-OrigaiTV-Screen": "1" }, "origaitv-pads")).status, 403);
  // The phone's port doesn't have it at all.
  assert.equal((await ask(b.lan, "/api/pads", { "X-OrigaiTV-Screen": "1" }, "origaitv-pads")).status, 401);
  // Another request that asks for a change of protocol is answered as it
  // was before game mode: the change is ignored.
  const health = await ask(b.tv, "/health", {}, "h2c");
  assert.equal(health.status, 200);
  assert.equal(b.daemon.pads.ready(), true, "none of that took the helper's place");
});

test("the input helper going away takes every controller with it, and the phones hear", async (t) => {
  const b = await box(t);
  const phone = await pairFromTv(b.tv, b.lan, "Ana's phone");
  const pad = await phone.pad();
  await pad.timed(still(buttons("a")));
  b.helper.stop();
  assert.deepEqual(await pad.closed, { code: CLOSED.lost, why: "the controllers stopped" });
  assert.deepEqual((await state(phone)).controllers, { phones: 0, most: 4 });
  await assert.rejects(phone.pad(), (error: PadRefused) => error.status === 503 && error.data.error === "Your TV isn't ready yet");
});

test("how long a press takes from the phone to the controller and back, on this machine", async (t) => {
  const b = await box(t);
  const pad = await (await pairFromTv(b.tv, b.lan)).pad();
  const times: number[] = [];
  for (let n = 0; n < 300; n++) times.push(await pad.timed(still(n % 2 ? 0 : buttons("a"))));
  times.sort((x, y) => x - y);
  const [median, p95, most] = [times[150], times[285], times[299]];
  t.diagnostic(`a press, there and back, over loopback: median ${median.toFixed(2)} ms, 95th ${p95.toFixed(2)} ms, slowest ${most.toFixed(2)} ms`);
  assert.equal(b.helper.reports(1).length, 300);
  // Far inside the 50 ms a press may take on the home Wi-Fi, so the Wi-Fi
  // has nearly all of it.
  assert.ok(median < 10, `the median was ${median.toFixed(2)} ms`);
});
