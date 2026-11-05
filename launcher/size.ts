// The TV's size (ADR-062): the canvas home lays out on, from /api/display,
// and the size picker. Larger, standard and more on screen are canvases
// 1600, 1920 and 2400 pixels across, and a TV offers the ones that stay
// sharp on it. The picker is behind the sizes switch; with it off, home lays
// out on 1920 × 1080 as before.

import { daemon, type DisplaySize, type DisplayState } from "./api.ts";
import { fit, h } from "./dom.ts";
import type { Ctx } from "./main.ts";

export const SIZE_NAMES: Record<DisplaySize, string> = { larger: "larger", standard: "standard", more: "more on screen" };

let shown: DisplayState | null = null;
let on = false;
let changing = false;

export function displayState(): DisplayState | null {
  return shown;
}

// What the daemon says, and the page on that canvas.
export function tookDisplay(state: DisplayState): void {
  shown = state;
  if (Array.isArray(state.canvas) && state.canvas[0] > 0 && state.canvas[1] > 0) fit(state.canvas);
}

export async function loadDisplay(): Promise<void> {
  const [features, state] = await Promise.all([daemon.features().catch(() => ({}) as Record<string, boolean>), daemon.display()]);
  on = features.sizes === true;
  tookDisplay(state);
}

// The size row, for Settings and setup: what the TV shows, stepped with
// left and right, or OK for the next one. None while the switch is off or
// this TV offers one size.
export function sizeRow(ctx: Ctx, rerender: (action: string) => void): HTMLElement[] {
  if (!on || !shown || shown.sizes.length < 2) return [];
  return [h(
    "button",
    { class: "button", "data-focus": true, "data-action": "size", "data-adjust": "size", onclick: () => void stepSize(ctx, 1, rerender, true) },
    h("span", {}, "size"),
    h("span", { class: "button-value" }, changing ? "…" : SIZE_NAMES[shown.size]),
  )];
}

// One size over: larger to the left, more on screen to the right. OK goes
// round from the last to the first.
export async function stepSize(ctx: Ctx, by: number, rerender: (action: string) => void, wrap = false): Promise<void> {
  if (!shown || changing) return;
  const sizes = shown.sizes;
  const at = sizes.indexOf(shown.size);
  const next = wrap ? sizes[(at + by + sizes.length) % sizes.length] : sizes[Math.max(0, Math.min(sizes.length - 1, at + by))];
  if (!next || next === shown.size) return;
  changing = true;
  rerender("size");
  try {
    tookDisplay(await daemon.setDisplay({ size: next }));
    ctx.sounds.play("confirm");
  } catch (error) {
    ctx.toast((error as Error).message, "fail");
    ctx.sounds.play("failure");
  }
  changing = false;
  rerender("size");
}

// Left and right on the size row, for a page's act().
export function sizeAct(ctx: Ctx, action: string, current: HTMLElement | null | undefined, rerender: (action: string) => void): boolean {
  if (current?.dataset.adjust !== "size" || (action !== "left" && action !== "right")) return false;
  void stepSize(ctx, action === "right" ? 1 : -1, rerender);
  return true;
}
