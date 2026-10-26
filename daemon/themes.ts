// The looks setup offers (board 12, Q55): three of Omarchy's own themes,
// with the colours each preview needs read from the theme itself, and which
// of them the TV has now. The theme is Omarchy's to set: picking one runs
// omarchy-theme-set through the screen daemon, and the colours come back to
// the TV the way every theme change does (ADR-012, S5.2).

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_THEMES = [
  { id: "tokyo-night", name: "tokyo night", note: "default" },
  { id: "gruvbox", name: "gruvbox", note: "warm, dark" },
  { id: "catppuccin-latte", name: "catppuccin latte", note: "light" },
] as const;

// The colours a preview draws: the screen, the focus, the tiles' edges and
// the status bar, and whether it's light or dark.
const KEYS = ["background", "dark_background", "accent", "selection", "foreground", "bright_foreground"] as const;

export interface ThemePreview {
  id: string;
  name: string;
  note: string;
  mode: "light" | "dark";
  colors: Record<(typeof KEYS)[number], string>;
}

const COLOUR = /^#[0-9a-fA-F]{3,8}$/;

// A theme's colors.toml: plain `name = "#rrggbb"` lines, and its mode.
export function parseColors(text: string): { mode: "light" | "dark"; colors: Record<string, string> } {
  const colors: Record<string, string> = {};
  let mode: "light" | "dark" = "dark";
  for (const line of text.split("\n")) {
    const found = /^\s*([a-z_]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (!found) continue;
    if (found[1] === "mode") mode = found[2] === "light" ? "light" : "dark";
    else if (COLOUR.test(found[2])) colors[found[1]] = found[2].toLowerCase();
  }
  return { mode, colors };
}

// The three looks, from Omarchy's themes folder, each one that's there.
export async function previews(omarchy: string): Promise<ThemePreview[]> {
  const found: ThemePreview[] = [];
  for (const theme of DEFAULT_THEMES) {
    const text = await readFile(join(omarchy, "themes", theme.id, "colors.toml"), "utf8").catch(() => null);
    if (text === null) continue;
    const { mode, colors } = parseColors(text);
    if (!KEYS.every((key) => colors[key])) continue;
    found.push({ ...theme, mode, colors: Object.fromEntries(KEYS.map((key) => [key, colors[key]])) as ThemePreview["colors"] });
  }
  return found;
}

// Which of them the TV has, from the colours it was handed last: its
// background and accent.
export function currentTheme(css: string, looks: ThemePreview[]): string | null {
  const value = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(css)?.[1]?.toLowerCase();
  const background = value("background");
  const accent = value("accent");
  return looks.find((look) => look.colors.background === background && look.colors.accent === accent)?.id ?? null;
}
