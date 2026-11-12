// A look's preview (ADR-063, D2, D3): home itself, drawn by the launcher in
// that look and size, read-only and silent, in a frame scaled down to a card.
// Setup's look step and Settings → Themes and backgrounds both show the three.
// Its address is /?preview&look=<id>&size=<size>&theme=<name>.

import { h } from "../dom.ts";
import { CANVAS, type LookId, type LookInfo, type SizeId } from "./looks.ts";

export function previewAddress(look: LookId, size: SizeId, theme?: string | null): string {
  const params = new URLSearchParams({ look, size });
  if (theme) params.set("theme", theme);
  return `/?preview&${params}`;
}

// The frame, at the size's own canvas, scaled to width pixels wide. With no
// width it fills the width it's given, and the page scales to fit each time
// that width changes, as the look cards do in Settings.
export function previewFrame(look: LookId, size: SizeId, width: number | null, theme?: string | null): HTMLElement {
  const canvas = CANVAS[size];
  const frame = h("iframe", {
    class: "look-frame-page",
    src: previewAddress(look, size, theme),
    width: canvas.width,
    height: canvas.height,
    tabindex: "-1",
    loading: "lazy",
    title: `${look} preview`,
    "aria-hidden": "true",
  });
  const box = h("span", { class: `look-frame${width === null ? " fill" : ""}` }, frame);
  if (width === null) {
    // The width inside its border, unrounded and before the page's zoom.
    new ResizeObserver(([seen]) => box.style.setProperty("--preview-scale", String(seen.contentBoxSize[0].inlineSize / canvas.width))).observe(box);
    return box;
  }
  box.style.setProperty("--preview-width", `${width}px`);
  box.style.setProperty("--preview-scale", String(width / canvas.width));
  return box;
}

// A card for each look: its preview and its name (D2, D3), three across the
// width they're given. OK on one picks it. The one in use has a small mark
// by its name (launcher.css), so the focus ring is the only ring.
export function lookCards(looks: LookInfo[], current: string | null, size: SizeId, pick: (look: LookInfo) => void, theme?: string | null): HTMLElement[] {
  return looks.map((look) =>
    h(
      "button",
      { class: `look-card${look.id === current ? " picked" : ""}`, "data-focus": true, "data-action": `look-${look.id}`, "data-look": look.id, onclick: () => pick(look) },
      previewFrame(look.id, size, null, theme),
      h("span", { class: "look-card-name" }, look.name),
    ),
  );
}
