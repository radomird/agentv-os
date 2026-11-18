// The controllers phones are (ADR-113): which phone has which, and what
// keeps each one alive.
//
// The daemon can't make an input device. It runs as its own account, and
// only the person logged in on the screen may use uinput. So the devices
// are made by the input helper (daemon/input.py), which holds one
// connection open to the daemon for them. This file sits between the two:
// a phone's opened messages come in on one side, and go out the other as a
// line each. The helper says when a controller is there, and when it has
// taken a message, which goes back to the phone.
//
// The rules it keeps:
// - one controller per phone, four at most, and a fifth phone is refused;
// - a phone that opens game mode again takes its controller over, and the
//   connection it had is closed;
// - a controller is gone the moment its phone closes the connection, is
//   forgotten, or sends nothing for five seconds;
// - when the helper goes away, so does every controller, and every phone
//   hears it.
//
// A line to the helper is {"open": slot}, {"state": [slot, buttons, x, y],
// "n": number}, {"close": slot} or {"beat": 1}. A line from it is
// {"opened": slot}, {"failed": slot, "why": "..."} or {"took": [slot, n]}.

import { CLOSED, packTook, unpackState } from "./pad-wire.ts";

export const PADS_MOST = 4;
// How long a phone may send nothing before its controller goes. A phone
// that's holding still sends its state again every second or two.
export const QUIET_MS = 5000;
// How long the helper has to make a controller.
const OPEN_MS = 3000;
// A phone's own mistakes it gets away with, on one connection: messages
// that didn't open or didn't hold a state.
const BAD_MOST = 16;
// More messages than this in one second isn't somebody playing.
const SECOND_MOST = 500;
// The helper hears from the daemon at least this often, so it can tell a
// daemon that's stuck from one with nothing to say.
const BEAT_MS = 2000;

// The helper's connection, as lines.
export interface PadLink {
  send(line: object): void;
  close(): void;
}

// A phone's connection: `give` seals and sends a few bytes, and `end`
// closes it with a reason.
export interface PadWire {
  give(plain: Uint8Array): void;
  end(code: number, why: string): void;
}

export type PadRefusal = { ok: false; status: number; error: string };

export interface Pad {
  slot: number;
  // A message from the phone, opened: its number and what it held. False
  // when it wasn't a state, which counts against the connection.
  took(n: number, plain: Uint8Array): boolean;
  // A message that didn't open.
  bad(): void;
  // The connection is over: the phone closed it, which is the reason when
  // none is given, or it broke.
  gone(code?: number, why?: string): void;
}

interface Held {
  slot: number;
  phone: string;
  wire: PadWire;
  timer: NodeJS.Timeout;
  bad: number;
  second: number;
  inSecond: number;
}

export interface PadsOptions {
  log?: (line: string) => void;
  // The count of controllers changed: the phones' state says it.
  changed?: () => void;
  quietMs?: number;
  openMs?: number;
  now?: () => number;
}

export class Pads {
  private link: PadLink | null = null;
  private beat?: NodeJS.Timeout;
  private held = new Map<number, Held>();
  // The controllers being made: who waits for the helper's word on each.
  private opening = new Map<number, (why: string | null) => void>();
  // Each phone's opens, one after another, so two at once can't both get a
  // controller.
  private turns = new Map<string, Promise<unknown>>();
  private log: (line: string) => void;
  private changed: () => void;
  private quietMs: number;
  private openMs: number;
  private now: () => number;

  constructor(options: PadsOptions = {}) {
    this.log = options.log ?? (() => {});
    this.changed = options.changed ?? (() => {});
    this.quietMs = options.quietMs ?? QUIET_MS;
    this.openMs = options.openMs ?? OPEN_MS;
    this.now = options.now ?? Date.now;
  }

  // How many phones are controllers right now.
  count(): number {
    return this.held.size;
  }

  // Whether the helper is there to make one.
  ready(): boolean {
    return this.link !== null;
  }

  // The helper connected. One at a time: a new one is the helper started
  // again, so what the old one held is gone. It gives back what to call
  // with each line from the helper, and when its connection ends.
  attach(link: PadLink): { line: (line: unknown) => void; closed: () => void } {
    if (this.link) {
      this.drop("the controllers started again");
      this.link.close();
    }
    this.link = link;
    clearInterval(this.beat);
    this.beat = setInterval(() => link.send({ beat: 1 }), BEAT_MS);
    this.beat.unref();
    this.log("phone controllers: ready");
    return {
      line: (line) => {
        if (this.link === link) this.heard(line);
      },
      closed: () => {
        if (this.link !== link) return;
        this.link = null;
        clearInterval(this.beat);
        this.drop("the controllers stopped");
        this.log("phone controllers: the input helper went away");
      },
    };
  }

  // Every controller goes, and each phone is told why.
  private drop(why: string): void {
    for (const waiting of this.opening.values()) waiting(why);
    this.opening.clear();
    const all = [...this.held.values()];
    this.held.clear();
    for (const pad of all) {
      clearTimeout(pad.timer);
      pad.wire.end(CLOSED.lost, why);
    }
    if (all.length) this.changed();
  }

  private heard(line: unknown): void {
    if (!line || typeof line !== "object") return;
    const { opened, failed, why, took } = line as { opened?: unknown; failed?: unknown; why?: unknown; took?: unknown };
    if (typeof opened === "number") this.opening.get(opened)?.(null);
    else if (typeof failed === "number") this.opening.get(failed)?.(typeof why === "string" ? why.slice(0, 200) : "no reason given");
    else if (Array.isArray(took) && took.length === 2 && Number.isSafeInteger(took[1])) {
      // The helper took a message: the phone hears which, so it can time a
      // press from its thumb to the controller.
      this.held.get(took[0] as number)?.wire.give(packTook(took[0] as number, took[1] as number));
    }
  }

  // A phone opens game mode. Its controller is made before this answers, so
  // a phone that's told yes has one.
  open(phone: { id: string; name: string }, wire: PadWire): Promise<Pad | PadRefusal> {
    const turn = (this.turns.get(phone.id) ?? Promise.resolve()).then(() => this.make(phone, wire));
    const settled = turn.catch(() => {});
    this.turns.set(phone.id, settled);
    void settled.then(() => {
      if (this.turns.get(phone.id) === settled) this.turns.delete(phone.id);
    });
    return turn;
  }

  private async make(phone: { id: string; name: string }, wire: PadWire): Promise<Pad | PadRefusal> {
    const link = this.link;
    if (!link) return { ok: false, status: 503, error: "Your TV isn't ready yet" };
    // The same phone again: the new connection has its controller.
    const mine = [...this.held.values()].find((pad) => pad.phone === phone.id);
    if (mine) this.remove(mine, CLOSED.again, "game mode opened again");
    const slot = Array.from({ length: PADS_MOST }, (_, i) => i + 1).find((n) => !this.held.has(n) && !this.opening.has(n));
    if (slot === undefined) return { ok: false, status: 409, error: "Four phones are playing already" };

    const why = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => done("it took too long"), this.openMs);
      const done = (result: string | null) => {
        clearTimeout(timer);
        this.opening.delete(slot);
        resolve(result);
      };
      this.opening.set(slot, done);
      link.send({ open: slot });
    });
    if (why !== null) {
      // Whatever the helper made of it, it isn't a phone's.
      if (this.link === link) link.send({ close: slot });
      this.log(`phone controllers: couldn't make one for ${phone.name}: ${why}`);
      return { ok: false, status: 503, error: "Your TV isn't ready yet" };
    }

    const pad: Held = { slot, phone: phone.id, wire, bad: 0, second: 0, inSecond: 0, timer: setTimeout(() => this.remove(pad, CLOSED.quiet, "nothing for a while"), this.quietMs) };
    pad.timer.unref();
    this.held.set(slot, pad);
    this.log(`phone controllers: ${phone.name} is controller ${slot}`);
    this.changed();
    // The first thing a phone hears on the connection: it's sealed, so it's
    // the TV saying the controller is there, and which one it is.
    wire.give(packTook(slot, 0));
    const live = () => this.held.get(slot) === pad;
    return {
      slot,
      took: (n, plain) => {
        if (!live()) return false;
        const state = unpackState(plain);
        if (!state) {
          this.strike(pad);
          return false;
        }
        const second = Math.floor(this.now() / 1000);
        if (second !== pad.second) {
          pad.second = second;
          pad.inSecond = 0;
        }
        if (++pad.inSecond > SECOND_MOST) {
          this.remove(pad, CLOSED.refused, "too many messages");
          return false;
        }
        pad.timer.refresh();
        this.link?.send({ state: [slot, state.buttons, state.x, state.y], n });
        return true;
      },
      bad: () => {
        if (live()) this.strike(pad);
      },
      gone: (code = CLOSED.done, why = "the phone closed game mode") => {
        if (live()) this.remove(pad, code, why);
      },
    };
  }

  private strike(pad: Held): void {
    if (++pad.bad > BAD_MOST) this.remove(pad, CLOSED.refused, "too many messages that weren't a controller's");
  }

  private remove(pad: Held, code: number, why: string): void {
    if (this.held.get(pad.slot) !== pad) return;
    this.held.delete(pad.slot);
    clearTimeout(pad.timer);
    this.link?.send({ close: pad.slot });
    pad.wire.end(code, why);
    this.log(`phone controllers: controller ${pad.slot} is gone (${why})`);
    this.changed();
  }

  // Settings forgot a phone, or its session ended: its controller goes.
  forget(phone: string): void {
    for (const pad of [...this.held.values()]) if (pad.phone === phone) this.remove(pad, CLOSED.ended, "the phone isn't paired any more");
  }

  // Every controller goes: the switch was turned off, or the daemon stops.
  clear(why: string, code: number = CLOSED.away): void {
    for (const pad of [...this.held.values()]) this.remove(pad, code, why);
  }

  // Everything goes, the helper's connection too: the daemon is stopping,
  // unless another reason is given.
  close(why = "the TV is stopping"): void {
    this.clear(why);
    clearInterval(this.beat);
    this.link?.close();
    this.link = null;
  }
}
