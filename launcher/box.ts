// The box check on the TV's pages (ADR-061): what GET /api/box says, the
// feature switch it's behind, and the 4K test.
//
// The test draws a scene like home's busiest, at the TV's full resolution:
// a pixel field redrawn every frame, a 4 × 3 grid of tiles whose focus moves
// with its grow and lift, and a frosted bar blurring what's under it. It
// counts the frames for five seconds after a short warm-up, and the daemon
// keeps the result with the GPU it ran on. It's drawn faintly, under the
// screen's own text, so setup's box step reads normally while it runs.

import { h } from "./dom.ts";
import type { BoxReport } from "./box-lines.ts";

export type { BoxReport };

export interface SmoothRun {
  width: number;
  height: number;
  fps: number;
  slow: number;
}

export interface SmoothState {
  gpu: string;
  needed: boolean;
  passed: boolean;
  result: (SmoothRun & { gpu: string; at: string }) | null;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} didn't answer`);
  return (await response.json()) as T;
}

// The box check's styles, once, on whichever page asks.
export function boxStyles(): void {
  if (document.querySelector('link[href="/launcher/box.css"]')) return;
  document.head.append(h("link", { rel: "stylesheet", href: "/launcher/box.css" }));
}

export const box = {
  report: () => get<BoxReport>("/api/box"),
  smooth: () => get<SmoothState>("/api/box/smooth"),
  // Whether the box check shows yet: its feature switch.
  on: async () => (await get<Record<string, boolean>>("/api/features").catch(() => ({}) as Record<string, boolean>)).boxcheck === true,
  async saveSmooth(run: SmoothRun): Promise<SmoothState> {
    const response = await fetch("/api/box/smooth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(run) });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error ?? "the 4k test's result wasn't kept");
    return data as SmoothState;
  },
};

// Whether this page is drawn at 4K now. The test means something only then:
// on a 4K TV the box shows at 1080p, it waits.
export function drawsFourK(): boolean {
  return Math.round(innerWidth * devicePixelRatio) >= 3840;
}

// How long the test counts, and how long it draws first so the GPU warms up.
export const SMOOTH_MS = 5000;
const WARM_MS = 500;
// A frame later than this is late.
const LATE_MS = 25;

export interface SmoothOptions {
  // Where the scene goes: the screen it runs on.
  host: HTMLElement;
  // How faint the scene is, from 0 to 1. The work is the same either way.
  opacity?: number;
  ms?: number;
  // Asked every frame; false stops the test, which then gives null.
  keepGoing?: () => boolean;
  // In front of everything, with this line over it, as Settings runs it.
  front?: string;
}

// The scene the test draws: the field, the tiles and the bar.
function scene(opacity: number, front?: string): { el: HTMLElement; frame: (t: number) => void } {
  const width = Math.round(innerWidth * devicePixelRatio);
  const height = Math.round(innerHeight * devicePixelRatio);
  const canvas = h("canvas", { class: "box-test-field", width, height });
  // Set through the style object: the pages' policy refuses style attributes.
  const tiles = Array.from({ length: 12 }, (_, i) => {
    const tile = h("div", { class: "box-test-tile" });
    tile.style.setProperty("--i", String(i));
    return tile;
  });
  const el = h("div", { class: "box-test", "aria-hidden": "true" }, canvas, h("div", { class: "box-test-grid" }, ...tiles), h("div", { class: "box-test-bar" }));
  el.style.opacity = String(opacity);
  if (front) {
    el.classList.add("front");
    el.append(h("div", { class: "box-test-say" }, front));
  }
  const draw = canvas.getContext("2d")!;
  const style = getComputedStyle(document.documentElement);
  const shades = ["--accent", "--blue", "--magenta", "--cyan"].map((name) => style.getPropertyValue(name).trim() || "#7aa2f7");
  const cell = Math.max(8, Math.round(width / 80));
  let focused = -1;
  const frame = (t: number) => {
    draw.clearRect(0, 0, width, height);
    for (let y = 0; y < height; y += cell) {
      for (let x = (y / cell) % 2 ? 0 : cell; x < width; x += cell * 2) {
        const wave = Math.sin(x / 97 + y / 61 + t / 180);
        if (wave < 0.2) continue;
        draw.fillStyle = shades[(x + y) % 4];
        draw.globalAlpha = wave;
        draw.fillRect(x, y, cell - 2, cell - 2);
      }
    }
    draw.globalAlpha = 1;
    const next = Math.floor(t / 250) % tiles.length;
    if (next !== focused) {
      tiles[focused]?.classList.remove("focused");
      tiles[next].classList.add("focused");
      focused = next;
    }
  };
  return { el, frame };
}

// Runs the test, and gives what it counted, or null when it was stopped.
export function measureSmooth(options: SmoothOptions): Promise<SmoothRun | null> {
  const total = options.ms ?? SMOOTH_MS;
  const { el, frame } = scene(options.opacity ?? 1, options.front);
  options.host.append(el);
  const width = Math.round(innerWidth * devicePixelRatio);
  const height = Math.round(innerHeight * devicePixelRatio);
  return new Promise((resolve) => {
    let started = -1;
    const times: number[] = [];
    const step = (t: number) => {
      if (started < 0) started = t;
      if (options.keepGoing && !options.keepGoing()) {
        el.remove();
        resolve(null);
        return;
      }
      frame(t - started);
      if (t - started >= WARM_MS) times.push(t);
      if (t - started < WARM_MS + total) {
        requestAnimationFrame(step);
        return;
      }
      el.remove();
      const gaps = times.slice(1).map((time, i) => time - times[i]);
      const seconds = (times[times.length - 1] - times[0]) / 1000;
      resolve({
        width,
        height,
        fps: seconds > 0 ? Math.round(((times.length - 1) / seconds) * 10) / 10 : 0,
        slow: gaps.length ? Math.round((gaps.filter((gap) => gap > LATE_MS).length / gaps.length) * 1000) / 1000 : 1,
      });
    };
    requestAnimationFrame(step);
  });
}

// The test, run and kept: the daemon's answer, or null when it was stopped
// or the result couldn't be kept.
export async function checkSmooth(options: SmoothOptions): Promise<SmoothState | null> {
  const run = await measureSmooth(options);
  if (!run) return null;
  return box.saveSmooth(run).catch(() => null);
}

// After a new GPU, the test runs again by itself: on the ambient screen,
// when nobody's watching, once, and only when the switch is on and the TV is
// 4K. Any key ends the ambient screen and stops it.
let ambientRun = false;
export async function checkWhileAmbient(host: HTMLElement, ambient: () => boolean): Promise<void> {
  if (ambientRun) return;
  ambientRun = true;
  try {
    if (!drawsFourK() || !(await box.on()) || !(await box.smooth()).needed || !ambient()) return;
    await checkSmooth({ host, opacity: 0.25, keepGoing: ambient });
  } catch {
    // The daemon will ask again after the next start.
  } finally {
    ambientRun = false;
  }
}
