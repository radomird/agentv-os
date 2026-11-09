// What's behind home and on the ambient screen (ADR-012, ADR-048, ADR-064):
// the still of the background on show, the theme's own or a photo or work,
// and with the dynamicbg switch on, Omarchy's moving ones over it:
//   - a video background, which loops, muted;
//   - a picture's theme intro, once when the TV session starts and once after
//     the theme changes, which ends on its still.
//
// They play only where the box decodes the video's codec in hardware, as its
// check says (GET /api/box), and show the still otherwise. They pause while an
// app is in front or another page covers home, and stay still with reduce
// motion or Omarchy's intros switch off.

import { daemon, shownCurrent, type Background, type Backgrounds, type Box } from "./api.ts";
import { h } from "./dom.ts";

export interface BackdropState {
  backgrounds: Backgrounds | null;
  // The dynamicbg switch.
  dynamic: boolean;
  reduceMotion: boolean;
  // The codecs the box decodes in hardware, or null before its check.
  decode: string[] | null;
}

// Why something that could move stays still, or null when it can move.
export function stillBecause(state: BackdropState, codec: string | null | undefined): string | null {
  if (state.reduceMotion) return "reduce-motion";
  if (state.backgrounds?.theme?.intros === false) return "intros-off";
  if (state.backgrounds?.softwareVideo) return null;
  if (!codec || !state.decode?.includes(codec)) return "no-hardware";
  return null;
}

// The background on show, and what moves over it: its loop, its intro while
// one is due and not yet shown, or nothing. A video that wouldn't play is
// left out from then on.
export function plan(
  state: BackdropState,
  shown: string | null = null,
  broken: ReadonlySet<string> = new Set(),
): { item: Background | null; still: string | null; loop: string | null; intro: { src: string; due: string } | null; why: string | null } {
  const item = shownCurrent(state.backgrounds, state.dynamic) ?? null;
  if (!item) return { item, still: null, loop: null, intro: null, why: null };
  const still = item.poster ?? `/api/backgrounds/${item.id}`;
  if (!state.dynamic) return { item, still, loop: null, intro: null, why: null };
  if (item.media === "video" && item.video) {
    const why = broken.has(item.video) ? "error" : stillBecause(state, item.codec);
    return { item, still, loop: why ? null : item.video, intro: null, why };
  }
  const theme = state.backgrounds?.theme;
  const due = theme?.introDue;
  if (item.intro && due && theme?.introShown?.due !== due && shown !== due) {
    const why = broken.has(item.intro) ? "error" : stillBecause(state, item.introCodec);
    return { item, still, loop: null, intro: why ? null : { src: item.intro, due }, why };
  }
  return { item, still, loop: null, intro: null, why: null };
}

// How long an intro may take to start before the still shows instead.
const INTRO_START_MS = 5000;

// A looping video background, muted, with its still until it plays.
function loopVideo(src: string, still: string, className: string): HTMLVideoElement {
  const video = h("video", { class: className, src, poster: still, muted: true, loop: true, autoplay: true, playsinline: true, preload: "auto", "aria-hidden": "true" });
  video.muted = true;
  return video;
}

// A background for the ambient screen: its video, where it can move, or its
// still, and the event that says it's ready to fade in.
export function ambientMedia(state: BackdropState, item: Background): { el: HTMLElement; ready: string } {
  const still = item.poster ?? `/api/backgrounds/${item.id}`;
  if (state.dynamic && item.media === "video" && item.video && !stillBecause(state, item.codec)) return { el: loopVideo(item.video, still, "ambient-picture ambient-video"), ready: "loadeddata" };
  return { el: h("img", { class: "ambient-picture", src: still, alt: "" }), ready: "load" };
}

export class Backdrop {
  readonly el: HTMLElement;
  state: BackdropState = { backgrounds: null, dynamic: false, reduceMotion: false, decode: null };
  // Home's window is in front of the TV, home's own page is up, and the
  // ambient screen isn't over it.
  private front = true;
  private onHome = false;
  private ambient = false;
  private moving: { el: HTMLVideoElement; kind: "loop" | "intro"; src: string; due?: string } | null = null;
  // The system's reduce motion, as well as Settings' (ADR-024).
  private reduced = matchMedia("(prefers-reduced-motion: reduce)");
  // The intro home dealt with last, before the daemon says so, and the
  // videos that wouldn't play.
  private shown: string | null = null;
  private broken = new Set<string>();

  constructor(el: HTMLElement) {
    this.el = el;
    this.onHome = document.body.classList.contains("on-home");
    // Home's page is up when the body says so, whichever page changed it.
    new MutationObserver(() => {
      const on = document.body.classList.contains("on-home");
      if (on !== this.onHome) {
        this.onHome = on;
        this.draw();
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", () => this.draw());
    this.reduced.addEventListener("change", () => this.draw());
  }

  // The switch and the box check, once home starts, and the switch again
  // when it changes.
  async start(): Promise<void> {
    const [features, box] = await Promise.all([daemon.features().catch(() => null), daemon.box()]);
    this.state.dynamic = features?.dynamicbg === true;
    this.state.decode = boxDecode(box);
    this.draw();
  }

  async features(): Promise<void> {
    this.state.dynamic = (await daemon.features().catch(() => null))?.dynamicbg === true;
    this.draw();
  }

  update(change: Partial<BackdropState>): void {
    Object.assign(this.state, change);
    this.draw();
  }

  // An app came in front of home, or home is in front again (the screen
  // daemon says so).
  setFront(front: boolean): void {
    this.front = front;
    this.draw();
  }

  setAmbient(on: boolean): void {
    this.ambient = on;
    this.draw();
  }

  // What decides what moves, the system's reduce motion included.
  now(): BackdropState {
    return { ...this.state, reduceMotion: this.state.reduceMotion || this.reduced.matches };
  }

  private visible(): boolean {
    return this.front && this.onHome && !this.ambient && document.visibilityState !== "hidden";
  }

  // What's there now, for the checks.
  status(): { id: string | null; moving: "loop" | "intro" | null; playing: boolean } {
    const id = this.el.querySelector<HTMLElement>("img.backdrop-picture")?.dataset.id ?? null;
    return { id, moving: this.moving?.kind ?? null, playing: Boolean(this.moving && !this.moving.el.paused && !this.moving.el.ended) };
  }

  draw(): void {
    const next = plan(this.now(), this.shown, this.broken);
    const item = next.item;
    document.body.classList.toggle("with-backdrop", Boolean(item));
    if (!item || !next.still) {
      this.stopMoving();
      this.el.replaceChildren();
      return;
    }
    let img = this.el.querySelector<HTMLImageElement>("img.backdrop-picture");
    if (!img || img.dataset.id !== item.id) {
      this.stopMoving();
      img = h("img", { class: "backdrop-picture", src: next.still, alt: "", "data-id": item.id });
      this.el.replaceChildren(img);
    } else if (img.getAttribute("src") !== next.still) {
      img.src = next.still;
    }

    // An intro plays only where it's seen. One that's due while it can't
    // move is shown as its still, and the daemon hears why.
    if (this.moving?.kind === "intro") {
      if (!this.visible()) this.endIntro();
      return;
    }
    if (next.loop) {
      if (this.moving?.src !== next.loop) {
        this.stopMoving();
        const el = loopVideo(next.loop, next.still, "backdrop-picture backdrop-video");
        Object.assign(el.style, { position: "absolute", inset: "0" });
        el.addEventListener("error", () => this.failed(el));
        this.moving = { el, kind: "loop", src: next.loop };
        img.after(el);
      }
      if (this.visible()) void this.moving.el.play().catch(() => {});
      else this.moving.el.pause();
      return;
    }
    this.stopMoving();
    const due = this.state.backgrounds?.theme?.introDue;
    if (!this.visible() || !due) return;
    if (next.intro) this.playIntro(img, next.intro.src, next.intro.due);
    else if (next.why && item.intro && this.shown !== due && this.state.backgrounds?.theme?.introShown?.due !== due) this.report(due, "still", next.why);
  }

  // The intro once, muted, over its still, which shows again as it ends. The
  // intro's last frame is the still, so the still waits hidden under it,
  // rather than show before its first frame. It counts as shown once it
  // starts, so an app opened over it doesn't bring it back later.
  private playIntro(img: HTMLImageElement, src: string, due: string): void {
    this.report(due, "played");
    const el = h("video", { class: "backdrop-picture backdrop-video backdrop-intro", src, muted: true, autoplay: true, playsinline: true, preload: "auto", "aria-hidden": "true" });
    el.muted = true;
    Object.assign(el.style, { position: "absolute", inset: "0" });
    img.style.opacity = "0";
    this.moving = { el, kind: "intro", src, due };
    const slow = setTimeout(() => {
      if (this.moving?.el !== el || !el.paused) return;
      this.broken.add(src);
      this.report(due, "still", "slow");
      this.endIntro();
    }, INTRO_START_MS);
    el.addEventListener("playing", () => clearTimeout(slow), { once: true });
    el.addEventListener("ended", () => this.endIntro());
    el.addEventListener("error", () => {
      clearTimeout(slow);
      if (this.moving?.el !== el) return;
      this.broken.add(src);
      this.report(due, "still", "error");
      this.endIntro();
    });
    img.after(el);
    void el.play().catch(() => {});
  }

  private endIntro(): void {
    const img = this.el.querySelector<HTMLImageElement>("img.backdrop-picture");
    if (img) img.style.opacity = "";
    this.stopMoving();
    this.draw();
  }

  // A video that won't play shows its still from then on.
  private failed(el: HTMLVideoElement): void {
    if (this.moving?.el !== el) return;
    this.broken.add(this.moving.src);
    this.stopMoving();
  }

  private stopMoving(): void {
    if (!this.moving) return;
    const { el } = this.moving;
    this.moving = null;
    el.pause();
    el.removeAttribute("src");
    el.load();
    el.remove();
  }

  // What home did with the intro that's due, for the daemon. An intro that
  // started and then wouldn't play says so too.
  private report(due: string, how: "played" | "still", why?: string): void {
    if (this.shown === due && !why) return;
    this.shown = due;
    void daemon.introShown(due, how, why).catch(() => {});
  }
}

// The codecs the box check says the GPU decodes, or null without one.
export function boxDecode(box: Box | null): string[] | null {
  const decode = box?.gpu?.decode;
  return Array.isArray(decode) ? decode.filter((codec): codec is string => typeof codec === "string").map((codec) => codec.toLowerCase()) : null;
}
