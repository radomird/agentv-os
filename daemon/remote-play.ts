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
    return playing.every((m) => m.paused) ? { ok: true, did: "paused" } : { ok: false, why: "the player didn't pause" };
  }
  const area = (m) => {
    const box = m.getBoundingClientRect();
    return m.tagName === "VIDEO" ? box.width * box.height : 0;
  };
  const waiting = all.filter((m) => !m.ended).sort((a, b) => (b.currentTime > 0) - (a.currentTime > 0) || area(b) - area(a));
  const one = waiting[0];
  if (!one) return { ok: false, why: "nothing is playing" };
  try {
    await one.play();
  } catch {
    return { ok: false, why: "the player wouldn't play" };
  }
  return one.paused ? { ok: false, why: "the player wouldn't play" } : { ok: true, did: "played" };
})()`;

// What's in front for play and pause, from the screen daemon. app calls the
// app's own playback (its worker, through PlaybackWatch); it throws when the
// app has no such call.
export type PlaybackFront =
  | { kind: "page"; id: string; evaluate(expression: string): Promise<unknown>; app?: (path: string) => Promise<unknown> }
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

const NOTHING: TextAnswer = { ok: false, why: "nothing is playing" };

export class PhonePlayback {
  private o: PhonePlaybackOptions;

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
      if (!now) return { ok: false, why: "nothing is playing" };
      const done = (await this.within(front.music!({ op: "next" }))) as { ok?: boolean } | null;
      return done?.ok ? { ok: true, by: "app" } : { ok: false, why: "music didn't go on" };
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
    return { ok: false, why: "this app has no next" };
  }

  // Home's own player, a shared video (ADR-050), then Music.
  private async home(front: Extract<PlaybackFront, { kind: "home" }>): Promise<TextAnswer> {
    const state = (await this.within(front.evaluate(MEDIA_STATE))) as { playing?: boolean; any?: boolean } | null;
    if (state?.playing) return this.page(front.evaluate);
    const now = await this.musicNow(front);
    if (now) {
      const done = (await this.within(front.music!({ op: "pause", on: now.playing }))) as { ok?: boolean } | null;
      return done?.ok ? { ok: true, by: "app" } : { ok: false, why: "music didn't answer" };
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
    if (!did) return { ok: false, why: "the tv's page didn't answer" };
    return did.ok ? { ok: true, by: "page" } : { ok: false, by: "page", why: typeof did.why === "string" ? did.why.slice(0, 120) : "the player didn't answer" };
  }

  private async key(name: string): Promise<TextAnswer> {
    try {
      await this.o.keys({ key: name });
      return { ok: true, by: "key" };
    } catch {
      return { ok: false, why: "the key didn't reach the tv" };
    }
  }
}
