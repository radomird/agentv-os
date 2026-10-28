// Page apps on the box (daemon/page-apps.ts, ADR-043): each one's own
// origin, its files under its policy, and the app kit's calls, each checked
// against the manifest, with storage kept to its quota (S6.8's parts here).

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { STORAGE_QUOTA } from "../../../apps/contract/kit.ts";
import { BACK_WAIT_MS as KIT_BACK_WAIT_MS } from "../../../apps/contract/kit.ts";
import { validatePackage, type Manifest } from "../../../apps/contract/manifest.ts";
import { Daemon } from "../../../daemon/server.ts";
import { cleanTile, pageAppId, pageHost, PageApps } from "../../../daemon/page-apps.ts";
import { BACK_WAIT_MS, padChanges } from "../../../launcher/kit-host.ts";

const ROOT = join(import.meta.dirname, "../../..");
const BLOCKS = join(ROOT, "test/agentv/fixtures/apps/blocks");
const SAMPLE = join(ROOT, "test/agentv/fixtures/apps/sample");
const scratch = mkdtempSync(join(tmpdir(), "agentv-page-apps-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// An app on the box, from a fixture, with its manifest changed by edit.
function app(id: string, edit: (m: Record<string, any>) => void = () => {}, from = BLOCKS): { manifest: Manifest; dir: string } {
  const dir = join(scratch, "apps", id);
  cpSync(from, dir, { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  m.id = id;
  edit(m);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  const { manifest, problems } = validatePackage(dir, "official");
  assert.ok(manifest, problems.join("\n"));
  return { manifest, dir };
}

const notices: string[] = [];
const tilesChanged: string[] = [];
let clock = 1_000_000;
const apps = new Map<string, { manifest: Manifest; dir: string }>();
const pages = new PageApps({
  state: join(scratch, "state"),
  root: ROOT,
  find: async (id) => apps.get(id) ?? null,
  viewer: async () => ({ id: "v1", name: "Ana", role: "adult" }),
  notice: (from, text) => notices.push(`${from.id}: ${text}`),
  tileChanged: (id) => tilesChanged.push(id),
  now: () => clock,
});

before(() => {
  apps.set("agentv.blocks", app("agentv.blocks"));
  apps.set("agentv.album", app("agentv.album", (m) => ((m.tv.media = ["photos"]), (m.tv.notices = true), (m.tv.origins = ["https://api.example.org"]))));
  apps.set("agentv.plain", app("agentv.plain", (m) => ((m.tv.capabilities = ["launch"]), delete m.tv.tiles)));
  apps.set("agentv.sample", app("agentv.sample", () => {}, SAMPLE));
});

test("a page app's host is its id on .app.localhost, at the daemon's port", () => {
  assert.equal(pageHost("local.blocks", 3000), "local.blocks.app.localhost:3000");
  assert.equal(pageAppId("local.blocks.app.localhost:3000", 3000), "local.blocks");
  assert.equal(pageAppId("LOCAL.Blocks.app.localhost:3000", 3000), "local.blocks");
  for (const host of [undefined, "localhost:3000", "127.0.0.1:3000", "local.blocks.app.localhost:3001", "blocks.app.localhost:3000", "a..b.app.localhost:3000", `local.${"x".repeat(64)}.app.localhost:3000`]) {
    assert.equal(pageAppId(host, 3000), null, String(host));
  }
});

test("home's copy of the kit's Back wait is the contract's", () => {
  assert.equal(BACK_WAIT_MS, KIT_BACK_WAIT_MS);
});

test("ADR-043 storage: each app's own, kept to its quota", async () => {
  assert.deepEqual(await pages.call("agentv.blocks", "storage.get", ["best"]), { value: null });
  assert.deepEqual(await pages.call("agentv.blocks", "storage.set", ["best", 1200]), {});
  assert.deepEqual(await pages.call("agentv.blocks", "storage.get", ["best"]), { value: 1200 });
  assert.deepEqual(await pages.call("agentv.blocks", "storage.keys", []), { value: ["best"] });
  // Another app's storage is its own.
  assert.deepEqual(await pages.call("agentv.album", "storage.get", ["best"]), { value: null });
  assert.deepEqual(await pages.call("agentv.blocks", "storage.remove", ["best"]), {});
  assert.deepEqual(await pages.call("agentv.blocks", "storage.keys", []), { value: [] });
  assert.match((await pages.call("agentv.blocks", "storage.set", ["k".repeat(101), 1])).error ?? "", /up to 100 characters/);
  assert.match((await pages.call("agentv.blocks", "storage.set", ["big", "x".repeat(STORAGE_QUOTA)])).error ?? "", /more than the 5 mb/);
  assert.match((await pages.call("agentv.blocks", "storage.set", ["none"])).error ?? "", /needs a value/);
});

test("ADR-043 storage: writes at once don't lose each other", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, n) => pages.call("agentv.blocks", "storage.set", [`k${n}`, n])));
  const keys = (await pages.call("agentv.blocks", "storage.keys", [])).value as string[];
  assert.equal(keys.length, 20);
});

test("ADR-043 a call needs what the manifest declared", async () => {
  assert.match((await pages.call("agentv.blocks", "notify", ["hello"])).error ?? "", /didn't declare what notify needs/);
  assert.match((await pages.call("agentv.plain", "tile.set", [{ headline: { label: "x" } }])).error ?? "", /didn't declare what tile\.set needs/);
  assert.match((await pages.call("agentv.blocks", "photos.list", ["s"])).error ?? "", /isn't something the app kit does here/);
  assert.match((await pages.call("agentv.blocks", "eval", [])).error ?? "", /isn't something the app kit does here/);
  assert.match((await pages.call("agentv.sample", "storage.get", ["x"])).error ?? "", /isn't a page app/);
  assert.match((await pages.call("agentv.nowhere", "viewer", [])).error ?? "", /no such app/);
  assert.match((await pages.call("../etc", "viewer", [])).error ?? "", /which app/);
  // The TV session asks the same for photos and music.
  assert.equal(await pages.allows("agentv.album", "photos.list"), null);
  assert.match((await pages.allows("agentv.album", "music.albums")) ?? "", /didn't declare what music\.albums needs/);
  assert.match((await pages.allows("agentv.blocks", "photos.list")) ?? "", /didn't declare/);
  assert.match((await pages.allows("agentv.album", "storage.get")) ?? "", /isn't something the app kit does here/);
});

test("the viewer, a tile and a notice", async () => {
  assert.deepEqual(await pages.call("agentv.blocks", "viewer", []), { value: { id: "v1", name: "Ana", role: "adult" } });
  assert.deepEqual(await pages.call("agentv.blocks", "tile.set", [{ headline: { label: "best", value: "1200", item: { id: "x" } }, refreshMins: 1 }]), {});
  assert.deepEqual(await pages.tile("agentv.blocks"), { headline: { label: "best", value: "1200" } });
  assert.deepEqual(tilesChanged, ["agentv.blocks"]);
  assert.match((await pages.call("agentv.blocks", "tile.set", [{}])).error ?? "", /a tile has a headline or entries/);
  assert.deepEqual(await pages.call("agentv.album", "notify", ["the slideshow is done"]), {});
  assert.match((await pages.call("agentv.album", "notify", ["again"])).error ?? "", /one notice a minute/);
  clock += 61_000;
  assert.deepEqual(await pages.call("agentv.album", "notify", ["again"]), {});
  assert.match((await pages.call("agentv.album", "notify", [""])).error ?? "", /a few words/);
  assert.deepEqual(notices, ["agentv.album: the slideshow is done", "agentv.album: again"]);
  await pages.forget("agentv.blocks");
  assert.equal(await pages.tile("agentv.blocks"), null);
  assert.deepEqual(await pages.call("agentv.blocks", "storage.keys", []), { value: [] });
});

test("a tile from a page app keeps only words, icons and pictures", () => {
  assert.deepEqual(cleanTile({ entries: [{ label: "a", image: "javascript:alert(1)" }, { value: "\u0000b" }, 7], headline: null }), { entries: [{ label: "a" }, { value: " b" }] });
  assert.equal(cleanTile([]), null);
  assert.equal(cleanTile("x"), null);
});

test("a gamepad's presses and releases, from one reading to the next", () => {
  const held = new Map<number, Set<string>>();
  const pad = (pressed: number[], axes = [0, 0]) => ({ index: 0, buttons: Array.from({ length: 17 }, (_, n) => ({ pressed: pressed.includes(n) })), axes });
  assert.deepEqual(padChanges([pad([0])], held), [{ pad: 0, button: "ok", down: true }]);
  assert.deepEqual(padChanges([pad([0])], held), []);
  assert.deepEqual(padChanges([pad([], [-0.9, 0])], held), [
    { pad: 0, button: "left", down: true },
    { pad: 0, button: "ok", down: false },
  ]);
  // The stick lets go only below its lower mark, so it doesn't flicker.
  assert.deepEqual(padChanges([pad([], [-0.5, 0])], held), []);
  assert.deepEqual(padChanges([pad([14], [-0.3, 0])], held), []);
  assert.deepEqual(padChanges([pad([1, 16])], held), [
    { pad: 0, button: "back", down: true },
    { pad: 0, button: "home", down: true },
    { pad: 0, button: "left", down: false },
  ]);
  // A gamepad that goes lets go of what it held.
  assert.deepEqual(padChanges([], held), [
    { pad: 0, button: "back", down: false },
    { pad: 0, button: "home", down: false },
  ]);
});

// --- Through the daemon --------------------------------------------------

function get(port: number, host: string, path: string, method = "GET", body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: host, ...(body ? { "Content-Type": "application/json" } : {}) } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("ADR-043 the daemon serves a page app from its own origin, under its policy, and nothing else", async () => {
  const dir = join(scratch, "box");
  const appsDir = join(dir, "apps");
  cpSync(BLOCKS, join(appsDir, "agentv.blocks"), { recursive: true });
  cpSync(SAMPLE, join(appsDir, "agentv.sample"), { recursive: true });
  writeFileSync(join(appsDir, "installed.json"), JSON.stringify({
    "agentv.blocks": { id: "agentv.blocks", name: "Blocks", version: "1.0.0", tier: "official", installedAt: "2026-10-27T12:00:00Z" },
    "agentv.sample": { id: "agentv.sample", name: "Sample", version: "1.0.0", tier: "official", installedAt: "2026-10-27T12:00:00Z" },
  }));
  const daemon = new Daemon({ root: ROOT, state: join(dir, "state"), apps: appsDir, updates: join(dir, "update"), builtins: null, port: 0, log: () => {} });
  const port = await daemon.listen();
  try {
    const host = pageHost("agentv.blocks", port);
    const page = await get(port, host, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /<canvas id="board"/);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'.*connect-src 'self';.*frame-ancestors http:\/\/127\.0\.0\.1:\d+ http:\/\/localhost:\d+/);
    assert.match(String(page.headers["permissions-policy"]), /camera=\(\)/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    const kit = await get(port, host, "/_agentv/kit.js");
    assert.equal(kit.status, 200);
    assert.match(kit.body, /defineProperty\(window, "agentv"/);
    assert.doesNotMatch(kit.body, /^import /m);
    assert.equal((await get(port, host, "/game.js")).status, 200);
    for (const path of ["/manifest.json", "/../agentv.sample/app.ts", "/%2e%2e/agentv.sample/app.ts", "/.hidden", "/nothing.js", "/game.js/"]) {
      assert.equal((await get(port, host, path)).status, 404, path);
    }
    assert.equal((await get(port, host, "/", "POST", "{}")).status, 405);
    // The daemon's own pages and API aren't on a page app's origin.
    assert.equal((await get(port, host, "/api/home")).status, 404);
    // A web app has no origin of this kind, and an app that isn't here none.
    assert.equal((await get(port, pageHost("agentv.sample", port), "/")).status, 404);
    assert.equal((await get(port, pageHost("agentv.nowhere", port), "/")).status, 404);

    // The kit's calls come from home, and the TV session asks first.
    const local = `127.0.0.1:${port}`;
    const set = await get(port, local, "/api/kit", "POST", JSON.stringify({ app: "agentv.blocks", call: "storage.set", args: ["best", 5] }));
    assert.equal(set.status, 200);
    const got = await get(port, local, "/api/kit", "POST", JSON.stringify({ app: "agentv.blocks", call: "storage.get", args: ["best"] }));
    assert.deepEqual(JSON.parse(got.body), { ok: true, value: 5 });
    assert.equal((await get(port, local, "/api/kit", "POST", JSON.stringify({ app: "agentv.blocks", call: "notify", args: ["x"] }))).status, 400);
    assert.equal((await get(port, local, "/api/apps/agentv.blocks/kit?call=photos.list")).status, 403);
    // A page app's own origin can't call the daemon at all.
    assert.equal((await get(port, host, "/api/kit", "POST", JSON.stringify({ app: "agentv.blocks", call: "storage.get", args: ["best"] }))).status, 405);

    // Home opens it in its frame, and its details say what it reaches.
    assert.deepEqual(JSON.parse((await get(port, local, "/api/apps/agentv.blocks/launch")).body), { ok: true, runtime: "page", name: "Blocks" });
    const home = JSON.parse((await get(port, local, "/api/home")).body);
    const blocks = home.apps.find((a: { id: string }) => a.id === "agentv.blocks");
    assert.equal(blocks.runtime, "page");
    assert.deepEqual(blocks.reach, ["a tile on home"]);
    await get(port, local, "/api/kit", "POST", JSON.stringify({ app: "agentv.blocks", call: "tile.set", args: [{ headline: { label: "best", value: "5" } }] }));
    const tile = JSON.parse((await get(port, local, "/api/tile/agentv.blocks/m")).body);
    assert.deepEqual(tile.tile, { headline: { label: "best", value: "5" } });
  } finally {
    await daemon.close();
  }
});
