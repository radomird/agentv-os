// The new remote's icons (D4): line drawings on a 24 × 24 grid, in the
// colour of the text around them, so each look and theme colours them.

const NS = "http://www.w3.org/2000/svg";

// Each icon's paths; a path starting with "fill:" is filled, not stroked.
const ICONS = {
  back: ["M15 5l-7 7 7 7"],
  home: ["M4 10.5L12 4l8 6.5V20h-5.5v-5.5h-5V20H4z"],
  play: ["fill:M3.5 5.5v13l8-6.5z", "M15 6v12M20 6v12"],
  pause: ["M8 5v14M16 5v14"],
  next: ["fill:M5 5.5v13l9-6.5z", "M18.5 5.5v13"],
  ask: ["M11 3.5l1.9 5.1 5.1 1.9-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z", "M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"],
  dpad: ["M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6z"],
  menu: ["M4 7h16M4 12h16M4 17h16"],
  up: ["M6 15l6-6 6 6"],
  down: ["M6 9l6 6 6-6"],
  left: ["M15 6l-6 6 6 6"],
  right: ["M9 6l6 6-6 6"],
  more: ["M9 6l6 6-6 6"],
  pointer: ["fill:M6 3.5l12 7-5.2 1.5L10 17.5z"],
  tv: ["M3.5 5.5h17v11h-17z", "M8 20.5h8"],
  lock: ["M6.5 11h11v9h-11z", "M8 11V8a4 4 0 0 1 8 0v3"],
  info: ["M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z", "M12 11v5.5M12 7.5v.01"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
  share: ["M12 15V4M7.5 8.5L12 4l4.5 4.5", "M5 13v6h14v-6"],
  apps: ["M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z"],
  settings: [
    "M21.9 10.6L21.68 14.5L19.36 13.9L18.07 16.57L19.99 18.01L17.08 20.61L15.86 18.55L13.06 19.53L13.4 21.9L9.5 21.68L10.1 19.36L7.43 18.07L5.99 19.99L3.39 17.08L5.45 15.86L4.47 13.06L2.1 13.4L2.32 9.5L4.64 10.1L5.93 7.43L4.01 5.99L6.92 3.39L8.14 5.45L10.94 4.47L10.6 2.1L14.5 2.32L13.9 4.64L16.57 5.93L18.01 4.01L20.61 6.92L18.55 8.14L19.53 10.94Z",
    "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z",
  ],
  sound: ["M4 9.5h3.5L12 5.5v13l-4.5-4H4z", "M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"],
} as const;

export type Icon = keyof typeof ICONS;

export function icon(name: Icon, size = 24): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", `icon icon-${name}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  for (const d of ICONS[name]) {
    const path = document.createElementNS(NS, "path");
    const filled = d.startsWith("fill:");
    path.setAttribute("d", filled ? d.slice(5) : d);
    path.setAttribute("fill", filled ? "currentColor" : "none");
    path.setAttribute("stroke", filled ? "none" : "currentColor");
    path.setAttribute("stroke-width", name === "pause" ? "3.2" : "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}
