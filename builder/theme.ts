// A theme the agent made (the theme recipe, ADR-046, S6.4), checked the way
// Omarchy will read it: only its colours, its icon set and its pictures,
// every colour Omarchy's templates name, and text that reads from the
// couch. Its backgrounds are the agent's own SVG scenes, drawn here as the
// pictures Omarchy and the TV show, in a headless Chromium with nothing to
// fetch, and a preview of the TV in the theme goes with the approval, as
// Omarchy's theme switcher shows it too.

import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseColors } from "../daemon/themes.ts";
import { headless } from "./gates/chromium.ts";
import type { Recipe } from "./recipe.ts";

export interface ThemeRules {
  files: string[]; // what a theme may hold, as paths in it with * for a name
  colors: string[]; // every colour colors.toml names
  contrast: number; // the foreground on the background, at least
}

// The recipe's own rules, from its tests folder.
export function themeRules(recipe: Recipe): ThemeRules {
  const data = JSON.parse(readFileSync(join(recipe.dir, recipe.tests, "required.json"), "utf8")) as Record<string, unknown>;
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  return { files: strings(data.files), colors: strings(data.colors), contrast: Number(data.contrast) || 4.5 };
}

const SIZE: Record<string, number> = { toml: 16 * 1024, theme: 1024, svg: 1024 * 1024, png: 25 * 1024 * 1024 };
const BACKGROUNDS_MAX = 8;
// The TV's focus is the accent, on the background.
const ACCENT_CONTRAST = 3;
// Omarchy's icon sets, as its own themes name them.
const ICONS = /^Yaru(?:-[a-z]+){0,2}$/;
const HEX = /^#[0-9a-f]{6}$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// How far apart two colours are to the eye, as WCAG measures it.
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

// What's wrong with an SVG scene: anything that runs, or reaches past it.
export function svgProblems(name: string, text: string): string[] {
  const problems: string[] = [];
  const has = (pattern: RegExp, why: string) => {
    if (pattern.test(text)) problems.push(`${name} ${why}`);
  };
  if (!/<svg[\s>]/i.test(text)) problems.push(`${name} isn't an SVG`);
  has(/<!DOCTYPE|<!ENTITY/i, "declares a DOCTYPE or entities");
  has(/<script[\s>]/i, "has a script");
  has(/<foreignObject[\s>]/i, "has HTML in it");
  has(/<(?:image|video|audio|iframe|embed|object)[\s>]/i, "holds something from elsewhere");
  has(/\son[a-z]+\s*=/i, "has an event handler");
  has(/\b(?:xlink:)?href\s*=\s*["']\s*(?!#)/i, "points somewhere outside itself");
  has(/url\(\s*["']?\s*(?!#)/i, "points somewhere outside itself in its styles");
  has(/@import/i, "imports a stylesheet");
  return problems;
}

// Whether a path in the theme is one the rules let it hold.
function allowed(path: string, rules: ThemeRules): boolean {
  return rules.files.some((pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")}$`).test(path));
}

export interface ThemeReport {
  ok: boolean;
  lines: string[];
  mode?: "light" | "dark";
  colors?: Record<string, string>;
}

// The theme folder, as the rules have it. With chromium, its scenes are
// drawn as pictures and its preview made, once the rest passes.
export async function checkTheme(work: string, rules: ThemeRules, o: { chromium?: string } = {}): Promise<ThemeReport> {
  const theme = join(work, "theme");
  const lines: string[] = [];
  const bad = (line: string) => lines.push(`not ok: ${line}`);
  if (!existsSync(theme)) return { ok: false, lines: ["not ok: there's no theme folder yet"] };

  // Only its colours, its icon set and its pictures, and nothing linked.
  const files: string[] = [];
  const walk = (at: string, prefix: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(join(at, name));
      // The template's empty placeholder, which keeps the folder in git.
      if (name === ".keep" && stat.isFile() && stat.size === 0) continue;
      if (stat.isSymbolicLink()) bad(`theme/${path} is a link, which a theme doesn't hold`);
      else if (stat.isDirectory()) {
        if (path === "backgrounds") walk(join(at, name), path);
        else bad(`theme/${path}/ isn't something a theme here holds`);
      } else if (!allowed(path, rules)) bad(`theme/${path} isn't something a theme here holds: only its colours, its icon set and its pictures`);
      else if (stat.size > (SIZE[path.split(".").pop() ?? ""] ?? 0)) bad(`theme/${path} is too big`);
      else files.push(path);
    }
  };
  walk(theme, "");

  // Every colour Omarchy's templates name, and text that reads from the couch.
  let mode: "light" | "dark" | undefined;
  let colors: Record<string, string> | undefined;
  if (!files.includes("colors.toml")) bad("there's no theme/colors.toml");
  else {
    const text = readFileSync(join(theme, "colors.toml"), "utf8");
    const parsed = parseColors(text);
    if (!/^\s*mode\s*=\s*"(?:light|dark)"\s*$/m.test(text)) bad('colors.toml says mode = "light" or "dark" first');
    const missing = rules.colors.filter((name) => !HEX.test(parsed.colors[name] ?? ""));
    if (missing.length) bad(`colors.toml has no #rrggbb for ${missing.join(", ")}`);
    else {
      mode = parsed.mode;
      colors = parsed.colors;
      const faint = [
        ["foreground", "background", rules.contrast],
        ["bright_foreground", "background", rules.contrast],
        ["foreground", "lighter_background", rules.contrast],
        ["accent", "background", ACCENT_CONTRAST],
      ] as const;
      let readable = true;
      for (const [name, against, least] of faint) {
        const ratio = contrast(colors[name]!, colors[against]!);
        if (ratio >= least) continue;
        readable = false;
        bad(`${name} on ${against} is ${ratio.toFixed(1)} to 1, and the TV needs ${least} to 1 to be read from the couch`);
      }
      if (readable) lines.push(`ok: colors.toml has every colour, ${mode}, and its text reads from the couch`);
    }
  }
  if (files.includes("icons.theme")) {
    const icons = readFileSync(join(theme, "icons.theme"), "utf8").trim();
    if (!ICONS.test(icons)) bad(`icons.theme names ${JSON.stringify(icons.slice(0, 40))}, which isn't one of Omarchy's icon sets, like Yaru-blue`);
  }

  // Its backgrounds: scenes that keep to themselves, and pictures that are pictures.
  const scenes = files.filter((path) => path.startsWith("backgrounds/") && path.endsWith(".svg"));
  const pictures = files.filter((path) => path.startsWith("backgrounds/") && path.endsWith(".png"));
  if (!scenes.length && !pictures.length) bad("there's no background in theme/backgrounds yet");
  if (scenes.length > BACKGROUNDS_MAX) bad(`there are ${scenes.length} scenes, and a theme has ${BACKGROUNDS_MAX} at most`);
  for (const path of scenes) for (const problem of svgProblems(`theme/${path}`, readFileSync(join(theme, path), "utf8"))) bad(problem);
  for (const path of [...pictures, ...(files.includes("preview.png") ? ["preview.png"] : [])]) {
    if (!readFileSync(join(theme, path)).subarray(0, 8).equals(PNG)) bad(`theme/${path} isn't a PNG`);
  }

  if (!lines.some((line) => line.startsWith("not ok")) && o.chromium && colors && mode) {
    try {
      for (const line of await drawTheme(theme, scenes, mode, colors, o.chromium)) lines.push(`ok: ${line}`);
    } catch (error) {
      bad(`its backgrounds couldn't be drawn: ${(error as Error).message}`);
    }
  }
  const ok = !lines.some((line) => line.startsWith("not ok"));
  return { ok, lines, ...(mode ? { mode } : {}), ...(colors ? { colors } : {}) };
}

// The TV's home in the theme, as a preview: its background, the bar and a
// row of tiles with the first one focused.
function previewPage(background: string | null, mode: string, c: Record<string, string>): string {
  const tile = (name: string, focused: boolean) =>
    `<div class="tile${focused ? " focused" : ""}"><span>${name}</span></div>`;
  return `<!doctype html><html><head><style>
html, body { margin: 0; width: 1800px; height: 1012px; overflow: hidden; color-scheme: ${mode}; }
body { background: ${c.background}; font: 600 26px monospace; color: ${c.foreground}; }
.background { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.bar { position: absolute; left: 0; right: 0; top: 0; height: 52px; background: ${c.dark_background}; border-bottom: 3px solid ${c.accent}; display: flex; align-items: center; padding: 0 28px; gap: 24px; font-size: 20px; color: ${c.bright_foreground}; }
.bar b { color: ${c.accent}; }
.tiles { position: absolute; left: 90px; right: 90px; bottom: 120px; display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 28px; }
.tile { height: 250px; background: ${c.lighter_background}; border: 3px solid ${c.selection}; border-radius: 6px; display: flex; align-items: flex-end; padding: 22px; box-sizing: border-box; }
.tile.focused { border: 6px solid ${c.accent}; }
</style></head><body>${background ? `<img class="background" src="${background}">` : ""}<div class="bar"><b>agentv</b><span>home</span><span>apps</span><span>settings</span></div>
<div class="tiles">${tile("watch", true)}${tile("music", false)}${tile("photos", false)}${tile("apps", false)}</div></body></html>`;
}

// Each scene drawn at 3840 x 2160 beside it, as backgrounds/<name>.png, and
// theme/preview.png: what it drew, a line each.
async function drawTheme(theme: string, scenes: string[], mode: "light" | "dark", colors: Record<string, string>, chromium: string): Promise<string[]> {
  const browser = headless(chromium);
  const { cdp } = browser;
  try {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
    const evaluate = async (expression: string) => {
      const reply = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result.value;
    };
    // A page drawn at its size, once its pictures are in, as a PNG.
    const shoot = async (html: string, width: number, height: number): Promise<Buffer> => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html }, sessionId);
      await evaluate("Promise.all([...document.images].map((img) => img.decode())).then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))");
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
      return Buffer.from(data, "base64");
    };
    const drawn: string[] = [];
    let first: string | null = null;
    for (const path of scenes) {
      // As a picture, an SVG runs nothing and fetches nothing.
      const source = `data:image/svg+xml;base64,${readFileSync(join(theme, path)).toString("base64")}`;
      first ??= source;
      const png = await shoot(`<!doctype html><style>html,body{margin:0;overflow:hidden}img{display:block;width:3840px;height:2160px;object-fit:cover}</style><img src="${source}">`, 3840, 2160);
      const out = path.replace(/\.svg$/, ".png");
      writeFileSync(join(theme, out), png);
      drawn.push(`drew theme/${path} as theme/${out}, 3840 x 2160`);
    }
    writeFileSync(join(theme, "preview.png"), await shoot(previewPage(first, mode, colors), 1800, 1012));
    drawn.push("the TV in the theme is in theme/preview.png");
    return drawn;
  } finally {
    await browser.close();
  }
}
