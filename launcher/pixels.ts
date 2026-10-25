// The launcher's own pixel set (ADR-014, ADR-016): the icons an app's tile()
// can name, drawn here in the Omarchy theme's colours, so no app sends a
// picture of its own for them. The ten weather scenes are canvas board 25's
// (ADR-015, ADR-016), on a 20 × 14 grid.

const NS = "http://www.w3.org/2000/svg";

type Ink = "yellow" | "bright-foreground" | "foreground" | "dark-foreground" | "muted" | "blue" | "bright-cyan" | "green";

interface Icon {
  label: string;
  width: number;
  height: number;
  paths: [Ink, string][];
}

const CLOUD_DARK = "M9 1h3v1h-3zM7 2h7v1h-7zM6 3h9v1h-9zM5 4h11v1h-11zM4 5h12v1h-12zM5 6h10v1h-10z";

const ICONS: Record<string, Icon> = {
  clear: {
    label: "clear",
    width: 20,
    height: 14,
    paths: [["yellow", "M9 2h1v1h-1zM6 3h1v1h-1zM12 3h1v1h-1zM8 4h3v1h-3zM7 5h5v1h-5zM5 6h1v1h-1zM7 6h5v1h-5zM13 6h1v1h-1zM7 7h5v1h-5zM8 8h3v1h-3zM6 9h1v1h-1zM12 9h1v1h-1zM9 10h1v1h-1z"]],
  },
  "clear-night": {
    label: "clear night",
    width: 20,
    height: 14,
    paths: [
      ["bright-foreground", "M9 3h3v1h-3zM8 4h2v1h-2zM7 5h2v1h-2zM7 6h2v1h-2zM7 7h2v1h-2zM8 8h2v1h-2zM9 9h3v1h-3z"],
      ["foreground", "M15 1h1v1h-1zM3 2h1v1h-1zM11 2h1v1h-1zM17 6h1v1h-1zM2 9h1v1h-1zM13 10h1v1h-1z"],
    ],
  },
  "partly-cloudy": {
    label: "partly cloudy",
    width: 20,
    height: 14,
    paths: [
      ["yellow", "M13 0h1v1h-1zM10 1h1v1h-1zM16 1h1v1h-1zM12 2h3v1h-3zM11 3h5v1h-5zM9 4h1v1h-1zM11 4h5v1h-5zM17 4h1v1h-1zM11 5h5v1h-5zM12 6h3v1h-3zM16 7h1v1h-1z"],
      ["foreground", "M8 6h3v1h-3zM6 7h7v1h-7zM5 8h9v1h-9zM4 9h11v1h-11zM3 10h12v1h-12zM4 11h10v1h-10z"],
    ],
  },
  cloudy: {
    label: "cloudy",
    width: 20,
    height: 14,
    paths: [
      ["dark-foreground", "M12 2h3v1h-3zM10 3h7v1h-7zM9 4h9v1h-9zM8 5h11v1h-11zM10 6h9v1h-9zM12 7h6v1h-6z"],
      ["foreground", "M7 6h3v1h-3zM5 7h7v1h-7zM4 8h9v1h-9zM3 9h11v1h-11zM2 10h12v1h-12zM3 11h10v1h-10z"],
    ],
  },
  rain: {
    label: "rain",
    width: 20,
    height: 14,
    paths: [
      ["dark-foreground", CLOUD_DARK],
      ["blue", "M9 8h1v1h-1zM15 8h1v1h-1zM6 9h1v1h-1zM12 9h1v1h-1zM10 11h1v1h-1zM16 11h1v1h-1zM7 12h1v1h-1zM13 12h1v1h-1zM5 13h1v1h-1z"],
    ],
  },
  "heavy-rain": {
    label: "heavy rain",
    width: 20,
    height: 14,
    paths: [
      ["muted", "M9 0h3v1h-3zM7 1h7v1h-7zM6 2h9v1h-9z"],
      ["dark-foreground", "M5 3h11v1h-11zM4 4h12v1h-12zM4 5h13v1h-13zM5 6h11v1h-11z"],
      ["blue", "M6 8h1v1h-1zM5 9h1v1h-1zM9 8h1v1h-1zM8 9h1v1h-1zM12 8h1v1h-1zM11 9h1v1h-1zM15 8h1v1h-1zM14 9h1v1h-1zM7 11h1v1h-1zM6 12h1v1h-1zM10 11h1v1h-1zM9 12h1v1h-1zM13 11h1v1h-1zM12 12h1v1h-1zM16 11h1v1h-1zM15 12h1v1h-1zM4 12h1v1h-1zM3 13h1v1h-1z"],
    ],
  },
  snow: {
    label: "snow",
    width: 20,
    height: 14,
    paths: [
      ["foreground", CLOUD_DARK],
      ["bright-foreground", "M6 8h1v1h-1zM10 8h1v1h-1zM14 8h1v1h-1zM5 9h3v1h-3zM9 9h3v1h-3zM13 9h3v1h-3zM6 10h1v1h-1zM10 10h1v1h-1zM14 10h1v1h-1zM8 11h1v1h-1zM12 11h1v1h-1zM16 11h1v1h-1zM7 12h3v1h-3zM11 12h3v1h-3zM15 12h3v1h-3zM8 13h1v1h-1zM12 13h1v1h-1zM16 13h1v1h-1z"],
    ],
  },
  thunderstorm: {
    label: "thunderstorm",
    width: 20,
    height: 14,
    paths: [
      ["dark-foreground", CLOUD_DARK],
      ["yellow", "M11 7h2v1h-2zM10 8h2v1h-2zM9 9h3v1h-3zM10 10h2v1h-2zM10 11h1v1h-1zM9 12h1v1h-1z"],
      ["blue", "M6 9h1v1h-1zM15 9h1v1h-1zM7 12h1v1h-1zM16 12h1v1h-1z"],
    ],
  },
  wind: {
    label: "windy",
    width: 20,
    height: 14,
    paths: [
      ["foreground", "M2 4h10v1h-10zM12 3h1v1h-1zM13 2h1v1h-1zM12 1h1v1h-1zM10 1h2v1h-2zM9 2h1v1h-1zM4 11h7v1h-7zM13 11h2v1h-2z"],
      ["bright-cyan", "M1 7h15v1h-15zM16 8h1v1h-1zM17 9h1v1h-1zM16 10h1v1h-1zM14 10h2v1h-2zM13 9h1v1h-1z"],
      ["green", "M16 3h2v1h-2zM17 4h1v1h-1z"],
    ],
  },
  fog: {
    label: "fog",
    width: 20,
    height: 14,
    paths: [["dark-foreground", "M2 3h12v1h-12zM5 6h13v1h-13zM1 9h11v1h-11zM6 12h11v1h-11z"]],
  },
};

export function hasPixel(name: string | undefined): boolean {
  return name !== undefined && Object.hasOwn(ICONS, name);
}

// An icon from the set, the given number of pixels wide, or null for a name
// the set doesn't have.
export function pixel(name: string | undefined, width: number): SVGSVGElement | null {
  if (!name || !Object.hasOwn(ICONS, name)) return null;
  const icon = ICONS[name];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", `pixel pixel-${name}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", icon.label);
  svg.setAttribute("viewBox", `0 0 ${icon.width} ${icon.height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(Math.round((width * icon.height) / icon.width)));
  svg.setAttribute("shape-rendering", "crispEdges");
  for (const [ink, d] of icon.paths) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.style.fill = `var(--${ink})`;
    svg.append(path);
  }
  return svg;
}
