// A theme your agent made, from approval to the TV and the desktop (S6.4,
// daemon/made-themes.ts): root puts it in the themes folder, checked again
// by AgenTV's own rules, with only what Omarchy shows; the screen daemon,
// as the person, hands it to Omarchy as theirs and sets it, never over
// Omarchy's own or a theme of theirs; and the daemon asks for that once a
// version, lists it in Look, and takes it away again when it's removed.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HandOver } from "../../../builder/sandbox/hand-over.ts";
import { AskWatch } from "../../../daemon/asks.ts";
import { dropTheme, madeThemes, placeTheme, takeTheme, type ThemeAnswer, type ThemeAsk, themeName } from "../../../daemon/made-themes.ts";
import { answerTheme } from "../../../daemon/screen.ts";

const ROOT = join(import.meta.dirname, "../../..");
const FOREST = join(ROOT, "test/agentv/fixtures/themes/forest");
const scratch = mkdtempSync(join(tmpdir(), "agentv-made-themes-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
// A 1 x 1 PNG, standing in for what theme_check drew.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ID = "local.theme-calm-forest";

// A theme as the builder leaves it once its gate passed: its scenes and
// what theme_check drew from them.
function drawn(dir: string, change: (theme: string) => void = () => {}): string {
  const theme = join(dir, "theme");
  cpSync(FOREST, theme, { recursive: true });
  writeFileSync(join(theme, "backgrounds", "1-scene.png"), PNG);
  writeFileSync(join(theme, "preview.png"), PNG);
  change(theme);
  return theme;
}

test("S6.4 a made theme's name in Omarchy is its id without local. or theme-", () => {
  assert.equal(themeName("local.theme-calm-forest"), "calm-forest");
  assert.equal(themeName("local.forest-at-dusk"), "forest-at-dusk");
  assert.equal(themeName("local.theme"), "theme");
});

test("S6.4 root installs an approved theme, checked again, with only what Omarchy shows, and keeps the version before", async () => {
  const base = join(scratch, "root");
  const o = { drop: join(base, "drop"), builds: join(base, "build"), apps: join(base, "apps"), themes: join(base, "themes") };
  const handOver = new HandOver({ ...o, recipes: join(ROOT, "builder/recipes"), home: join(base, "home"), run: join(base, "run"), spend: join(base, "spend.json"), builder: { uid: process.getuid!(), gid: process.getgid!() }, rootUid: process.getuid!(), systemctl: () => false });
  const built = (version: string, build: string, change?: (theme: string) => void) => {
    const dir = join(o.builds, ID, version);
    mkdirSync(join(dir, "work"), { recursive: true });
    drawn(join(dir, "work"), change);
    writeFileSync(join(dir, "status.json"), JSON.stringify({ build, id: ID, version, phase: "build", state: "approve", steps: [], understood: { name: "Calm forest at dusk", recipe: "theme", says: "" }, started: "", at: "" }));
  };
  const install = async (build: string, version: string) => {
    mkdirSync(o.drop, { recursive: true });
    writeFileSync(join(o.drop, "install.json"), JSON.stringify({ build, id: ID, version }));
    return (await handOver.handle())!;
  };
  const state = (version: string) => JSON.parse(readFileSync(join(o.builds, ID, version, "status.json"), "utf8")).state;
  const placed = join(o.themes, ID);

  built("1.0.0", "b1");
  assert.equal((await install("b1", "1.0.0")).started, true);
  assert.equal(state("1.0.0"), "installed");
  assert.deepEqual(readdirSync(placed).sort(), ["about.json", "backgrounds", "colors.toml", "icons.theme", "preview.png"]);
  assert.deepEqual(readdirSync(join(placed, "backgrounds")), ["1-scene.png"], "the picture Omarchy shows, not the scene it was drawn from");
  assert.deepEqual(JSON.parse(readFileSync(join(placed, "about.json"), "utf8")), { id: ID, name: "Calm forest at dusk", version: "1.0.0" });
  assert.equal(statSync(join(placed, "colors.toml")).mode & 0o777, 0o644, "anyone may read it");
  assert.equal(statSync(join(placed, "backgrounds")).mode & 0o777, 0o755);
  assert.ok(!existsSync(join(o.apps, ID)), "a theme isn't an app on home");

  built("1.1.0", "b2", (theme) => writeFileSync(join(theme, "colors.toml"), readFileSync(join(theme, "colors.toml"), "utf8").replace("#e0a458", "#e8b070")));
  await install("b2", "1.1.0");
  assert.equal(state("1.0.0"), "kept");
  assert.match(readFileSync(join(placed, "colors.toml"), "utf8"), /accent = "#e8b070"/);
  await install("b1", "1.0.0");
  assert.match(readFileSync(join(placed, "colors.toml"), "utf8"), /accent = "#e0a458"/, "one press back");

  // A build that changed after its gate is checked again, and isn't put in place.
  built("1.2.0", "b3", (theme) => writeFileSync(join(theme, "hyprland.lua"), "os.execute('id')"));
  assert.match((await install("b3", "1.2.0")).reason!, /couldn't be installed: theme\/hyprland\.lua isn't something a theme here holds/);
  built("1.3.0", "b4", (theme) => {
    rmSync(join(theme, "colors.toml"));
    symlinkSync("/etc/agentv/env", join(theme, "colors.toml"));
  });
  assert.match((await install("b4", "1.3.0")).reason!, /colors\.toml is a link/);
  assert.match(readFileSync(join(placed, "colors.toml"), "utf8"), /accent = "#e0a458"/, "what was there stays");
  assert.ok(!readdirSync(o.themes).some((name) => name.startsWith(".staging-")), "nothing's left half done");

  writeFileSync(join(o.drop, "remove.json"), JSON.stringify({ id: ID }));
  assert.equal((await handOver.handle())!.started, true);
  assert.ok(!existsSync(placed));
});

test("S6.4 the screen daemon hands a made theme to Omarchy as the person's and sets it, never over Omarchy's own or theirs", async () => {
  const base = join(scratch, "person");
  const themes = join(base, "themes");
  const home = join(base, "home");
  const omarchy = join(base, "omarchy");
  mkdirSync(join(omarchy, "themes", "tokyo-night"), { recursive: true });
  placeTheme(drawn(join(base, "built")), themes, { id: ID, name: "Calm forest at dusk", version: "1.0.0" });

  const set: string[] = [];
  let busy = 1;
  const screen = {
    async setTheme(theme: unknown) {
      if (busy-- > 0) return { ok: false, error: "tokyo night is still being set" };
      set.push(String(theme));
      return { ok: true };
    },
  };
  assert.deepEqual(await answerTheme({ kind: "take", id: ID }, screen, { home, omarchy, themes, waitMs: 1 }), { ok: true, name: "calm-forest" });
  assert.deepEqual(set, ["calm-forest"], "set once the theme before it was");
  const mine = join(home, ".config/omarchy/themes/calm-forest");
  assert.deepEqual(readdirSync(mine).sort(), [".agentv-theme", "backgrounds", "colors.toml", "icons.theme", "preview.png"]);
  assert.equal(readFileSync(join(mine, "colors.toml"), "utf8"), readFileSync(join(FOREST, "colors.toml"), "utf8"));

  // A newer version goes over AgenTV's own copy.
  assert.equal(takeTheme({ themes, id: ID, home, omarchy }).name, "calm-forest");

  // Omarchy's own, and a theme of the person's, are left alone.
  placeTheme(drawn(join(base, "tokyo")), themes, { id: "local.tokyo-night", name: "Tokyo night", version: "1.0.0" });
  assert.deepEqual(takeTheme({ themes, id: "local.tokyo-night", home, omarchy }), { error: "omarchy has a theme called tokyo-night already" });
  mkdirSync(join(home, ".config/omarchy/themes/dusk"), { recursive: true });
  writeFileSync(join(home, ".config/omarchy/themes/dusk/colors.toml"), "mine");
  placeTheme(drawn(join(base, "dusk")), themes, { id: "local.dusk", name: "Dusk", version: "1.0.0" });
  assert.deepEqual(takeTheme({ themes, id: "local.dusk", home, omarchy }), { error: "you have a theme called dusk already" });
  assert.equal(readFileSync(join(home, ".config/omarchy/themes/dusk/colors.toml"), "utf8"), "mine");
  assert.deepEqual(takeTheme({ themes, id: "local.nowhere", home, omarchy }), { error: "it isn't on this box" });
  const failing = { setTheme: async () => ({ ok: false, error: "the theme does not exist" }) };
  assert.deepEqual(await answerTheme({ kind: "take", id: ID }, failing, { home, omarchy, themes }), { ok: false, error: "the theme does not exist" });

  // Taken away again, only AgenTV's own copy.
  dropTheme({ id: "local.dusk", home });
  assert.ok(existsSync(join(home, ".config/omarchy/themes/dusk")));
  assert.deepEqual(await answerTheme({ kind: "drop", id: ID }, screen, { home, omarchy, themes }), { ok: true });
  assert.ok(!existsSync(mine));
});

test("S6.4 the daemon has a made theme set once a version, lists it in Look, and takes it away when it's removed", async () => {
  const { Daemon } = await import("../../../daemon/server.ts");
  const base = join(scratch, "daemon");
  mkdirSync(join(base, "root", "setup"), { recursive: true });
  const builds = join(base, "build");
  const themes = join(base, "themes");
  const daemon = new Daemon({ root: join(base, "root"), state: join(base, "state"), port: 0, log: () => {}, builtins: null, keyStatus: join(base, "key.json"), builds, buildRun: join(base, "run"), spend: join(base, "spend.json"), npmWarnings: join(base, "warnings.json"), themes, omarchy: ROOT });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  // The screen daemon, as the person: it sets what it's asked, except dusk,
  // whose name is taken.
  const asked: ThemeAsk[] = [];
  const screen = new AskWatch<ThemeAsk, ThemeAnswer>({
    url: `${url}/`,
    path: "api/themes/ask",
    what: "made themes",
    handle: async (ask) => {
      asked.push(ask);
      if (ask.id === "local.dusk") return { ok: false, error: "you have a theme called dusk already" };
      return { ok: true, ...(ask.kind === "take" ? { name: themeName(ask.id) } : {}) };
    },
    failed: (error) => ({ ok: false, error: error.message }),
    log: () => {},
    retryMs: 50,
  });
  screen.start();
  try {
    const send = (method: string, path: string, body?: unknown) => fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const state = () => JSON.parse(readFileSync(join(base, "state", "made-themes.json"), "utf8"));
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i++) await new Promise((done) => setTimeout(done, 50));
    };
    // Two theme builds, as the daemon asked for them, which root installed.
    writeFileSync(join(base, "key.json"), JSON.stringify({ set: true, provider: "claude", at: new Date().toISOString() }));
    const installed = async (sentence: string, id: string, version: string) => {
      const record = join(base, "state", "builds.json");
      mkdirSync(join(base, "state"), { recursive: true });
      const all = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : [];
      const build = `b${all.length + 1}`;
      writeFileSync(record, JSON.stringify([...all, { build, id, version, sentence, provider: "claude", path: "key", at: new Date().toISOString() }]));
      const dir = join(builds, id, version);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "status.json"), JSON.stringify({ build, id, version, phase: "build", state: "installed", steps: [], understood: { name: sentence, recipe: "theme", says: "" }, started: "", at: new Date().toISOString() }));
      placeTheme(drawn(join(base, "built", id, version)), themes, { id, name: sentence, version });
    };
    await installed("Calm forest", ID, "1.0.0");
    await installed("Dusk", "local.dusk", "1.0.0");
    await until(() => existsSync(join(base, "state", "made-themes.json")) && Object.keys(state()).length === 2);
    assert.deepEqual(state(), { [ID]: { version: "1.0.0", name: "calm-forest" }, "local.dusk": { version: "1.0.0", error: "you have a theme called dusk already" } });

    // Look lists the one that's set, after Omarchy's own, made by your agent.
    const looks = await (await send("GET", "/api/themes")).json();
    const made = looks.themes.filter((look: { note: string }) => look.note === "made by your agent");
    assert.deepEqual(made.map((look: { id: string; name: string }) => [look.id, look.name]), [["calm-forest", "calm forest"]]);
    assert.equal(made[0].colors.accent, "#e0a458");
    assert.deepEqual((await (await send("GET", "/api/builds")).json()).themes, state(), "the TV's build page hears it too");

    // Each version once: the person may change from it, and it isn't set again.
    await new Promise((done) => setTimeout(done, 2500));
    assert.equal(asked.filter((ask) => ask.kind === "take").length, 2);
    await installed("Calm forest", ID, "1.1.0");
    await until(() => state()[ID].version === "1.1.0");
    assert.equal(asked.filter((ask) => ask.kind === "take" && ask.id === ID).length, 2);

    // Removed by root: gone from Omarchy too, and from Look.
    rmSync(join(themes, ID), { recursive: true });
    await until(() => !state()[ID]);
    assert.deepEqual(asked.at(-1), { kind: "drop", id: ID, n: asked.length });
    assert.ok(!(await (await send("GET", "/api/themes")).json()).themes.some((look: { note: string }) => look.note === "made by your agent"));
  } finally {
    screen.stop();
    await daemon.close();
  }
});
