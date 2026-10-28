// A theme your agent made (the theme recipe, S6.4). An adult approves it on
// the phone, and root puts it in /var/lib/agentv/themes/<id>/, where anyone
// may read it: its colours, its icon set, its pictures and its preview,
// checked again against AgenTV's own rules. The screen daemon, which runs as
// the person, then hands it to Omarchy as a theme of theirs, in
// ~/.config/omarchy/themes/<name>/, and sets it with omarchy-theme-set, so
// the TV and the desktop change together (ADR-012). Look lists it beside
// Omarchy's own (ADR-048).

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseColors, type ThemePreview, themePreview } from "./themes.ts";

export const THEMES = "/var/lib/agentv/themes";

// What a made theme takes along: what Omarchy shows. The SVG scenes its
// backgrounds were drawn from stay in the build.
const FILES = /^(?:colors\.toml|icons\.theme|preview\.png|backgrounds\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.png)$/;
const FILE_MAX = 25 * 1024 * 1024;
const ID = /^local\.[a-z0-9][a-z0-9-]{0,62}$/;
// Marks the person's copy as AgenTV's, so a theme of their own is never
// written over.
const MARK = ".agentv-theme";

export interface MadeTheme {
  id: string;
  name: string;
  version: string;
}

// Omarchy's name for it: the app id without "local." or "theme-".
export function themeName(id: string): string {
  return id.replace(/^local\./, "").replace(/^theme-(?=.)/, "");
}

// The theme's files, by their paths in it: regular files only, of the kinds
// it takes along.
function themeFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string, prefix: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(join(at, name));
      if (stat.isDirectory() && path === "backgrounds") walk(join(at, name), path);
      else if (stat.isFile() && FILES.test(path) && stat.size <= FILE_MAX) found.push(path);
    }
  };
  walk(dir, "");
  return found;
}

// A copy of the theme's files at to, in place of what was there, once it's
// whole: folders 0755 and files 0644, so anyone may read it.
function copyTheme(from: string, to: string, extra: Record<string, string> = {}): void {
  const files = themeFiles(from);
  if (!files.includes("colors.toml")) throw new Error("it has no colours");
  const next = `${to}.next`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true, mode: 0o755 });
  for (const path of files) {
    if (path.startsWith("backgrounds/")) mkdirSync(join(next, "backgrounds"), { recursive: true, mode: 0o755 });
    copyFileSync(join(from, path), join(next, path));
    chmodSync(join(next, path), 0o644);
  }
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(next, name), text, { mode: 0o644 });
  rmSync(to, { recursive: true, force: true });
  renameSync(next, to);
}

// Root's part: the approved theme, from a copy of its build that root
// checked, with what it is.
export function placeTheme(from: string, themes: string, about: MadeTheme): void {
  if (!ID.test(about.id)) throw new Error("which theme");
  mkdirSync(themes, { recursive: true, mode: 0o755 });
  copyTheme(from, join(themes, about.id), { "about.json": `${JSON.stringify(about)}\n` });
}

export function removeTheme(themes: string, id: string): void {
  if (ID.test(id)) rmSync(join(themes, id), { recursive: true, force: true });
}

// The daemon's part: Look's preview of each made theme, by Omarchy's name
// for it, and its version.
export function madeThemes(themes: string): (ThemePreview & { app: string; version: string })[] {
  const found: (ThemePreview & { app: string; version: string })[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(themes).filter((entry) => ID.test(entry)).sort();
  } catch {
    return found;
  }
  for (const id of entries) {
    try {
      const about = JSON.parse(readFileSync(join(themes, id, "about.json"), "utf8")) as Partial<MadeTheme>;
      const preview = themePreview(themeName(id), String(about.name ?? themeName(id)).toLowerCase().slice(0, 40), "made by your agent", readFileSync(join(themes, id, "colors.toml"), "utf8"));
      if (preview) found.push({ ...preview, app: id, version: String(about.version ?? "") });
    } catch {}
  }
  return found;
}

// The person's part, in the screen daemon: the theme as one of theirs, by
// Omarchy's name for it, or why not. Omarchy's own themes and a theme of
// theirs by the same name are left alone.
export function takeTheme(o: { themes: string; id: string; home: string; omarchy: string }): { name?: string; error?: string } {
  if (!ID.test(o.id)) return { error: "which theme" };
  const name = themeName(o.id);
  const from = join(o.themes, o.id);
  if (!existsSync(join(from, "colors.toml"))) return { error: "it isn't on this box" };
  if (existsSync(join(o.omarchy, "themes", name))) return { error: `omarchy has a theme called ${name} already` };
  const to = join(o.home, ".config", "omarchy", "themes", name);
  const ours = () => {
    try {
      return readFileSync(join(to, MARK), "utf8").trim() === o.id;
    } catch {
      return false;
    }
  };
  if (existsSync(to) && !ours()) return { error: `you have a theme called ${name} already` };
  mkdirSync(join(o.home, ".config", "omarchy", "themes"), { recursive: true });
  try {
    copyTheme(from, to, { [MARK]: `${o.id}\n` });
  } catch (error) {
    return { error: (error as Error).message };
  }
  return { name };
}

// And when it's removed: the person's copy, if it's still AgenTV's.
export function dropTheme(o: { id: string; home: string }): void {
  if (!ID.test(o.id)) return;
  const to = join(o.home, ".config", "omarchy", "themes", themeName(o.id));
  try {
    if (readFileSync(join(to, MARK), "utf8").trim() === o.id) rmSync(to, { recursive: true, force: true });
  } catch {}
}

// The daemon's asks of the screen daemon about made themes, and its answers.
export type ThemeAsk = { kind: "take"; id: string } | { kind: "drop"; id: string };

export interface ThemeAnswer {
  ok: boolean;
  error?: string;
  name?: string; // Omarchy's name for it, once it's set
  late?: boolean; // the screen daemon didn't answer: ask again
}

// Only what an answer from the screen daemon has, within bounds.
export function cleanTheme(said: unknown): ThemeAnswer {
  const a = (typeof said === "object" && said !== null ? said : {}) as Record<string, unknown>;
  if (a.ok !== true) return { ok: false, error: typeof a.error === "string" ? a.error.slice(0, 200) : "the TV couldn't set it" };
  return { ok: true, ...(typeof a.name === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(a.name) ? { name: a.name } : {}) };
}
