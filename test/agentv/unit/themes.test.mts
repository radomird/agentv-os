// The looks setup and Settings offer (daemon/themes.ts, board 12, Q55):
// Tokyo Night, Gruvbox and Catppuccin Latte, with each preview's colours
// read from Omarchy's own theme, and which one the TV has from the colours
// it was handed last (S5.2).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Daemon } from "../../../daemon/server.ts";
import { currentTheme, parseColors, previews } from "../../../daemon/themes.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-themes-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The TV's colours as Omarchy renders AgenTV's template for a theme.
function rendered(theme: string): string {
  const { colors } = parseColors(readFileSync(join(ROOT, "themes", theme, "colors.toml"), "utf8"));
  return readFileSync(join(ROOT, "config/omarchy/themed/launcher.css.tpl"), "utf8").replace(/\{\{ *([a-z_]+) *\}\}/g, (_, key) => colors[key] ?? "#000000");
}

test("S5.2 the three looks are Omarchy's own Tokyo Night, Gruvbox and Catppuccin Latte, in their own colours", async () => {
  const looks = await previews(ROOT);
  assert.deepEqual(looks.map((look) => [look.id, look.name, look.note, look.mode]), [
    ["tokyo-night", "tokyo night", "default", "dark"],
    ["gruvbox", "gruvbox", "warm, dark", "dark"],
    ["catppuccin-latte", "catppuccin latte", "light", "light"],
  ]);
  assert.deepEqual(looks[0].colors, { background: "#1a1b26", dark_background: "#13141c", accent: "#7aa2f7", selection: "#292e42", foreground: "#a9b1d6", bright_foreground: "#c0caf5" });
  assert.equal(looks[2].colors.background, "#eff1f5");
  assert.deepEqual(await previews(join(scratch, "none")), [], "a box without Omarchy's themes has none to offer");
});

test("a theme's colours are plain colours and nothing else", () => {
  const { mode, colors } = parseColors('mode = "light"\naccent = "#ABCDEF"\nbackground = "url(x)"\n# note = "#000"\nselection="#123"\n');
  assert.equal(mode, "light");
  assert.deepEqual(colors, { accent: "#abcdef", selection: "#123" });
});

test("S5.2 the TV says which look it has from the colours it was handed last", async () => {
  const looks = await previews(ROOT);
  assert.equal(currentTheme(rendered("gruvbox"), looks), "gruvbox");
  assert.equal(currentTheme(rendered("catppuccin-latte"), looks), "catppuccin-latte");
  assert.equal(currentTheme(rendered("nord"), looks), null, "another of Omarchy's themes is none of the three");
  assert.equal(currentTheme("", looks), null);

  mkdirSync(join(scratch, "root", "setup"), { recursive: true });
  const daemon = new Daemon({ root: join(scratch, "root"), state: join(scratch, "state"), port: 0, log: () => {}, builtins: null, omarchy: ROOT });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  try {
    const before = await (await fetch(`${url}/api/themes`)).json();
    assert.deepEqual([before.themes.length, before.current], [3, null]);
    assert.equal((await fetch(`${url}/api/theme`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered("tokyo-night") })).status, 200);
    assert.equal((await (await fetch(`${url}/api/themes`)).json()).current, "tokyo-night");
  } finally {
    await daemon.close();
  }
});
