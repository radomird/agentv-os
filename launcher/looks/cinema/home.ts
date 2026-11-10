// Cinema's home (D1, Q194): tabs along the top, a featured title as big as
// the screen allows with Play and its poster over a wash of the poster's own
// colours, then labelled rows: your apps, and the week's new titles. Left and
// right on Play go through what's featured, and its dots say where you are.
//
// The featured titles are what your apps' tiles already send: titles you're
// part way through and New this week's. Your apps are in the layout's order,
// and an app pinned medium or large says a little more about itself.

import { daemon, type App } from "../../api.ts";
import { h } from "../../dom.ts";
import type { Ctx, View } from "../../main.ts";
import { buildTile, underway } from "../../pages/build.ts";
import { logo, NEW, openApp, openEntry } from "../../pages/home.ts";
import { bar } from "../../pages/parts.ts";
import { cardContent, featured, tileData, type Featured } from "../cards.ts";
import { ordered } from "../glass/home.ts";
import { icon } from "../icons.ts";
import { named, preview, said } from "../looks.ts";

// How many featured titles the carousel goes through.
const MOST = 5;

// What a card says under its app's name: open, or setup or a sign-in still
// needed. Nothing in a look's preview, which shows each app as it is once
// it's set up.
function state(ctx: Ctx, app: App): string {
  if (preview()) return "";
  const open = ctx.running.get(app.id);
  if (open) return said(open.paused ? "paused" : "open");
  if (app.needsSetup) return said("set up");
  if (app.signIn === "needed") return said("sign in");
  return "";
}

function appCard(ctx: Ctx, app: App, size: string): HTMLElement {
  const words = state(ctx, app);
  return h(
    "button",
    { class: `tile cinema-card size-${size}`, "data-focus": true, "data-id": app.id, "data-details": app.id, "aria-label": app.name, onclick: () => void openApp(ctx, app) },
    cardContent(app, logo(app), true),
    h("span", { class: "cinema-card-name" }, named(app.name)),
    words ? h("span", { class: "cinema-card-state" }, words) : null,
  );
}

export function home(ctx: Ctx): View {
  const apps = ordered(ctx);
  const sizes = new Map(ctx.state.layout.map((tile) => [tile.id, tile.size]));
  const cards = apps.map((app) => appCard(ctx, app, sizes.get(app.id) ?? "s"));
  const building = underway()[0];
  if (building) cards.splice(1, 0, buildTile(ctx, building));

  // The carousel: one featured title at a time.
  const kicker = h("div", { class: "cinema-kicker" });
  const name = h("h1", { class: "cinema-name" });
  const meta = h("div", { class: "cinema-meta" });
  const dots = h("span", { class: "cinema-dots", "aria-hidden": "true" });
  const poster = h("img", { class: "cinema-poster", alt: "" });
  // Behind it all, the poster again, blurred across the top of the screen.
  // Two of them, so the next title's fades in over the last.
  const glows = [h("img", { class: "cinema-glow", alt: "" }), h("img", { class: "cinema-glow", alt: "" })];
  let glowing = 0;
  const backdrop = h("div", { class: "cinema-backdrop", "aria-hidden": "true" }, ...glows);
  let slides: Featured[] = [];
  let at = 0;
  const play = h(
    "button",
    {
      class: "button primary cinema-play",
      "data-focus": true,
      "data-action": "cinema-play",
      onclick: () => {
        const slide = slides[at];
        if (slide?.item) void openEntry(ctx, slide.app, slide.item);
        else if (slide) void openApp(ctx, slide.app);
        else if (apps[0]) void openApp(ctx, apps[0]);
      },
    },
    icon("play", 30),
    h("span", { class: "cinema-play-word" }, said("play")),
  );
  const show = () => {
    const slide = slides[at];
    const first = apps[0];
    kicker.replaceChildren(...(slide ? [logo(slide.app), h("span", {}, slide.line)] : []));
    name.textContent = slide?.title ?? (first ? named(first.name) : said("your home"));
    meta.textContent = slide?.meta ?? "";
    const word = play.querySelector(".cinema-play-word")!;
    word.textContent = said(slide?.item ? "play" : "open");
    dots.replaceChildren(...slides.map((_, i) => h("span", { class: `cinema-dot${i === at ? " on" : ""}` })));
    if (slide?.image) {
      poster.src = slide.image;
      poster.classList.add("on");
      const next = glows[1 - glowing];
      const image = slide.image;
      next.onload = () => {
        if (slides[at]?.image !== image) return;
        glows[glowing].classList.remove("on");
        next.classList.add("on");
        glowing = 1 - glowing;
      };
      next.src = image;
    } else {
      poster.classList.remove("on");
      for (const glow of glows) glow.classList.remove("on");
    }
  };
  show();

  // New this week's row, posters with the app each is on.
  const newApp = ctx.state.apps.find((app) => app.id === NEW && app.tier === "built-in");
  const newRow = h("div", { class: "cinema-row cinema-posters", "data-scroll": true });
  const newSection = h("div", { class: "section cinema-section" }, said("new this week"));
  newSection.hidden = true;
  if (newApp) {
    void tileData(newApp, "l").then((data) => {
      const entries = (data?.entries ?? []).filter((entry) => entry.image && entry.item);
      if (!entries.length || !el.isConnected) return;
      newRow.replaceChildren(
        ...entries.map((entry, i) =>
          h(
            "button",
            { class: "poster-card cinema-poster-card", "data-focus": true, "data-action": `new-${i}`, "aria-label": entry.item!.title, onclick: () => void openEntry(ctx, newApp, entry.item!) },
            h("img", { class: "poster-image", src: daemon.image(newApp.id, entry.image!), alt: "" }),
          ),
        ),
      );
      newSection.hidden = false;
    });
  }

  // What's featured: titles your apps send, New this week's first.
  void Promise.all([...(newApp ? [newApp] : []), ...apps.filter((app) => app !== newApp)].map((app) => featured(app))).then((all) => {
    slides = all.flat().slice(0, MOST);
    if (!el.isConnected) return;
    at = 0;
    show();
  });

  const hero = h(
    "div",
    { class: "cinema-hero" },
    h("div", { class: "cinema-hero-text" }, kicker, name, meta, h("div", { class: "cinema-actions" }, play, dots)),
    poster,
  );
  const body = h(
    "div",
    { class: "cinema-body", "data-scroll": true },
    hero,
    h("div", { class: "section cinema-section" }, said("your apps")),
    h("div", { class: "cinema-row", "data-scroll": true }, ...cards),
    newSection,
    newRow,
  );
  const el = h("div", { class: "screen cinema-home" }, backdrop, bar(ctx, "home"), body);
  return {
    el,
    first: play,
    act(action) {
      const focused = ctx.focus.get();
      // Left and right on Play go through the featured titles.
      if (focused === play && (action === "left" || action === "right") && slides.length > 1) {
        const next = at + (action === "right" ? 1 : -1);
        if (next < 0 || next >= slides.length) return action === "right";
        at = next;
        show();
        ctx.sounds.play("move");
        return true;
      }
      const id = focused?.dataset.id;
      if (action === "info" && id && apps.some((app) => app.id === id)) {
        ctx.go(`details/${id}`);
        return true;
      }
      if (action === "edit") {
        ctx.edit();
        return true;
      }
      return false;
    },
  };
}
