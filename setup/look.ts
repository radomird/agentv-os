// Setup's look step (ADR-063, D3), with the looks switch on: home in each
// look, Terminal, Glass and Cinema, drawn by the launcher itself in a frame,
// and OK on one picks it and goes on to the theme, step 11 of 12. Under the
// cards, with the sizes switch on, the TV's sizes (ADR-062): OK on one sets
// it, and the cards show home at it.
// Settings → Themes and backgrounds changes both any time.

import { h } from "../launcher/dom.ts";
import { lookCards } from "../launcher/looks/preview.ts";
import type { LookId, LookInfo, SizeId } from "../launcher/looks/looks.ts";
import { loadSizes, setSize, SIZE_NAMES } from "../launcher/size.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

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
  let display = await loadSizes();
  const cardsFor = (size: SizeId) => lookCards(looks, current, size, 480, (one) => void pick(one));
  const cards = cardsFor(display?.size ?? "standard");
  const cardsBox = h("div", { class: "look-cards setup-look-cards" }, ...cards);
  // The sizes this TV offers, the one it's at marked. None with the sizes
  // off, or on a TV that offers one.
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
    cardsBox.replaceChildren(...cardsFor(display.size));
    drawSizes();
    const again = sizesBox.querySelector<HTMLElement>(`[data-action="size-${one}"]`);
    if (again) ctx.focus.set(again);
  };
  drawSizes();
  const el = h(
    "div",
    { class: "setup-page setup-look" },
    h("div", { class: "setup-top" }, h("div", {}, ...heading("tv look", "pick a look.", ctx.reduced()))),
    cardsBox,
    sizesBox,
  );
  return {
    el,
    first: cards.find((card) => card.dataset.look === current) ?? cards[0],
    info: "←→ move · ↵ pick",
  };
}
