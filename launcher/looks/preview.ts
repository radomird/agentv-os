// A look's preview (ADR-063, D2, D3): home itself, drawn by the launcher in
// that look and size, read-only and silent, in a frame scaled down to a card.
// Setup's look step and Settings → Themes and backgrounds both show the three.
// Its address is /?preview&look=<id>&size=<size>&theme=<name>.

import { h } from "../dom.ts";
import { CANVAS, named, type LookId, type LookInfo, type SizeId } from "./looks.ts";

export function previewAddress(look: LookId, size: SizeId, theme?: string | null): string {
  const params = new URLSearchParams({ look, size });
  if (theme) params.set("theme", theme);
  return `/?preview&${params}`;
}

// The frame, at the size's own canvas, scaled to width pixels wide.
export function previewFrame(look: LookId, size: SizeId, width: number, theme?: string | null): HTMLElement {
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
  const box = h("span", { class: "look-frame" }, frame);
  box.style.setProperty("--preview-width", `${width}px`);
  box.style.setProperty("--preview-scale", String(width / canvas.width));
  return box;
}

// A card for each look: its preview, its name and its line. OK on one picks
// it; the one in use is marked.
export function lookCards(looks: LookInfo[], current: string | null, size: SizeId, width: number, pick: (look: LookInfo) => void, theme?: string | null): HTMLElement[] {
  return looks.map((look) =>
    h(
      "button",
      { class: `look-card${look.id === current ? " picked" : ""}`, "data-focus": true, "data-action": `look-${look.id}`, "data-look": look.id, onclick: () => pick(look) },
      previewFrame(look.id, size, width, theme),
      h("span", { class: "look-card-name" }, named(look.name)),
      h("span", { class: "look-card-line" }, named(look.line)),
    ),
  );
}
