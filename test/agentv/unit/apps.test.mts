// The app contract's checks (apps/contract/manifest.ts), which `agentv app
// validate`, the installer and the builder run on every package (S2.2).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { validatePackage, type Manifest, type Tier } from "../../../apps/contract/manifest.ts";
import { pagePermissions, pagePolicy } from "../../../apps/contract/page.ts";

const SAMPLE = join(import.meta.dirname, "../fixtures/apps/sample");
const BLOCKS = join(import.meta.dirname, "../fixtures/apps/blocks");
const scratch = mkdtempSync(join(tmpdir(), "agentv-apps-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;

// A copy of the sample app, with the manifest changed by edit.
function sample(edit: (manifest: Record<string, any>) => void = () => {}, from = SAMPLE): string {
  const dir = join(scratch, `app-${++count}`);
  cpSync(from, dir, { recursive: true });
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
  refused(sample((m) => (m.tv.contract = 3)), /tv\.contract has to be 1 or 2/);
  refused(sample((m) => (m.tv.category = "news")), /tv\.category has to be one of/);
  refused(sample((m) => (m.tv.capabilities = ["search"])), /launch capability/);
  refused(sample((m) => m.tv.capabilities.push("cookies")), /'cookies' isn't a capability/);
  refused(sample((m) => (m.tv.runtime = "qml")), /web, native or page/);
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

// --- Contract 2: page apps (ADR-043) ------------------------------------

// A copy of the Blocks page app, with the manifest changed by edit and
// files written into it.
function blocks(edit: (manifest: Record<string, any>) => void = () => {}, files: Record<string, string> = {}): string {
  const dir = sample(edit, BLOCKS);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test("a page app passes on contract 2, in every tier", () => {
  assert.deepEqual(problems(BLOCKS), []);
  assert.deepEqual(problems(blocks((m) => ((m.id = "local.blocks"), (m.author = "local"))), "local"), []);
  assert.deepEqual(problems(blocks((m) => ((m.id = "someone.blocks"), (m.author = "someone"))), "community"), []);
});

test("contract 1 apps don't change, and may say contract 2", () => {
  assert.deepEqual(problems(SAMPLE), []);
  assert.deepEqual(problems(sample((m) => (m.tv.contract = 2))), []);
  refused(sample((m) => (m.tv.contract = 3)), /tv\.contract has to be 1 or 2/);
  refused(blocks((m) => (m.tv.contract = 1)), /a page app is on contract 2/);
});

test("a page app's entry point is its page, and it has no code for Node", () => {
  refused(blocks((m) => (m.entryPoints = {})), /the kind tv-app needs entryPoints\.page/);
  refused(blocks((m) => (m.entryPoints.page = "missing.html")), /'missing\.html' isn't in the package/);
  refused(blocks((m) => (m.entryPoints.page = "game.js")), /the entry point page is an \.html file/);
  refused(blocks((m) => (m.entryPoints.page = "../index.html")), /has '\.\.' in it/);
  refused(blocks((m) => (m.entryPoints.tvApp = "game.js")), /not entryPoints\.tvApp/);
  refused(sample((m) => (m.entryPoints.page = "app.ts")), /only a page app has entryPoints\.page/);
  refused(blocks((m) => (m.kinds = ["tv-app", "tv-background-source"])), /a tv-app and nothing else/);
});

test("a page app has no setup, sign-in or service capabilities", () => {
  refused(blocks((m) => (m.tv.setup = [{ type: "signIn" }])), /a page app has no setup steps/);
  refused(blocks((m) => (m.tv.homeUrl = "https://example.org/")), /no tv\.homeUrl, tv\.package or tv\.exec/);
  refused(blocks((m) => m.tv.capabilities.push("playback")), /a page app's capabilities are launch and tile, not playback/);
  refused(blocks((m) => (m.tv.capabilities = ["launch"])), /the medium tile needs the tile capability/);
});

test("ADR-043 a page app declares what it reads and whether it sends notices", () => {
  assert.deepEqual(problems(blocks((m) => ((m.tv.media = ["photos", "music"]), (m.tv.notices = true)))), []);
  refused(blocks((m) => (m.tv.media = ["files"])), /tv\.media lists what the app reads on the box: photos or music/);
  refused(blocks((m) => (m.tv.media = [])), /tv\.media lists what the app reads/);
  refused(blocks((m) => (m.tv.media = ["photos", "photos"])), /the same thing twice/);
  refused(blocks((m) => (m.tv.notices = "yes")), /tv\.notices is true or false/);
  refused(sample((m) => (m.tv.media = ["photos"])), /only a page app declares tv\.media/);
  refused(sample((m) => (m.tv.notices = true)), /only a page app declares tv\.notices/);
});

test("ADR-043 a page app's origins are on the network, never the box", () => {
  assert.deepEqual(problems(blocks((m) => (m.tv.origins = ["https://api.example.org", "http://nas.example.org:8080"]))), []);
  for (const origin of ["http://localhost:3000", "http://agentv.blocks.app.localhost:3003", "http://127.0.0.1", "http://[::1]:3000", "http://0.0.0.0"]) {
    refused(blocks((m) => (m.tv.origins = [origin])), /is this box, which a page app reaches only through AgenTV's app kit/);
  }
  for (const origin of ["{serverUrl}", "https://example.org/path", "file:///etc", "example.org"]) {
    refused(blocks((m) => (m.tv.origins = [origin])), /isn't an origin/);
  }
});

test("ADR-043 a page app's files are a page's, bundled, within the size limit", () => {
  refused(blocks(() => {}, { "node_modules/left-pad/index.js": "module.exports = 1;\n" }), /ships no node_modules/);
  refused(blocks(() => {}, { "server.sh": "echo hi\n" }), /isn't something a page app is made of/);
  refused(blocks(() => {}, { "main.ts": "export {};\n" }), /isn't something a page app is made of/);
  const big = blocks();
  writeFileSync(join(big, "huge.json"), Buffer.alloc(11 * 1024 * 1024, 32));
  refused(big, /a page app's files are up to 10 MB each/);
  const total = blocks();
  for (const n of [1, 2, 3]) writeFileSync(join(total, `part-${n}.json`), Buffer.alloc(9 * 1024 * 1024, 32));
  refused(total, /a page app is up to 25 MB/);
});

test("ADR-043 static checks: no remote scripts or inline code in the page", () => {
  const page = (body: string) => blocks(() => {}, { "index.html": `<!doctype html><html><body>${body}<script src="game.js"></script></body></html>` });
  refused(page('<script src="https://cdn.example.org/lib.js"></script>'), /loads a script from https:\/\/cdn\.example\.org\/lib\.js/);
  refused(page('<script src="//cdn.example.org/lib.js"></script>'), /loads a script from/);
  refused(page('<script src="lib/missing.js"></script>'), /loads the script lib\/missing\.js, which isn't in the package/);
  refused(page("<script>alert(1)</script>"), /has an inline script/);
  refused(page('<button onclick="go()">go</button>'), /inline onclick handler/);
  refused(page('<a href="javascript:go()">go</a>'), /javascript: address/);
  refused(page('<iframe src="game.html"></iframe>'), /has a <iframe>/);
  refused(page('<base href="https://example.org/">'), /has a <base>/);
  refused(page('<meta http-equiv="refresh" content="0;url=https://example.org">'), /<meta http-equiv>/);
  refused(page('<img src="https://images.example.org/a.png">'), /reaches https:\/\/images\.example\.org, which isn't one of the app's tv\.origins/);
  assert.deepEqual(problems(page('<!-- <script src="https://cdn.example.org/lib.js"></script> --><a href="https://example.org/about">about</a>')), []);
  const declared = blocks((m) => (m.tv.origins = ["https://images.example.org"]), {
    "index.html": '<!doctype html><img src="https://images.example.org/a.png"><script src="/_agentv/kit.js"></script><script src="game.js"></script>',
  });
  assert.deepEqual(problems(declared), []);
});

test("ADR-043 static checks: no eval, no code from elsewhere, requests only to declared origins", () => {
  const script = (js: string, edit: (m: Record<string, any>) => void = () => {}) => blocks(edit, { "game.js": js });
  refused(script("eval('1 + 1');"), /calls eval\(\)/);
  refused(script("eval(atob(code));"), /calls eval\(\)/);
  refused(script("window.x = 1;eval(String(1))"), /calls eval\(\)/);
  refused(script("globalThis.eval('1');"), /calls eval\(\)/);
  refused(script("const f = new Function('return 1');"), /uses new Function\(\)/);
  // A method called eval is a method, not eval().
  assert.deepEqual(problems(script("const parser = { eval(text) { return text; } }; parser.eval('x'); const m={eval(e){return e}};")), []);
  refused(script('import { x } from "https://cdn.example.org/x.js";'), /imports code from another site/);
  refused(script('const m = await import("https://cdn.example.org/x.js");'), /loads code from another site/);
  refused(script('importScripts("https://cdn.example.org/w.js");'), /loads code from another site/);
  refused(script('fetch("https://tracker.example.org/hit");'), /game\.js \(fetch\) reaches https:\/\/tracker\.example\.org/);
  refused(script('const ws = new WebSocket("wss://live.example.org/feed");'), /reaches https:\/\/live\.example\.org/);
  refused(script('xhr.open("GET", "http://plain.example.org/data");'), /reaches http:\/\/plain\.example\.org/);
  refused(script('img.src = "https://images.example.org/a.png";'), /reaches https:\/\/images\.example\.org/);
  refused(script('navigator.sendBeacon("https://tracker.example.org/b", "x");'), /reaches https:\/\/tracker\.example\.org/);
  assert.deepEqual(problems(script('fetch("https://api.example.org/v1/forecast");', (m) => (m.tv.origins = ["https://api.example.org"]))), []);
  // An address that's only text, such as a namespace or a link to docs, isn't a request.
  assert.deepEqual(problems(script('const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); const docs = "https://example.org/why";')), []);
});

test("ADR-043 static checks: styles reach only declared origins", () => {
  refused(blocks(() => {}, { "style.css": "body { background: url(https://images.example.org/bg.png); }" }), /style\.css \(url\(\)\) reaches https:\/\/images\.example\.org/);
  refused(blocks(() => {}, { "style.css": '@import "https://fonts.example.org/font.css";' }), /style\.css \(@import\) reaches https:\/\/fonts\.example\.org/);
  assert.deepEqual(problems(blocks(() => {}, { "style.css": "/* url(https://example.org/x.png) */ body { background: url(bg.png); }" })), []);
});

test("ADR-043 the policy the box serves a page app under", () => {
  const manifest = JSON.parse(readFileSync(join(BLOCKS, "manifest.json"), "utf8")) as Manifest;
  const policy = pagePolicy(manifest, "http://localhost:3000");
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'(;|$)/);
  assert.match(policy, /connect-src 'self'(;|$)/);
  assert.match(policy, /frame-ancestors http:\/\/localhost:3000/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  const online = pagePolicy({ ...manifest, tv: { ...manifest.tv, origins: ["https://api.example.org"] } }, "http://localhost:3000");
  assert.match(online, /connect-src 'self' https:\/\/api\.example\.org/);
  assert.match(online, /img-src 'self' data: blob: https:\/\/api\.example\.org/);
});

test("ADR-043 what a page app reaches, in plain words", () => {
  const manifest = JSON.parse(readFileSync(join(BLOCKS, "manifest.json"), "utf8")) as Manifest;
  assert.deepEqual(pagePermissions(manifest), {
    always: ["the remote, a gamepad and your phone", "sound", "its own storage, up to 5 mb"],
    declared: ["a tile on home"],
  });
  const all = pagePermissions({ ...manifest, tv: { ...manifest.tv, origins: ["https://api.example.org"], media: ["photos", "music"], notices: true } });
  assert.deepEqual(all.declared, [
    "the internet, only at api.example.org",
    "the photos in music's sources on this tv, without changing them",
    "the music in music's sources on this tv, without changing it",
    "a tile on home",
    "notices on the tv and your phone",
  ]);
});
