// The phone's remote (ADR-065, PHASE-2-PLAN.md "Shared interfaces"): what
// you type on the phone, in the TV's field as you type it.
//
//   POST /api/phone/text  { "value": "…", "caret": 5 } on each change,
//                         { "done": true } for Enter
//
// Each change goes to the screen daemon on its stream (daemon/remote.ts),
// which puts it in the field in front and answers here. Only the newest
// change waits to go: one that's overtaken before the screen daemon takes it
// is answered as done, since the newer one carries it. Home's typing bar
// hears each change too, with dots for a password. Nothing here keeps or
// logs what's typed.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RemoteAsk } from "../remote.ts";
import { barText, type Bar } from "../remote-text.ts";

// The most a phone sends at once, in characters.
export const TEXT_MAX = 500;
// How long a change waits for the screen daemon's answer.
const ANSWER_MS = 3000;

export interface RemoteAnswer {
  ok: boolean;
  by?: "app" | "page" | "key";
  why?: string;
  value?: string;
  kept?: number;
}

// An ask before it has its number.
type Unnumbered<T> = T extends unknown ? Omit<T, "n"> : never;
type Ask = Unnumbered<RemoteAsk>;

export interface PhoneRemoteOptions {
  // An event on the screen daemon's stream; false with no TV session.
  send(event: object): boolean;
  // The field in front on the TV and what's in front, as the phones see it.
  tv(): { field: { kind: string } | null; front: "home" | "app" };
  // Who's watching, for the typing bar's "radomir's phone".
  viewer(): Promise<{ name: string }>;
  // An event for the TV's own pages.
  toPages(event: string, data: unknown): void;
  json(response: ServerResponse, status: number, data: unknown): void;
  body(request: IncomingMessage): Promise<unknown>;
  answerMs?: number;
}

// Only what an answer can carry, within bounds.
export function cleanAnswer(said: unknown): RemoteAnswer {
  if (!said || typeof said !== "object") return { ok: false, why: "the tv's answer made no sense" };
  const a = said as Record<string, unknown>;
  const answer: RemoteAnswer = { ok: a.ok === true };
  if (a.by === "app" || a.by === "page" || a.by === "key") answer.by = a.by;
  if (typeof a.why === "string") answer.why = a.why.slice(0, 120);
  if (typeof a.value === "string") answer.value = a.value.slice(0, TEXT_MAX * 2);
  if (Number.isInteger(a.kept) && (a.kept as number) >= 0) answer.kept = a.kept as number;
  return answer;
}

export class PhoneRemote {
  private o: PhoneRemoteOptions;
  private next = 1;
  private waiting = new Map<number, (answer: RemoteAnswer) => void>();
  // The newest change waiting to go, while one is with the screen daemon.
  private queued: { value: string; caret: number | null; bar: Bar; done: (answer: RemoteAnswer) => void } | null = null;
  private typing = false;

  constructor(options: PhoneRemoteOptions) {
    this.o = options;
  }

  // The phone's routes, on the home network. True when it was one of them.
  async phone(method: string, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (method === "POST" && path === "/api/phone/text") {
      await this.text(request, response);
      return true;
    }
    return false;
  }

  // The screen daemon's answers, on the daemon's own port, with the header
  // only it sends.
  async local(method: string, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const answered = /^\/api\/remote\/answer\/(\d+)$/.exec(path);
    if (method !== "POST" || !answered) return false;
    const who = request.headers["x-agentv-screen"];
    if (who !== "1" && who !== "desktop") {
      this.o.json(response, 403, { ok: false, error: "only the screen daemon answers for the phone" });
      return true;
    }
    const done = this.waiting.get(Number(answered[1]));
    this.waiting.delete(Number(answered[1]));
    done?.(cleanAnswer(await this.o.body(request)));
    this.o.json(response, done ? 200 : 404, done ? { ok: true } : { ok: false, error: "nothing waits for that answer" });
    return true;
  }

  // Every ask still waiting gets an answer, as the daemon stops.
  close(): void {
    for (const done of [...this.waiting.values()]) done({ ok: false, why: "the tv stopped" });
    this.waiting.clear();
  }

  // One ask on the screen daemon's stream, and its answer, or why not.
  ask(what: Ask, ms = this.o.answerMs ?? ANSWER_MS): Promise<RemoteAnswer> {
    const n = this.next++;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiting.delete(n);
        done({ ok: false, why: "the tv didn't answer in time" });
      }, ms);
      this.waiting.set(n, (answer) => {
        clearTimeout(timer);
        done(answer);
      });
      if (!this.o.send({ ask: { n, ...what } })) {
        this.waiting.delete(n);
        clearTimeout(timer);
        done({ ok: false, why: "the tv session isn't on" });
      }
    });
  }

  private async text(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = ((await this.o.body(request)) ?? {}) as Record<string, unknown>;
    if (body.done === true) {
      this.o.toPages("typing", null);
      this.reply(response, await this.ask({ kind: "done" }));
      return;
    }
    const value = body.value;
    if (typeof value !== "string" || [...value].length > TEXT_MAX) {
      this.o.json(response, 400, { ok: false, error: `text of up to ${TEXT_MAX} characters, or done` });
      return;
    }
    const caret = Number.isInteger(body.caret) && (body.caret as number) >= 0 && (body.caret as number) <= value.length ? (body.caret as number) : null;
    const tv = this.o.tv();
    const password = tv.field?.kind === "password";
    const name = (await this.o.viewer()).name.toLowerCase();
    const bar: Bar = { from: name === "you" ? "your phone" : `${name}'s phone`, text: barText(value, password), password };
    // Home draws its own bar; over an app, the screen daemon has the overlay
    // draw it.
    this.o.toPages("typing", tv.front === "home" ? bar : null);
    this.reply(response, await this.change(value, caret, bar));
  }

  // A change, once the one with the screen daemon is done; a newer one
  // takes the place of one still waiting.
  private change(value: string, caret: number | null, bar: Bar): Promise<RemoteAnswer> {
    return new Promise((done) => {
      this.queued?.done({ ok: true });
      this.queued = { value, caret, bar, done };
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.typing) return;
    this.typing = true;
    try {
      while (this.queued) {
        const { value, caret, bar, done } = this.queued;
        this.queued = null;
        done(await this.ask({ kind: "text", value, caret, bar }));
      }
    } finally {
      this.typing = false;
    }
  }

  private reply(response: ServerResponse, answer: RemoteAnswer): void {
    this.o.json(response, answer.why === "the tv session isn't on" ? 503 : 200, answer);
  }
}
