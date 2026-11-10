// What a look's preview shows where the TV has nothing of its own yet (D3):
// in setup, before New this week has a TMDB key, the looks would be empty
// frames. A preview fills New this week with Blender Studio's open movies,
// whose posters ship in showcase/ under Creative Commons (showcase/CREDITS.md),
// so each look shows its featured title, its posters and its rows. Home
// itself never shows them, and a preview shows the TV's own titles once it
// has some.

import type { TileData } from "../api.ts";
import type { Size } from "../layout.ts";

// The built-in whose tile the stand-ins fill.
export const SHOWCASE_APP = "agentv.new";

const FILMS: [title: string, year: number, file: string][] = [
  ["Cosmos Laundromat", 2015, "cosmos-laundromat"],
  ["Sprite Fright", 2021, "sprite-fright"],
  ["Spring", 2019, "spring"],
  ["Tears of Steel", 2012, "tears-of-steel"],
  ["Sintel", 2010, "sintel"],
  ["Big Buck Bunny", 2008, "big-buck-bunny"],
  ["Elephants Dream", 2006, "elephants-dream"],
];

// The seven posters, by the address the launcher serves each at.
const POSTERS = new Set(FILMS.map(([, , file]) => `/launcher/looks/showcase/poster-${file}.jpg`));

// One of the seven posters exactly: never another address under it, such as
// one that climbs out with "..", which the launcher would then ask the
// daemon for itself.
export function isShowcaseImage(url: string): boolean {
  return POSTERS.has(url);
}

// Whether a tile's picture is one the launcher serves itself, as is: only in
// a look's preview, only on New this week's tile, and only one of the seven.
// Any other picture goes through the daemon's image route, under its app.
export function showcasePicture(app: string, url: string, inPreview: boolean): boolean {
  return inPreview && app === SHOWCASE_APP && isShowcaseImage(url);
}

// New this week's tile as the daemon sent it, or the open movies when it
// has no posters of its own.
export function showcaseTile(tile: TileData | null, size: Size): TileData | null {
  if (tile?.entries?.some((entry) => entry.image)) return tile;
  if (size === "s") return { headline: { label: "", value: String(FILMS.length) } };
  return {
    headline: { label: "" },
    entries: FILMS.map(([title, year, file]) => ({
      label: title.toLowerCase(),
      caption: `blender studio · ${year}`,
      image: `/launcher/looks/showcase/poster-${file}.jpg`,
      item: { id: `showcase-${file}`, kind: "film", title },
    })),
  };
}
