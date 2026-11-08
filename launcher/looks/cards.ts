// What Glass's and Cinema's tiles show (D1, D2). The apps send the same data
// as for Terminal's tiles (ADR-016), and these draw it the way the two looks
// do: Clock's time, Weather's condition and temperature, what Music plays,
// New this week's posters, and an app's featured title, the first of its
// entries with a picture.

import { daemon, screen, type App, type TileData, type TileEntry } from "../api.ts";
import { clock, h } from "../dom.ts";
import { CLOCK, MUSIC, NEW, WEATHER } from "../pages/home.ts";
import { hasIcon, icon } from "./icons.ts";
import { named, said } from "./looks.ts";

export interface Featured {
  app: App;
  title: string; // the title's own name, or the app's
  line: string; // "continue on Jellyfin", "new on Jellyfin"
  image: string | null; // a picture to draw it with
  item?: TileEntry["item"];
  meta?: string; // under the title, as Cinema has it
}

// Each app's tile data, asked for once per home and kept for the visit.
const asked = new Map<string, Promise<TileData | null>>();

export function tileData(app: App, size: "s" | "m" | "l"): Promise<TileData | null> {
  const key = `${app.id}:${size}`;
  let found = asked.get(key);
  if (!found) {
    found = daemon.tile(app.id, size).catch(() => null);
    asked.set(key, found);
    // Asked again next time home draws, a minute on.
    setTimeout(() => asked.delete(key), 60_000);
  }
  return found;
}

// The largest size an app has content for: its entries come from there.
export function richest(app: App): "s" | "m" | "l" {
  const sizes = app.sizes.map((choice) => choice.size);
  return sizes.includes("l") ? "l" : sizes.includes("m") ? "m" : "s";
}

const isBuiltin = (app: App, id: string) => app.id === id && app.tier === "built-in";

// What an app's featured title is, from its tile's entries: the first with a
// picture, as New this week's posters and the apps' own tiles send.
export async function featured(app: App): Promise<Featured[]> {
  const data = await tileData(app, richest(app));
  const found: Featured[] = [];
  for (const entry of data?.entries ?? []) {
    if (!entry.image) continue;
    const title = entry.item?.title ?? entry.label ?? app.name;
    const onNew = isBuiltin(app, NEW);
    const where = onNew ? (entry.caption ?? "").split(" · ")[0] : app.name;
    found.push({
      app,
      title: named(title),
      line: said(typeof entry.progress === "number" ? `continue on ${named(where)}` : `new on ${named(where)}`),
      image: daemon.image(app.id, entry.image),
      item: entry.item,
      meta: onNew ? said(entry.caption ?? "") : undefined,
    });
  }
  return found;
}

function weatherIcon(name: string | undefined, size: number): SVGSVGElement {
  return icon(hasIcon(name) ? name : "cloudy", size);
}

// A tile's inside, in Glass and Cinema: the built-ins draw their content, an
// app its logo. Cinema adds words under it (wide), Glass doesn't.
export function cardContent(app: App, logo: HTMLElement, wide: boolean): HTMLElement {
  const box = h("span", { class: "card-content" }, logo);
  if (isBuiltin(app, CLOCK)) {
    const draw = () => {
      const date = new Date();
      const time = h("span", { class: "card-time" }, clock(date));
      if (wide) box.replaceChildren(time, h("span", { class: "card-words" }, date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).replace(",", "")));
      else box.replaceChildren(time);
    };
    draw();
    const timer = setInterval(() => (box.isConnected ? draw() : clearInterval(timer)), 5_000);
    box.classList.add("card-clock");
    return box;
  }
  if (isBuiltin(app, WEATHER)) {
    void tileData(app, "s").then((data) => {
      const now = data?.headline;
      if (!now?.value) return;
      const words = (now.caption ?? "").split("\n")[0];
      // A city's name, with its capitals in these looks.
      const place = (now.label ?? "").replace(/ · offline$/, "").replace(/(^|[\s-])(\p{Ll})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());
      const top = h("span", { class: "card-weather" }, weatherIcon(now.icon, wide ? 52 : 44), h("span", { class: "card-temp" }, now.value));
      if (wide) box.replaceChildren(top, h("span", { class: "card-words" }, said(place ? `${words} in ${place}` : words)));
      else box.replaceChildren(top);
      box.classList.add("card-weather-on");
    });
    return box;
  }
  if (isBuiltin(app, MUSIC)) {
    void screen.music("now").then(async (reply) => {
      const now = reply.now as { title: string; artist: string; albumId: string | null; playing: boolean } | null | undefined;
      if (!now) return;
      const cover = h("span", { class: "card-cover" });
      if (now.albumId) void screen.music("cover", { key: now.albumId }).then((found) => typeof found.cover === "string" && cover.replaceChildren(h("img", { src: found.cover, alt: "" })));
      box.replaceChildren(
        cover,
        wide ? h("span", { class: "card-music" }, h("span", { class: "card-title" }, named(now.title)), h("span", { class: "card-words" }, named(now.artist))) : icon(now.playing ? "pause" : "play", 40),
      );
      box.classList.add("card-music-on");
    });
    return box;
  }
  if (isBuiltin(app, NEW)) {
    void tileData(app, "l").then((data) => {
      const posters = (data?.entries ?? []).filter((entry) => entry.image).slice(0, 3);
      if (!posters.length) return;
      box.replaceChildren(h("span", { class: "card-posters" }, ...posters.map((entry) => h("img", { src: daemon.image(app.id, entry.image!), alt: "" }))));
    });
    return box;
  }
  return box;
}
