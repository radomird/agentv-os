// The TV's size (ADR-062): larger, standard or more on screen, canvases
// 1600, 1920 and 2400 pixels across, which the TV's scale makes of its own
// resolution. A TV offers the sizes that stay sharp on it: all three on a 4K
// TV, larger and standard on a 1080p one. Settings → Themes and backgrounds
// and setup's look step pick one with this; home lays out on it through
// looks/looks.ts. Behind the sizes switch.
//
// And Fit to screen (ADR-103): a margin round the picture, a percent of the
// canvas on each side, for a TV that crops its edges. Apps are maximized
// inside it (daemon/screen.ts). Home stays full screen, its picture to the
// edges, and its words and tiles move in by as much as the margin is over
// the 3 percent its own safe area already allows for.

import { featureOn } from "./features.ts";
import type { SizeId } from "./looks/looks.ts";

export const SIZE_NAMES: Record<SizeId, string> = { larger: "Larger", standard: "Standard", more: "More on screen" };

// What GET /api/display answers (daemon/display.ts).
export interface DisplayState {
  size: SizeId;
  output: "auto" | "1080p";
  mode: string | null;
  scale: number | null;
  canvas: [number, number];
  sizes: SizeId[];
  // The TV's full resolution, when it's more than 1080p: "3840x2160@60".
  full: string | null;
  // Fit to screen: the margin, a percent on each side, and what that is on
  // the canvas, across and down.
  margin: number;
  inset: [number, number];
}

// Fit to screen's margin: 3 percent to start with, none at all to 10, in
// half steps (daemon/display.ts).
export const MARGIN = 3;
export const MARGIN_MAX = 10;
export const MARGIN_STEP = 0.5;

// The margin as a person reads it: how much of the screen the picture
// fills across, 94% for a margin of 3 on each side, up to 100%.
export function pictureSize(margin: number): number {
  return Math.round(100 - 2 * margin);
}

// The margin one step over: left makes the picture smaller (more margin),
// right bigger (less). Null at either end.
export function steppedMargin(margin: number, by: number): number | null {
  const next = Math.round((margin - by * MARGIN_STEP) / MARGIN_STEP) * MARGIN_STEP;
  return next < 0 || next > MARGIN_MAX || next === margin ? null : next;
}

// The margin on home's canvas, across and down, and how far it is over the
// margin home's own safe area already allows for.
export function margins(margin: number, canvas: { width: number; height: number }): { x: number; y: number; overX: number; overY: number } {
  const x = Math.round((canvas.width * margin) / 100);
  const y = Math.round((canvas.height * margin) / 100);
  return {
    x,
    y,
    overX: Math.max(0, x - Math.round((canvas.width * MARGIN) / 100)),
    overY: Math.max(0, y - Math.round((canvas.height * MARGIN) / 100)),
  };
}

// Puts the margin on the page, for the looks' safe area and the fit screen's
// corners: --fit-x and --fit-y, and --fit-over-x and --fit-over-y. None with
// the sizes off.
export function applyMargin(state: DisplayState | null, canvas: { width: number; height: number }): void {
  const at = margins(state?.margin ?? 0, canvas);
  const root = document.documentElement.style;
  root.setProperty("--fit-x", `${at.x}px`);
  root.setProperty("--fit-y", `${at.y}px`);
  root.setProperty("--fit-over-x", `${at.overX}px`);
  root.setProperty("--fit-over-y", `${at.overY}px`);
}

let shown: DisplayState | null = null;

// The TV's size and the sizes it offers, or null with the switch off.
export async function loadSizes(): Promise<DisplayState | null> {
  if (!(await featureOn("sizes"))) {
    shown = null;
    return null;
  }
  try {
    const response = await fetch("/api/display", { cache: "no-store" });
    shown = response.ok ? ((await response.json()) as DisplayState) : null;
  } catch {
    shown = null;
  }
  return shown;
}

// The last answer, for a page drawn again in place.
export function sizes(): DisplayState | null {
  return shown;
}

// Picks a size, the output or the margin: the TV takes it within a second,
// and home follows on the display event. The new state, or why not.
async function put(change: { size?: SizeId; output?: DisplayState["output"]; margin?: number }, grant?: string): Promise<{ state?: DisplayState; error?: string }> {
  try {
    const response = await fetch("/api/display", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(grant ? { "X-OrigaiTV-Grant": grant } : {}) },
      body: JSON.stringify(change),
    });
    const data = (await response.json()) as DisplayState & { ok?: boolean; error?: string };
    if (!response.ok || data.ok === false) return { error: data.error ?? "Couldn't change the size" };
    shown = data;
    return { state: data };
  } catch {
    return { error: "Couldn't change the size" };
  }
}

export function setSize(size: SizeId, grant?: string): Promise<{ state?: DisplayState; error?: string }> {
  return put({ size }, grant);
}

export function setMargin(margin: number, grant?: string): Promise<{ state?: DisplayState; error?: string }> {
  return put({ margin }, grant);
}

// The TV's full resolution, or 1080p output, which the TV scales up: what a
// box that can't keep 4K smooth starts at (ADR-062).
export function setOutput(output: DisplayState["output"], grant?: string): Promise<{ state?: DisplayState; error?: string }> {
  return put({ output }, grant);
}

// What the resolution row says: "4K" for 3840 x 2160, "1440p" and so on,
// and "1080p" for 1080p output.
export function resolutionName(state: DisplayState): string {
  if (state.output === "1080p" || !state.full) return "1080p";
  const height = Number(/x(\d+)@/.exec(state.full)?.[1] ?? 0);
  return height >= 2160 ? "4K" : `${height}p`;
}

// The size one step over: larger to the left, more on screen to the right,
// staying at the ends. Null when there's nowhere to go.
export function stepped(state: DisplayState, by: number): SizeId | null {
  const at = state.sizes.indexOf(state.size);
  const next = state.sizes[Math.max(0, Math.min(state.sizes.length - 1, at + by))];
  return next && next !== state.size ? next : null;
}
