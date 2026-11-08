// Setup's look step (ADR-063, D3), with the looks switch on: home in each
// look, Terminal, Glass and Cinema, drawn by the launcher itself in a frame,
// and OK on one picks it and goes on to the theme. The size picker joins it
// here when the TV's sizes come (track 4); until then home is at standard.
// Settings → Themes and backgrounds changes the look any time.

import { h } from "../launcher/dom.ts";
import { lookCards } from "../launcher/looks/preview.ts";
import type { LookId, LookInfo } from "../launcher/looks/looks.ts";
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
    // On to the theme, within the same step.
    ctx.open("theme/colours");
  };
  const cards = lookCards(looks, current, "standard", 480, (one) => void pick(one));
  const el = h(
    "div",
    { class: "setup-page setup-look" },
    h("div", { class: "setup-top" }, h("div", {}, ...heading("tv look", "pick a look.", ctx.reduced()))),
    h("div", { class: "look-cards setup-look-cards" }, ...cards),
    // Where the size picker goes once the TV's sizes come (track 4).
    h("div", { class: "setup-look-sizes", "data-sizes": "" }),
  );
  return {
    el,
    first: cards.find((card) => card.dataset.look === current) ?? cards[0],
    info: "←→ move · ↵ pick",
  };
}
