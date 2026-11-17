// The phone's d-pad and keyboard on the TV (ADR-008, stage 4): the daemon
// takes them from a paired phone, and this, in the TV session's screen
// daemon, holds its stream open and hands each one to the virtual input
// device (input.py), so they reach whatever's in front. What's typed can be
// a password, so it's never logged (ADR-032).
//
// The new remote (ADR-065) also asks things the daemon waits on: a change to
// what's typed, Enter, and play or pause. Each one comes on the same stream,
// in order with the keys, and the answer goes back over the daemon's port.

import { createConnection } from "node:net";
import { join } from "node:path";
import type { PlaybackAsk } from "./remote-play.ts";
import { type Bar, NativeTyping } from "./remote-text.ts";

// What the daemon asks of the TV session for a phone, numbered for the
// answer: the field in front holds value (daemon/remote-text.ts), Enter, or
// play and pause in whatever plays. With what's playing in full, that's
// also play, pause, previous, a jump to a place, and where the thing is
// (daemon/remote-play.ts).
export type RemoteAsk =
  | { n: number; kind: "text"; value: string; caret: number | null; bar: Bar | null }
  | { n: number; kind: "done" }
  | ({ n: number; kind: "playback" } & PlaybackAsk);

export interface RemoteOptions {
  url: string; // the daemon's stream: http://127.0.0.1:3000/api/remote
  // Who takes the stream: the screen daemon ("1"), or Omarchy's desktop
  // ("desktop"), while it's on, for the phone's trackpad (ADR-037).
  as?: "1" | "desktop";
  // Hands one request to the virtual input device: {"key": "up"}, {"text": ...}.
  send?: (request: Record<string, unknown>) => Promise<void>;
  // What the TV session does for a phone, past the PIN the daemon checked:
  // {"cmd": "update-install"}, Install now from the phone (S4.8).
  command?: (cmd: string) => Promise<void>;
  // Answers the daemon's asks. Without it, as on Omarchy's desktop, text is
  // typed as keystrokes and play and pause is the media key.
  ask?: (ask: RemoteAsk) => Promise<object>;
  // Two fingers on the phone's pad (ADR-103): scroll the page in front by
  // dx to the right and dy down, in its pixels, from its middle, or from
  // the pointer in pointer mode. Without it, as on Omarchy's desktop, it's
  // the virtual device's wheel where the pointer is.
  wheel?: (dx: number, dy: number, at: "page" | "pointer") => Promise<void>;
  log?: (line: string) => void;
  retryMs?: number;
}

// How far one notch of a mouse's wheel scrolls a page in Chromium on
// Linux, in pixels.
export const WHEEL_NOTCH_PX = 53;
// The most the virtual device's wheel turns in one request, each way: 50
// notches of 120 (daemon/input.py's WHEEL_MOST and NOTCH). A bigger scroll,
// up to the route's 4000 pixels, turns it this far.
export const WHEEL_MOST = 6000;

// A page's scroll, dx right and dy down in pixels, as the virtual device's
// wheel: right and up, in 120ths of a notch (daemon/input.py). Null when
// it's less than the wheel's smallest turn.
export function wheelTurn(dx: number, dy: number): { wheel: [number, number] } | null {
  const turn = (px: number) => Math.max(-WHEEL_MOST, Math.min(WHEEL_MOST, Math.round((px * 120) / WHEEL_NOTCH_PX))) || 0;
  const wheel: [number, number] = [turn(dx), -turn(dy) || 0];
  return wheel[0] || wheel[1] ? { wheel } : null;
}

// One JSON line to input.py's socket, and its answer.
export function sendInput(request: Record<string, unknown>, socket = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`, "origaitv", "input.sock")): Promise<void> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let answer = "";
    connection.setEncoding("utf8");
    connection.setTimeout(10_000, () => connection.destroy(new Error("the virtual input device didn't answer")));
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (chunk: string) => {
      answer += chunk;
      if (!answer.includes("\n")) return;
      connection.end();
      if (answer.trim() === "ok") resolve();
      // input.py's errors never name what was typed.
      else reject(new Error(answer.trim()));
    });
    connection.on("error", (error) => reject(new Error(`the virtual input device isn't there (${(error as NodeJS.ErrnoException).code ?? error.message})`)));
  });
}

export class RemoteInput {
  private url: string;
  private as: string;
  private send: (request: Record<string, unknown>) => Promise<void>;
  private command: (cmd: string) => Promise<void>;
  private ask: (ask: RemoteAsk) => Promise<object>;
  private wheel: (dx: number, dy: number, at: "page" | "pointer") => Promise<void>;
  private native = new NativeTyping();
  private log: (line: string) => void;
  private retryMs: number;
  private stopped = false;
  private abort?: AbortController;
  // One at a time, in order, so typed text comes out as it was typed.
  private chain: Promise<void> = Promise.resolve();
  private failed = "";

  constructor(options: RemoteOptions) {
    this.url = options.url;
    this.as = options.as ?? "1";
    this.send = options.send ?? ((request) => sendInput(request));
    this.command = options.command ?? (async () => {});
    this.ask = options.ask ?? ((ask) => this.keystrokes(ask));
    this.wheel =
      options.wheel ??
      (async (dx, dy) => {
        const turn = wheelTurn(dx, dy);
        if (turn) await this.send(turn);
      });
    this.log = options.log ?? ((line) => console.log(line));
    this.retryMs = options.retryMs ?? 2000;
  }

  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  // Waits for what's been sent so far, for the tests.
  idle(): Promise<void> {
    return this.chain;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const response = await fetch(this.url, { headers: { "X-OrigaiTV-Screen": this.as }, signal: this.abort.signal });
        if (!response.ok || !response.body) throw new Error(`the daemon answered ${response.status}`);
        let buffer = "";
        const decoder = new TextDecoder();
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block.split("\n").find((line) => line.startsWith("data: "));
            if (data) this.take(data.slice(6));
          }
        }
      } catch (error) {
        if (this.stopped) return;
        const message = (error as Error).message;
        if (message !== this.failed) this.log(`phone input: ${message}; trying again`);
        this.failed = message;
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, this.retryMs));
    }
  }

  private take(json: string): void {
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(json);
    } catch {
      return;
    }
    if (request.ask && typeof request.ask === "object") {
      const ask = request.ask as RemoteAsk;
      this.chain = this.chain.then(async () => {
        const answer = await this.ask(ask).catch((error: Error) => ({ ok: false, why: error.message }));
        void this.reply(ask.n, answer);
      });
      return;
    }
    const cmd = typeof request.cmd === "string" ? request.cmd : null;
    const wheel = Array.isArray(request.wheel) && request.wheel.length === 2 && request.wheel.every(Number.isFinite) ? (request.wheel as [number, number]) : null;
    this.chain = this.chain
      .then(() => (cmd ? this.command(cmd) : wheel ? this.wheel(wheel[0], wheel[1], request.at === "pointer" ? "pointer" : "page") : this.send(request)))
      .then(() => {
        this.failed = "";
      })
      .catch((error: Error) => {
        // Never the text itself: only what went wrong.
        this.log(`phone input: ${error.message}`);
      });
  }

  // The answer to an ask, over the daemon's port, with the same header.
  private async reply(n: number, answer: object): Promise<void> {
    try {
      await fetch(`${this.url}/answer/${Number(n)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OrigaiTV-Screen": this.as },
        body: JSON.stringify(answer),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      this.log(`phone input: an answer didn't reach the daemon (${(error as Error).message})`);
    }
  }

  // With nothing in front but native windows: keystrokes for text, and the
  // media key for play and pause.
  private async keystrokes(ask: RemoteAsk): Promise<object> {
    if (ask.kind === "text") return this.native.type(ask.value, "", this.send);
    if (ask.kind === "done") {
      this.native.reset();
      await this.send({ key: "enter" });
      return { ok: true, by: "key" };
    }
    // Nothing here can see what plays, or tell play from pause.
    if (ask.action === "now") return { ok: true, now: null };
    if (ask.action !== "toggle" && ask.action !== "next" && ask.action !== "previous") return { ok: false, why: "This app can't do that", ...(ask.now ? { now: null } : {}) };
    await this.send({ key: ask.action === "toggle" ? "playpause" : ask.action });
    return { ok: true, by: "key", ...(ask.now ? { now: null } : {}) };
  }
}
