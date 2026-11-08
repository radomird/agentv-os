// Weather's own page (D2), with the looks on: the weather now as the
// headline, the city under it, and the next seven days as cards. It's drawn
// from what Weather's large tile sends, so the app keeps sending data and
// each look draws it (ADR-016, ADR-063). Settings → Weather picks the city.

import { daemon, type TileData, type TileEntry } from "../api.ts";
import { h } from "../dom.ts";
import { hasIcon, icon } from "../looks/icons.ts";
import { lookId, said } from "../looks/looks.ts";
import type { Ctx, View } from "../main.ts";
import { WEATHER } from "./home.ts";
import { bar, heading } from "./parts.ts";

// The last forecast, so the page draws at once on the next visit.
let last: TileData | null = null;

// A condition's line icon, coloured by what it is in look.css.
export function weatherIcon(name: string | undefined, size: number): SVGSVGElement {
  return icon(hasIcon(name) ? name : "cloudy", size);
}

// "h 13° · l 10°" and "cloudy\nh 13° · l 10°", as Weather writes them, read
// back as their parts.
function condition(caption: string | undefined): string {
  return (caption ?? "").split("\n")[0] ?? "";
}

function day(entry: TileEntry, at: number): HTMLElement {
  return h(
    "button",
    { class: "forecast-day", "data-focus": true, "data-action": `day-${at}` },
    h("span", { class: "forecast-name" }, said(entry.label ?? "")),
    weatherIcon(entry.icon, 84),
    h("span", { class: "forecast-temps" }, h("span", { class: "forecast-high" }, entry.value ?? ""), h("span", { class: "forecast-low" }, entry.caption ?? "")),
  );
}

export function forecast(ctx: Ctx): View {
  const head = h("div", { class: "page-head forecast-head" });
  const week = h("div", { class: "forecast-week", "data-scroll": true });
  const terminal = lookId() === "terminal";
  const draw = (data: TileData | null) => {
    const now = data?.headline;
    const words = condition(now?.caption);
    const place = (now?.label ?? "").replace(/ · 7 days$/, "");
    const title = now?.value ? (terminal ? `${now.value} ${words}.` : `${now.value} and ${words}`) : said(terminal ? "the weather." : "the weather");
    const line = data?.entries?.length ? said(place) : said(now?.caption?.replace("\n", " ") ?? "the forecast is on its way");
    head.replaceChildren(h("div", {}, ...heading("tv weather", title), h("p", { class: "page-line" }, line)));
    week.replaceChildren(...(data?.entries ?? []).slice(0, 7).map(day));
  };
  draw(last);
  const app = ctx.state.apps.find((one) => one.id === WEATHER);
  // Terminal's cards need no heading; Glass and Cinema label the row.
  const section = terminal ? null : h("div", { class: "section" }, said("this week"));
  const el = h("div", { class: "screen" }, h("div", { class: "page forecast" }, head, section, week), bar(ctx, "weather"));
  if (app) {
    void daemon
      .tile(app.id, "l")
      .then((data) => {
        const had = week.childElementCount > 0;
        last = data;
        if (!el.isConnected) return;
        const at = ctx.focus.get()?.dataset.action;
        draw(data);
        // The days arrived after the page: the focus goes to today, unless
        // someone already moved it.
        const again = at ? el.querySelector<HTMLElement>(`[data-action="${at}"]`) : null;
        const today = el.querySelector<HTMLElement>(".forecast-day") ?? undefined;
        ctx.focus.setRoot(el, had ? (again ?? today) : today);
      })
      .catch(() => {});
  }
  return { el, first: el.querySelector<HTMLElement>(".forecast-day") ?? undefined };
}
