// What game mode puts on the wire (docs/phone-api.md, "Game mode"): a
// WebSocket, as little of one as it needs, and the two messages it carries.
//
// A phone in game mode is a controller, and a signed request per press is
// too slow to play on. So one request opens a connection that stays open,
// and each change of the controller is one small message on it. It's a
// WebSocket because a phone already has a client for one, it's a request
// on the port a phone already uses, and TCP keeps the presses in order.
//
// Only binary messages count, and each is sealed and numbered by the
// session (daemon/phone-channel.ts). This file knows nothing of keys: it
// frames bytes, and packs a controller's state into six of them.

import { createHash } from "node:crypto";

// --- The controller ------------------------------------------------------------

// The buttons, by their bit in a state: A is bit 0. The two shoulders on
// each side are l1 and r1 in front and l2 and r2 behind them. View and
// Menu are the two small ones, and home is the guide button.
export const BUTTONS = ["a", "b", "x", "y", "l1", "r1", "l2", "r2", "view", "menu", "home"] as const;
export type Button = (typeof BUTTONS)[number];
const KNOWN = (1 << BUTTONS.length) - 1;
// How far the stick goes each way. Right and down are above 0.
export const STICK = 32767;

export interface PadState {
  buttons: number;
  x: number;
  y: number;
}

export const STATE_BYTES = 6;
export const TOOK_BYTES = 9;

// The bits for some buttons by name.
export function buttons(...down: Button[]): number {
  return down.reduce((bits, name) => bits | (1 << BUTTONS.indexOf(name)), 0);
}

// A state as the phone sends it: the buttons as 16 bits, then the stick's
// x and y as signed 16 bits, all big end first.
export function packState(state: PadState): Buffer {
  const plain = Buffer.alloc(STATE_BYTES);
  plain.writeUInt16BE(state.buttons, 0);
  plain.writeInt16BE(state.x, 2);
  plain.writeInt16BE(state.y, 4);
  return plain;
}

// A state, or null for anything that isn't exactly one: another length, a
// bit no button has, or a stick past its end. Nothing else fits in a
// message, so nothing else can be sent.
export function unpackState(plain: Uint8Array): PadState | null {
  if (plain.length !== STATE_BYTES) return null;
  const bytes = Buffer.from(plain.buffer, plain.byteOffset, plain.length);
  const state = { buttons: bytes.readUInt16BE(0), x: bytes.readInt16BE(2), y: bytes.readInt16BE(4) };
  if ((state.buttons & ~KNOWN) !== 0 || Math.abs(state.x) > STICK || Math.abs(state.y) > STICK) return null;
  return state;
}

// What the TV sends back: which controller the phone is, 1 to 4, and the
// number of the newest message that controller has taken. 0 is the first
// one, sent as the connection opens: the controller is there.
export function packTook(slot: number, took: number): Buffer {
  const plain = Buffer.alloc(TOOK_BYTES);
  plain.writeUInt8(slot, 0);
  plain.writeUInt32BE(Math.floor(took / 2 ** 32), 1);
  plain.writeUInt32BE(took % 2 ** 32, 5);
  return plain;
}

export function unpackTook(plain: Uint8Array): { slot: number; took: number } | null {
  if (plain.length !== TOOK_BYTES) return null;
  const bytes = Buffer.from(plain.buffer, plain.byteOffset, plain.length);
  const high = bytes.readUInt32BE(1);
  if (high >= 2 ** 21) return null;
  return { slot: bytes.readUInt8(0), took: high * 2 ** 32 + bytes.readUInt32BE(5) };
}

// --- The WebSocket (RFC 6455) --------------------------------------------------

export const OP = { more: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

// Why the TV closes a connection, as the close frame's code.
export const CLOSED = {
  // The phone closed game mode, or the TV is going away.
  done: 1000,
  away: 1001,
  // Not a WebSocket as this speaks it: no mask, a frame in pieces, a frame
  // too long.
  broken: 1002,
  // Nothing came for five seconds.
  quiet: 4000,
  // The same phone opened game mode again: that connection has it now.
  again: 4001,
  // The session ended, or the phone was forgotten in Settings.
  ended: 4002,
  // Too many messages that didn't open, or far too many at once.
  refused: 4003,
  // The TV can't keep the controller right now.
  lost: 4004,
} as const;

// The most a frame carries here. A message is 42 bytes, and the longest
// thing a control frame may hold is 125.
export const FRAME_MOST = 125;

// The answer to a handshake's Sec-WebSocket-Key.
export function acceptKey(key: string): string {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

// One whole frame. A phone masks what it sends, with four bytes of its own.
export function frame(opcode: number, payload: Uint8Array = new Uint8Array(0), mask?: Uint8Array): Buffer {
  if (payload.length > FRAME_MOST) throw new Error("a frame here holds 125 bytes at most");
  const head = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | payload.length]);
  if (!mask) return Buffer.concat([head, payload]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

// A close frame: the code, and a few words for whoever reads a log.
export function closeFrame(code: number, why = "", mask?: Uint8Array): Buffer {
  const text = Buffer.from(why).subarray(0, FRAME_MOST - 2);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return frame(OP.close, payload, mask);
}

export type Framed = { opcode: number; payload: Buffer } | { broken: string };

// Takes the bytes of a connection as they come and gives whole frames.
// `masked` says what this end must be sent: a TV takes only masked frames,
// and a phone only unmasked ones. After a broken frame it gives nothing
// more, and the connection is to be closed.
export class Frames {
  private held = Buffer.alloc(0);
  private masked: boolean;
  private dead = false;

  constructor(masked: boolean) {
    this.masked = masked;
  }

  push(chunk: Uint8Array): Framed[] {
    if (this.dead) return [];
    this.held = this.held.length ? Buffer.concat([this.held, chunk]) : Buffer.from(chunk);
    const frames: Framed[] = [];
    const broken = (why: string): Framed[] => {
      this.dead = true;
      this.held = Buffer.alloc(0);
      return [...frames, { broken: why }];
    };
    for (;;) {
      if (this.held.length < 2) return frames;
      const [first, second] = this.held;
      const opcode = first & 0x0f;
      const length = second & 0x7f;
      if ((first & 0x70) !== 0) return broken("an extension nobody agreed to");
      if ((first & 0x80) === 0 || opcode === OP.more) return broken("a message in pieces");
      if (!Object.values(OP).includes(opcode as (typeof OP)[keyof typeof OP])) return broken("a kind of frame there isn't");
      if (length > FRAME_MOST) return broken("a frame too long");
      if (((second & 0x80) !== 0) !== this.masked) return broken(this.masked ? "a frame with no mask" : "a frame with a mask");
      const start = this.masked ? 6 : 2;
      if (this.held.length < start + length) return frames;
      const payload = Buffer.from(this.held.subarray(start, start + length));
      if (this.masked) for (let i = 0; i < payload.length; i++) payload[i] ^= this.held[2 + (i % 4)];
      this.held = this.held.subarray(start + length);
      frames.push({ opcode, payload });
    }
  }
}
