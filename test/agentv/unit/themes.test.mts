// The looks setup and Settings offer (daemon/themes.ts, ADR-048, board 12):
// every theme Omarchy has, the ones it ships and any installed on its
// desktop, Tokyo Night first, each preview in the theme's own colours as
// Omarchy's own omarchy-theme-color resolves them, and which one the TV has
// (S5.2, S5.7). The screen daemon reads the person's folder and hands the
// list over (daemon/omarchy-themes.ts), since the daemon can't.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pictureId } from "../../../daemon/backgrounds.ts";
import { contrast, legible, TARGET } from "../../../daemon/legible.ts";
import { OmarchyThemes } from "../../../daemon/omarchy-themes.ts";
import { Daemon } from "../../../daemon/server.ts";
import { cleanFound, currentTheme, parseColors, previews } from "../../../daemon/themes.ts";

const ROOT = join(import.meta.dirname, "../../..");
const SHIPPED = readdirSync(join(ROOT, "themes")).sort();
const scratch = mkdtempSync(join(tmpdir(), "agentv-themes-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The TV's colours as Omarchy renders AgenTV's template for a theme.
function rendered(theme: string): string {
  const { colors } = parseColors(readFileSync(join(ROOT, "themes", theme, "colors.toml"), "utf8"));
  return readFileSync(join(ROOT, "config/omarchy/themed/launcher.css.tpl"), "utf8").replace(/\{\{ *([a-z_]+) *\}\}/g, (_, key) => colors[key] ?? "#000000");
}

async function daemon(): Promise<{ url: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(scratch, "daemon-"));
  mkdirSync(join(dir, "root", "setup"), { recursive: true });
  const d = new Daemon({ root: join(dir, "root"), state: join(dir, "state"), port: 0, log: () => {}, builtins: null, omarchy: ROOT });
  return { url: `http://127.0.0.1:${await d.listen()}`, close: () => d.close() };
}

test("S5.7 every theme Omarchy ships is a look, Tokyo Night first and the rest by name, each in its own colours", async () => {
  const looks = await previews(ROOT);
  assert.equal(looks.length, SHIPPED.length, "all of Omarchy's themes");
  assert.deepEqual(looks.map((look) => look.id).sort(), SHIPPED);
  assert.deepEqual(looks.slice(0, 3).map((look) => [look.id, look.name, look.note, look.mode]), [
    ["tokyo-night", "tokyo night", "default", "dark"],
    ["catppuccin", "catppuccin", "dark", "dark"],
    ["catppuccin-latte", "catppuccin latte", "light", "light"],
  ]);
  const names = looks.slice(1).map((look) => look.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(looks[0].colors, { background: "#1a1b26", dark_background: "#13141c", accent: "#7aa2f7", selection: "#292e42", foreground: "#a9b1d6", bright_foreground: "#c0caf5" });
  assert.deepEqual(await previews(join(scratch, "none")), [], "a box without Omarchy's themes has none to offer");
});

test("a theme's colours are plain colours and nothing else", () => {
  const { mode, colors } = parseColors('mode = "light"\naccent = "#ABCDEF"\nbackground = "url(x)"\n# note = "#000"\nselection="#123"\n');
  assert.equal(mode, "light");
  assert.deepEqual(colors, { accent: "#abcdef", selection: "#123" });
});

test("S5.7 the list the screen daemon hands over is checked: names Omarchy allows, plain colours, the installed ones said so", () => {
  const colors = { background: "#111111", dark_background: "#000000", accent: "#ABCDEF", selection: "#222222", foreground: "#cccccc", bright_foreground: "#ffffff" };
  const looks = cleanFound({
    themes: [
      { id: "zebra", mode: "light", colors, installed: true },
      { id: "tokyo-night", mode: "dark", colors },
      { id: "../etc", colors },
      { id: ".hidden", colors },
      { id: "no-accent", colors: { ...colors, accent: undefined } },
      { id: "url", colors: { ...colors, background: "url(x)" } },
      { id: "neo_brutal+2.0", colors },
    ],
  });
  assert.deepEqual(looks?.map((look) => [look.id, look.name, look.note, look.mode]), [
    ["tokyo-night", "tokyo night", "default", "dark"],
    ["neo_brutal+2.0", "neo brutal+2.0", "dark", "dark"],
    ["zebra", "zebra", "installed", "light"],
  ]);
  assert.equal(looks?.[0].colors.accent, "#abcdef");
  assert.equal(cleanFound({ themes: "nope" }), null);
  assert.equal(cleanFound(null), null);
  assert.equal(cleanFound({ themes: Array.from({ length: 151 }, (_, i) => ({ id: `t${i}`, colors })) }), null, "more than a box would have");
});

test("S5.2 the TV says which look it has: the name Omarchy's hook sent, or else the colours it was handed last", async () => {
  const looks = await previews(ROOT);
  assert.equal(currentTheme(rendered("gruvbox"), looks), "gruvbox");
  assert.equal(currentTheme(rendered("nord"), looks), "nord", "any of Omarchy's themes, not only three");
  assert.equal(currentTheme(rendered("nord"), looks, "white"), "white", "the name the hook sent wins");
  assert.equal(currentTheme(rendered("nord"), looks, "gone"), "nord", "a name that isn't a look is passed over");
  assert.equal(currentTheme("", looks), null);

  const d = await daemon();
  try {
    const before = await (await fetch(`${d.url}/api/themes`)).json();
    assert.deepEqual([before.themes.length, before.current], [SHIPPED.length, null]);
    assert.equal((await fetch(`${d.url}/api/theme?name=rose-pine`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered("rose-pine") })).status, 200);
    assert.equal((await (await fetch(`${d.url}/api/themes`)).json()).current, "rose-pine");
    assert.equal((await fetch(`${d.url}/api/theme`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered("tokyo-night") })).status, 200);
    assert.equal((await (await fetch(`${d.url}/api/themes`)).json()).current, "tokyo-night", "an older hook without a name: from the colours");
  } finally {
    await d.close();
  }
});

// The person's home, with a theme installed on Omarchy's desktop as
// `omarchy theme install` leaves it, one of Omarchy's own changed there, and
// an older theme with only the terminal's sixteen colours.
function home(): string {
  const dir = mkdtempSync(join(scratch, "home-"));
  const themes = join(dir, ".config", "omarchy", "themes");
  mkdirSync(themes, { recursive: true });
  cpSync(join(ROOT, "themes", "nord"), join(themes, "aurora"), { recursive: true });
  writeFileSync(join(themes, "aurora", "colors.toml"), readFileSync(join(ROOT, "themes", "nord", "colors.toml"), "utf8").replace(/^accent = .*$/m, 'accent = "#a3be8c"'));
  mkdirSync(join(themes, "gruvbox"));
  writeFileSync(join(themes, "gruvbox", "colors.toml"), readFileSync(join(ROOT, "themes", "gruvbox", "colors.toml"), "utf8").replace(/^background = .*$/m, 'background = "#101010"'));
  mkdirSync(join(themes, "retro_term"));
  writeFileSync(
    join(themes, "retro_term", "colors.toml"),
    ['accent = "#33ff33"', ...Array.from({ length: 16 }, (_, i) => `color${i} = "#${(i * 16).toString(16).padStart(2, "0").repeat(3)}"`)].join("\n") + "\n",
  );
  mkdirSync(join(themes, "no-colours"));
  mkdirSync(join(themes, "Bad Name"));
  writeFileSync(join(themes, "Bad Name", "colors.toml"), 'background = "#000000"\n');
  mkdirSync(join(dir, ".local", "state", "omarchy", "current"), { recursive: true });
  return dir;
}

test("S5.7 the screen daemon finds every theme, the person's installed ones too, with Omarchy's own colour resolver", async () => {
  const person = home();
  const lister = new OmarchyThemes({ omarchy: ROOT, home: person });
  const found = await lister.list();
  const ids = found.map((theme) => theme.id).sort();
  assert.deepEqual(ids, [...SHIPPED, "aurora", "retro_term"].sort(), "Omarchy's, and the person's with colours and a name Omarchy allows");
  const by = (id: string) => found.find((theme) => theme.id === id)!;
  assert.deepEqual([by("aurora").installed, by("aurora").colors.accent], [true, "#a3be8c"]);
  assert.deepEqual([by("gruvbox").installed, by("gruvbox").colors.background], [true, "#101010"], "an installed theme wins over Omarchy's of the same name");
  assert.equal(by("nord").installed, false);
  // Omarchy's resolver gives an older theme the colours Omarchy sets it with.
  assert.equal(by("retro_term").colors.background, "#000000", "color0");
  assert.equal(by("retro_term").colors.foreground, "#707070", "color7");
  assert.equal(by("retro_term").colors.selection, "#808080", "color8");
  assert.ok(by("retro_term").colors.dark_background, "a darker background is made from it");
  assert.equal(by("catppuccin-latte").mode, "light");
  assert.ok(found.every((theme) => Object.keys(theme.colors).length <= 6), "only the colours the TV draws");
});

test("S5.7 the screen daemon hands the list to the daemon, at the start and when a theme is installed on the desktop", async () => {
  const person = home();
  const d = await daemon();
  const lines: string[] = [];
  const lister = new OmarchyThemes({ omarchy: ROOT, home: person, daemon: `${d.url}/`, settleMs: 50, retryMs: 50, log: (line) => lines.push(line) });
  try {
    await lister.start();
    const handed = await (await fetch(`${d.url}/api/themes`)).json();
    assert.equal(handed.themes.length, SHIPPED.length + 2);
    assert.equal(handed.themes[0].id, "tokyo-night");
    assert.deepEqual(handed.themes.find((look: { id: string }) => look.id === "aurora").note, "installed");

    // `omarchy theme install` clones into the folder, then sets the theme.
    cpSync(join(ROOT, "themes", "lumon"), join(person, ".config", "omarchy", "themes", "lumon-night"), { recursive: true });
    writeFileSync(join(person, ".local", "state", "omarchy", "current", "theme.name"), "lumon-night\n");
    let ids: string[] = [];
    for (let i = 0; i < 100 && !ids.includes("lumon-night"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      ids = (await (await fetch(`${d.url}/api/themes`)).json()).themes.map((look: { id: string }) => look.id);
    }
    assert.ok(ids.includes("lumon-night"), "a theme installed on the desktop is a look within moments");

    rmSync(join(person, ".config", "omarchy", "themes", "aurora"), { recursive: true });
    for (let i = 0; i < 100 && ids.includes("aurora"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      ids = (await (await fetch(`${d.url}/api/themes`)).json()).themes.map((look: { id: string }) => look.id);
    }
    assert.ok(!ids.includes("aurora"), "and one removed there goes");
  } finally {
    lister.stop();
    await d.close();
  }
  assert.deepEqual(lines, []);
});

test("the screen daemon keeps trying while the daemon isn't there yet, at the start", async () => {
  const person = home();
  const lines: string[] = [];
  const lister = new OmarchyThemes({ omarchy: ROOT, home: person, daemon: "http://127.0.0.1:1/", retryMs: 1, log: (line) => lines.push(line), resolve: async () => ({ background: "#000000" }) });
  await lister.start();
  lister.stop();
  assert.equal(lines.length, 12);
  assert.match(lines[0], /didn't take the list/);
});

// A person's home on Tokyo Night as omarchy-theme-set leaves it: the
// theme's backgrounds in the current theme, one of the person's own for
// Tokyo Night beside them, and the one Omarchy shows linked.
function themedHome(): { dir: string; state: string; mine: string; lake: string; oma: string } {
  const dir = home();
  const state = join(dir, ".local", "state", "omarchy", "current");
  const backgrounds = join(state, "theme", "backgrounds");
  mkdirSync(backgrounds, { recursive: true });
  const from = join(ROOT, "themes", "tokyo-night", "backgrounds");
  cpSync(join(from, "3-sunset-lake.png"), join(backgrounds, "3-sunset-lake.png"));
  cpSync(join(from, "6-oma.jpg"), join(backgrounds, "6-oma.jpg"));
  writeFileSync(join(backgrounds, "7-moving.gif"), "GIF89a");
  const own = join(dir, ".config", "omarchy", "backgrounds", "tokyo-night");
  mkdirSync(own, { recursive: true });
  cpSync(join(from, "5-oma-cityscape.jpg"), join(own, "mine.jpg"));
  writeFileSync(join(state, "theme.name"), "tokyo-night\n");
  symlinkSync(join(backgrounds, "6-oma.jpg"), join(state, "background"));
  return { dir, state, mine: join(own, "mine.jpg"), lake: join(backgrounds, "3-sunset-lake.png"), oma: join(backgrounds, "6-oma.jpg") };
}

test("S5.8 the screen daemon finds the theme's backgrounds as Omarchy does, the person's own first, and the one Omarchy shows", async () => {
  const person = themedHome();
  const found = await new OmarchyThemes({ omarchy: ROOT, home: person.dir }).backgrounds();
  const id = (path: string) => pictureId(readFileSync(path));
  assert.equal(found?.theme, "tokyo-night");
  assert.deepEqual(found?.files.map((file) => [file.id, file.type]), [
    [id(person.mine), "image/jpeg"],
    [id(person.lake), "image/png"],
    [id(person.oma), "image/jpeg"],
  ], "in Omarchy's order, and only what the TV can show");
  assert.equal(found?.current, id(person.oma));
  rmSync(join(person.state, "theme.name"));
  assert.equal(await new OmarchyThemes({ omarchy: ROOT, home: person.dir }).backgrounds(), null, "no theme set yet: nothing to hand over");
});

test("S5.8 the theme's backgrounds reach the daemon once each, and home follows the desktop to the next", async () => {
  const person = themedHome();
  const d = await daemon();
  const lines: string[] = [];
  const lister = new OmarchyThemes({ omarchy: ROOT, home: person.dir, daemon: `${d.url}/`, settleMs: 50, retryMs: 50, log: (line) => lines.push(line) });
  const id = (path: string) => pictureId(readFileSync(path));
  try {
    await lister.start();
    let list = await (await fetch(`${d.url}/api/backgrounds`)).json();
    assert.equal(list.source, "theme", "the theme's own, by default");
    assert.deepEqual([list.theme.name, list.theme.current, list.theme.items.length], ["tokyo-night", id(person.oma), 3]);
    assert.deepEqual(list.theme.items[0].credit, { text: "tokyo night", from: "omarchy" });
    assert.deepEqual(Buffer.from(await (await fetch(`${d.url}/api/backgrounds/${id(person.oma)}`)).arrayBuffer()), readFileSync(person.oma));

    // The desktop's next background: Omarchy links another.
    rmSync(join(person.state, "background"));
    symlinkSync(person.lake, join(person.state, "background"));
    for (let i = 0; i < 100 && list.theme.current !== id(person.lake); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      list = await (await fetch(`${d.url}/api/backgrounds`)).json();
    }
    assert.equal(list.theme.current, id(person.lake), "home follows the desktop to the next");
  } finally {
    lister.stop();
    await d.close();
  }
  assert.deepEqual(lines, []);
});

// The TV's colours for a theme as agentv-theme-sync hands them over, from
// Omarchy's own resolver.
function resolved(theme: string): string {
  const out = execFileSync(join(ROOT, "bin/omarchy-theme-color"), ["--file", join(ROOT, "themes", theme, "colors.toml"), "--all"], { env: { ...process.env, OMARCHY_PATH: ROOT }, encoding: "utf8" });
  const colors: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const [key, value] = line.split("\t");
    if (/^[a-z_]+$/.test(key ?? "") && /^#[0-9a-fA-F]{3,8}$/.test(value ?? "")) colors[key] = value;
  }
  return readFileSync(join(ROOT, "config/omarchy/themed/launcher.css.tpl"), "utf8").replace(/\{\{ *([a-z_]+) *\}\}/g, (_, key) => colors[key] ?? "#000000");
}

const value = (css: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\b`, "i").exec(css)?.[1]?.toLowerCase();
const rgbOf = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

test("S5.8 each colour the TV writes text in gets an ink that reads on the theme's backgrounds, and an on colour for text on it", () => {
  for (const theme of SHIPPED) {
    const css = legible(resolved(theme));
    for (const name of ["green", "yellow", "red", "accent", "bright-magenta", "bright-cyan"]) {
      const ink = value(css, `${name}-ink`);
      const on = value(css, `${name}-on`);
      assert.ok(ink && on, `${theme} has --${name}-ink and --${name}-on`);
      for (const back of ["background", "dark-background", "lighter-background"]) {
        assert.ok(contrast(rgbOf(ink!), rgbOf(value(css, back)!)) >= TARGET, `${theme}'s ${name} ink on its ${back}`);
      }
      assert.ok(contrast(rgbOf(on!), rgbOf(value(css, name)!)) >= TARGET, `${theme}'s text on its ${name}`);
    }
  }
  // A colour that reads already is left as it is.
  const tokyo = legible(resolved("tokyo-night"));
  assert.equal(value(tokyo, "green-ink"), value(tokyo, "green"));
  // Catppuccin Latte's green doesn't, on its light grey: it's taken towards
  // its dark foreground.
  const latte = legible(resolved("catppuccin-latte"));
  assert.notEqual(value(latte, "green-ink"), value(latte, "green"));
  // Without a foreground there's nothing to mix with: as it came.
  assert.equal(legible(":root {\n  --accent: #123456;\n}\n"), ":root {\n  --accent: #123456;\n}\n");
});
