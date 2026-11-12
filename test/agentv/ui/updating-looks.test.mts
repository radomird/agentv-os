// The Updating screen in each look, in a real Chromium (ADR-019, layer 4),
// while an install runs and after one fails. At each size, in a dark theme
// and a light one:
//
// - Glass and Cinema draw it in their own design: centred, a slim rounded
//   bar, and each step's mark drawn by the look (a tick when done, a dot for
//   the one that's going, a faint ring for those to come), not Terminal's
//   "[x]", "[>]" and "[ ]";
// - Terminal's stays as it was: left-aligned, with its bracketed marks;
// - in every look it's all on the screen, nothing in it is cut off, and its
//   words read clearly.

import assert from "node:assert/strict";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";
import { rendered } from "./legible.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
const SIZES = { larger: 1600, standard: 1920, more: 2400 } as const;
const THEMES = ["tokyo-night", "catppuccin-latte"];

let browser: Browser;
let daemon: Daemon;
let url = "";
let updates = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url, updates } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", features: { looks: true } }));
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

function write(data: unknown): void {
  writeFileSync(join(updates, "progress.json.next"), JSON.stringify(data));
  renameSync(join(updates, "progress.json.next"), join(updates, "progress.json"));
}

// An install part way through, with a long version, as edge's are.
const RUNNING = {
  state: "running",
  step: "packages",
  percent: 40,
  detail: "1 of 4",
  from: { agentv: "0.2.0.r470.g1234567-1", omarchy: "4.5.0-1" },
  to: { agentv: "0.2.0.r479.g7b931248a-1" },
};

async function tv(size: keyof typeof SIZES): Promise<Page> {
  const width = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height: Math.round((width * 9) / 16) } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/?size=${size}`);
  await page.waitForSelector("html[data-look] #page .focused");
  await rest(page);
  return page;
}

interface Drawn {
  centre: number;
  title: { left: number; middle: number };
  bar: { radius: string } | null;
  marks: { shown: boolean; text: string; before: { border: string; mask: string } }[];
  offScreen: string[];
  cut: string[];
  faint: string[];
}

function drawn(page: Page): Promise<Drawn> {
  return page.evaluate(() => {
    const root = document.getElementById("updating")!;
    const style = (e: Element, pseudo?: string) => getComputedStyle(e, pseudo);
    // The headline's words, not its box, which can be as wide as the screen.
    const words = document.createRange();
    words.selectNodeContents(root.querySelector(".updating-title")!);
    const title = words.getBoundingClientRect();
    const bar = root.querySelector(".updating-bar");
    const offScreen: string[] = [];
    const cut: string[] = [];
    for (const e of root.querySelectorAll<HTMLElement>("*")) {
      const box = e.getBoundingClientRect();
      if (!box.width || !box.height || style(e).display === "none") continue;
      const name = `${e.tagName.toLowerCase()}.${e.className}`;
      if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) offScreen.push(name);
      if (!(e instanceof SVGElement) && (style(e).overflowX !== "visible" || style(e).overflowY !== "visible") && (e.scrollWidth > e.clientWidth + 2 || e.scrollHeight > e.clientHeight + 2)) cut.push(name);
    }
    // Each line of words against what's behind it: the screen's own colour,
    // laid over the page's.
    const parse = (value: string) => (/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(value) ?? []).slice(1).map((n, i) => (n === undefined ? (i === 3 ? 1 : 0) : Number(n)));
    const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
    const luminance = (c: number[]) => {
      const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const behind = over(parse(style(root).backgroundColor), parse(style(document.body).backgroundColor));
    const faint: string[] = [];
    for (const e of root.querySelectorAll<HTMLElement>(".updating-title, .updating-note, .updating-step")) {
      const text = over(parse(style(e).color), behind);
      const [a, b] = [luminance(text), luminance(behind)].sort((x, y) => y - x);
      if ((a + 0.05) / (b + 0.05) < 4.5) faint.push(`"${e.textContent!.trim().slice(0, 30)}" at ${((a + 0.05) / (b + 0.05)).toFixed(2)}`);
    }
    return {
      centre: innerWidth / 2,
      title: { left: title.left, middle: (title.left + title.right) / 2 },
      bar: bar ? { radius: style(bar).borderTopLeftRadius } : null,
      marks: [...root.querySelectorAll(".updating-step")].map((step) => {
        const b = step.querySelector("b")!;
        const before = style(step, "::before");
        return {
          shown: style(b).display !== "none",
          text: b.textContent ?? "",
          before: { border: before.borderTopWidth, mask: [before.maskImage, before.webkitMaskImage].find((one) => one?.startsWith("url(")) ?? "none" },
        };
      }),
      offScreen,
      cut,
      faint,
    };
  });
}

for (const look of LOOKS) {
  test(`the Updating screen in ${look} follows the look, fits and reads clearly at each size, dark and light`, async () => {
    await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
    const problems: string[] = [];
    try {
      for (const theme of THEMES) {
        await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) });
        for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
          const page = await tv(size);
          const at = `${theme}, ${size}`;
          try {
            write({ ...RUNNING, at: new Date().toISOString() });
            await page.waitForSelector("#updating.on .updating-step.now");
            await page.waitForTimeout(200);
            const d = await drawn(page);
            for (const one of d.offScreen) problems.push(`${at}: ${one} is off the screen`);
            for (const one of d.cut) problems.push(`${at}: ${one} cuts off what's in it`);
            for (const one of d.faint) problems.push(`${at}: ${one}`);
            if (look === "terminal") {
              // As it was: left-aligned, with its bracketed marks.
              if (Math.abs(d.title.middle - d.centre) < 40) problems.push(`${at}: Terminal's headline moved to the centre`);
              if (!d.marks.every((mark) => mark.shown) || d.marks.map((mark) => mark.text).join(" ") !== "[x] [>] [ ] [ ]") problems.push(`${at}: Terminal's marks changed: ${d.marks.map((mark) => mark.text).join(" ")}`);
            } else {
              if (Math.abs(d.title.middle - d.centre) > 2) problems.push(`${at}: the headline isn't centred`);
              if (!d.bar || d.bar.radius === "0px") problems.push(`${at}: the bar isn't rounded`);
              if (d.marks.some((mark) => mark.shown)) problems.push(`${at}: Terminal's marks show`);
              const [done, now, ...later] = d.marks;
              if (!done.before.mask.startsWith("url(")) problems.push(`${at}: the step that's done has no tick`);
              if (now.before.mask !== "none" || parseFloat(now.before.border) <= parseFloat(later[0].before.border)) problems.push(`${at}: the step that's going isn't a dot`);
              if (later.some((mark) => mark.before.mask !== "none" || parseFloat(mark.before.border) === 0)) problems.push(`${at}: the steps to come aren't rings`);
            }

            // One that failed: its headline and line, no steps.
            write({ ...RUNNING, state: "failed", percent: 0, detail: "nothing changed", at: new Date().toISOString() });
            await page.waitForFunction(() => !document.querySelector("#updating .updating-steps"));
            const failed = await drawn(page);
            for (const one of failed.offScreen) problems.push(`${at}, failed: ${one} is off the screen`);
            for (const one of failed.faint) problems.push(`${at}, failed: ${one}`);
            if (look !== "terminal" && Math.abs(failed.title.middle - failed.centre) > 2) problems.push(`${at}, failed: the headline isn't centred`);
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      rmSync(join(updates, "progress.json"), { force: true });
    }
    assert.deepEqual(problems, [], `${look}:\n${problems.join("\n")}`);
  });
}
