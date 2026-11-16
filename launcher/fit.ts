// Fit to screen's screen (ADR-103): four corner marks where the margin puts
// the edge of what apps fill, the picture's size, and a tip for a TV that can
// show the whole picture itself. Left makes the picture smaller and right
// bigger, a step at a time, down to no margin at all, and the TV takes each
// step at once: the marks move, apps are maximized inside the new margin and
// home's words and tiles move with it. Settings, Appearance opens it as a
// page of its own (pages/fit.ts), and setup shows it right after the size
// (setup/fit.ts), in Terminal's style.
//
// A TV that crops the picture's edges (overscan) would cut the marks off,
// so a person makes the picture smaller until all four show.

import { h } from "./dom.ts";
import { margins, pictureSize, steppedMargin, type DisplayState } from "./size.ts";

export const FIT_HEADLINE = "Can you see all four corners?";
// The TV's own word, as its picture menu has it.
export const FIT_TIP = "Turning off overscan in your TV's picture menu shows the whole picture";

export interface FitParts {
  // The four marks, over the whole screen.
  marks: HTMLElement;
  // The picture's size, which left and right change.
  size: HTMLElement;
  // One step: -1 smaller, 1 bigger. False at either end.
  step(by: number): boolean;
  // The margin shown now.
  margin(): number;
}

export interface FitOptions {
  margin: number;
  // The page's canvas, which the marks are placed on.
  canvas: { width: number; height: number };
  // Keeps a margin: the TV takes it at once.
  save(margin: number): Promise<{ state?: DisplayState; error?: string }>;
  failed(error: string): void;
  // The marks moved, for the page's focus ring.
  moved?(): void;
}

export function fitParts(o: FitOptions): FitParts {
  let shown = o.margin;
  let saved = o.margin;
  // One save at a time. Steps taken while one is out are saved after it,
  // the last one only.
  let saving = false;
  let wanted: number | null = null;

  const marks = h(
    "div",
    { class: "fit-marks", "aria-hidden": "true" },
    ...["top-left", "top-right", "bottom-left", "bottom-right"].map((corner) => h("div", { class: `fit-mark ${corner}` })),
  );
  const value = h("span", { class: "button-value fit-value" });
  const size = h("button", { class: "button fit-size", "data-focus": true, "data-action": "fit-size", "data-adjust": "fit" }, h("span", {}, "Picture size"), value);

  const draw = () => {
    const at = margins(shown, o.canvas);
    marks.style.setProperty("--mark-x", `${at.x}px`);
    marks.style.setProperty("--mark-y", `${at.y}px`);
    marks.classList.toggle("none", shown === 0);
    value.textContent = shown === 0 ? "Whole screen" : `${pictureSize(shown)}%`;
    size.classList.toggle("smallest", steppedMargin(shown, -1) === null);
    size.classList.toggle("biggest", steppedMargin(shown, 1) === null);
    o.moved?.();
  };

  const send = async () => {
    if (saving || wanted === null) return;
    saving = true;
    const margin = wanted;
    wanted = null;
    const answer = await o.save(margin);
    saving = false;
    if (answer.state) saved = answer.state.margin;
    else {
      wanted = null;
      shown = saved;
      draw();
      o.failed(answer.error ?? "Couldn't change the picture size");
      return;
    }
    void send();
  };

  draw();
  return {
    marks,
    size,
    margin: () => shown,
    step(by) {
      const next = steppedMargin(shown, by);
      if (next === null) return false;
      shown = next;
      wanted = next;
      draw();
      void send();
      return true;
    },
  };
}
