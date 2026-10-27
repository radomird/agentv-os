// A native app's icon from its installed package (daemon/package-icon.ts):
// its desktop entry's Icon=, found in the hicolor theme the way the desktop's
// app launcher finds it, largest first. The icons here are stand-ins, a few
// bytes each, never a real app's artwork.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { desktopEntry, packageIcon, themeIcon } from "../../../daemon/package-icon.ts";
import { ICON_MAX } from "../../../daemon/site-icon.ts";

const steam = { package: { pacman: "steam" }, exec: ["steam", "-gamepadui"] };

// A data folder like /usr/share, with the files given, by path inside it.
function share(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "agentv-share-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const entry = (exec: string, icon: string, extra = "") => `[Desktop Entry]\nName=Stand-in\nExec=${exec}\nIcon=${icon}\n${extra}`;

test("an app's icon is the one its desktop entry names, at the largest size its package installs", () => {
  const dir = share({
    "applications/steam.desktop": entry("/usr/bin/steam %U", "steam"),
    "icons/hicolor/48x48/apps/steam.png": "small",
    "icons/hicolor/256x256/apps/steam.png": "large",
    "icons/hicolor/32x32/apps/steam.png": "smaller",
  });
  assert.deepEqual(packageIcon(steam, [dir]), { path: join(dir, "icons/hicolor/256x256/apps/steam.png"), type: "image/png" });
});

test("a scalable icon comes before any size", () => {
  const dir = share({
    "applications/steam.desktop": entry("steam", "steam"),
    "icons/hicolor/256x256/apps/steam.png": "large",
    "icons/hicolor/scalable/apps/steam.svg": "<svg/>",
  });
  assert.deepEqual(packageIcon(steam, [dir]), { path: join(dir, "icons/hicolor/scalable/apps/steam.svg"), type: "image/svg+xml" });
});

test("an entry named otherwise is found by the command it runs", () => {
  const dir = share({
    "applications/other.desktop": entry("/usr/bin/other", "other"),
    "applications/com.example.Games.desktop": entry('"/usr/bin/steam" %U', "games-icon"),
    "icons/hicolor/128x128/apps/games-icon.png": "icon",
    "icons/hicolor/128x128/apps/other.png": "not this one",
  });
  assert.equal(packageIcon(steam, [dir])?.path, join(dir, "icons/hicolor/128x128/apps/games-icon.png"));
});

test("an icon can be a path, or in pixmaps when the theme has none", () => {
  const icons = share({ "pictures/logo.png": "logo", "pixmaps/kodi.svg": "<svg/>" });
  const apps = share({
    "applications/steam.desktop": entry("steam", join(icons, "pictures/logo.png")),
    "applications/kodi.desktop": entry("kodi", "kodi"),
  });
  assert.equal(packageIcon(steam, [apps])?.path, join(icons, "pictures/logo.png"));
  assert.equal(packageIcon({ package: { pacman: "kodi" }, exec: ["kodi"] }, [apps, icons])?.type, "image/svg+xml");
});

test("the first data folder wins at the same size, as on the desktop", () => {
  const local = share({ "icons/hicolor/64x64/apps/steam.png": "local" });
  const system = share({ "applications/steam.desktop": entry("steam", "steam"), "icons/hicolor/64x64/apps/steam.png": "system" });
  assert.equal(packageIcon(steam, [local, system])?.path, join(local, "icons/hicolor/64x64/apps/steam.png"));
});

test("no icon when the package isn't installed, its entry is hidden, or its icon is no PNG or SVG", () => {
  assert.equal(packageIcon(steam, [share({})]), null);
  assert.equal(packageIcon(steam, [share({ "applications/steam.desktop": entry("steam", "steam", "Hidden=true\n"), "icons/hicolor/64x64/apps/steam.png": "x" })]), null);
  assert.equal(packageIcon(steam, [share({ "applications/steam.desktop": entry("steam", "steam"), "pixmaps/steam.xpm": "x" })]), null);
  assert.equal(packageIcon(steam, [share({ "applications/steam.desktop": "[Desktop Entry]\nExec=steam\n" })]), null);
});

test("an icon too large to be a logo is passed over for a smaller one", () => {
  const dir = share({
    "applications/steam.desktop": entry("steam", "steam"),
    "icons/hicolor/scalable/apps/steam.svg": Buffer.alloc(ICON_MAX + 1, 32),
    "icons/hicolor/64x64/apps/steam.png": "fits",
  });
  assert.equal(packageIcon(steam, [dir])?.path, join(dir, "icons/hicolor/64x64/apps/steam.png"));
});

test("a name that's a relative path never leaves the theme", () => {
  const dir = share({ "icons/hicolor/64x64/apps/steam.png": "x", "secret.png": "x" });
  assert.equal(themeIcon("../../../../secret", [dir]), null);
  assert.equal(packageIcon({ package: { pacman: "../steam" }, exec: [] }, [share({ "steam.desktop": entry("steam", "steam") })]), null);
});

test("only the [Desktop Entry] group counts", () => {
  const keys = desktopEntry("# a comment\n[Desktop Entry]\nIcon=steam\nExec=steam %U\n\n[Desktop Action Store]\nIcon=store\nExec=steam steam://store\n");
  assert.deepEqual(keys, { Icon: "steam", Exec: "steam %U" });
});
