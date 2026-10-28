// A theme the agent made, drawn (builder/theme.ts, S6.4): theme_check draws
// each SVG scene as the 3840 x 2160 picture Omarchy and the TV show, and a
// preview of the TV in the theme at the size Omarchy's theme switcher
// shows, in a real headless Chromium. As the theme's gate, it gives the
// approval that preview, and refuses a theme it can't pass.

import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser } from "playwright-core";
import { Build } from "../../../builder/build.ts";
import { gates } from "../../../builder/gates/gates.ts";
import { loadRecipes } from "../../../builder/recipe.ts";
import { checkTheme, themeRules } from "../../../builder/theme.ts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium: playwright } = require("playwright-core") as typeof import("playwright-core");

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-theme-draw-"));
const recipe = loadRecipes(join(ROOT, "builder/recipes")).get("theme")!;
const rules = themeRules(recipe);
let browser: Browser;

// The browser layer 4 uses, without its own sandbox, as the gates' test
// starts it; on the box the builder's sandbox holds it.
const chromium = join(scratch, "chromium");
writeFileSync(chromium, `#!/bin/sh\nexec "${process.env.AGENTV_UI_BROWSER ?? "chromium"}" --no-sandbox "$@"\n`);
chmodSync(chromium, 0o755);

before(async () => {
  browser = await playwright.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});
after(async () => {
  await browser?.close();
  rmSync(scratch, { recursive: true, force: true });
});

// A PNG's size, from its header.
const size = (path: string) => {
  const png = readFileSync(path);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

// The colour at a point of a PNG, as the browser decodes it.
async function pixel(path: string, x: number, y: number): Promise<string> {
  const page = await browser.newPage();
  try {
    const source = `data:image/png;base64,${readFileSync(path).toString("base64")}`;
    return await page.evaluate(
      async ({ source, x, y }) => {
        const img = new Image();
        img.src = source;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(img, 0, 0);
        const [r, g, b] = context.getImageData(x, y, 1, 1).data;
        return `#${[r, g, b].map((c) => c!.toString(16).padStart(2, "0")).join("")}`;
      },
      { source, x, y },
    );
  } finally {
    await page.close();
  }
}

// A build's folder with the forest theme as its work, as the recipe leaves it.
function build(name: string, change: (theme: string) => void = () => {}): Build {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, "test/agentv/fixtures/themes/forest"), join(dir, "work", "theme"), { recursive: true });
  change(join(dir, "work", "theme"));
  return new Build(dir);
}

test("S6.4 theme_check draws a scene as the theme's 3840 x 2160 background, and a preview of the TV in the theme", async () => {
  const forest = build("forest", (theme) => writeFileSync(join(theme, "backgrounds", "2-plain.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#123456"/></svg>'));
  const report = await checkTheme(forest.work, rules, { chromium });
  assert.equal(report.ok, true, report.lines.join("\n"));
  assert.deepEqual(report.lines.slice(1), [
    "ok: drew theme/backgrounds/1-scene.svg as theme/backgrounds/1-scene.png, 3840 x 2160",
    "ok: drew theme/backgrounds/2-plain.svg as theme/backgrounds/2-plain.png, 3840 x 2160",
    "ok: the TV in the theme is in theme/preview.png",
  ]);
  const theme = join(forest.work, "theme");
  assert.deepEqual(size(join(theme, "backgrounds", "1-scene.png")), { width: 3840, height: 2160 });
  assert.deepEqual(size(join(theme, "preview.png")), { width: 1800, height: 1012 });
  // The scene as it is, stretched to fill the screen.
  assert.equal(await pixel(join(theme, "backgrounds", "2-plain.png"), 1920, 1080), "#123456");
  assert.equal(await pixel(join(theme, "backgrounds", "1-scene.png"), 100, 2100), "#0a0f0d");
  // The preview's focused tile has the accent round it, and its bar the dark background.
  assert.equal(await pixel(join(theme, "preview.png"), 92, 700), "#e0a458");
  assert.equal(await pixel(join(theme, "preview.png"), 900, 20), "#0f1513");
  // What it drew passes the check again.
  assert.equal((await checkTheme(forest.work, rules)).ok, true);
});

test("S6.4 a theme's gate gives the approval its preview, and refuses a theme it can't pass", async () => {
  const forest = build("gate");
  const passed = await gates(forest, recipe, { root: ROOT, chromium });
  assert.deepEqual(passed.problems, []);
  assert.equal(passed.shot, join(forest.dir, "shot.png"));
  assert.deepEqual(size(passed.shot!), { width: 1800, height: 1012 });
  assert.ok(existsSync(join(forest.work, "theme", "backgrounds", "1-scene.png")));

  const runs = build("runs", (theme) => writeFileSync(join(theme, "hyprland.lua"), "os.execute('id')"));
  const refused = await gates(runs, recipe, { root: ROOT, chromium });
  assert.match(refused.problems[0]!, /theme\/hyprland\.lua isn't something a theme here holds/);
  assert.equal(refused.shot, undefined);
  assert.ok(!existsSync(join(runs.work, "theme", "preview.png")), "nothing is drawn for a theme that fails");
});
