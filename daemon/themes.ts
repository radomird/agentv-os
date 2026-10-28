// The looks setup and Settings offer (ADR-048, board 12): every theme
// Omarchy has, the ones it ships and any installed on its desktop, each with
// the colours its preview draws, and which one the TV has now. Tokyo Night
// comes first. The theme is Omarchy's to set: picking one runs
// omarchy-theme-set through the screen daemon, and the colours come back to
// the TV the way every theme change does (ADR-012, S5.2).
//
// The daemon can't read the person's own themes folder, so the screen
// daemon, in the TV session, reads both folders with Omarchy's own colour
// resolver and hands the list over (omarchy-themes.ts). Until it has, the
// looks are the themes Omarchy ships, read here.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Omarchy's default, first in every list.
export const FIRST = "tokyo-night";

// A theme's name, as omarchy-theme-install allows it.
export const THEME_NAME = /^[a-z0-9_][a-z0-9._+-]{0,63}$/;

// More than any box would have, so a list that's longer isn't taken. It
// fits in a request the daemon takes.
const MOST = 150;

// The colours a preview draws: the screen, the focus, the tiles' edges and
// the status bar, and whether it's light or dark.
export const KEYS = ["background", "dark_background", "accent", "selection", "foreground", "bright_foreground"] as const;

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

// A look's preview from its colors.toml, or null when it lacks a colour
// the preview draws.
export function themePreview(id: string, name: string, note: string, text: string): ThemePreview | null {
  const { mode, colors } = parseColors(text);
  if (!KEYS.every((key) => colors[key])) return null;
  return { id, name, note, mode, colors: Object.fromEntries(KEYS.map((key) => [key, colors[key]])) as ThemePreview["colors"] };
}

// A theme's name on the TV, as Omarchy's menu shows it but in the TV's
// lower case: "tokyo-night" is "tokyo night".
export function lookName(id: string): string {
  return id.replace(/[-_]+/g, " ").trim();
}

// What a look's card says under its name.
function lookNote(id: string, mode: "light" | "dark", installed: boolean): string {
  if (id === FIRST) return "default";
  return installed ? "installed" : mode;
}

// Tokyo Night first, then the rest by name.
export function ordered(looks: ThemePreview[]): ThemePreview[] {
  return [...looks].sort((a, b) => (a.id === FIRST ? -1 : b.id === FIRST ? 1 : a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
}

// The themes Omarchy ships, from its themes folder, for until the screen
// daemon hands over the whole list.
export async function previews(omarchy: string): Promise<ThemePreview[]> {
  const dir = join(omarchy, "themes");
  const found: ThemePreview[] = [];
  for (const id of await readdir(dir).catch(() => [] as string[])) {
    if (!THEME_NAME.test(id)) continue;
    const text = await readFile(join(dir, id, "colors.toml"), "utf8").catch(() => null);
    const preview = text === null ? null : themePreview(id, lookName(id), "", text);
    if (preview) found.push({ ...preview, note: lookNote(id, preview.mode, false) });
  }
  return ordered(found);
}

// The list the screen daemon handed over, checked: names Omarchy allows,
// the colours a preview draws as plain colours, and no more than a box would
// have. Null when it isn't a list at all.
export function cleanFound(body: unknown): ThemePreview[] | null {
  const list = (body as { themes?: unknown } | null)?.themes;
  if (!Array.isArray(list) || list.length > MOST) return null;
  const looks = new Map<string, ThemePreview>();
  for (const item of list as Record<string, unknown>[]) {
    const id = item?.id;
    const colors = item?.colors as Record<string, unknown> | undefined;
    if (typeof id !== "string" || !THEME_NAME.test(id) || !colors || typeof colors !== "object") continue;
    if (!KEYS.every((key) => typeof colors[key] === "string" && COLOUR.test(colors[key] as string))) continue;
    const mode = item.mode === "light" ? "light" : "dark";
    looks.set(id, {
      id,
      name: lookName(id),
      note: lookNote(id, mode, item.installed === true),
      mode,
      colors: Object.fromEntries(KEYS.map((key) => [key, (colors[key] as string).toLowerCase()])) as ThemePreview["colors"],
    });
  }
  return ordered([...looks.values()]);
}

// Which of them the TV has: the theme Omarchy set last, as its hook said
// when it handed the colours over, or failing that, the one whose colours
// the TV was handed last.
export function currentTheme(css: string, looks: ThemePreview[], name?: string | null): string | null {
  if (name && looks.some((look) => look.id === name)) return name;
  const value = (key: string) => new RegExp(`--${key}:\\s*(#[0-9a-fA-F]{3,8})`).exec(css)?.[1]?.toLowerCase();
  const background = value("background");
  const accent = value("accent");
  const foreground = value("foreground");
  return looks.find((look) => look.colors.background === background && look.colors.accent === accent && look.colors.foreground === foreground)?.id ?? null;
}
