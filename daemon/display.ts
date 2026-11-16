// The TV's resolution and its three sizes (ADR-062).
//
// The TV runs at its own full resolution, and the daemon picks the mode and
// the scale itself instead of Hyprland's "preferred" and "auto". There are
// three sizes, each a logical canvas: larger is 1600 pixels wide, standard
// 1920 and more on screen 2400. The scale is the output's width over the
// canvas, so a 4K TV at standard runs at scale 2. Hyprland's scale moves
// everything on the TV at once: home, the services' pages, the toasts and
// overlays, and Steam's gamescope.
//
// Two halves:
//   - Display, in OrigaiTV's daemon, keeps what was picked in display.json in
//     the daemon's state, with the TV the screen daemon last saw, and says
//     what the TV should run at (GET and PUT /api/display, routes/display.ts).
//   - DisplayWatch, in the screen daemon, which runs as the person in the TV
//     session and holds Hyprland: it tells the daemon what the TV offers,
//     applies the mode and scale the daemon says with `hyprctl eval`, and
//     keeps the last one applied for session/hypr.lua, so the next session
//     starts at it with no flash of another mode.
//
// Fit to screen (ADR-103) rides on the same: a margin round the picture,
// for a TV that crops its edges (overscan) at a resolution the box's
// graphics can't shrink the picture for. It's a percent of the canvas on
// each side, 3 to start with, kept with the size. The screen daemon makes it
// the monitor's reserved area, and apps are maximized inside it rather than
// made full screen (daemon/screen.ts). Home stays full screen, and moves its
// own margin in by as much as the margin is over the 3 it already allows
// for (launcher/size.ts).
//
// Behind the sizes switch (daemon/features.ts). With it off, the TV session
// keeps Hyprland's preferred mode and automatic scale, as before, home
// zooms its 1920 × 1080 page to fit, and there's no margin.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AskWatch } from "./asks.ts";
import type { Monitor } from "./hyprland.ts";

export type Size = "larger" | "standard" | "more";
export type Output = "auto" | "1080p";

export const SIZES: Size[] = ["larger", "standard", "more"];
export const OUTPUTS: Output[] = ["auto", "1080p"];
// Each size's logical canvas, in pixels across.
export const CANVAS: Record<Size, number> = { larger: 1600, standard: 1920, more: 2400 };
// The canvas home is drawn for when there are no sizes (the switch is off).
export const DESIGN: [number, number] = [1920, 1080];

// Fit to screen's margin, a percent of the canvas on each side: the width's
// on the left and right, the height's at the top and bottom. 3 to start
// with, at every resolution; none at all to 10, in half steps.
export const MARGIN = 3;
export const MARGIN_MAX = 10;
export const MARGIN_STEP = 0.5;

// A margin as it's kept, or null for one that isn't.
export function cleanMargin(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MARGIN_MAX) return null;
  const stepped = Math.round(value / MARGIN_STEP) * MARGIN_STEP;
  return Math.abs(stepped - value) < 1e-9 ? stepped : null;
}

// The margin in a canvas's pixels: across (left and right) and down (top
// and bottom).
export function inset(canvas: [number, number], margin: number): [number, number] {
  return [Math.round((canvas[0] * margin) / 100), Math.round((canvas[1] * margin) / 100)];
}

export interface Mode {
  width: number;
  height: number;
  refresh: number;
}

// "3840x2160@60.00Hz", as Hyprland lists a monitor's modes, or "3840x2160@60".
export function parseMode(text: unknown): Mode | null {
  if (typeof text !== "string") return null;
  const m = /^(\d{3,5})x(\d{3,5})@(\d{1,3}(?:\.\d{1,3})?)(?:Hz)?$/.exec(text.trim());
  if (!m) return null;
  const mode = { width: Number(m[1]), height: Number(m[2]), refresh: Number(m[3]) };
  return mode.width > 0 && mode.height > 0 && mode.refresh > 0 ? mode : null;
}

// A mode as Hyprland takes it: "3840x2160@60", or "1920x1080@59.94".
export function modeText(mode: Mode): string {
  return `${mode.width}x${mode.height}@${Number(mode.refresh.toFixed(2))}`;
}

// The mode the TV runs at: its full resolution, or 1080p for a box that
// can't keep 4K smooth, which the TV then scales up. A TV's own 16:9 modes
// come before the others: a 4K TV lists 4096 × 2160 too, and fits it to its
// panel by cropping or squeezing. At that resolution, 60 Hz where it's there,
// since home is drawn for 60 fps and more would only cost the GPU.
export function pickMode(modes: Mode[], output: Output): Mode | null {
  let pool = modes;
  if (output === "1080p") {
    const hd = modes.filter((m) => m.width === 1920 && m.height === 1080);
    const smaller = modes.filter((m) => m.width <= 1920 && m.height <= 1080);
    pool = hd.length > 0 ? hd : smaller.length > 0 ? smaller : modes;
  }
  const wide = pool.filter((m) => m.width * 9 === m.height * 16);
  if (wide.length > 0) pool = wide;
  if (pool.length === 0) return null;
  const biggest = pool.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  const same = pool.filter((m) => m.width === biggest.width && m.height === biggest.height);
  const upTo60 = same.filter((m) => m.refresh < 61);
  return (upTo60.length > 0 ? upTo60 : same).reduce((a, b) => (b.refresh > a.refresh ? b : a));
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

// Hyprland takes only a scale that leaves whole logical pixels, in steps of
// 1/120, as Omarchy's omarchy-hyprland-monitor-scaling says: the nearest one
// at or above the scale asked for. 3840 × 2160 takes 2.4, 2 and 1.6 as they
// are, and so does 1920 × 1080 with 1.2.
export function cleanScale(want: number, width: number, height: number): number {
  const g = gcd(width * 120, height * 120);
  let k = Math.min(Math.max(Math.round(want * 120), 1), g);
  while (g % k !== 0) k++;
  return k / 120;
}

// The sizes a TV offers: those whose canvas is no wider than the TV's
// output, so the smallest text home draws (23 px, the TV design principles'
// floor) is never drawn on fewer pixels than that. A 4K TV gets all three,
// and a 1080p TV larger and standard. A TV narrower than every canvas gets
// larger alone, and one the screen daemon hasn't seen yet what any 1080p TV
// has.
export function offered(mode: Mode | null): Size[] {
  if (!mode) return ["larger", "standard"];
  const sizes = SIZES.filter((size) => CANVAS[size] <= mode.width);
  return sizes.length > 0 ? sizes : ["larger"];
}

// The size the TV shows: the one picked, or, on a TV that doesn't offer it,
// the nearest smaller canvas it does (more on screen on a 1080p TV shows
// standard). The pick is kept, so the next 4K TV shows it again.
export function fitSize(want: Size, sizes: Size[]): Size {
  if (sizes.includes(want)) return want;
  const below = sizes.filter((size) => CANVAS[size] <= CANVAS[want]);
  return below.length > 0 ? below[below.length - 1] : sizes[0];
}

// What the screen daemon applies: the output, its mode and the scale, and
// Fit to screen's margin as the monitor's reserved area, in logical pixels
// across and down.
export interface Target {
  output: string;
  mode: string;
  scale: number;
  reserved: [number, number];
}

// A reserved area as the screen daemon takes it: two whole numbers of
// logical pixels, none below 0 or over a quarter of 8K's width. A target from
// before Fit to screen has none.
export function cleanReserved(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  return value.every((n) => Number.isInteger(n) && n >= 0 && n <= 2048) ? [value[0], value[1]] : null;
}

// Where a target comes from: the mode for the output picked, the scale
// that turns it into the canvas of the size shown, and the margin on that
// canvas.
export function targetFor(
  output: string,
  modes: Mode[],
  size: Size,
  picked: Output,
  margin = 0,
): { target: Target; canvas: [number, number]; sizes: Size[]; size: Size } | null {
  const mode = pickMode(modes, picked);
  if (!mode) return null;
  const sizes = offered(mode);
  const shown = fitSize(size, sizes);
  const scale = cleanScale(mode.width / CANVAS[shown], mode.width, mode.height);
  const canvas: [number, number] = [Math.round(mode.width / scale), Math.round(mode.height / scale)];
  return {
    target: { output, mode: modeText(mode), scale, reserved: inset(canvas, margin) },
    canvas,
    sizes,
    size: shown,
  };
}

// A connector's name, as it goes into the Lua that sets it: HDMI-A-1, DP-2.
// Anything else is refused, so a hostile name can't run Lua.
export function safeOutput(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(name);
}

// --- The daemon's side ---------------------------------------------------

// What the TV runs at: its mode and scale, and the reserved area the screen
// daemon set on it, when it said.
export interface Live {
  mode: string;
  scale: number;
  reserved?: [number, number];
}

// The TV, as the screen daemon last saw it: its output, the modes it lists,
// and what it runs at now.
export interface Tv {
  output: string;
  modes: string[];
  live: Live | null;
}

interface Saved {
  size?: Size;
  output?: Output;
  margin?: number;
  tv?: Tv;
}

// What GET /api/display answers (PHASE-2-PLAN.md, "Shared interfaces").
export interface DisplayState {
  size: Size;
  output: Output;
  mode: string | null;
  scale: number | null;
  canvas: [number, number];
  sizes: Size[];
  // The TV's full resolution, when it's more than 1080p, for picking it
  // over 1080p output: "3840x2160@60". Null otherwise.
  full: string | null;
  // Fit to screen: the margin, a percent on each side, and what that is on
  // the canvas, across and down. None with the switch off.
  margin: number;
  inset: [number, number];
}

export interface DisplayOptions {
  // The daemon's state folder, which holds display.json.
  state: string;
  // The sizes switch.
  on: () => Promise<boolean>;
  // The box check's verdict on 4K (GET /api/box's verdicts.fourKSmooth), or
  // null while there's none.
  fourKSmooth?: () => Promise<boolean | null>;
}

function cleanLive(said: unknown): Live | null {
  const l = said as Record<string, unknown> | null | undefined;
  const mode = parseMode(l?.mode);
  if (!mode || typeof l?.scale !== "number" || !(l.scale > 0 && l.scale <= 8)) return null;
  const reserved = cleanReserved(l.reserved);
  return { mode: modeText(mode), scale: l.scale, ...(reserved ? { reserved } : {}) };
}

function cleanTv(said: unknown): Tv | null {
  if (!said || typeof said !== "object") return null;
  const tv = said as Record<string, unknown>;
  if (!safeOutput(tv.output) || !Array.isArray(tv.modes)) return null;
  const modes = [...new Set(tv.modes.map(parseMode).filter((m): m is Mode => m !== null).map(modeText))].slice(0, 64);
  const live = cleanLive(tv.live);
  if (modes.length === 0 && live) modes.push(live.mode);
  return modes.length > 0 ? { output: tv.output, modes, live } : null;
}

export class Display {
  private file: string;
  private o: DisplayOptions;
  // Writes one at a time, so two changes close together both land.
  private writing: Promise<unknown> = Promise.resolve();

  constructor(options: DisplayOptions) {
    this.o = options;
    this.file = join(options.state, "display.json");
  }

  private async read(): Promise<Saved> {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8")) as Record<string, unknown>;
      return {
        ...(SIZES.includes(saved.size as Size) ? { size: saved.size as Size } : {}),
        ...(OUTPUTS.includes(saved.output as Output) ? { output: saved.output as Output } : {}),
        ...(cleanMargin(saved.margin) !== null ? { margin: cleanMargin(saved.margin)! } : {}),
        ...(cleanTv(saved.tv) ? { tv: cleanTv(saved.tv)! } : {}),
      };
    } catch {
      return {};
    }
  }

  private change(edit: (saved: Saved) => Saved): Promise<Saved> {
    const next = this.writing.then(async () => {
      const saved = edit(await this.read());
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(saved, null, 2) + "\n");
      await rename(tmp, this.file);
      return saved;
    });
    this.writing = next.catch(() => {});
    return next;
  }

  // The output for a box nobody picked one for: 1080p when the box check
  // says it can't keep 4K smooth, and the TV's full resolution otherwise.
  private async output(saved: Saved): Promise<Output> {
    if (saved.output) return saved.output;
    const smooth = await (this.o.fourKSmooth?.() ?? Promise.resolve(null)).catch(() => null);
    return smooth === false ? "1080p" : "auto";
  }

  private async plan(saved: Saved) {
    if (!saved.tv) return null;
    const modes = saved.tv.modes.map(parseMode).filter((m): m is Mode => m !== null);
    return targetFor(saved.tv.output, modes, saved.size ?? "standard", await this.output(saved), saved.margin ?? MARGIN);
  }

  async state(): Promise<DisplayState> {
    const saved = await this.read();
    const live = saved.tv?.live ?? null;
    if (!(await this.o.on())) {
      return { size: "standard", output: "auto", mode: live?.mode ?? null, scale: live?.scale ?? null, canvas: [DESIGN[0], DESIGN[1]], sizes: [], full: null, margin: 0, inset: [0, 0] };
    }
    const output = await this.output(saved);
    const margin = saved.margin ?? MARGIN;
    const planned = await this.plan(saved);
    if (!planned) {
      const size = fitSize(saved.size ?? "standard", offered(null));
      const canvas: [number, number] = [CANVAS[size], Math.round((CANVAS[size] * 9) / 16)];
      return { size, output, mode: null, scale: null, canvas, sizes: offered(null), full: null, margin, inset: inset(canvas, margin) };
    }
    const best = pickMode((saved.tv?.modes ?? []).map(parseMode).filter((m): m is Mode => m !== null), "auto");
    const full = best && best.width > 1920 ? modeText(best) : null;
    return {
      size: planned.size,
      output,
      mode: planned.target.mode,
      scale: planned.target.scale,
      canvas: planned.canvas,
      sizes: planned.sizes,
      full,
      margin,
      inset: planned.target.reserved,
    };
  }

  // What the TV should run at, for the screen daemon, or null while the
  // switch is off or no TV has been seen.
  async target(): Promise<Target | null> {
    if (!(await this.o.on())) return null;
    return (await this.plan(await this.read()))?.target ?? null;
  }

  // A size, an output or Fit to screen's margin picked, from Settings or
  // setup's look step.
  async choose(change: unknown): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    if (!(await this.o.on())) return { ok: false, status: 409, error: "Sizes aren't available" };
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      return { ok: false, status: 400, error: 'send {"size": "larger" | "standard" | "more"}, {"output": "auto" | "1080p"} or {"margin": 0 to 10}' };
    }
    const { size, output, margin } = change as { size?: unknown; output?: unknown; margin?: unknown };
    if (size === undefined && output === undefined && margin === undefined) return { ok: false, status: 400, error: "send a size, an output or a margin" };
    if (size !== undefined && !SIZES.includes(size as Size)) return { ok: false, status: 400, error: "the size is larger, standard or more" };
    if (output !== undefined && !OUTPUTS.includes(output as Output)) return { ok: false, status: 400, error: "the output is auto or 1080p" };
    if (margin !== undefined && cleanMargin(margin) === null) return { ok: false, status: 400, error: `the margin is 0 to ${MARGIN_MAX}, in steps of ${MARGIN_STEP}` };
    if (size !== undefined) {
      const saved = await this.read();
      const planned = await this.plan(saved);
      const sizes = planned?.sizes ?? offered(null);
      // Only what this TV offers, unless the output changes with it.
      if (output === undefined && !sizes.includes(size as Size)) return { ok: false, status: 400, error: `This TV offers ${sizes.join(" and ")}` };
    }
    await this.change((saved) => ({
      ...saved,
      ...(size !== undefined ? { size: size as Size } : {}),
      ...(output !== undefined ? { output: output as Output } : {}),
      ...(margin !== undefined ? { margin: cleanMargin(margin)! } : {}),
    }));
    return { ok: true };
  }

  // Whether the TV, as the screen daemon last said, runs at a target, its
  // margin too.
  async runs(target: Target): Promise<boolean> {
    const tv = (await this.read()).tv;
    const reserved = tv?.live?.reserved ?? [0, 0];
    return Boolean(
      tv &&
        tv.output === target.output &&
        tv.live &&
        tv.live.mode === target.mode &&
        Math.abs(tv.live.scale - target.scale) < 0.005 &&
        reserved[0] === target.reserved[0] &&
        reserved[1] === target.reserved[1],
    );
  }

  // What the TV runs at, after the screen daemon set it.
  async live(live: Live): Promise<void> {
    await this.change((saved) => (saved.tv ? { ...saved, tv: { ...saved.tv, live } } : saved));
  }

  // The TV the screen daemon sees. Whether anything changed, which the TV's
  // pages hear as the display event.
  async reported(said: unknown): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
    const tv = cleanTv(said);
    if (!tv) return { ok: false, error: "send the tv's output, its modes and what it runs at" };
    let changed = false;
    await this.change((saved) => {
      changed = JSON.stringify(saved.tv ?? null) !== JSON.stringify(tv);
      return { ...saved, tv };
    });
    return { ok: true, changed };
  }
}

// --- The screen daemon's side --------------------------------------------

// What the daemon asks: the TV set to a target, or back to Hyprland's own
// mode and scale (null) with the switch off.
export interface DisplayAsk {
  target: Target | null;
}

export interface DisplayAnswer {
  ok: boolean;
  live?: Live;
  error?: string;
  late?: boolean;
}

export function cleanDisplayAnswer(said: unknown): DisplayAnswer {
  const a = (said ?? {}) as Record<string, unknown>;
  const live = cleanLive(a.live);
  return {
    ok: a.ok === true,
    ...(live ? { live } : {}),
    ...(typeof a.error === "string" ? { error: a.error.slice(0, 300) } : {}),
  };
}

// The part of Hyprland's IPC the display needs (daemon/hyprland.ts).
export interface DisplayHyprland {
  monitors(): Promise<Monitor[]>;
  eval(code: string): Promise<void>;
  events(handler: (name: string, data: string) => void, closed: () => void): void;
}

// Where the screen daemon keeps the last mode and scale it applied, for
// session/hypr.lua, with Fit to screen's reserved area across and down:
// "HDMI-A-1 3840x2160@60 2 58 32" on one line.
export function displayFile(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "origaitv", "display");
}

export interface DisplayWatchOptions {
  hyprland: DisplayHyprland;
  url: string; // the daemon: http://127.0.0.1:3000/
  file: string; // displayFile()
  log?: (line: string) => void;
  // How long a new scale may take to show in Hyprland's monitors.
  settleMs?: number;
  // How long to keep trying the daemon at the session's start.
  retryMs?: number;
  fetch?: typeof fetch;
  // Fit to screen's margin came or went, so the app in front is placed
  // again: maximized inside it, or full screen (daemon/screen.ts).
  fitted?: (on: boolean) => void;
}

function liveOf(monitor: Monitor): { mode: string; scale: number } {
  return { mode: modeText({ width: monitor.width, height: monitor.height, refresh: monitor.refreshRate }), scale: monitor.scale ?? 1 };
}

// The monitor's rule, as the screen daemon sets it with hyprctl eval and
// session/hypr.lua at the session's start: the mode, the scale, and the
// reserved area Hyprland keeps clear of maximized windows and of the layers
// that keep a zone for themselves, such as the sign-in bar.
export function monitorRule(target: Target): string {
  const [x, y] = target.reserved;
  return `hl.monitor({ output = "${target.output}", mode = "${target.mode}", position = "auto", scale = ${target.scale}, reserved = { top = ${y}, right = ${x}, bottom = ${y}, left = ${x} } })`;
}

// The kept line's reserved area, or none on a line from before it.
export function keptReserved(line: string): [number, number] {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 5) return [0, 0];
  const reserved = cleanReserved([Number(parts[3]), Number(parts[4])]);
  return reserved ?? [0, 0];
}

export class DisplayWatch {
  private o: Required<Omit<DisplayWatchOptions, "fetch">> & { fetch: typeof fetch };
  private asks?: AskWatch<DisplayAsk, DisplayAnswer>;
  // The output this session set a mode and scale on, to put back if the
  // switch goes off.
  private set: string | null = null;
  // The reserved area on the TV: what this session set, or what
  // session/hypr.lua started it at from the kept line.
  private reserved: [number, number];
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: DisplayWatchOptions) {
    this.o = { log: (line) => console.log(line), settleMs: 1500, retryMs: 5000, fetch: globalThis.fetch, fitted: () => {}, ...options };
    this.reserved = keptReserved(this.keptLine() ?? "");
  }

  // Whether Fit to screen keeps a margin on the TV now, so apps are
  // maximized inside it rather than full screen.
  fitted(): boolean {
    return this.reserved[0] > 0 || this.reserved[1] > 0;
  }

  private reservedNow(reserved: [number, number]): void {
    const was = this.fitted();
    this.reserved = reserved;
    if (was !== this.fitted()) this.o.fitted(this.fitted());
  }

  private async monitor(): Promise<Monitor | null> {
    const monitors = (await this.o.hyprland.monitors()).filter((m) => !m.disabled);
    return monitors.find((m) => m.focused) ?? monitors[0] ?? null;
  }

  // Tells the daemon what the TV offers and runs at, and applies what it
  // says back. False when the daemon didn't answer.
  async report(): Promise<boolean> {
    const monitor = await this.monitor();
    if (!monitor || !safeOutput(monitor.name)) return true;
    const modes = (monitor.availableModes ?? []).map(parseMode).filter((m): m is Mode => m !== null).map(modeText);
    let said: { ok?: boolean; target?: Target | null };
    try {
      const response = await this.o.fetch(`${this.o.url}api/display/tv`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ output: monitor.name, modes, live: { ...liveOf(monitor), reserved: this.reserved } }),
        signal: AbortSignal.timeout(3000),
      });
      said = (await response.json()) as typeof said;
    } catch {
      return false;
    }
    if (said.ok) await this.apply(said.target ?? null);
    return true;
  }

  // The TV at a target, or at Hyprland's own preferred mode and automatic
  // scale with none, and no margin. A target it already runs at is left
  // alone, since even the same mode set again can make the TV look for its
  // signal. A new margin alone is set at the same mode and scale, which
  // Hyprland takes without setting the mode again.
  async apply(target: Target | null): Promise<DisplayAnswer> {
    if (!target) {
      // The session may have started at the line kept last time, so that
      // output goes back too.
      const output = this.set ?? this.kept();
      this.forget();
      this.set = null;
      if (output) {
        await this.o.hyprland.eval(`hl.monitor({ output = "${output}", mode = "preferred", position = "auto", scale = "auto" })`).catch((error: Error) => this.o.log(`display: ${error.message}`));
      }
      this.reservedNow([0, 0]);
      const monitor = await this.monitor();
      return { ok: true, ...(monitor ? { live: { ...liveOf(monitor), reserved: this.reserved } } : {}) };
    }
    const mode = parseMode(target.mode);
    const reserved = cleanReserved(target.reserved ?? [0, 0]);
    if (!safeOutput(target.output) || !mode || !(target.scale > 0 && target.scale <= 8) || !reserved) return { ok: false, error: "that isn't a mode and scale the tv can take" };
    const wanted: Target = { output: target.output, mode: modeText(mode), scale: target.scale, reserved };
    const runs = (m: Monitor | null) => m !== null && m.name === target.output && m.width === mode.width && m.height === mode.height && Math.abs((m.scale ?? 1) - target.scale) < 0.005;
    let monitor = await this.monitor();
    if (!runs(monitor)) {
      try {
        await this.o.hyprland.eval(monitorRule(wanted));
      } catch (error) {
        return { ok: false, error: `hyprland didn't take it: ${(error as Error).message}` };
      }
      this.set = target.output;
      this.reservedNow(reserved);
      const until = Date.now() + this.o.settleMs;
      while (!runs((monitor = await this.monitor())) && Date.now() < until) await new Promise((done) => setTimeout(done, 50));
      if (!runs(monitor)) return { ok: false, error: `the tv runs at ${monitor ? `${liveOf(monitor).mode}, scale ${liveOf(monitor).scale}` : "nothing"}`, ...(monitor ? { live: liveOf(monitor) } : {}) };
      this.o.log(`display: ${target.output} at ${modeText(mode)}, scale ${target.scale}, margin ${reserved.join(" by ")}`);
    } else if (reserved[0] !== this.reserved[0] || reserved[1] !== this.reserved[1]) {
      try {
        await this.o.hyprland.eval(monitorRule(wanted));
      } catch (error) {
        return { ok: false, error: `hyprland didn't take the margin: ${(error as Error).message}`, live: { ...liveOf(monitor!), reserved: this.reserved } };
      }
      this.set = target.output;
      this.reservedNow(reserved);
      this.o.log(`display: the margin on ${target.output} is ${reserved.join(" by ")}`);
    }
    this.keep(wanted);
    return { ok: true, live: { ...liveOf(monitor!), reserved: this.reserved } };
  }

  private keep(target: Target): void {
    try {
      mkdirSync(dirname(this.o.file), { recursive: true });
      writeFileSync(`${this.o.file}.tmp`, `${target.output} ${target.mode} ${target.scale} ${target.reserved[0]} ${target.reserved[1]}\n`);
      renameSync(`${this.o.file}.tmp`, this.o.file);
    } catch (error) {
      this.o.log(`display: couldn't keep the mode for the next session: ${(error as Error).message}`);
    }
  }

  private keptLine(): string | null {
    try {
      return readFileSync(this.o.file, "utf8").split("\n")[0];
    } catch {
      return null;
    }
  }

  // The output named in the line kept last time, if it's one.
  private kept(): string | null {
    const output = this.keptLine()?.split(" ")[0];
    return safeOutput(output) ? output : null;
  }

  private forget(): void {
    rmSync(this.o.file, { force: true });
  }

  // At the session's start: report and apply, then take the daemon's asks,
  // and report again whenever a TV is plugged in. Resolves after the first
  // report, or once the daemon has had a few seconds, so a daemon that's
  // still starting never holds up the TV.
  async start(): Promise<void> {
    const first = new Promise<void>((done) => {
      const attempt = async () => {
        if (this.stopped) return done();
        if (await this.report().catch(() => false)) return done();
        this.timer = setTimeout(() => void attempt(), this.o.retryMs);
      };
      void attempt();
      setTimeout(done, 3000);
    });
    let pending: ReturnType<typeof setTimeout> | undefined;
    this.o.hyprland.events(
      (name) => {
        if (name !== "monitoradded" && name !== "monitoraddedv2") return;
        clearTimeout(pending);
        pending = setTimeout(() => void this.report().catch((error: Error) => this.o.log(`display: ${error.message}`)), 500);
      },
      () => {},
    );
    this.asks = new AskWatch<DisplayAsk, DisplayAnswer>({
      url: this.o.url,
      path: "api/display/ask",
      what: "the display",
      log: this.o.log,
      handle: (ask) => this.apply(ask.target),
      failed: (error) => ({ ok: false, error: error.message }),
    });
    this.asks.start();
    await first;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.asks?.stop();
  }
}
