// AgenTV's UI icons (ADR-014): one colour each, in the theme's colours
// through currentColor, drawn as pixel art on a 12 × 12 grid, like the
// launcher's weather scenes (pixels.ts). The home screen and the phone
// companion share them, so a button looks the same on both.

const NS = "http://www.w3.org/2000/svg";

const GLYPHS = {
  "up": "M5 3h2v1h-2zM4 4h4v1h-4zM3 5h6v1h-6zM2 6h3v1h-3zM7 6h3v1h-3zM1 7h3v1h-3zM8 7h3v1h-3zM1 8h2v1h-2zM9 8h2v1h-2z",
  "down": "M1 3h2v1h-2zM9 3h2v1h-2zM1 4h3v1h-3zM8 4h3v1h-3zM2 5h3v1h-3zM7 5h3v1h-3zM3 6h6v1h-6zM4 7h4v1h-4zM5 8h2v1h-2z",
  "left": "M7 1h2v1h-2zM6 2h3v1h-3zM5 3h3v1h-3zM4 4h3v1h-3zM3 5h3v1h-3zM3 6h3v1h-3zM4 7h3v1h-3zM5 8h3v1h-3zM6 9h3v1h-3zM7 10h2v1h-2z",
  "right": "M3 1h2v1h-2zM3 2h3v1h-3zM4 3h3v1h-3zM5 4h3v1h-3zM6 5h3v1h-3zM6 6h3v1h-3zM5 7h3v1h-3zM4 8h3v1h-3zM3 9h3v1h-3zM3 10h2v1h-2z",
  "back": "M3 1h1v1h-1zM2 2h2v1h-2zM1 3h8v1h-8zM1 4h9v1h-9zM2 5h2v1h-2zM9 5h2v1h-2zM3 6h1v1h-1zM10 6h2v1h-2zM10 7h2v1h-2zM10 8h2v1h-2zM9 9h2v1h-2zM3 10h7v1h-7zM3 11h6v1h-6z",
  "home": "M5 0h2v1h-2zM4 1h4v1h-4zM3 2h2v1h-2zM7 2h2v1h-2zM2 3h2v1h-2zM8 3h2v1h-2zM1 4h2v1h-2zM9 4h2v1h-2zM0 5h3v1h-3zM9 5h3v1h-3zM1 6h1v1h-1zM10 6h1v1h-1zM1 7h1v1h-1zM4 7h4v1h-4zM10 7h1v1h-1zM1 8h1v1h-1zM4 8h1v1h-1zM7 8h1v1h-1zM10 8h1v1h-1zM1 9h1v1h-1zM4 9h1v1h-1zM7 9h1v1h-1zM10 9h1v1h-1zM1 10h1v1h-1zM4 10h1v1h-1zM7 10h1v1h-1zM10 10h1v1h-1zM1 11h4v1h-4zM7 11h4v1h-4z",
  "play-pause": "M1 2h1v1h-1zM6 2h2v1h-2zM9 2h2v1h-2zM1 3h2v1h-2zM6 3h2v1h-2zM9 3h2v1h-2zM1 4h3v1h-3zM6 4h2v1h-2zM9 4h2v1h-2zM1 5h4v1h-4zM6 5h2v1h-2zM9 5h2v1h-2zM1 6h4v1h-4zM6 6h2v1h-2zM9 6h2v1h-2zM1 7h3v1h-3zM6 7h2v1h-2zM9 7h2v1h-2zM1 8h2v1h-2zM6 8h2v1h-2zM9 8h2v1h-2zM1 9h1v1h-1zM6 9h2v1h-2zM9 9h2v1h-2z",
  "backspace": "M3 2h8v1h-8zM2 3h2v1h-2zM10 3h1v1h-1zM1 4h2v1h-2zM5 4h1v1h-1zM8 4h1v1h-1zM10 4h1v1h-1zM0 5h2v1h-2zM6 5h2v1h-2zM10 5h1v1h-1zM0 6h2v1h-2zM6 6h2v1h-2zM10 6h1v1h-1zM1 7h2v1h-2zM5 7h1v1h-1zM8 7h1v1h-1zM10 7h1v1h-1zM2 8h2v1h-2zM10 8h1v1h-1zM3 9h8v1h-8z",
  "enter": "M10 2h2v1h-2zM10 3h2v1h-2zM3 4h1v1h-1zM10 4h2v1h-2zM2 5h2v1h-2zM10 5h2v1h-2zM1 6h11v1h-11zM1 7h11v1h-11zM2 8h2v1h-2zM3 9h1v1h-1z",
  "mic": "M5 1h2v1h-2zM4 2h4v1h-4zM4 3h4v1h-4zM4 4h4v1h-4zM2 5h1v1h-1zM4 5h4v1h-4zM9 5h1v1h-1zM2 6h1v1h-1zM4 6h4v1h-4zM9 6h1v1h-1zM3 7h1v1h-1zM8 7h1v1h-1zM4 8h4v1h-4zM5 9h2v1h-2zM5 10h2v1h-2zM4 11h4v1h-4z",
  "keyboard": "M0 2h12v1h-12zM0 3h1v1h-1zM11 3h1v1h-1zM0 4h1v1h-1zM2 4h2v1h-2zM5 4h2v1h-2zM8 4h2v1h-2zM11 4h1v1h-1zM0 5h1v1h-1zM11 5h1v1h-1zM0 6h1v1h-1zM2 6h2v1h-2zM5 6h2v1h-2zM8 6h2v1h-2zM11 6h1v1h-1zM0 7h1v1h-1zM11 7h1v1h-1zM0 8h1v1h-1zM2 8h8v1h-8zM11 8h1v1h-1zM0 9h1v1h-1zM11 9h1v1h-1zM0 10h12v1h-12z",
  "remote": "M4 0h4v1h-4zM4 1h1v1h-1zM7 1h1v1h-1zM4 2h1v1h-1zM7 2h1v1h-1zM0 3h5v1h-5zM7 3h5v1h-5zM0 4h1v1h-1zM11 4h1v1h-1zM0 5h1v1h-1zM5 5h2v1h-2zM11 5h1v1h-1zM0 6h1v1h-1zM5 6h2v1h-2zM11 6h1v1h-1zM0 7h1v1h-1zM11 7h1v1h-1zM0 8h5v1h-5zM7 8h5v1h-5zM4 9h1v1h-1zM7 9h1v1h-1zM4 10h1v1h-1zM7 10h1v1h-1zM4 11h4v1h-4z",
  "grid": "M1 1h4v1h-4zM7 1h4v1h-4zM1 2h4v1h-4zM7 2h4v1h-4zM1 3h4v1h-4zM7 3h4v1h-4zM1 4h4v1h-4zM7 4h4v1h-4zM1 7h4v1h-4zM7 7h4v1h-4zM1 8h4v1h-4zM7 8h4v1h-4zM1 9h4v1h-4zM7 9h4v1h-4zM1 10h4v1h-4zM7 10h4v1h-4z",
  "lock": "M4 0h4v1h-4zM3 1h1v1h-1zM8 1h1v1h-1zM3 2h1v1h-1zM8 2h1v1h-1zM3 3h1v1h-1zM8 3h1v1h-1zM1 4h10v1h-10zM1 5h10v1h-10zM1 6h4v1h-4zM7 6h4v1h-4zM1 7h4v1h-4zM7 7h4v1h-4zM1 8h5v1h-5zM7 8h4v1h-4zM1 9h10v1h-10zM1 10h10v1h-10z",
  "download": "M5 0h2v1h-2zM5 1h2v1h-2zM5 2h2v1h-2zM2 3h1v1h-1zM5 3h2v1h-2zM9 3h1v1h-1zM2 4h2v1h-2zM5 4h2v1h-2zM8 4h2v1h-2zM3 5h6v1h-6zM4 6h4v1h-4zM5 7h2v1h-2zM0 9h1v1h-1zM11 9h1v1h-1zM0 10h1v1h-1zM11 10h1v1h-1zM0 11h12v1h-12z",
  "person": "M4 0h4v1h-4zM3 1h6v1h-6zM3 2h6v1h-6zM3 3h6v1h-6zM4 4h4v1h-4zM2 6h8v1h-8zM1 7h10v1h-10zM1 8h10v1h-10zM1 9h10v1h-10zM1 10h10v1h-10z",
  "phone": "M3 0h6v1h-6zM3 1h1v1h-1zM8 1h1v1h-1zM3 2h1v1h-1zM8 2h1v1h-1zM3 3h1v1h-1zM8 3h1v1h-1zM3 4h1v1h-1zM8 4h1v1h-1zM3 5h1v1h-1zM8 5h1v1h-1zM3 6h1v1h-1zM8 6h1v1h-1zM3 7h1v1h-1zM8 7h1v1h-1zM3 8h1v1h-1zM8 8h1v1h-1zM3 9h6v1h-6zM3 10h1v1h-1zM5 10h2v1h-2zM8 10h1v1h-1zM3 11h6v1h-6z",
  "tv": "M2 1h1v1h-1zM9 1h1v1h-1zM3 2h1v1h-1zM8 2h1v1h-1zM4 3h1v1h-1zM7 3h1v1h-1zM0 4h12v1h-12zM0 5h1v1h-1zM11 5h1v1h-1zM0 6h1v1h-1zM11 6h1v1h-1zM0 7h1v1h-1zM11 7h1v1h-1zM0 8h1v1h-1zM11 8h1v1h-1zM0 9h1v1h-1zM11 9h1v1h-1zM0 10h12v1h-12z",
  "clock": "M4 0h4v1h-4zM2 1h2v1h-2zM8 1h2v1h-2zM1 2h1v1h-1zM6 2h1v1h-1zM10 2h1v1h-1zM1 3h1v1h-1zM6 3h1v1h-1zM10 3h1v1h-1zM0 4h1v1h-1zM6 4h1v1h-1zM11 4h1v1h-1zM0 5h1v1h-1zM6 5h4v1h-4zM11 5h1v1h-1zM0 6h1v1h-1zM11 6h1v1h-1zM0 7h1v1h-1zM11 7h1v1h-1zM1 8h1v1h-1zM10 8h1v1h-1zM1 9h1v1h-1zM10 9h1v1h-1zM2 10h2v1h-2zM8 10h2v1h-2zM4 11h4v1h-4z",
  "check": "M10 2h2v1h-2zM9 3h2v1h-2zM8 4h2v1h-2zM1 5h2v1h-2zM7 5h2v1h-2zM2 6h2v1h-2zM6 6h2v1h-2zM3 7h4v1h-4zM4 8h2v1h-2z",
  "plus": "M5 1h2v1h-2zM5 2h2v1h-2zM5 3h2v1h-2zM5 4h2v1h-2zM1 5h10v1h-10zM1 6h10v1h-10zM5 7h2v1h-2zM5 8h2v1h-2zM5 9h2v1h-2zM5 10h2v1h-2z",
  "minus": "M1 5h10v1h-10zM1 6h10v1h-10z",
  "next": "M2 2h1v1h-1zM9 2h2v1h-2zM2 3h2v1h-2zM9 3h2v1h-2zM2 4h3v1h-3zM9 4h2v1h-2zM2 5h4v1h-4zM9 5h2v1h-2zM2 6h4v1h-4zM9 6h2v1h-2zM2 7h3v1h-3zM9 7h2v1h-2zM2 8h2v1h-2zM9 8h2v1h-2zM2 9h1v1h-1zM9 9h2v1h-2z",
  "settings": "M5 0h2v1h-2zM1 1h2v1h-2zM4 1h4v1h-4zM9 1h2v1h-2zM1 2h10v1h-10zM2 3h3v1h-3zM7 3h3v1h-3zM1 4h3v1h-3zM8 4h3v1h-3zM0 5h4v1h-4zM8 5h4v1h-4zM0 6h4v1h-4zM8 6h4v1h-4zM1 7h3v1h-3zM8 7h3v1h-3zM2 8h3v1h-3zM7 8h3v1h-3zM1 9h10v1h-10zM1 10h2v1h-2zM4 10h4v1h-4zM9 10h2v1h-2zM5 11h2v1h-2z",
  "pointer": "M2 0h2v1h-2zM2 1h3v1h-3zM2 2h4v1h-4zM2 3h5v1h-5zM2 4h6v1h-6zM2 5h7v1h-7zM2 6h8v1h-8zM2 7h5v1h-5zM2 8h2v1h-2zM5 8h3v1h-3zM2 9h1v1h-1zM6 9h3v1h-3zM7 10h3v1h-3zM8 11h2v1h-2z",
  "wifi": "M2 1h8v1h-8zM1 2h2v1h-2zM9 2h2v1h-2zM0 3h2v1h-2zM10 3h2v1h-2zM3 4h6v1h-6zM2 5h2v1h-2zM8 5h2v1h-2zM4 7h4v1h-4zM3 8h2v1h-2zM7 8h2v1h-2zM5 10h2v1h-2zM5 11h2v1h-2z",
  // What the TV is for, from setup's goal screen (board 08).
  "film": "M2 1h1v1h-1zM2 2h2v1h-2zM2 3h3v1h-3zM2 4h4v1h-4zM2 5h5v1h-5zM2 6h5v1h-5zM2 7h4v1h-4zM2 8h3v1h-3zM2 9h2v1h-2zM2 10h1v1h-1z",
  "music": "M6 0h4v1h-4zM4 1h6v1h-6zM4 2h2v1h-2zM9 2h1v1h-1zM4 3h1v1h-1zM9 3h1v1h-1zM4 4h1v1h-1zM9 4h1v1h-1zM4 5h1v1h-1zM9 5h1v1h-1zM4 6h1v1h-1zM9 6h1v1h-1zM2 7h3v1h-3zM7 7h3v1h-3zM1 8h4v1h-4zM6 8h4v1h-4zM1 9h4v1h-4zM6 9h4v1h-4zM2 10h2v1h-2zM7 10h2v1h-2z",
  "photo": "M0 1h12v1h-12zM0 2h1v1h-1zM11 2h1v1h-1zM0 3h1v1h-1zM8 3h2v1h-2zM11 3h1v1h-1zM0 4h1v1h-1zM8 4h2v1h-2zM11 4h1v1h-1zM0 5h1v1h-1zM4 5h1v1h-1zM11 5h1v1h-1zM0 6h1v1h-1zM3 6h3v1h-3zM11 6h1v1h-1zM0 7h1v1h-1zM2 7h5v1h-5zM9 7h1v1h-1zM11 7h1v1h-1zM0 8h12v1h-12zM0 9h12v1h-12z",
  "gamepad": "M1 2h10v1h-10zM0 3h12v1h-12zM0 4h2v1h-2zM3 4h5v1h-5zM10 4h2v1h-2zM0 5h1v1h-1zM4 5h8v1h-8zM0 6h2v1h-2zM3 6h4v1h-4zM9 6h3v1h-3zM0 7h12v1h-12zM0 8h4v1h-4zM8 8h4v1h-4zM0 9h3v1h-3zM9 9h3v1h-3zM0 10h2v1h-2zM10 10h2v1h-2z",
} as const;

export type Glyph = keyof typeof GLYPHS;

// An icon, drawn the given number of pixels across. It's decoration: the
// text beside it, or the button's own label, says what it is.
export function glyph(name: Glyph, size = 24): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", `glyph glyph-${name}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("shape-rendering", "crispEdges");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", GLYPHS[name]);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

export const GLYPH_NAMES = Object.keys(GLYPHS) as Glyph[];
