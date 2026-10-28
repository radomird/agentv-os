// The looks setup and Settings offer (daemon/themes.ts, ADR-048, board 12):
// every theme Omarchy has, the ones it ships and any installed on its
// desktop, Tokyo Night first, each preview in the theme's own colours as
// Omarchy's own omarchy-theme-color resolves them, and which one the TV has
// (S5.2, S5.7). The screen daemon reads the person's folder and hands the
// list over (daemon/omarchy-themes.ts), since the daemon can't.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
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
