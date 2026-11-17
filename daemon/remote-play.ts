// Play and pause in every app (ADR-065). The phone's button asks the box,
// and the box finds what plays and says whether it worked, never firing a
// key and hoping. In order:
//   1. the app's own playback.pause and resume, when its module has them;
//   2. the audio or video in the page in front, found through open shadow
//      roots and same-origin frames, as a service's player keeps it;
//   3. with home in front, home's own player, then Music;
//   4. a native app, such as a game, gets the media key, which can't say.
// Next goes the same way: the app's playback.next, Music's next, or the
// key. "Something is playing" uses the same search (MEDIA_PLAYING), so the
// phone switches to playback on a service's player too.
//
// What's playing, in full (the playing2 switch) is further down: play and
// pause as two requests that leave what's already so alone, previous, a
// jump to a place in seconds, and where the thing is. They go the same way:
// the app's own player first, and the page's video when it has none. The
// daemon asks for them only with the switch on.

import type { PlaybackState } from "../apps/contract/contract.ts";
import { MUSIC } from "./music.ts";
import { NOT_READY } from "./notices.ts";
import type { TextAnswer } from "./remote-text.ts";

// Every audio and video element in a page, through open shadow roots and
// same-origin frames. For the expressions below.
const MEDIA = `
  const media = () => {
    const found = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.tagName === "VIDEO" || el.tagName === "AUDIO") found.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
          try { if (el.contentDocument) walk(el.contentDocument); } catch {}
        }
      }
    };
    walk(document);
    return found;
  };
`;

// An expression for a page: whether something in it plays.
export const MEDIA_PLAYING = `(() => {${MEDIA}
  return media().some((m) => !m.paused && !m.ended);
})()`;

// An expression for a page: whether something plays, and whether there's
// anything that could, for the toggle.
export const MEDIA_STATE = `(() => {${MEDIA}
  const all = media();
  return { playing: all.some((m) => !m.paused && !m.ended), any: all.length > 0 };
})()`;

// An expression for a page: pauses what plays, or else plays the one that
// was playing last, the biggest on the screen. It answers what it did, once
// the element says so.
export const MEDIA_TOGGLE = `(async () => {${MEDIA}
  const all = media();
  const playing = all.filter((m) => !m.paused && !m.ended);
  if (playing.length > 0) {
    for (const m of playing) m.pause();
    return playing.every((m) => m.paused) ? { ok: true, did: "paused" } : { ok: false, why: "Couldn't pause" };
  }
  const area = (m) => {
    const box = m.getBoundingClientRect();
    return m.tagName === "VIDEO" ? box.width * box.height : 0;
  };
  const waiting = all.filter((m) => !m.ended).sort((a, b) => (b.currentTime > 0) - (a.currentTime > 0) || area(b) - area(a));
  const one = waiting[0];
  if (!one) return { ok: false, why: "Nothing is playing" };
  try {
    await one.play();
  } catch {
    return { ok: false, why: "Couldn't play" };
  }
  return one.paused ? { ok: false, why: "Couldn't play" } : { ok: true, did: "played" };
})()`;

// The same search, for what's playing in full. It leaves out a video that
// loops with no sound, which is a background and not something to steer.
// pick is the one that plays, or else the one that was playing last, the
// biggest on the screen. read is where it is, as the page says it, with the
// page's own clock for when.
const NOW = `${MEDIA}
  const real = () => media().filter((m) => !(m.loop && m.muted));
  const area = (m) => {
    const box = m.getBoundingClientRect();
    return m.tagName === "VIDEO" ? box.width * box.height : 0;
  };
  const going = (m) => !m.paused && !m.ended;
  const pick = (all) => [...all].sort((a, b) => going(b) - going(a) || (b.currentTime > 0) - (a.currentTime > 0) || area(b) - area(a))[0] ?? null;
  const read = (one) => {
    const duration = Number.isFinite(one.duration) && one.duration > 0 ? one.duration : null;
    const said = navigator.mediaSession ? navigator.mediaSession.metadata : null;
    return {
      title: String((said && said.title) || one.getAttribute("aria-label") || one.getAttribute("title") || document.title || "").slice(0, 300),
      position: one.currentTime,
      duration,
      playing: going(one),
      seek: duration !== null && one.seekable.length > 0,
      at: Date.now(),
    };
  };
`;

// An expression for a page: where what plays in it is, or null with nothing
// to play.
export const MEDIA_NOW = `(() => {${NOW}
  const one = pick(real());
  return one ? read(one) : null;
})()`;

const CANT_JUMP = "This app can't jump to a time";
const CANT_GO_BACK = "This app can't go back";

// An expression for a page: what plays is paused, or what was playing last
// plays. Either leaves it alone when it's already so.
export function mediaSet(want: "playing" | "paused"): string {
  return `(async () => {${NOW}
  const all = real();
  if (all.length === 0) return { ok: false, why: "Nothing is playing" };
  const playing = all.filter(going);
  if (${want === "paused"}) {
    for (const m of playing) m.pause();
    return all.some(going) ? { ok: false, why: "Couldn't pause" } : { ok: true };
  }
  if (playing.length > 0) return { ok: true };
  const one = pick(all);
  try {
    await one.play();
  } catch {
    return { ok: false, why: "Couldn't play" };
  }
  return one.paused ? { ok: false, why: "Couldn't play" } : { ok: true };
})()`;
}

// An expression for a page: what plays jumps to a place in seconds, or by
// so many seconds from where it is, kept inside its length. It answers once
// the element says it's there.
export function mediaSeek(jump: { to: number } | { by: number }): string {
  return `(async () => {${NOW}
  const one = pick(real());
  if (!one) return { ok: false, why: "Nothing is playing" };
  const jump = ${JSON.stringify(jump)};
  if (!Number.isFinite(one.duration) || one.seekable.length === 0) return { ok: false, why: ${JSON.stringify(CANT_JUMP)} };
  const to = Math.max(0, Math.min(one.duration, "to" in jump ? jump.to : one.currentTime + jump.by));
  await new Promise((done) => {
    const timer = setTimeout(done, 1500);
    one.addEventListener("seeked", () => (clearTimeout(timer), done()), { once: true });
    one.currentTime = to;
  });
  return one.currentTime > to - 1 && one.currentTime < to + 3 ? { ok: true } : { ok: false, why: "Couldn't jump there" };
})()`;
}

// What a page says about what plays in it (MEDIA_NOW).
interface PageNow {
  title: string;
  position: number;
  duration: number | null;
  playing: boolean;
  seek: boolean;
  at: number;
}

// Where what's playing is, as the screen daemon reads it for the daemon.
export interface PlayingNow {
  // Who said so: the app's own playback, Music among them, or the page's
  // video.
  by: "app" | "page";
  // The app it's in, or "home" for home's own player.
  id: string;
  title: string;
  position: number; // seconds
  duration: number | null; // seconds; null for something live
  playing: boolean;
  at: number; // when position was read, in ms since 1970
  // What can be asked of it now.
  next: boolean;
  previous: boolean;
  seek: boolean;
  // A picture the app gave for it: an address on its own origins.
  picture?: string;
  // The TV session holds a picture for it, as Music holds an album's cover.
  cover?: boolean;
}

// Every request the daemon makes for a phone about what plays.
export type PlaybackAction = "toggle" | "next" | "play" | "pause" | "previous" | "seek" | "now" | "picture";

export interface PlaybackAsk {
  action: PlaybackAction;
  // Where to jump to, in seconds, for seek.
  position?: number;
  // Answer with where the thing then is, too.
  now?: boolean;
}

export type PlayAnswer = TextAnswer & { now?: PlayingNow | null; picture?: string };

// What's in front for play and pause, from the screen daemon. app calls the
// app's own playback (its worker, through PlaybackWatch); it throws when the
// app has no such call. has says whether the app's module has one of the
// calls it may leave out, such as playback.previous. last is what the app's
// last read for the ledger gave, and when.
export type PlaybackFront =
  | {
      kind: "page";
      id: string;
      evaluate(expression: string): Promise<unknown>;
      app?: (path: string, ...args: unknown[]) => Promise<unknown>;
      has?: (path: string) => Promise<boolean>;
      last?: () => { state: PlaybackState; at: number } | null;
    }
  | { kind: "home"; evaluate(expression: string): Promise<unknown>; music?: (request: Record<string, unknown>) => Promise<object> }
  | { kind: "native"; id: string }
  | null;

export interface PhonePlaybackOptions {
  front(): PlaybackFront;
  // A request for the virtual input device: {"key": "playpause"}.
  keys(request: Record<string, unknown>): Promise<void>;
  // How long a page or an app has to answer.
  ms?: number;
}

const NOTHING: TextAnswer = { ok: false, why: "Nothing is playing" };
// How long an app has to say where its player is, for what's playing, and
// how long its last read for the ledger stands in for a new one.
const APP_READ_MS = 4000;
const LAST_READ_MS = 15_000;

export class PhonePlayback {
  private o: PhonePlaybackOptions;
  // When something was last asked of the player.
  private acted = 0;

  constructor(options: PhonePlaybackOptions) {
    this.o = options;
  }

  private within<T>(work: Promise<T>, ms = this.o.ms ?? 2000): Promise<T | null> {
    return Promise.race([work.catch(() => null), new Promise<null>((done) => setTimeout(() => done(null), ms))]);
  }

  async toggle(): Promise<TextAnswer> {
    const front = this.o.front();
    if (!front) return NOTHING;
    if (front.kind === "native") return this.key("playpause");
    if (front.kind === "home") return this.home(front);
    const state = (await this.within(front.evaluate(MEDIA_STATE))) as { playing?: boolean; any?: boolean } | null;
    // The app's own pause and resume come first, when it has them. Whether
    // it plays is the page's to say, or the app's when the page can't see
    // its player.
    if (front.app) {
      let playing = state?.playing === true;
      if (!state?.any) {
        const read = (await this.within(front.app("playback.readPlaybackState"))) as { playing?: boolean } | null;
        playing = read?.playing === true;
      }
      const done = await this.within(
        front.app(playing ? "playback.pause" : "playback.resume").then(
          () => true,
          () => false,
        ),
        10_000,
      );
      if (done) return { ok: true, by: "app" };
    }
    if (!state?.any) return NOTHING;
    return this.page(front.evaluate);
  }

  async next(): Promise<TextAnswer> {
    const front = this.o.front();
    if (!front) return NOTHING;
    if (front.kind === "native") return this.key("next");
    if (front.kind === "home") {
      const now = await this.musicNow(front);
      if (!now) return { ok: false, why: "Nothing is playing" };
      const done = (await this.within(front.music!({ op: "next" }))) as { ok?: boolean } | null;
      return done?.ok ? { ok: true, by: "app" } : { ok: false, why: "Couldn't play music" };
    }
    if (front.app) {
      const done = await this.within(
        front.app("playback.next").then(
          () => true,
          () => false,
        ),
        10_000,
      );
      if (done) return { ok: true, by: "app" };
    }
    return { ok: false, why: "This app can't skip" };
  }

  // --- What's playing, in full (the playing2 switch) ----------------------

  // One request from the daemon: what it asks, and with now, where the
  // thing then is.
  async answer(ask: PlaybackAsk): Promise<PlayAnswer> {
    if (ask.action === "now") return { ok: true, now: await this.now() };
    if (ask.action === "picture") return this.picture();
    // What an app's last read said from before this is out of date now.
    this.acted = Date.now();
    const did =
      ask.action === "toggle"
        ? await this.toggle()
        : ask.action === "next"
          ? await this.next()
          : ask.action === "previous"
            ? await this.previous()
            : ask.action === "seek"
              ? await this.seek(ask.position)
              : await this.set(ask.action === "pause" ? "paused" : "playing");
    return ask.now ? { ...did, now: await this.now() } : did;
  }

  // Play, or pause, as two requests: each leaves what's already so as it
  // is, so one sent twice does nothing the second time. A native app only
  // has the one key for both, which can't say which way it went.
  async set(want: "playing" | "paused"): Promise<TextAnswer> {
    const front = this.o.front();
    if (!front) return NOTHING;
    if (front.kind === "native") return { ok: false, why: "This app can't do that" };
    if (front.kind === "home") {
      const state = await this.pageNow(front.evaluate);
      if (state?.playing) return this.pageSet(front.evaluate, want);
      if (await this.musicNow(front)) {
        const done = (await this.within(front.music!({ op: "pause", on: want === "paused" }))) as { ok?: boolean } | null;
        return done?.ok ? { ok: true, by: "app" } : { ok: false, why: "Couldn't play music" };
      }
      return state ? this.pageSet(front.evaluate, want) : NOTHING;
    }
    // The app's own pause and resume leave a player that's already so as
    // it is, by the contract.
    if (front.app) {
      const done = await this.within(
        front.app(want === "paused" ? "playback.pause" : "playback.resume").then(
          () => true,
          () => false,
        ),
        10_000,
      );
      if (done) return { ok: true, by: "app" };
    }
    return this.pageSet(front.evaluate, want);
  }

  // The one before: the app's own previous, Music's, or the key.
  async previous(): Promise<TextAnswer> {
    const front = this.o.front();
    if (!front) return NOTHING;
    if (front.kind === "native") return this.key("previous");
    if (front.kind === "home") {
      if (!(await this.musicNow(front))) return { ok: false, why: CANT_GO_BACK };
      const done = (await this.within(front.music!({ op: "previous" }))) as { ok?: boolean } | null;
      return done?.ok ? { ok: true, by: "app" } : { ok: false, why: "Couldn't play music" };
    }
    if (front.app) {
      const done = await this.within(
        front.app("playback.previous").then(
          () => true,
          () => false,
        ),
        10_000,
      );
      if (done) return { ok: true, by: "app" };
    }
    return { ok: false, why: CANT_GO_BACK };
  }

  // A jump to a place, in seconds from the start: the app's own seek, or
  // the page's video. An app's place isn't always its video's clock, so
  // with no seek of its own the video jumps by as far as the place is from
  // where the app says it is now.
  async seek(position: unknown): Promise<TextAnswer> {
    if (typeof position !== "number" || !Number.isFinite(position) || position < 0) return { ok: false, why: "Couldn't jump there" };
    const front = this.o.front();
    if (!front) return NOTHING;
    if (front.kind === "native") return { ok: false, why: CANT_JUMP };
    if (front.kind === "home") {
      const state = await this.pageNow(front.evaluate);
      if (state?.playing) return this.pageSeek(front.evaluate, { to: position });
      if (await this.musicNow(front)) return { ok: false, why: CANT_JUMP };
      return state ? this.pageSeek(front.evaluate, { to: position }) : NOTHING;
    }
    if (front.app) {
      const done = await this.within(
        front.app("playback.seek", position).then(
          () => true,
          () => false,
        ),
        10_000,
      );
      if (done) return { ok: true, by: "app" };
      const read = (await this.within(front.app("playback.readPlaybackState"), APP_READ_MS)) as PlaybackState | null;
      if (read && typeof read.position === "number" && Number.isFinite(read.position)) return this.pageSeek(front.evaluate, { by: position - read.position });
    }
    return this.pageSeek(front.evaluate, { to: position });
  }

  // Where what's playing is, or null with nothing to steer: the app's own
  // word first, then the page's video. A native app's can't be seen.
  async now(): Promise<PlayingNow | null> {
    const front = this.o.front();
    if (!front || front.kind === "native") return null;
    if (front.kind === "home") {
      const state = await this.pageNow(front.evaluate);
      if (state?.playing) return { by: "page", id: "home", ...state, next: false, previous: false };
      return (await this.musicFull(front)) ?? (state ? { by: "page", id: "home", ...state, next: false, previous: false } : null);
    }
    const state = await this.pageNow(front.evaluate);
    if (front.app) {
      // The app is read every 10 s for the ledger already. That reading
      // does while it's fresh and nothing was asked of the player since,
      // so looking again and again doesn't read the app twice as often.
      const kept = front.last?.() ?? null;
      const fresh = kept && kept.at > this.acted && Date.now() - kept.at < LAST_READ_MS ? kept : null;
      const read = fresh ? fresh.state : ((await this.within(front.app("playback.readPlaybackState"), APP_READ_MS)) as PlaybackState | null);
      const at = fresh ? fresh.at : Date.now();
      if (read && typeof read.title === "string" && read.title.trim() && typeof read.position === "number" && read.position >= 0) {
        const has = async (path: string) => (front.has ? (await this.within(front.has(path))) === true : false);
        const [next, previous, seek] = await Promise.all([has("playback.next"), has("playback.previous"), has("playback.seek")]);
        const duration = typeof read.duration === "number" && Number.isFinite(read.duration) && read.duration > 0 ? read.duration : null;
        return {
          by: "app",
          id: front.id,
          title: read.title.slice(0, 300),
          position: read.position,
          duration,
          // A reading from a few seconds back can't know about a pause
          // since. The page's video can, when the page can see it.
          playing: fresh && state ? state.playing : read.playing === true,
          at,
          next: next && read.hasNext !== false,
          previous: previous && read.hasPrevious !== false,
          seek: duration !== null && (seek || state?.seek === true),
          ...(typeof read.picture === "string" && read.picture.length <= 2000 ? { picture: read.picture } : {}),
        };
      }
    }
    return state ? { by: "page", id: front.id, ...state, next: false, previous: false } : null;
  }

  // The picture the TV session holds for what's playing, as a data: address.
  // Today that's the cover of the album Music plays.
  async picture(): Promise<PlayAnswer> {
    const front = this.o.front();
    if (front?.kind !== "home" || !front.music) return { ok: false };
    const said = (await this.within(front.music({ op: "now" }))) as { now?: { albumId?: string | null } | null } | null;
    const album = said?.now?.albumId;
    if (!album) return { ok: false };
    const found = (await this.within(front.music({ op: "cover", key: album }))) as { cover?: string | null } | null;
    return typeof found?.cover === "string" ? { ok: true, picture: found.cover } : { ok: false };
  }

  private async pageNow(evaluate: (expression: string) => Promise<unknown>): Promise<PageNow | null> {
    const said = (await this.within(evaluate(MEDIA_NOW))) as Partial<PageNow> | null;
    if (!said || typeof said.position !== "number" || typeof said.at !== "number") return null;
    return {
      title: typeof said.title === "string" ? said.title : "",
      position: said.position,
      duration: typeof said.duration === "number" ? said.duration : null,
      playing: said.playing === true,
      seek: said.seek === true,
      at: said.at,
    };
  }

  // What Music plays, with whether its queue has one after and one before.
  // Music has no jump yet.
  private async musicFull(front: Extract<PlaybackFront, { kind: "home" }>): Promise<PlayingNow | null> {
    if (!front.music) return null;
    const said = (await this.within(front.music({ op: "now" }))) as { now?: Record<string, unknown> | null } | null;
    const now = said?.now;
    if (!now || typeof now.title !== "string") return null;
    const index = Number(now.index) || 0;
    return {
      by: "app",
      id: MUSIC,
      title: now.title.slice(0, 300),
      position: typeof now.position === "number" && now.position >= 0 ? now.position : 0,
      duration: typeof now.duration === "number" && now.duration > 0 ? now.duration : null,
      playing: now.playing === true,
      at: Date.now(),
      next: index + 1 < (Number(now.count) || 0),
      previous: index > 0,
      seek: false,
      ...(typeof now.albumId === "string" && now.albumId ? { cover: true } : {}),
    };
  }

  private async pageSet(evaluate: (expression: string) => Promise<unknown>, want: "playing" | "paused"): Promise<TextAnswer> {
    return this.pageDid((await this.within(evaluate(mediaSet(want)))) as { ok?: boolean; why?: string } | null);
  }

  private async pageSeek(evaluate: (expression: string) => Promise<unknown>, jump: { to: number } | { by: number }): Promise<TextAnswer> {
    return this.pageDid((await this.within(evaluate(mediaSeek(jump)), 4000)) as { ok?: boolean; why?: string } | null);
  }

  private pageDid(did: { ok?: boolean; why?: string } | null): TextAnswer {
    if (!did) return { ok: false, why: NOT_READY };
    if (did.ok) return { ok: true, by: "page" };
    if (did.why === NOTHING.why) return NOTHING;
    return { ok: false, by: "page", why: typeof did.why === "string" ? did.why.slice(0, 120) : "Something went wrong" };
  }

  // Home's own player, a shared video (ADR-050), then Music.
  private async home(front: Extract<PlaybackFront, { kind: "home" }>): Promise<TextAnswer> {
    const state = (await this.within(front.evaluate(MEDIA_STATE))) as { playing?: boolean; any?: boolean } | null;
    if (state?.playing) return this.page(front.evaluate);
    const now = await this.musicNow(front);
    if (now) {
      const done = (await this.within(front.music!({ op: "pause", on: now.playing }))) as { ok?: boolean } | null;
      return done?.ok ? { ok: true, by: "app" } : { ok: false, why: "Couldn't play music" };
    }
    if (state?.any) return this.page(front.evaluate);
    return NOTHING;
  }

  private async musicNow(front: Extract<PlaybackFront, { kind: "home" }>): Promise<{ playing: boolean } | null> {
    if (!front.music) return null;
    const said = (await this.within(front.music({ op: "now" }))) as { now?: { playing?: boolean } | null } | null;
    return said?.now ? { playing: said.now.playing === true } : null;
  }

  private async page(evaluate: (expression: string) => Promise<unknown>): Promise<TextAnswer> {
    const did = (await this.within(evaluate(MEDIA_TOGGLE))) as { ok?: boolean; why?: string } | null;
    if (!did) return { ok: false, why: NOT_READY };
    return did.ok ? { ok: true, by: "page" } : { ok: false, by: "page", why: typeof did.why === "string" ? did.why.slice(0, 120) : "Something went wrong" };
  }

  private async key(name: string): Promise<TextAnswer> {
    try {
      await this.o.keys({ key: name });
      return { ok: true, by: "key" };
    } catch {
      return { ok: false, why: "Couldn't reach your TV" };
    }
  }
}
