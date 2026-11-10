// Setup's look step (ADR-063, D3), with the looks switch on: Terminal,
// Glass and Cinema by name down the left, and home in the focused one on the
// right, drawn by the launcher itself in a frame. OK on a name picks it and
// goes on to the theme, step 11 of 12. Under the preview, with the sizes
// switch on, the TV's sizes (ADR-062): OK on one sets it, and the preview
// shows home at it. Where the TV has nothing of its own yet, the preview
// fills in with open movies (launcher/looks/showcase.ts).
// Settings → Themes and backgrounds changes both any time.

import { h } from "../launcher/dom.ts";
import { previewFrame } from "../launcher/looks/preview.ts";
import { named, type LookId, type LookInfo, type SizeId } from "../launcher/looks/looks.ts";
import { loadSizes, setSize, SIZE_NAMES } from "../launcher/size.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

// The preview's width, as D3 has it: home at 58 percent.
const PREVIEW_WIDTH = 1114;

export async function look(ctx: Ctx): Promise<View> {
  const found = await fetch("/api/look")
    .then((response) => response.json() as Promise<{ look?: string; looks?: LookInfo[] }>)
    .catch(() => ({ look: "terminal", looks: [] as LookInfo[] }));
  let current = found.look ?? "terminal";
  const looks = (found.looks ?? []).filter((one): one is LookInfo => ["terminal", "glass", "cinema"].includes(one.id as LookId));
  const pick = async (one: LookInfo) => {
    const grant = await ctx.grant("the look");
    if (grant === null) return;
    const response = await fetch("/api/look", { method: "PUT", headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: JSON.stringify({ look: one.id }) }).catch(() => null);
    if (!response?.ok) {
      ctx.sounds.play("failure");
      ctx.toast(`${one.name.toLowerCase()} didn't set`, "fail");
      return;
    }
    current = one.id;
    ctx.sounds.play("confirm");
    // On to the theme and background, setup's next step.
    await ctx.finish("look");
  };

  // The looks by name, the one in use marked.
  const names = looks.map((one) =>
    h(
      "button",
      { class: `look-card setup-look-name${one.id === current ? " picked" : ""}`, "data-focus": true, "data-action": `look-${one.id}`, "data-look": one.id, onclick: () => void pick(one) },
      h("span", { class: "look-card-name" }, named(one.name)),
    ),
  );

  // Home in each look, one over the other, and the focused one shown. They
  // all load at once, so moving between them shows each straight away.
  let shown = current;
  const stage = h("div", { class: "setup-look-stage", "aria-hidden": "true" });
  const drawFrames = (size: SizeId) =>
    stage.replaceChildren(
      ...looks.map((one) => {
        const frame = previewFrame(one.id as LookId, size, PREVIEW_WIDTH);
        frame.dataset.preview = one.id;
        frame.classList.toggle("on", one.id === shown);
        return frame;
      }),
    );
  const show = (id: string) => {
    shown = id;
    for (const frame of stage.children) (frame as HTMLElement).classList.toggle("on", (frame as HTMLElement).dataset.preview === id);
  };

  // The sizes this TV offers, the one it's at marked. None with the sizes
  // off, or on a TV that offers one.
  let display = await loadSizes();
  const sizesBox = h("div", { class: "setup-look-sizes", "data-sizes": "" });
  const drawSizes = () => {
    if (!display || display.sizes.length < 2) return sizesBox.replaceChildren();
    const at = display.size;
    sizesBox.replaceChildren(
      h("span", { class: "setup-look-sizes-label" }, "size"),
      ...display.sizes.map((one) => h("button", { class: `chip${one === at ? " picked" : ""}`, "data-focus": true, "data-action": `size-${one}`, onclick: () => void pickSize(one) }, SIZE_NAMES[one])),
    );
  };
  const pickSize = async (one: SizeId) => {
    if (!display || one === display.size) {
      ctx.sounds.play("confirm");
      return;
    }
    const grant = await ctx.grant("the size");
    if (grant === null) return;
    const set = await setSize(one, grant || undefined);
    if (!set.state) {
      ctx.sounds.play("failure");
      ctx.toast(set.error ?? `${SIZE_NAMES[one]} didn't set`, "fail");
      return;
    }
    display = set.state;
    ctx.sounds.play("confirm");
    drawFrames(display.size);
    drawSizes();
    const again = sizesBox.querySelector<HTMLElement>(`[data-action="size-${one}"]`);
    if (again) ctx.focus.set(again);
  };
  drawFrames(display?.size ?? "standard");
  drawSizes();

  const el = h(
    "div",
    { class: "setup-page d3 setup-look" },
    h("div", { class: "setup-top" }, h("div", {}, ...heading("tv look", "pick a look.", ctx.reduced()))),
    h("div", { class: "setup-look-list" }, ...names),
    h("div", { class: "setup-look-right" }, stage, sizesBox),
  );
  return {
    el,
    first: names.find((name) => name.dataset.look === current) ?? names[0],
    info: "↑↓ move · ↵ pick",
    // The preview follows the look with the focus, and stays on it while the
    // focus is on a size.
    focused(target) {
      const id = target.dataset.look;
      if (id) show(id);
    },
  };
}
