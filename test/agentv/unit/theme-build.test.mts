// A theme the agent made (builder/theme.ts, the theme recipe, S6.4), as
// theme_check reads it before anything is drawn: only its colours, its
// icon set and its pictures, every colour Omarchy's templates name, text
// that reads from the couch, and scenes that keep to themselves. Layer 4
// draws them (test/agentv/ui/theme-build.test.mts).

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadRecipes } from "../../../builder/recipe.ts";
import { checkTheme, contrast, svgProblems, themeRules } from "../../../builder/theme.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-theme-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const rules = themeRules(loadRecipes(join(ROOT, "builder/recipes")).get("theme")!);
let count = 0;

// A build's work folder with the forest theme in it, changed as given.
function work(change: (theme: string) => void = () => {}): string {
  const dir = join(scratch, `work${++count}`);
  cpSync(join(ROOT, "test/agentv/fixtures/themes/forest"), join(dir, "theme"), { recursive: true });
  change(join(dir, "theme"));
  return dir;
}
const problems = async (dir: string) => (await checkTheme(dir, rules)).lines.filter((line) => line.startsWith("not ok"));

test("S6.4 the theme recipe's rules: every colour Omarchy's templates name, and only colours, icons and pictures", () => {
  assert.deepEqual(rules.files, ["colors.toml", "icons.theme", "backgrounds/*.png", "backgrounds/*.svg", "preview.png"]);
  assert.ok(rules.colors.includes("accent") && rules.colors.includes("bright_magenta"));
  assert.equal(rules.contrast, 4.5);
  assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
  assert.equal(contrast("#7aa2f7", "#7aa2f7"), 1);
});

test("S6.4 a calm forest at dusk passes the theme check, and so does the recipe's own template with a scene", async () => {
  const forest = await checkTheme(work(), rules);
  assert.deepEqual(forest.lines, ["ok: colors.toml has every colour, dark, and its text reads from the couch"]);
  assert.equal(forest.ok, true);
  assert.equal(forest.mode, "dark");
  assert.equal(forest.colors?.accent, "#e0a458");

  const template = join(scratch, "template");
  cpSync(join(ROOT, "builder/recipes/theme/template"), template, { recursive: true });
  cpSync(join(ROOT, "test/agentv/fixtures/themes/forest/backgrounds"), join(template, "theme", "backgrounds"), { recursive: true });
  assert.deepEqual(await problems(template), []);
});

test("S6.4 a theme holds nothing that runs, nothing linked, and nothing else", async () => {
  assert.match((await problems(work((t) => writeFileSync(join(t, "hyprland.lua"), "os.execute('id')"))))[0]!, /theme\/hyprland\.lua isn't something a theme here holds/);
  assert.match((await problems(work((t) => writeFileSync(join(t, "alacritty.toml"), "[terminal.shell]\nprogram = 'sh'"))))[0]!, /alacritty\.toml isn't something/);
  assert.match((await problems(work((t) => symlinkSync("/etc/agentv/env", join(t, "backgrounds", "2-key.png")))))[0]!, /is a link/);
  assert.match((await problems(work((t) => mkdirSync(join(t, "extra")))))[0]!, /theme\/extra\/ isn't something/);
  assert.match((await problems(work((t) => writeFileSync(join(t, "preview.png"), "not a picture"))))[0]!, /preview\.png isn't a PNG/);
  assert.match((await problems(work((t) => writeFileSync(join(t, "backgrounds", "2-big.svg"), `<svg>${" ".repeat(1024 * 1024)}</svg>`))))[0]!, /2-big\.svg is too big/);
  assert.match((await problems(work((t) => rmSync(join(t, "backgrounds"), { recursive: true }))))[0]!, /no background/);
  assert.match((await problems(work((t) => writeFileSync(join(t, "icons.theme"), "../../etc\n"))))[0]!, /isn't one of Omarchy's icon sets/);
});

test("S6.4 every colour is there, and the TV's text and focus read from the couch", async () => {
  const colors = (edit: (text: string) => string) => work((t) => writeFileSync(join(t, "colors.toml"), edit(readFileSync(join(t, "colors.toml"), "utf8"))));
  assert.match((await problems(colors((text) => text.replace(/^brown = .*$/m, ""))))[0]!, /no #rrggbb for brown/);
  assert.match((await problems(colors((text) => text.replace('accent = "#e0a458"', 'accent = "#fa5"'))))[0]!, /no #rrggbb for accent/);
  assert.match((await problems(colors((text) => text.replace('mode = "dark"\n', ""))))[0]!, /mode = "light" or "dark"/);
  const faint = await problems(colors((text) => text.replace('foreground = "#d8d4c3"', 'foreground = "#2a3631"')));
  assert.match(faint[0]!, /foreground on background is 1\.\d to 1, and the TV needs 4\.5 to 1/);
  assert.match((await problems(colors((text) => text.replace('accent = "#e0a458"', 'accent = "#1c2622"'))))[0]!, /accent on background is .* needs 3 to 1/);
});

test("S6.4 a scene keeps to itself: no script, no HTML, nothing from elsewhere", () => {
  const scene = readFileSync(join(ROOT, "test/agentv/fixtures/themes/forest/backgrounds/1-scene.svg"), "utf8");
  assert.deepEqual(svgProblems("scene", scene), []);
  const with_ = (inside: string) => svgProblems("scene", scene.replace("</svg>", `${inside}</svg>`));
  assert.match(with_("<script>fetch('https://example.com')</script>")[0]!, /has a script/);
  assert.match(with_('<foreignObject><iframe src="https://example.com"></iframe></foreignObject>').join(), /has HTML in it/);
  assert.match(with_('<image href="https://example.com/tree.png"/>').join(), /holds something from elsewhere/);
  assert.match(with_('<use href="https://example.com/sprite.svg#tree"/>')[0]!, /points somewhere outside itself/);
  assert.match(with_('<use xlink:href="file:///etc/agentv/env"/>')[0]!, /points somewhere outside itself/);
  assert.match(with_('<rect style="fill: url(https://example.com/x)"/>')[0]!, /in its styles/);
  assert.match(with_('<style>@import "https://example.com/a.css";</style>').join(), /imports a stylesheet/);
  assert.match(with_('<rect onclick="alert(1)"/>')[0]!, /event handler/);
  assert.match(svgProblems("scene", `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${scene}`)[0]!, /DOCTYPE or entities/);
  assert.match(svgProblems("scene", "<html></html>")[0]!, /isn't an SVG/);
  assert.deepEqual(with_('<use href="#sky"/><rect fill="url(#sun)"/>'), [], "pointing inside itself is fine");
});
