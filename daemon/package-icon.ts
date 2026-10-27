// A native app's logo when its package has none: the icon its installed
// package gives itself, found the way the desktop's app launcher finds it.
// Steam's package installs steam.desktop, whose Icon=steam names the icons
// it puts in the hicolor theme. Nothing is fetched or kept, and no repo
// ships the file: it's read where the package put it, so an app whose
// package isn't installed has no icon, and its tile shows its name.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { ICON_MAX } from "./site-icon.ts";

// Where packages put their desktop entries and icons, first wins: the
// system's own, then flatpak's.
export const DATA_DIRS = ["/usr/local/share", "/usr/share", "/var/lib/flatpak/exports/share"];

const TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png" };

// A package, command or icon name, which is never a path.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export interface NativeApp {
  exec?: string[];
  package?: { pacman?: string; flatpak?: string };
}

// The keys of a desktop entry's [Desktop Entry] group.
export function desktopEntry(text: string): Record<string, string> {
  const keys: Record<string, string> = {};
  let group = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      group = line;
      continue;
    }
    const at = line.indexOf("=");
    if (group === "[Desktop Entry]" && !line.startsWith("#") && at > 0) keys[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return keys;
}

// The program an Exec= line runs, without its folder: "steam" for
// "/usr/bin/steam %U".
function program(exec: string): string {
  const first = /^\s*(?:"([^"]*)"|(\S+))/.exec(exec);
  return basename(first?.[1] ?? first?.[2] ?? "");
}

function read(path: string): Record<string, string> | null {
  try {
    return desktopEntry(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Every desktop entry in a data folder, read again only when the folder
// changes, as it does when a package is installed or removed.
const scanned = new Map<string, { mtime: number; entries: Record<string, string>[] }>();
function entries(dir: string): Record<string, string>[] {
  const folder = join(dir, "applications");
  let mtime: number;
  try {
    mtime = statSync(folder).mtimeMs;
  } catch {
    return [];
  }
  const kept = scanned.get(folder);
  if (kept?.mtime === mtime) return kept.entries;
  let files: string[] = [];
  try {
    files = readdirSync(folder).filter((file) => file.endsWith(".desktop")).sort();
  } catch {
    // An empty list, then.
  }
  const found = files.map((file) => read(join(folder, file))).filter((entry): entry is Record<string, string> => entry !== null);
  scanned.set(folder, { mtime, entries: found });
  return found;
}

// The app's desktop entry: the one named after its package or command, or
// else one that runs its command. Only one with an icon counts, and not one
// a package has hidden.
export function findEntry(app: NativeApp, dirs: string[] = DATA_DIRS): Record<string, string> | null {
  const command = basename(app.exec?.[0] ?? "");
  const counts = (entry: Record<string, string> | null): entry is Record<string, string> => !!entry?.Icon && entry.Hidden !== "true";
  const names = [app.package?.flatpak, app.package?.pacman, command].filter((name): name is string => !!name && NAME.test(name));
  for (const dir of dirs) {
    for (const name of names) {
      const entry = read(join(dir, "applications", `${name}.desktop`));
      if (counts(entry)) return entry;
    }
  }
  if (!command) return null;
  for (const dir of dirs) {
    const entry = entries(dir).find((each) => counts(each) && program(each.Exec ?? "") === command);
    if (entry) return entry;
  }
  return null;
}

function usable(path: string): { path: string; type: string } | null {
  const type = TYPES[extname(path).toLowerCase()];
  if (!type) return null;
  try {
    const file = statSync(path);
    return file.isFile() && file.size > 0 && file.size <= ICON_MAX ? { path, type } : null;
  } catch {
    return null;
  }
}

function folders(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// The file an Icon= value names: a path as it is, or a name in the hicolor
// theme, largest first with scalable before them all, then in pixmaps.
// Only a PNG or an SVG, and nothing over the size a site's icon may be.
export function themeIcon(icon: string, dirs: string[] = DATA_DIRS): { path: string; type: string } | null {
  if (isAbsolute(icon)) return usable(icon);
  if (!NAME.test(icon)) return null;
  const files = TYPES[extname(icon).toLowerCase()] ? [icon] : [`${icon}.svg`, `${icon}.png`];
  const sized: { path: string; size: number }[] = [];
  for (const dir of dirs) {
    const theme = join(dir, "icons", "hicolor");
    for (const folder of folders(theme)) {
      const size = folder === "scalable" ? Infinity : Number(/^(\d+)x\1$/.exec(folder)?.[1] ?? 0);
      if (size > 0) for (const file of files) sized.push({ path: join(theme, folder, "apps", file), size });
    }
  }
  // Sorting keeps the folders' order for one size, so the first one wins.
  const candidates = sized.sort((a, b) => (a.size === b.size ? 0 : a.size < b.size ? 1 : -1)).map((each) => each.path);
  for (const dir of dirs) for (const file of files) candidates.push(join(dir, "pixmaps", file));
  for (const path of candidates) {
    const found = usable(path);
    if (found) return found;
  }
  return null;
}

// The icon a native app's installed package gives it, or null.
export function packageIcon(app: NativeApp, dirs: string[] = DATA_DIRS): { path: string; type: string } | null {
  const entry = findEntry(app, dirs);
  return entry ? themeIcon(entry.Icon, dirs) : null;
}
