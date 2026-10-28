// Colours for text that read in every Omarchy theme (ADR-048, S5.8). Some
// themes' accents are too faint to read as text on their own backgrounds,
// such as Catppuccin Latte's green on its light grey, or Matte Black's red on
// its black. So for each colour the TV writes text in, the daemon adds an ink
// of it: the colour itself where it reads, or else mixed towards the theme's
// own foreground just as far as it takes. And for text drawn on that colour,
// such as a monogram, whichever of the theme's background and foreground
// reads better on it. The TV's CSS takes them where they're there.

// The colours the TV writes text in.
const INKS = ["accent", "red", "orange", "yellow", "green", "cyan", "blue", "magenta", "bright-yellow", "bright-cyan", "bright-magenta"];
// What text sits on: the screen, the tiles and the panels.
const BEHIND = ["background", "dark-background", "lighter-background"];
// A little over WCAG's 3 : 1 for large text, all the TV's text is 24 px or more.
export const TARGET = 3.2;

type Rgb = [number, number, number];

function rgb(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

function hex(c: Rgb): string {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function mix(a: Rgb, b: Rgb, by: number): Rgb {
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * by) as Rgb;
}

// The theme's colours with each ink and each "on" colour added, as
// --green-ink and --green-on, after the colours it was handed.
export function legible(css: string): string {
  const vars: Record<string, Rgb> = {};
  for (const m of css.matchAll(/--([a-z][a-z0-9-]*)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    const c = rgb(m[2]);
    if (c) vars[m[1]] = c;
  }
  const ink = vars["bright-foreground"] ?? vars.foreground;
  const behind = BEHIND.map((name) => vars[name]).filter(Boolean);
  if (!ink || !vars.background || !behind.length) return css;
  const lines: string[] = [];
  for (const name of INKS) {
    const colour = vars[name];
    if (!colour) continue;
    let reads = colour;
    for (let step = 0; step <= 20; step++) {
      reads = mix(colour, ink, step / 20);
      if (Math.min(...behind.map((back) => contrast(reads, back))) >= TARGET) break;
    }
    lines.push(`  --${name}-ink: ${hex(reads)};`);
    // On it: the theme's background or foreground, whichever reads better,
    // and when neither reads well enough, that one taken towards black or
    // white, whichever the colour is further from.
    const best = contrast(vars.background, colour) >= contrast(ink, colour) ? vars.background : ink;
    const end: Rgb = contrast([0, 0, 0], colour) >= contrast([255, 255, 255], colour) ? [0, 0, 0] : [255, 255, 255];
    let on = best;
    for (let step = 0; step <= 20 && contrast(on, colour) < TARGET; step++) on = mix(best, end, step / 20);
    lines.push(`  --${name}-on: ${hex(on)};`);
  }
  return lines.length ? css.replace(/\n?\}\s*$/, `\n${lines.join("\n")}\n}\n`) : css;
}
