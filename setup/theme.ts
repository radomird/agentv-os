// The look (board 12, ADR-048): every theme Omarchy has, the ones it ships
// and any installed on its desktop, Tokyo Night first, each shown as a small
// screen in its own colours, in a grid that scrolls, and "describe your
// own" at the end, which setup keeps for the TV's agent to make (S6.4). OK on
// one sets it with Omarchy's omarchy-theme-set, through the screen daemon,
// and the whole TV follows a moment later, as it does when the theme changes
// on Omarchy's desktop (S5.2, S5.7). Settings → Look changes it again any
// time.

import { daemon, screen, type ThemePreview } from "../launcher/api.ts";
import { h } from "../launcher/dom.ts";
import { glyph } from "../launcher/glyphs.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

// A theme's screen in miniature, as on the canvas: a focused tile, two
// tiles beside it, and the status bar with its accent.
export function preview(look: ThemePreview): HTMLElement {
  const c = look.colors;
  const big = h("span", { class: "look-big" });
  big.style.borderColor = c.accent;
  const small = () => {
    const el = h("span", { class: "look-small" });
    el.style.borderColor = c.selection;
    return el;
  };
  const accent = h("span", { class: "look-bar-accent" });
  accent.style.background = c.accent;
  const bar = h("span", { class: "look-bar" }, accent);
  bar.style.background = c.dark_background;
  const screenEl = h("span", { class: "look-screen" }, h("span", { class: "look-tiles" }, big, h("span", { class: "look-side" }, small(), small())), bar);
  screenEl.style.background = c.background;
  return screenEl;
}

export async function theme(ctx: Ctx): Promise<View> {
  const found = await daemon.themes().catch(() => ({ themes: [] as ThemePreview[], current: null as string | null }));
  let current = found.current;
  let setting: string | null = null;
  const card = (look: ThemePreview) =>
    h(
      "button",
      { class: "look", "data-focus": true, "data-theme": look.id, onclick: () => void pick(look) },
      preview(look),
      h("span", { class: "look-text" }, h("span", { class: "look-name" }, look.name), h("span", { class: "look-note" }, look.note)),
    );
  let cards = found.themes.map(card);
  const own = h(
    "button",
    {
      class: "look look-own",
      "data-focus": true,
      "data-theme": "own",
      onclick: () => ctx.open("theme/own"),
    },
    h("span", { class: "look-screen look-dashed" }, glyph("spark", 96)),
    h("span", { class: "look-text" }, h("span", { class: "look-name" }, "describe your own"), h("span", { class: "look-note" }, "your agent will make it")),
  );
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "continue", onclick: () => void ctx.finish("theme") }, "↵ continue");
  const line = h("span", { class: "setup-note" }, "every omarchy theme on this tv, and any you install on omarchy's desktop. change it any time in settings.");
  // Every theme, more than fit: the grid scrolls as the focus moves, and
  // the ring follows a mouse's wheel.
  const grid = h("div", { class: "looks looks-all", "data-scroll": true }, ...cards, own);
  grid.addEventListener("scroll", () => ctx.focus.refresh(), { passive: true });

  const draw = () => {
    for (const card of cards) {
      card.classList.toggle("picked", card.dataset.theme === current);
      card.classList.toggle("setting", card.dataset.theme === setting);
    }
  };

  const pick = async (look: ThemePreview) => {
    if (setting) return;
    if (look.id === current) {
      ctx.sounds.play("confirm");
      return;
    }
    setting = look.id;
    draw();
    ctx.status(`setting ${look.name}`);
    const reply = await screen.setTheme(look.id);
    setting = null;
    if (!reply.ok) {
      ctx.sounds.play("failure");
      ctx.toast(reply.error ?? `${look.name} didn't set`, "fail");
      ctx.status("←↑↓→ move · ↵ pick");
      draw();
      return;
    }
    current = look.id;
    ctx.sounds.play("confirm");
    ctx.status("←↑↓→ move · ↵ pick");
    draw();
  };

  draw();
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", { class: "setup-top" }, h("div", {}, ...heading("omarchy theme", "pick a look.", ctx.reduced())), go),
    grid,
    line,
  );
  return {
    el,
    first: cards.find((card) => card.dataset.theme === current) ?? cards[0] ?? go,
    info: "←↑↓→ move · ↵ pick",
    heard(event) {
      // The colours came, from here or from Omarchy's desktop: which look
      // the TV has now. A theme installed or removed on the desktop: the
      // grid again, with the focus where it was.
      if (event !== "theme" && event !== "themes") return;
      void daemon.themes().then((now) => {
        current = now.current;
        if (now.themes.map((look) => look.id).join(" ") !== cards.map((c) => c.dataset.theme).join(" ")) {
          const at = ctx.focus.get()?.dataset.theme;
          cards = now.themes.map(card);
          grid.replaceChildren(...cards, own);
          const back = [...cards, own].find((c) => c.dataset.theme === at);
          if (at && back) ctx.focus.set(back, false);
          else if (at) ctx.focus.set(cards[0] ?? go, false);
        }
        draw();
      }, () => {});
    },
  };
}
