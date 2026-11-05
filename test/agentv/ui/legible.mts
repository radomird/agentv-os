// Shared by the legibility checks: each Omarchy theme's colours as the TV
// gets them, and every piece of text on a page that's hard to read, with
// WCAG's bar: 4.5 : 1, or 3 : 1 for large text (24 px, or 19 px bold).

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { ROOT } from "./box.mts";

export const THEMES = readdirSync(join(ROOT, "themes")).sort();
const TEMPLATE = readFileSync(join(ROOT, "config/omarchy/themed/launcher.css.tpl"), "utf8");

// The TV's colours for a theme, as Omarchy renders AgenTV's template.
export function rendered(theme: string): string {
  const out = execFileSync(join(ROOT, "bin/omarchy-theme-color"), ["--file", join(ROOT, "themes", theme, "colors.toml"), "--all"], {
    env: { ...process.env, OMARCHY_PATH: ROOT },
    encoding: "utf8",
  });
  const colors: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const [key, value] = line.split("\t");
    if (/^[a-z_]+$/.test(key ?? "") && /^#[0-9a-fA-F]{3,8}$/.test(value ?? "")) colors[key] = value;
  }
  return TEMPLATE.replace(/\{\{ *([a-z_]+) *\}\}/g, (_, key) => colors[key] ?? "#000000");
}

export interface Short {
  text: string;
  ratio: number;
  needs: number;
  color: string;
  behind: string;
}

// Every piece of text on the page that falls short of its bar.
export function shortfalls(page: Page): Promise<Short[]> {
  return page.evaluate(() => {
    const parse = (value: string): [number, number, number, number] | null => {
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(value);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
    };
    const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] =>
      [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])) as [number, number, number];
    const luminance = (c: [number, number, number]) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // What's behind an element: its own background and its ancestors',
    // each laid over the next, down to the page's.
    const behind = (el: Element): [number, number, number] => {
      const layers: [number, number, number, number][] = [];
      for (let at: Element | null = el; at; at = at.parentElement) {
        const colour = parse(getComputedStyle(at).backgroundColor);
        if (colour && colour[3] > 0) layers.push(colour);
        if (colour && colour[3] >= 1) break;
      }
      let base: [number, number, number] = parse(getComputedStyle(document.body).backgroundColor)?.slice(0, 3) as [number, number, number];
      for (const layer of layers.reverse()) base = over(layer, base);
      return base;
    };
    const opacity = (el: Element) => {
      let o = 1;
      for (let at: Element | null = el; at; at = at.parentElement) o *= Number(getComputedStyle(at).opacity);
      return o;
    };
    const found: Short[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const own = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
      if (!own || el.closest("#ambient, #updating, #toasts, svg, [aria-hidden='true']")) continue;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!box.width || !box.height || style.visibility !== "visible" || box.bottom < 0 || box.top > innerHeight) continue;
      const fg = parse(style.color);
      if (!fg) continue;
      const bg = behind(el);
      const text = over([fg[0], fg[1], fg[2], fg[3] * opacity(el)], bg);
      const [a, b] = [luminance(text), luminance(bg)].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      const needs = large ? 3 : 4.5;
      if (ratio < needs) found.push({ text: el.textContent!.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, needs, color: style.color, behind: `rgb(${bg.map(Math.round).join(", ")})` });
    }
    return found;
  });
}

