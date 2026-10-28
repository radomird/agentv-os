// Every theme Omarchy ships stays legible on the TV (ADR-048, S5.8): home,
// Apps and Settings, in each of them, light ones included. Each theme's
// colours are resolved by Omarchy's own omarchy-theme-color and rendered
// into AgenTV's template, as Omarchy does when it sets the theme. Then every
// piece of text on each page is measured against what's behind it, opacity
// included, with WCAG's bar: 4.5 : 1, or 3 : 1 for large text (24 px, or
// 19 px bold).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { ROOT, startBox } from "./box.mts";

const require = createRequire(join(process.env.AGENTV_UI_MODULES ?? join(ROOT, "node_modules"), "x.js"));
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const THEMES = readdirSync(join(ROOT, "themes")).sort();
const TEMPLATE = readFileSync(join(ROOT, "config/omarchy/themed/launcher.css.tpl"), "utf8");

// The TV's colours for a theme, as Omarchy renders AgenTV's template.
function rendered(theme: string): string {
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

let browser: Browser;
let daemon: Daemon;
let url = "";

before(async () => {
  ({ daemon, url } = await startBox());
  await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "field" }) });
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

interface Short {
  text: string;
  ratio: number;
  needs: number;
  color: string;
  behind: string;
}

// Every piece of text on the page that falls short of its bar.
function shortfalls(page: Page): Promise<Short[]> {
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

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

test("S5.8 home, Apps and Settings read clearly in every theme Omarchy ships, light ones included", async () => {
  const page = await tv();
  const short: string[] = [];
  try {
    for (const theme of THEMES) {
      await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) });
      for (const [where, go] of [
        ["home", async () => page.keyboard.press("Home")],
        ["apps", async () => page.locator('.bar-link:has-text("apps")').click()],
        ["settings", async () => page.locator('.bar-link:has-text("settings")').click()],
        ["settings → look", async () => page.locator('.menu-item[data-key="look"]').click()],
      ] as const) {
        await go();
        await page.waitForTimeout(150);
        await page.evaluate(async () => {
          const link = document.getElementById("theme") as HTMLLinkElement;
          link.href = `/api/theme.css?at=${Date.now()}`;
          await new Promise((resolve) => link.addEventListener("load", resolve, { once: true }));
        });
        for (const one of await shortfalls(page)) short.push(`${theme}, ${where}: "${one.text}" ${one.ratio} of ${one.needs} (${one.color} on ${one.behind})`);
      }
      await page.keyboard.press("Home");
    }
  } finally {
    await page.close();
  }
  assert.deepEqual(short, [], `text that's hard to read:\n${short.join("\n")}`);
});
