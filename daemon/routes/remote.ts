// The phone's remote (ADR-065, PHASE-2-PLAN.md "Shared interfaces"): what
// you type on the phone, in the TV's field as you type it, and play and
// pause in every app.
//
//   POST /api/phone/text      { "value": "…", "caret": 5 } on each change,
//                             { "done": true } for Enter
//   POST /api/phone/playback  { "action": "toggle" | "next" }, answered
//                             { "ok": true, "by": "app" | "page" | "key" }
//                             or { "ok": false, "why": "nothing is playing" }
//   POST /api/phone/apps      Apps on the TV, from the remote's menu, with
//                             home brought in front of an app first
//
// With the playing2 switch on, what's playing is said in full, for a card
// on a phone's Lock Screen:
//
//   POST /api/phone/playback  also { "action": "play" | "pause" | "previous" }
//                             and { "action": "seek", "position": 754 }, in
//                             seconds. Play and pause each do nothing when
//                             it's already so. Every action but toggle is
//                             answered with "nowPlaying" too: where the
//                             thing then is
//   GET /api/phone/playing/picture
//                             a picture for what's playing, from what the
//                             TV already has for the title
//
// and the state's nowPlaying says where the thing is and how long it runs,
// in seconds, when that was read, whether it's playing or paused, and what
// can be asked of it. With the switch off, all of this is as it was.
//
// Each change goes to the screen daemon on its stream (daemon/remote.ts),
// which puts it in the field in front and answers here. Only the newest
// change waits to go: one that's overtaken before the screen daemon takes it
// is answered as done, since the newer one carries it. Home's typing bar
// hears each change too, with dots for a password. Nothing here keeps or
// logs what's typed.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { WatchRow } from "../ledger.ts";
import { NOT_READY, WENT_WRONG } from "../notices.ts";
import type { RemoteAsk } from "../remote.ts";
import type { PlayingNow } from "../remote-play.ts";
import { barText, type Bar } from "../remote-text.ts";

// The most a phone sends at once, in characters.
export const TEXT_MAX = 500;
// How long a change waits for the screen daemon's answer, and play and
// pause, which can wait on an app's own pause.
const ANSWER_MS = 3000;
const PLAYBACK_MS = 12_000;
// The requests that answer with where the thing then is wait longer: the
// app's own call can take 10 s, the page's video is tried after it, and
// then the place is read.
export const PLAYBACK_FULL_MS = 20_000;
// How long a look at what's playing waits for its answer, and how often one
// comes while something plays or is paused in front. A jump made on the TV
// itself, or the next episode starting, has no event to hear, so this
// looks. It's the ledger's own pace.
const LOOK_WAIT_MS = 8000;
const LOOK_MS = 10_000;
// A jump's place: seconds from the start, up to a day.
const SEEK_MOST = 86_400;
// A picture from the TV session, as a data: address. The daemon's own
// limit on a body is under this, so a cover bigger than that isn't shown.
const PICTURE_MOST = 512 * 1024;
const PICTURE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/;

export interface RemoteAnswer {
  ok: boolean;
  by?: "app" | "page" | "key";
  why?: string;
  // The TV's screen wasn't there to ask. Never sent on.
  off?: boolean;
  value?: string;
  kept?: number;
  // Where what's playing is, and a picture the TV session holds for it, as
  // the screen daemon says them. Never sent on as they are.
  now?: PlayingNow | null;
  picture?: string;
}

// What's playing, as a phone is told with the playing2 switch on. title,
// app and left are what the remote's card had before.
export interface NowPlaying {
  title: string;
  app: string;
  left?: number; // minutes
  position: number; // seconds
  duration: number | null; // seconds; null for something live
  at: string; // when position was read
  playing: boolean; // false while it's paused
  next: boolean;
  previous: boolean;
  seek: boolean;
  picture: boolean;
}

export interface Picture {
  type: string;
  body: Buffer;
}

// What's playing in full needs these of the daemon. Without them, as in a
// test of the typing alone, the switch counts as off.
export interface PlayingOptions {
  on(): Promise<boolean>;
  // An app's name, by its id.
  name(app: string): Promise<string>;
  // A picture the TV already has for the title, or null.
  picture(now: PlayingNow): Promise<Picture | null>;
  // The phones hear that the state changed.
  changed(): void;
  // A picture, as it is, to a paired phone.
  send(response: ServerResponse, type: string, body: Buffer): void;
  lookMs?: number;
}

// An ask before it has its number.
type Unnumbered<T> = T extends unknown ? Omit<T, "n"> : never;
type Ask = Unnumbered<RemoteAsk>;

export interface PhoneRemoteOptions {
  // An event on the screen daemon's stream; false with no TV session.
  send(event: object): boolean;
  // The field in front on the TV and what's in front, as the phones see it.
  tv(): { field: { kind: string } | null; front: "home" | "app"; playing?: boolean };
  // Who's watching, for the typing bar's "radomir's phone".
  viewer(): Promise<{ name: string }>;
  // An event for the TV's own pages.
  toPages(event: string, data: unknown): void;
  json(response: ServerResponse, status: number, data: unknown): void;
  body(request: IncomingMessage): Promise<unknown>;
  answerMs?: number;
  // What's playing, in full, behind its switch.
  playing2?: PlayingOptions;
}

// What's playing, for the card on the phone's remote: the newest row of the
// ledger, while something plays and its app has read it in the last 30 s.
export function nowPlaying(rows: WatchRow[], name: (app: string) => string, now = Date.now()): { title: string; app: string; left?: number } | null {
  const row = rows[0];
  if (!row || now - Date.parse(row.updated_at) > 30_000) return null;
  const left = row.duration_s && row.position_s !== null ? Math.max(0, Math.round((row.duration_s - row.position_s) / 60)) : null;
  return { title: row.title, app: name(row.app_id), ...(left === null ? {} : { left }) };
}

// Only what an answer can carry, within bounds.
export function cleanAnswer(said: unknown): RemoteAnswer {
  if (!said || typeof said !== "object") return { ok: false, why: WENT_WRONG };
  const a = said as Record<string, unknown>;
  const answer: RemoteAnswer = { ok: a.ok === true };
  if (a.by === "app" || a.by === "page" || a.by === "key") answer.by = a.by;
  if (typeof a.why === "string") answer.why = a.why.slice(0, 120);
  if (typeof a.value === "string") answer.value = a.value.slice(0, TEXT_MAX * 2);
  if (Number.isInteger(a.kept) && (a.kept as number) >= 0) answer.kept = a.kept as number;
  if ("now" in a) answer.now = cleanNow(a.now);
  if (typeof a.picture === "string" && a.picture.length <= PICTURE_MOST && PICTURE.test(a.picture)) answer.picture = a.picture;
  return answer;
}

// Where what's playing is, as the screen daemon said it: only what it can
// be, within bounds, or null.
export function cleanNow(said: unknown): PlayingNow | null {
  if (!said || typeof said !== "object") return null;
  const n = said as Record<string, unknown>;
  const seconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (typeof n.id !== "string" || !n.id || typeof n.title !== "string" || !seconds(n.position) || !seconds(n.at)) return null;
  const duration = seconds(n.duration) && n.duration > 0 ? n.duration : null;
  return {
    by: n.by === "app" ? "app" : "page",
    id: n.id.slice(0, 120),
    title: n.title
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 300),
    position: duration === null ? n.position : Math.min(n.position, duration),
    duration,
    playing: n.playing === true,
    at: n.at,
    next: n.next === true,
    previous: n.previous === true,
    seek: n.seek === true,
    ...(typeof n.picture === "string" && n.picture.length <= 2000 ? { picture: n.picture } : {}),
    ...(n.cover === true ? { cover: true } : {}),
  };
}

// Whether what's playing changed in a way a phone has to hear: anything
// but the clock running on by itself. A place more than 2 s from where the
// last reading puts it is a jump.
export function moved(before: PlayingNow, now: PlayingNow): boolean {
  if (before.playing !== now.playing || before.next !== now.next || before.previous !== now.previous || before.seek !== now.seek) return true;
  if ((before.duration === null) !== (now.duration === null) || Math.abs((before.duration ?? 0) - (now.duration ?? 0)) > 1) return true;
  const expected = before.position + (before.playing ? (now.at - before.at) / 1000 : 0);
  return Math.abs(now.position - expected) > 2;
}

// What a phone is told of it, with its app's name and whether there's a
// picture. The minutes left are counted from now, for the remote's card.
export function toldNow(now: PlayingNow, app: string, picture: boolean, at = Date.now()): NowPlaying {
  const position = now.position + (now.playing ? Math.max(0, at - now.at) / 1000 : 0);
  const left = now.duration === null ? null : Math.max(0, Math.round((now.duration - position) / 60));
  return {
    title: now.title || app,
    app,
    ...(left === null ? {} : { left }),
    position: Math.round(now.position * 10) / 10,
    duration: now.duration === null ? null : Math.round(now.duration * 10) / 10,
    at: new Date(now.at).toISOString(),
    playing: now.playing,
    next: now.next,
    previous: now.previous,
    seek: now.seek,
    picture,
  };
}

export class PhoneRemote {
  private o: PhoneRemoteOptions;
  private next = 1;
  private waiting = new Map<number, (answer: RemoteAnswer) => void>();
  // The newest change waiting to go, while one is with the screen daemon.
  private queued: { value: string; caret: number | null; bar: Bar; done: (answer: RemoteAnswer) => void } | null = null;
  private typing = false;
  // What's playing, as last read, with its app's name and its picture.
  private kept: { key: string; now: PlayingNow; app: string; picture: Picture | null } | null = null;
  private keeping: Promise<void> = Promise.resolve();
  private looking = false;
  private lookAgain = false;
  private lookTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(options: PhoneRemoteOptions) {
    this.o = options;
  }

  // The phone's routes, on the home network. True when it was one of them.
  async phone(method: string, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (method === "POST" && path === "/api/phone/text") {
      await this.text(request, response);
      return true;
    }
    if (method === "POST" && path === "/api/phone/playback") {
      const body = (await this.o.body(request)) as { action?: unknown; position?: unknown } | undefined;
      const action = body?.action;
      if (await this.full()) {
        await this.playback(response, action, body?.position);
        return true;
      }
      if (action !== "toggle" && action !== "next") {
        this.o.json(response, 400, { ok: false, error: 'the action is "toggle" or "next"' });
        return true;
      }
      this.reply(response, await this.ask({ kind: "playback", action }, PLAYBACK_MS));
      return true;
    }
    // With the switch off this isn't a route, like any other address.
    if (method === "GET" && path === "/api/phone/playing/picture" && (await this.full())) {
      const picture = this.kept?.picture;
      if (picture) this.o.playing2!.send(response, picture.type, picture.body);
      else this.o.json(response, 404, { ok: false, error: "There's no picture for what's playing" });
      return true;
    }
    if (method === "POST" && path === "/api/phone/apps") {
      const sent = this.o.send({ cmd: "apps" });
      this.o.json(response, sent ? 200 : 503, sent ? { ok: true } : { ok: false, error: NOT_READY });
      return true;
    }
    return false;
  }

  // The screen daemon's answers, on the daemon's own port, with the header
  // only it sends.
  async local(method: string, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const answered = /^\/api\/remote\/answer\/(\d+)$/.exec(path);
    if (method !== "POST" || !answered) return false;
    const who = request.headers["x-origaitv-screen"];
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
    this.closed = true;
    clearTimeout(this.lookTimer);
    for (const done of [...this.waiting.values()]) done({ ok: false, why: NOT_READY });
    this.waiting.clear();
  }

  // --- What's playing, in full (the playing2 switch) ----------------------

  private full(): Promise<boolean> {
    return this.o.playing2 ? this.o.playing2.on().catch(() => false) : Promise.resolve(false);
  }

  // What's playing, for the state, or null with nothing to steer in front.
  nowPlaying(): NowPlaying | null {
    return this.kept ? toldNow(this.kept.now, this.kept.app, this.kept.picture !== null) : null;
  }

  // What's on the TV changed, or the switch did: a look at what plays.
  tvChanged(): void {
    if (this.o.playing2 && !this.closed) void this.look();
  }

  // One look at a time. One asked for meanwhile runs once it's done.
  async look(): Promise<void> {
    if (this.looking) {
      this.lookAgain = true;
      return;
    }
    this.looking = true;
    try {
      do {
        this.lookAgain = false;
        if (!(await this.full())) {
          await this.keep(null);
          break;
        }
        const answer = await this.ask({ kind: "playback", action: "now" }, LOOK_WAIT_MS);
        // An answer that didn't come leaves what's kept: the next look
        // tries again. With no TV session, nothing plays.
        if (answer.ok || answer.off) await this.keep(answer.now ?? null);
      } while (this.lookAgain && !this.closed);
    } finally {
      this.looking = false;
    }
    // Again in a while, as long as something plays or is paused in front.
    clearTimeout(this.lookTimer);
    if (this.closed || !(this.kept || this.o.tv().playing) || !(await this.full())) return;
    this.lookTimer = setTimeout(() => void this.look(), this.o.playing2?.lookMs ?? LOOK_MS);
    this.lookTimer.unref?.();
  }

  // Keeps a reading, each after the one before. The phones hear when it's
  // another thing, or the same thing changed by more than its clock.
  private keep(now: PlayingNow | null): Promise<void> {
    this.keeping = this.keeping.then(async () => {
      const before = this.kept;
      if (!now) {
        this.kept = null;
        if (before) this.o.playing2?.changed();
        return;
      }
      const key = JSON.stringify([now.id, now.title, now.picture ?? null, now.cover === true]);
      if (before?.key === key) {
        this.kept = { ...before, now };
        if (moved(before.now, now)) this.o.playing2?.changed();
        return;
      }
      const app = (await this.o.playing2?.name(now.id).catch(() => null)) ?? now.id;
      this.kept = { key, now, app, picture: null };
      this.o.playing2?.changed();
      void this.findPicture(key, now);
    });
    // One that fails doesn't stop the ones after it.
    this.keeping = this.keeping.catch(() => {});
    return this.keeping;
  }

  // The picture for a new title: the one the TV session holds, such as an
  // album's cover, or one the daemon already has for it.
  private async findPicture(key: string, now: PlayingNow): Promise<void> {
    let picture: Picture | null = null;
    try {
      if (now.cover) {
        const found = PICTURE.exec((await this.ask({ kind: "playback", action: "picture" }, LOOK_WAIT_MS)).picture ?? "");
        if (found) picture = { type: found[1], body: Buffer.from(found[2], "base64") };
      } else {
        picture = (await this.o.playing2?.picture(now)) ?? null;
      }
    } catch {
      picture = null;
    }
    if (!picture || this.kept?.key !== key) return;
    this.kept = { ...this.kept, picture };
    this.o.playing2?.changed();
  }

  // One of the playback requests, with the switch on. Toggle is as it was.
  // The others answer with where the thing then is.
  private async playback(response: ServerResponse, action: unknown, position: unknown): Promise<void> {
    if (action === "toggle") {
      this.reply(response, await this.ask({ kind: "playback", action }, PLAYBACK_MS));
      return;
    }
    if (action !== "next" && action !== "play" && action !== "pause" && action !== "previous" && action !== "seek") {
      this.o.json(response, 400, { ok: false, error: 'the action is "toggle", "next", "play", "pause", "previous" or "seek"' });
      return;
    }
    if (action === "seek" && !(typeof position === "number" && Number.isFinite(position) && position >= 0 && position <= SEEK_MOST)) {
      this.o.json(response, 400, { ok: false, error: "seek takes a position in seconds" });
      return;
    }
    const answer = await this.ask({ kind: "playback", action, now: true, ...(action === "seek" ? { position: position as number } : {}) }, PLAYBACK_FULL_MS);
    // What the screen daemon read after it. With no answer in time, what's
    // kept stands until the next look.
    if (answer.now !== undefined) await this.keep(answer.now);
    else if (answer.off) await this.keep(null);
    else void this.look();
    const { off, now, picture, ...said } = answer;
    this.o.json(response, off ? 503 : 200, { ...said, nowPlaying: this.nowPlaying() });
  }

  // One ask on the screen daemon's stream, and its answer, or why not.
  ask(what: Ask, ms = this.o.answerMs ?? ANSWER_MS): Promise<RemoteAnswer> {
    const n = this.next++;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiting.delete(n);
        done({ ok: false, why: NOT_READY });
      }, ms);
      this.waiting.set(n, (answer) => {
        clearTimeout(timer);
        done(answer);
      });
      if (!this.o.send({ ask: { n, ...what } })) {
        this.waiting.delete(n);
        clearTimeout(timer);
        done({ ok: false, why: NOT_READY, off: true });
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
    const name = (await this.o.viewer()).name;
    const bar: Bar = { from: name.toLowerCase() === "you" ? "Your phone" : `${name}'s phone`, text: barText(value, password), password };
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
    const { off, now, picture, ...said } = answer;
    this.o.json(response, off ? 503 : 200, said);
  }
}
