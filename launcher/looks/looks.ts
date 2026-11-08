// Home's three looks (ADR-063): Terminal, Glass and Cinema. Each is a folder
// here with its look.json, its look.css (the shared components in its
// style), its home.ts (home's layout from the profile's layout) and its
// bar. Every look takes its colours from the Omarchy theme, so any theme
// works in any look.
//
// The looks are behind the "looks" switch until they're signed off on the
// NUC. With it off, the launcher is phase 1's Terminal, exactly as it was.
//
// The size (ADR-062) is the logical canvas home lays out on: 1600, 1920 or
// 2400 wide. It comes from /api/display once the box has it, and the page
// zooms that canvas to fit the screen. A preview, as setup frames one, says
// its own look, size and theme in its address:
// /?preview&look=<id>&size=<size>&theme=<name>.

import { h } from "../dom.ts";
import { features } from "../features.ts";
import { writeInSentenceCase } from "./words.ts";
import { GRID, GRID_MORE, type Grid } from "../layout.ts";

export const LOOKS = ["terminal", "glass", "cinema"] as const;
export type LookId = (typeof LOOKS)[number];

export const SIZES = ["larger", "standard", "more"] as const;
export type SizeId = (typeof SIZES)[number];

// Each size's logical canvas, 16:9.
export const CANVAS: Record<SizeId, { width: number; height: number }> = {
  larger: { width: 1600, height: 900 },
  standard: { width: 1920, height: 1080 },
  more: { width: 2400, height: 1350 },
};

export interface LookInfo {
  id: LookId;
  name: string;
  line: string;
  font: string;
}

interface State {
  look: LookId | null; // null: the looks are switched off
  size: SizeId;
  preview: { theme: string | null } | null;
  all: LookInfo[];
}

const state: State = { look: null, size: "standard", preview: null, all: [] };

const isLook = (value: unknown): value is LookId => typeof value === "string" && (LOOKS as readonly string[]).includes(value);
const isSize = (value: unknown): value is SizeId => typeof value === "string" && (SIZES as readonly string[]).includes(value);

async function json<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(path);
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

// What the box has: whether the looks are on, which one, and which size.
// A preview's address wins over all three, and is read-only.
export async function loadLook(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const preview = params.has("preview");
  const switches = await features();
  // The display's size is track 4's, behind its own switch, so it's asked
  // for only once that's on.
  const [look, display] = await Promise.all([
    switches.looks || preview ? json<{ look?: string; looks?: LookInfo[] }>("/api/look") : null,
    switches.sizes ? json<{ size?: string }>("/api/display") : null,
  ]);
  state.all = (look?.looks ?? []).filter((info) => isLook(info.id));
  const asked = params.get("look");
  state.look = preview && isLook(asked) ? asked : switches.looks ? (isLook(look?.look) ? look.look : "terminal") : null;
  const size = params.get("size");
  state.size = isSize(size) ? size : isSize(display?.size) ? display.size : "standard";
  state.preview = preview ? { theme: params.get("theme") } : null;
}

// The look home is drawn in, or null when the looks are off.
export function lookId(): LookId | null {
  return state.look;
}

export function sizeId(): SizeId {
  return state.size;
}

export function preview(): { theme: string | null } | null {
  return state.preview;
}

export function looksList(): LookInfo[] {
  return state.all;
}

// The canvas the page lays out on: phase 1's 1920 × 1080 with the looks off.
export function canvas(): { width: number; height: number } {
  return state.look ? CANVAS[state.size] : CANVAS.standard;
}

// Puts the look on the page: its name and size on the root, for look.css
// and launcher.css, and its stylesheet after the launcher's own, before the
// theme's colours. Again with another look, it swaps them in place.
export function applyLook(look: LookId | null = state.look, size: SizeId = state.size): void {
  state.look = look;
  state.size = size;
  const root = document.documentElement;
  // Glass and Cinema write the launcher's words in sentence case.
  writeInSentenceCase(look === "glass" || look === "cinema");
  if (look) {
    root.dataset.look = look;
    root.dataset.size = size;
  } else {
    delete root.dataset.look;
    delete root.dataset.size;
  }
  let link = document.getElementById("look-css") as HTMLLinkElement | null;
  if (!look) {
    link?.remove();
    return;
  }
  const href = `/launcher/looks/${look}/look.css`;
  if (link?.getAttribute("href") === href) return;
  if (!link) {
    link = h("link", { rel: "stylesheet", id: "look-css" });
    document.head.insertBefore(link, document.getElementById("theme"));
  }
  link.setAttribute("href", href);
}

// A name as the look writes it: Terminal writes everything in lower case,
// as phase 1 did, and Glass and Cinema keep a name's own capitals.
export function named(name: string): string {
  return state.look === null || state.look === "terminal" ? name.toLowerCase() : name;
}

// Words the launcher writes itself, in lower case in the code: Terminal
// keeps them so, and Glass and Cinema start them with a capital.
export function said(text: string): string {
  if (state.look === null || state.look === "terminal") return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A preview of a theme the box doesn't have on yet, as setup's look step
// can ask for: that theme's colours over the box's, from the list of themes.
const PREVIEW_COLOURS: Record<string, string> = {
  background: "--background",
  dark_background: "--dark-background",
  accent: "--accent",
  selection: "--selection",
  foreground: "--foreground",
  bright_foreground: "--bright-foreground",
};

export async function previewColours(): Promise<void> {
  const theme = state.preview?.theme;
  if (!theme) return;
  const found = await json<{ themes?: { id: string; colors: Record<string, string> }[]; current?: string | null }>("/api/themes");
  const colours = found?.current === theme ? null : found?.themes?.find((one) => one.id === theme)?.colors;
  if (!colours) return;
  for (const [key, property] of Object.entries(PREVIEW_COLOURS)) {
    if (typeof colours[key] === "string") document.documentElement.style.setProperty(property, colours[key]);
  }
}

// The grid home's layout is on: Terminal at more on screen has a 5 × 4 one of
// its own (D6), and everything else the profile's 4 × 3 one.
export function currentGrid(): Grid {
  return state.look === "terminal" && state.size === "more" ? GRID_MORE : GRID;
}

// Its name, as the daemon's /api/home and /api/layout take it, or null for
// the 4 × 3 grid.
export function gridName(): string | null {
  return currentGrid() === GRID_MORE ? "5x4" : null;
}
