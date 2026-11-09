// Theme and background on one screen (D3, step 11 of 12), with setup's own
// switch on. The top row is home in the look you picked, once in each of
// Omarchy's themes, drawn by the launcher itself. OK on one sets it, as
// Settings does, and the focus goes down to the backgrounds. The row under
// it is the background: the theme's own, which is the default, your photos,
// a shared folder, or one your agent will draw soon. OK on one picks it and
// finishes setup. Photos and a folder open their own page first, and come
// back here with the one picked.

import { daemon, screen, shownCurrent, type Backgrounds, type ThemePreview } from "../launcher/api.ts";
import { h } from "../launcher/dom.ts";
import { glyph, type Glyph } from "../launcher/glyphs.ts";
import type { LookId, LookInfo } from "../launcher/looks/looks.ts";
import { previewFrame } from "../launcher/looks/preview.ts";
import { loadSizes } from "../launcher/size.ts";
import { setup } from "./api.ts";
import { field, heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

type Back = "theme" | "photos" | "folder" | "made";

const BACKS: { id: Back; name: string; icon: Glyph }[] = [
  { id: "theme", name: "", icon: "grid" },
  { id: "photos", name: "your photos", icon: "photo" },
  { id: "folder", name: "a shared folder", icon: "grid" },
  { id: "made", name: "made for you", icon: "spark" },
];

const LOOKS: LookId[] = ["terminal", "glass", "cinema"];
const empty = (): Backgrounds => ({ source: "theme", current: null, items: [] });
const lower = (name: string | null | undefined) => (name ?? "").replace(/[-_]+/g, " ").toLowerCase();

export async function themeBackground(ctx: Ctx): Promise<View> {
  const [found, looked, display] = await Promise.all([
    daemon.themes().catch(() => ({ themes: [] as ThemePreview[], current: null as string | null })),
    fetch("/api/look")
      .then((response) => response.json() as Promise<{ look?: string; looks?: LookInfo[] }>)
      .catch(() => ({ look: "terminal", looks: [] as LookInfo[] })),
    loadSizes(),
  ]);
  let themes = found.themes;
  let current = found.current;
  let now = await daemon.backgrounds().catch(empty);
  let setting: string | null = null;
  let leaving = false;
  const look = LOOKS.includes(looked.look as LookId) ? (looked.look as LookId) : "terminal";
  const size = display?.size ?? "standard";
  const lookName = lower(looked.looks?.find((one) => one.id === look)?.name ?? look);

  const themeCard = (one: ThemePreview) =>
    h(
      "button",
      { class: "tb-theme", "data-focus": true, "data-theme": one.id, onclick: () => void pickTheme(one) },
      previewFrame(look, size, 326, one.id),
      h("span", { class: "tb-theme-name" }, lower(one.name)),
    );
  let themeCards = themes.map(themeCard);
  const themeRow = h("div", { class: "tb-themes", "data-scroll": true }, ...themeCards);
  themeRow.addEventListener("scroll", () => ctx.focus.refresh(), { passive: true });

  const backCards = BACKS.map((back) =>
    h(
      "button",
      { class: `tb-back${back.id === "made" ? " soon" : ""}`, "data-focus": true, "data-background": back.id, onclick: () => void pickBack(back.id) },
      h("span", { class: "tb-back-shot" }),
      h("span", { class: "tb-back-name" }, back.name),
    ),
  );
  const backOf = (id: Back) => backCards.find((card) => card.dataset.background === id)!;

  const draw = () => {
    for (const card of themeCards) {
      card.classList.toggle("picked", card.dataset.theme === current);
      card.classList.toggle("setting", card.dataset.theme === setting);
    }
    const own = shownCurrent({ ...now, source: "theme" });
    const name = lower(themes.find((one) => one.id === current)?.name ?? now.theme?.name);
    for (const card of backCards) {
      const id = card.dataset.background as Back;
      card.classList.toggle("picked", id === now.source);
      const shot = card.querySelector<HTMLElement>(".tb-back-shot")!;
      if (id === "theme") {
        card.querySelector(".tb-back-name")!.textContent = name ? `${name}'s` : "the theme's own";
        if (own && shot.querySelector("img")?.dataset.id !== own.id) shot.replaceChildren(h("img", { src: `/api/backgrounds/${own.id}`, alt: "", "data-id": own.id }));
        else if (!own && !shot.querySelector(".pixel-field")) shot.replaceChildren(field());
        continue;
      }
      const kind = id === "photos" ? "photo" : id === "folder" ? "folder" : null;
      const mine = kind ? now.items.filter((item) => item.kind === kind) : [];
      const newest = mine.find((item) => item.id === now.current) ?? mine[0];
      if (newest && shot.querySelector("img")?.dataset.id !== newest.id) shot.replaceChildren(h("img", { src: `/api/backgrounds/${newest.id}`, alt: "", "data-id": newest.id }));
      else if (!newest && !shot.querySelector(".glyph")) shot.replaceChildren(glyph(BACKS.find((back) => back.id === id)!.icon, 48));
    }
  };

  const pickTheme = async (one: ThemePreview) => {
    if (setting || leaving) return;
    if (one.id === current) {
      ctx.sounds.play("confirm");
      ctx.focus.set(backOf("theme"));
      return;
    }
    setting = one.id;
    draw();
    ctx.status(`setting ${lower(one.name)}`);
    const reply = await screen.setTheme(one.id);
    setting = null;
    ctx.status("←↑↓→ move · ↵ pick");
    if (!reply.ok) {
      ctx.sounds.play("failure");
      ctx.toast(reply.error ?? `${lower(one.name)} didn't set`, "fail");
      draw();
      return;
    }
    current = one.id;
    ctx.sounds.play("confirm");
    draw();
    ctx.focus.set(backOf("theme"));
  };

  // OK on a background picks it and finishes setup. Photos before there are
  // any, and a folder not yet picked, open their page first.
  const pickBack = async (id: Back) => {
    if (setting || leaving) return;
    if (id === "made") {
      ctx.sounds.play("failure");
      ctx.toast("your tv's agent will draw backgrounds soon", "fail");
      return;
    }
    if (id === "photos" && !now.items.some((item) => item.kind === "photo")) return ctx.open("background/photos");
    if (id === "folder" && now.source !== "folder") return ctx.open("background/folder");
    leaving = true;
    try {
      now = await daemon.chooseBackground(id);
      draw();
      if (!ctx.info.setup.finished.theme) ctx.info.setup = await setup.finish("theme");
    } catch (error) {
      leaving = false;
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    await ctx.finish("background");
    leaving = false;
  };

  draw();
  const top = heading("omarchy theme", "pick a theme.", ctx.reduced());
  const el = h(
    "div",
    { class: "setup-page d3 theme2" },
    ...top,
    // The look is named only once one was picked, a step before this.
    ctx.info.setup.finished.look ? h("p", { class: "setup-line" }, `shown in ${lookName}, the look you picked`) : "",
    themeRow,
    h("span", { class: "tb-label" }, "# background"),
    h("div", { class: "tb-backs" }, ...backCards),
  );
  // Back from photos or a folder, the focus is on the one picked there.
  const picked = now.source === "photos" || now.source === "folder" ? backOf(now.source) : null;
  return {
    el,
    first: picked ?? themeCards.find((card) => card.dataset.theme === current) ?? themeCards[0] ?? backOf("theme"),
    info: "←↑↓→ move · ↵ pick",
    heard(event, data) {
      if (event === "background") {
        now = data as Backgrounds;
        draw();
        return;
      }
      // The theme changed, here or on Omarchy's desktop, or one was added
      // or taken off there: the row again, with the focus where it was.
      if (event !== "theme" && event !== "themes") return;
      void daemon.themes().then((next) => {
        current = next.current;
        if (next.themes.map((one) => one.id).join(" ") !== themes.map((one) => one.id).join(" ")) {
          const at = ctx.focus.get()?.dataset.theme;
          themes = next.themes;
          themeCards = themes.map(themeCard);
          themeRow.replaceChildren(...themeCards);
          const again = themeCards.find((card) => card.dataset.theme === at);
          if (again) ctx.focus.set(again, false);
          else if (at) ctx.focus.set(themeCards[0] ?? backOf("theme"), false);
        }
        draw();
      }, () => {});
    },
  };
}
