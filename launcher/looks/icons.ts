// Glass's and Cinema's line icons (ADR-063): one stroke each, in
// currentColor, so the theme colours them. Terminal keeps its pixel art
// (glyphs.ts, pixels.ts). They're AgenTV's own shapes, on a 24 × 24 grid,
// and none of them is Apple's or Google's.

const NS = "http://www.w3.org/2000/svg";

// Each icon is a list of shapes: a path's d, or a circle as "c cx cy r".
// A shape that starts with "f " is filled rather than stroked.
const ICONS = {
  ask: ["f M11 3l1.9 5.1 5.1 1.9-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z", "f M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"],
  apps: ["M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"],
  settings: [
    "c 12 12 3.2",
    "M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1L5.3 5.3",
    "c 12 12 7",
  ],
  play: ["f M8 5.5v13l10.5-6.5z"],
  pause: ["f M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  clear: ["c 12 12 4.2", "M12 2.5v2.5M12 19v2.5M21.5 12H19M5 12H2.5M18.7 5.3L17 7M7 17l-1.7 1.7M18.7 18.7L17 17M7 7L5.3 5.3"],
  "clear-night": ["M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"],
  "partly-cloudy": ["M8 9.5a4 4 0 0 1 7.5-1", "M8 3.5v1.5M3.5 8H5M4.8 4.8l1 1", "M7.5 20h10a3.5 3.5 0 0 0 0-7h-.3A5 5 0 0 0 7.5 14a3 3 0 0 0 0 6z"],
  cloudy: ["M6.5 19h11a4 4 0 0 0 .3-8A6 6 0 0 0 6.2 11.5 3.75 3.75 0 0 0 6.5 19z"],
  rain: ["M6.5 15h11a4 4 0 0 0 .3-8A6 6 0 0 0 6.2 7.5 3.75 3.75 0 0 0 6.5 15z", "M8.5 18l-1 2.5M12.5 18l-1 2.5M16.5 18l-1 2.5"],
  "heavy-rain": ["M6.5 13h11a4 4 0 0 0 .3-8A6 6 0 0 0 6.2 5.5 3.75 3.75 0 0 0 6.5 13z", "M7.5 16l-1.5 4M11 16l-1.5 4M14.5 16l-1.5 4M18 16l-1.5 4"],
  snow: ["M6.5 14h11a4 4 0 0 0 .3-8A6 6 0 0 0 6.2 6.5 3.75 3.75 0 0 0 6.5 14z", "c 8 18 0.9", "c 12 20 0.9", "c 16 18 0.9"],
  thunderstorm: ["M6.5 14h11a4 4 0 0 0 .3-8A6 6 0 0 0 6.2 6.5 3.75 3.75 0 0 0 6.5 14z", "M12.5 15l-2 3.5h3l-2 3.5"],
  wind: ["M3 9h11a3 3 0 1 0-3-3", "M3 13h15a3 3 0 1 1-3 3", "M3 17h7"],
  fog: ["M4 8h16M3 12h18M5 16h14M7 20h10"],
} as const;

export type LineIcon = keyof typeof ICONS;

export function hasIcon(name: string | undefined): name is LineIcon {
  return typeof name === "string" && name in ICONS;
}

export function icon(name: LineIcon, size = 28, label?: string): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", `line-icon line-${name}`);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else svg.setAttribute("aria-hidden", "true");
  for (const shape of ICONS[name] as readonly string[]) {
    const filled = shape.startsWith("f ");
    const body = filled ? shape.slice(2) : shape;
    let el: SVGElement;
    if (body.startsWith("c ")) {
      const [cx, cy, r] = body.slice(2).split(" ");
      el = document.createElementNS(NS, "circle");
      el.setAttribute("cx", cx);
      el.setAttribute("cy", cy);
      el.setAttribute("r", r);
    } else {
      el = document.createElementNS(NS, "path");
      el.setAttribute("d", body);
    }
    if (filled) {
      el.setAttribute("fill", "currentColor");
      el.setAttribute("stroke", "none");
    }
    svg.append(el);
  }
  return svg;
}
