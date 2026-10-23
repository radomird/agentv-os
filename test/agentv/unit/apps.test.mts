// The app contract's checks (apps/contract/manifest.ts), which `agentv app
// validate`, the installer and the builder run on every package (S2.2).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { validatePackage, type Tier } from "../../../apps/contract/manifest.ts";

const SAMPLE = join(import.meta.dirname, "../fixtures/apps/sample");
const scratch = mkdtempSync(join(tmpdir(), "agentv-apps-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;

// A copy of the sample app, with the manifest changed by edit.
function sample(edit: (manifest: Record<string, any>) => void = () => {}): string {
  const dir = join(scratch, `app-${++count}`);
  cpSync(SAMPLE, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  edit(manifest);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

function problems(dir: string, tier: Tier = "official"): string[] {
  return validatePackage(dir, tier).problems;
}

function refused(dir: string, pattern: RegExp, tier: Tier = "official"): void {
  const found = problems(dir, tier);
  assert.ok(found.some((problem) => pattern.test(problem)), `expected a problem like ${pattern}, got:\n${found.join("\n")}`);
}

test("the sample app passes as an official app", () => {
  const result = validatePackage(SAMPLE, "official");
  assert.deepEqual(result.problems, []);
  assert.equal(result.manifest?.id, "agentv.sample");
});

test("S2.2 a symlink anywhere in the package is refused", () => {
  const dir = sample();
  mkdirSync(join(dir, "lib"));
  symlinkSync("/etc/passwd", join(dir, "lib", "passwd"));
  refused(dir, /symlinks aren't allowed in an app package: lib\/passwd/);
});

test("S2.2 a symlinked entry point is refused", () => {
  const dir = sample((m) => (m.entryPoints.tvApp = "linked.ts"));
  symlinkSync(join(dir, "app.ts"), join(dir, "linked.ts"));
  refused(dir, /symlinks aren't allowed/);
});

test("S2.2 unsafe entry paths are refused", () => {
  for (const [path, why] of [
    ["../outside.ts", /has '\.\.' in it/],
    ["lib/../../outside.ts", /has '\.\.' in it/],
    ["/etc/app.ts", /isn't a relative path/],
    ["C:/app.ts", /isn't a relative path/],
    ["lib\\app.ts", /backslash/],
    ["app.ts\nother.ts", /control character/],
    ["", /is empty/],
  ] as const) {
    refused(sample((m) => (m.entryPoints.tvApp = path)), why);
  }
});

test("an entry point that isn't in the package is refused", () => {
  refused(sample((m) => (m.entryPoints.tvApp = "missing.ts")), /isn't in the package/);
});

test("S2.2 a third-party app can't take an agentv.* id", () => {
  refused(SAMPLE, /uses agentv\.\*, which is only for AgenTV's own apps/, "community");
  refused(SAMPLE, /starts with local\./, "local");
});

test("ids follow where the app came from", () => {
  assert.deepEqual(problems(sample((m) => ((m.id = "someone.sample"), (m.author = "someone"))), "community"), []);
  assert.deepEqual(problems(sample((m) => (m.id = "local.mytv")), "local"), []);
  refused(sample((m) => ((m.id = "other.sample"), (m.author = "someone"))), /starts with its author, someone\./, "community");
  refused(sample((m) => ((m.id = "omarchy.sample"), (m.author = "omarchy"))), /reserved/, "community");
  refused(sample((m) => (m.id = "local.sample")), /official app's id starts with agentv\./);
  refused(sample((m) => (m.id = "Agentv.Sample")), /isn't valid/);
  refused(sample((m) => (m.id = "sample")), /isn't valid/);
});

test("the required fields are there", () => {
  refused(sample((m) => (m.schemaVersion = "1")), /schemaVersion has to be 1/);
  refused(sample((m) => delete m.license), /needs a license/);
  refused(sample((m) => (m.version = "1.0")), /isn't a version/);
  refused(sample((m) => (m.kinds = [])), /kinds has to be a list/);
  refused(sample((m) => (m.kinds = ["bar-widget"])), /isn't a kind an app can have/);
  refused(sample((m) => (m.kinds = ["tv-app", "tv-background-source"])), /needs entryPoints\.backgroundSource/);
  refused(sample((m) => delete m.tv), /needs a tv block/);
});

test("the tv block follows the contract", () => {
  refused(sample((m) => (m.tv.contract = 2)), /tv\.contract has to be 1/);
  refused(sample((m) => (m.tv.category = "news")), /tv\.category has to be one of/);
  refused(sample((m) => (m.tv.capabilities = ["search"])), /launch capability/);
  refused(sample((m) => m.tv.capabilities.push("cookies")), /'cookies' isn't a capability/);
  refused(sample((m) => (m.tv.runtime = "qml")), /web or native/);
});

test("a web app reaches only its declared origins", () => {
  refused(sample((m) => delete m.tv.origins), /lists the origins it may reach/);
  refused(sample((m) => (m.tv.homeUrl = "https://elsewhere.example/")), /outside the app's tv\.origins/);
  refused(sample((m) => (m.tv.origins = ["https://example.org/path"])), /isn't an origin/);
  refused(sample((m) => (m.tv.origins = ["file:///etc"])), /isn't an origin/);
  refused(sample((m) => (m.tv.homeUrl = "javascript:alert(1)")), /isn't an http or https address/);
  refused(sample((m) => (m.tv.origins = ["{server}"])), /uses \{server\}, which isn't one of the app's setup fields/);
  assert.deepEqual(
    problems(sample((m) => ((m.tv.homeUrl = "https://www.example.org/watch"), (m.tv.origins = ["https://www.example.org"])))),
    [],
  );
});

test("a native app names its package and command", () => {
  const native = (m: Record<string, any>) => {
    m.tv.runtime = "native";
    delete m.tv.homeUrl;
    m.tv.package = { pacman: "steam" };
    m.tv.exec = ["steam", "-gamepadui"];
  };
  assert.deepEqual(problems(sample(native)), []);
  refused(sample((m) => (native(m), (m.tv.exec = ["/usr/bin/steam"]))), /starts with a command name/);
  refused(sample((m) => (native(m), (m.tv.package = { pacman: "steam", flatpak: "x" }))), /names one package/);
  refused(sample((m) => (native(m), (m.tv.homeUrl = "https://example.org/"))), /no tv\.homeUrl/);
});

test("tiles take only the sizes s, m and l, with short labels (ADR-016)", () => {
  refused(sample((m) => (m.tv.tiles = { xl: "huge" })), /'xl' isn't a tile size/);
  refused(sample((m) => (m.tv.tiles = { s: "a label that is far too long for a size picker" })), /up to 24 characters/);
  refused(sample((m) => (m.tv.capabilities = ["launch", "playback"])), /large tile needs the tile capability/);
  // Medium without tile() is the free "continue" tile, for apps with playback.
  assert.deepEqual(problems(sample((m) => ((m.tv.capabilities = ["launch", "playback"]), (m.tv.tiles = { s: "logo", m: "continue" })))), []);
  refused(sample((m) => ((m.tv.capabilities = ["launch"]), (m.tv.tiles = { m: "now" }))), /medium tile needs the tile capability/);
});

test("the icon is an image in the package", () => {
  refused(sample((m) => (m.tv.icon = "../icon.png")), /tv\.icon has '\.\.' in it/);
  refused(sample((m) => (m.tv.icon = "app.ts")), /tv\.icon is a/);
  refused(sample((m) => (m.tv.icon = "missing.png")), /isn't in the package/);
});

test("app code imports only files from its own package", () => {
  for (const [code, why] of [
    ['import { readFileSync } from "node:fs";', /imports node:fs/],
    ['import cp from "child_process";', /imports child_process/],
    ['export * from "../outside.ts";', /outside the package/],
    ['import "./missing.ts";', /isn't in the package/],
    ['const fs = require("fs");', /calls require\(\)/],
    ['const m = await import("./library.ts");', /uses import\(\)/],
    ['const fs = process.getBuiltinModule("fs");', /reaches for Node's own modules/],
  ] as const) {
    const dir = sample();
    writeFileSync(join(dir, "extra.ts"), `${code}\nexport const x = 1;\n`);
    refused(dir, why);
  }
});

test("app code is TypeScript that Node runs as it is", () => {
  const dir = sample();
  writeFileSync(join(dir, "extra.ts"), "export enum Size { Small, Large }\n");
  refused(dir, /TypeScript that Node can't run as it is/);
});

test("a package with something other than files and folders is refused", () => {
  const dir = sample();
  try {
    execFileSync("mkfifo", [join(dir, "pipe")]);
  } catch {
    return; // no FIFOs here; the symlink tests cover the walk
  }
  refused(dir, /only files and folders/);
});

test("a package without a valid manifest says so", () => {
  const dir = join(scratch, "empty");
  mkdirSync(dir);
  refused(dir, /has no manifest\.json/);
  writeFileSync(join(dir, "manifest.json"), "{ not json");
  refused(dir, /isn't valid JSON/);
  refused(join(scratch, "nowhere"), /no app package at/);
});
