// New this week's own page (D2), with the looks on: every new title across
// your apps, as posters, each with the app it's on. Choosing one plays it in
// its own app, the same as on the tile (S8.1). It's drawn from what the
// daemon's New this week tile sends, so each look draws the same data.

import { daemon, type TileData, type TileEntry } from "../api.ts";
import { h } from "../dom.ts";
import { keepAsking, showLoading, SHOWN_MS } from "../loading.ts";
import type { Ctx, View } from "../main.ts";
import { NEW, openEntry } from "./home.ts";
import { bar, heading } from "./parts.ts";

let last: TileData | null = null;

function card(ctx: Ctx, entry: TileEntry, at: number): HTMLElement {
  const app = ctx.state.apps.find((one) => one.id === NEW);
  // The item has the title's own capitals.
  const title = entry.item?.title ?? entry.label ?? "";
  return h(
    "button",
    {
      class: "poster-card",
      "data-focus": true,
      "data-action": `new-${at}`,
      onclick: () => app && entry.item && void openEntry(ctx, app, entry.item),
    },
    entry.image && app ? h("img", { class: "poster-image", src: daemon.image(app.id, entry.image), alt: "" }) : h("span", { class: "poster-image poster-none" }),
    h("span", { class: "poster-title" }, title),
    entry.caption ? h("span", { class: "poster-caption" }, entry.caption) : null,
  );
}

export function newWeek(ctx: Ctx): View {
  const head = h("div", { class: "page-head" });
  const row = h("div", { class: "poster-row", "data-scroll": true });
  const draw = (data: TileData | null) => {
    const entries = (data?.entries ?? []).filter((entry) => entry.item);
    const n = entries.length;
    const line = n ? `${n} new across your apps` : (data?.headline?.caption ?? "Finding what's new…");
    head.replaceChildren(h("div", {}, ...heading("tv new", "New this week"), h("p", { class: "page-line" }, line)));
    row.replaceChildren(...entries.map((entry, at) => card(ctx, entry, at)));
    // With no key or no location yet, an adult goes to its settings from here.
    if (!n && ctx.state.viewer.role === "adult" && data?.headline?.caption) {
      row.append(h("button", { class: "button", "data-focus": true, "data-action": "new-settings", onclick: () => ctx.go("settings/tmdb") }, "Set it up in Settings"));
    }
  };
  draw(last);
  const el = h("div", { class: "screen" }, h("div", { class: "page new-week" }, head, row), bar(ctx, "new this week"));
  // With nothing from an earlier visit, the row says it's loading.
  const loaded = last ? () => {} : showLoading(row);
  const started = Date.now();
  const ask = async (): Promise<boolean> => {
    const answer = await daemon.tileAnswer(NEW, "l").catch(() => ({ tile: null, waiting: true }));
    // What a wait has to say for now shows once the mark has gone.
    if (answer.waiting && Date.now() - started < SHOWN_MS) return true;
    const data = answer.tile;
    const had = row.querySelector("[data-focus]") !== null;
    last = answer.waiting ? last : data;
    if (!el.isConnected) return false;
    loaded();
    const at = ctx.focus.get()?.dataset.action;
    draw(data);
    const again = at ? el.querySelector<HTMLElement>(`[data-action="${at}"]`) : null;
    const first = row.querySelector<HTMLElement>("[data-focus]") ?? undefined;
    ctx.focus.setRoot(el, had ? (again ?? first) : first);
    return answer.waiting;
  };
  void ask().then((waiting) => waiting && keepAsking(ask, () => el.isConnected));
  return { el, first: row.querySelector<HTMLElement>("[data-focus]") ?? undefined };
}
