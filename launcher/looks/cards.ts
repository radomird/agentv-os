// What Glass's and Cinema's tiles show (D1, D2). The apps send the same data
// as for Terminal's tiles (ADR-016), and these draw it the way the two looks
// do: Clock's time, Weather's condition and temperature, what Music plays,
// New this week's posters, and an app's featured title, the first of its
// entries with a picture.

import { daemon, screen, type App, type TileAnswer, type TileData, type TileEntry } from "../api.ts";
import { clock, h } from "../dom.ts";
import { CLOCK, MUSIC, NEW, WEATHER } from "../pages/home.ts";
import { hasIcon, icon } from "./icons.ts";
import { keepAsking, showLoading } from "../loading.ts";
import { named, preview, said } from "./looks.ts";

export interface Featured {
  app: App;
  title: string; // the title's own name, or the app's
  line: string; // "continue on Jellyfin", "new on Jellyfin"
  image: string | null; // a picture to draw it with
  item?: TileEntry["item"];
  meta?: string; // under the title, as Cinema has it
}

// Each app's tile data, asked for once per home and kept for the visit. A
// tile that's still waiting for its content isn't kept: it's asked for
// again while home shows (loading.ts), and when it lands the TV says so and
// home draws again with it.
const asked = new Map<string, Promise<TileAnswer>>();
const asking = new Set<string>();

export function tileAnswer(app: App, size: "s" | "m" | "l"): Promise<TileAnswer> {
  const key = `${app.id}:${size}`;
  let found = asked.get(key);
  if (!found) {
    const ask = () => daemon.tileAnswer(app.id, size).catch(() => ({ tile: null, waiting: true }));
    found = ask();
    const first = found;
    asked.set(key, found);
    // Asked again next time home draws, a minute on.
    setTimeout(() => asked.get(key) === first && asked.delete(key), 60_000);
    void found.then((answer) => {
      if (!answer.waiting) return;
      if (asked.get(key) === first) asked.delete(key);
      if (asking.has(key)) return;
      asking.add(key);
      keepAsking(
        async () => {
          const waiting = (await ask()).waiting;
          if (!waiting) asking.delete(key);
          return waiting;
        },
        () => {
          // Only while home shows. Away from it, the asking stops, and
          // starts again with home's next draw.
          const home = document.body.classList.contains("on-home");
          if (!home) asking.delete(key);
          return home;
        },
      );
    });
  }
  return found;
}

export function tileData(app: App, size: "s" | "m" | "l"): Promise<TileData | null> {
  return tileAnswer(app, size).then((answer) => answer.tile);
}

// A tile changed on the TV's side: every tile is asked for again.
export function forgetTiles(): void {
  asked.clear();
}

// The mark on a card while its content is on the way.
function loadingUntil(box: HTMLElement, name: string, answer: Promise<TileAnswer>): void {
  if (preview()) return;
  const loaded = showLoading(box, name);
  void answer.then((found) => !found.waiting && loaded());
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
    const answer = tileAnswer(app, "s");
    loadingUntil(box, `${app.id}:s`, answer);
    void answer.then(({ tile: data }) => {
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
    const answer = tileAnswer(app, "l");
    loadingUntil(box, `${app.id}:l`, answer);
    void answer.then(({ tile: data }) => {
      const posters = (data?.entries ?? []).filter((entry) => entry.image).slice(0, 3);
      if (!posters.length) return;
      box.replaceChildren(h("span", { class: "card-posters" }, ...posters.map((entry) => h("img", { src: daemon.image(app.id, entry.image!), alt: "" }))));
    });
    return box;
  }
  return box;
}
