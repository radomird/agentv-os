// The background (board 13, ADR-012, S5.3): the theme's pixel field, the
// household's photos sent from a phone, a shared folder, art from museum
// archives, or art the TV's agent makes. The pixel field and the photos are
// here now; the others are coming soon. A photo sent from the phone becomes
// the background at once, with its credit, which the ambient screen shows.

import { daemon, type Backgrounds } from "../launcher/api.ts";
import { h } from "../launcher/dom.ts";
import { glyph, type Glyph } from "../launcher/glyphs.ts";
import { setup } from "./api.ts";
import { field, heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

interface Card {
  id: "field" | "photos" | "folder" | "art" | "made";
  name: string;
  note: string;
  icon?: Glyph;
  soon?: string;
}

const CARDS: Card[] = [
  { id: "field", name: "pixel field", note: "default" },
  { id: "photos", name: "your photos", note: "sent from your phone", icon: "photo" },
  { id: "folder", name: "shared folder", note: "nas or immich", icon: "grid", soon: "shared folders are coming soon" },
  { id: "art", name: "art", note: "museum archives", icon: "spark", soon: "museum archives are coming soon" },
  { id: "made", name: "made for you", note: "your agent will draw it", icon: "spark", soon: "your tv's agent will draw backgrounds soon" },
];

const empty = (): Backgrounds => ({ source: "field", current: null, items: [] });

export async function background(ctx: Ctx): Promise<View> {
  let now = await daemon.backgrounds().catch(empty);
  const cards = CARDS.map((card) => {
    const shot = h("span", { class: "back-shot" });
    return h(
      "button",
      { class: `back${card.soon ? " soon" : ""}`, "data-focus": true, "data-background": card.id, onclick: () => void pick(card) },
      shot,
      h("span", { class: "look-text" }, h("span", { class: "look-name" }, card.name), h("span", { class: "look-note" }, card.soon && card.id !== "made" ? `${card.note} · soon` : card.note)),
    );
  });
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "continue", onclick: () => void ctx.finish("background") }, "↵ done");
  const line = h("span", { class: "setup-note" });

  const draw = () => {
    for (const card of cards) {
      const id = card.dataset.background;
      card.classList.toggle("picked", id === now.source);
      const shot = card.querySelector<HTMLElement>(".back-shot")!;
      const newest = now.items.find((item) => item.id === now.current) ?? now.items[0];
      if (id === "field" && !shot.firstChild) shot.append(field());
      else if (id === "photos") shot.replaceChildren(newest ? h("img", { src: `/api/backgrounds/${newest.id}`, alt: "" }) : glyph("photo", 72));
      else if (id !== "field" && !shot.firstChild) shot.append(glyph(CARDS.find((c) => c.id === id)!.icon!, 72));
    }
    line.textContent = now.items.length
      ? `${now.items.length === 1 ? "1 photo" : `${now.items.length} photos`} from your phone. send more any time.`
      : "on your phone: the tv's page, then send a photo.";
  };

  const pick = async (card: Card) => {
    if (card.soon) {
      ctx.sounds.play("failure");
      ctx.toast(card.soon, "fail");
      return;
    }
    if (card.id === "photos" && now.items.length === 0) {
      ctx.open("background/photos");
      return;
    }
    try {
      now = await daemon.chooseBackground(card.id as Backgrounds["source"]);
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    draw();
  };

  draw();
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", { class: "setup-top" }, h("div", {}, ...heading("tv background", "pick a background.", ctx.reduced())), go),
    h("div", { class: "backs" }, ...cards),
    line,
  );
  return {
    el,
    first: cards.find((card) => card.dataset.background === now.source) ?? cards[0],
    info: "←→ move · ↵ pick",
    heard(event, data) {
      if (event !== "background") return;
      now = data as Backgrounds;
      draw();
    },
  };
}

// Your photos, before there are any: send one from the phone, which pairs
// from this code if none is paired yet. The first one to come is the
// background, and setup goes back to the choice.
export function photos(ctx: Ctx): View {
  const qr = h("img", { class: "qr", alt: "" }) as HTMLImageElement;
  const label = h("span", { class: "qr-label" });
  const paired = ctx.info.phones.length > 0;
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", {}, ...heading("tv background --photos", "send a photo.", ctx.reduced())),
    h(
      "div",
      { class: "terms" },
      h(
        "div",
        { class: "terms-left" },
        h(
          "div",
          { class: "ready-list" },
          h("span", { class: `ready-row ${paired ? "mark-done" : "mark-now"}` }, h("span", {}, h("b", {}, paired ? "[x]" : "[>]"), paired ? ` paired · ${ctx.info.phones[ctx.info.phones.length - 1]}` : " pair your phone with the code")),
          h("span", { class: "ready-row mark-todo" }, h("span", {}, h("b", {}, "[ ]"), " on the phone: send a photo")),
        ),
        h("p", { class: "setup-note" }, "it becomes the background, and the ambient screen says who took it."),
      ),
      paired ? null : h("div", { class: "welcome-qr small" }, h("span", { class: "qr-box" }, qr), label),
    ),
  );
  if (!paired) {
    void setup.pair().then((code) => {
      if (code?.url) qr.setAttribute("src", `/api/phones/qr?${code.code}`);
      label.textContent = code ? `pair a phone · code ${code.code}` : "";
    });
  }
  let moved = false;
  return {
    el,
    info: "waiting for a photo · esc back",
    heard(event, data) {
      if (event !== "background" || moved || !(data as Backgrounds).items?.length) return;
      moved = true;
      ctx.sounds.play("confirm");
      ctx.toast("your photo is the background now", "ok");
      ctx.open("background", "back");
    },
  };
}
