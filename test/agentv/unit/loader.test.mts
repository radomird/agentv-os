// The app loader and its per-app worker (daemon/apps/loader.ts, worker.ts):
// an app runs in a process of its own that reads only its own package, starts
// no processes, and reaches only its declared origins; every call has a time
// limit and fails with a typed error.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { validatePackage } from "../../../apps/contract/manifest.ts";
import { AppError, AppHost, allowedOrigins, systemPaths, timeZoneLink, workerJail } from "../../../daemon/apps/loader.ts";
import { HARNESS, SANDBOX_PROBLEM } from "../harness.mts";

const SAMPLE = join(import.meta.dirname, "../fixtures/apps/sample");
const scratch = mkdtempSync(join(tmpdir(), "agentv-loader-"));
const viewer = { id: "radomir", role: "adult" as const };
const hosts: AppHost[] = [];
let server: Server;
let serverUrl = "";
let other: Server;
let otherUrl = "";
let count = 0;

// Node 25 and later refuse the network to a process under the permission
// model; on older Node the worker's fetch still goes through the loader.
// The worker runs in its sandbox wherever bubblewrap can start one; where
// it can't, the tests of the sandbox itself are skipped.
const harness = HARNESS;
const noSandbox = SANDBOX_PROBLEM;

const netPermission = Number(process.versions.node.split(".")[0]) >= 25;

before(async () => {
  const listen = async (reply: string) => {
    const s = createServer((_request, response) => response.end(reply));
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    return [s, `http://127.0.0.1:${(s.address() as { port: number }).port}`] as const;
  };
  [server, serverUrl] = await listen("from the app's own server");
  [other, otherUrl] = await listen("from somewhere else");
});

after(() => {
  for (const host of hosts) host.stop();
  server.close();
  other.close();
  rmSync(scratch, { recursive: true, force: true });
});

// A copy of the sample app, with its app.ts replaced by code when given.
function app(code?: string, edit: (manifest: Record<string, any>) => void = () => {}): string {
  const dir = join(scratch, `app-${++count}`);
  cpSync(SAMPLE, dir, { recursive: true });
  if (code !== undefined) writeFileSync(join(dir, "app.ts"), code);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  edit(manifest);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

function host(dir: string, limits = {}): AppHost {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const h = new AppHost({ dir, manifest, settings: { serverUrl }, limits, harness });
  hosts.push(h);
  return h;
}

// An app module with every capability the sample declares, and body for tile().
function tileApp(body: string, extra = ""): string {
  return `${extra}
export default {
  id: "agentv.sample",
  async launch() {},
  signIn: { async isSignedIn() { return true; } },
  async search() { return []; },
  playback: { async open() {}, async readPlaybackState() { return null; } },
  async tile(ctx, size) { ${body} },
};
`;
}

async function fails(promise: Promise<unknown>, kind: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: Error) => {
    assert.ok(error instanceof AppError, `expected an AppError, got ${error}`);
    assert.equal(error.kind, kind, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("the sample app loads in its own worker and answers its capabilities", async () => {
  assert.deepEqual(validatePackage(SAMPLE, "official").problems, []);
  const h = host(app());
  const tile = await h.call<{ headline: { label: string } }>(viewer, "tile", "m");
  assert.equal(tile.headline.label, "Big Buck Bunny");
  const found = await h.call<{ title: string }[]>(viewer, "search", "sint");
  assert.deepEqual(found.map((item) => item.title), ["Sintel"]);
  assert.equal(await h.call(viewer, "signIn.isSignedIn"), true);
});

test("each call gets the app's settings and the viewer", async () => {
  const h = host(app(tileApp("return { headline: { label: ctx.settings.serverUrl, value: ctx.viewer.role } };")));
  assert.deepEqual(await h.call(viewer, "tile", "s"), { headline: { label: serverUrl, value: "adult" } });
});

test("an app reads its own package, and nothing else", async () => {
  // The static checks refuse this import; the permission model refuses the read.
  const h = host(app(tileApp('return { headline: { label: String(fs.readFileSync("/etc/hostname")) } };', 'import fs from "node:fs";')));
  await fails(h.call(viewer, "tile", "s"), "failed", /ERR_ACCESS_DENIED|Access to this API has been restricted/);
  const own = host(app(tileApp('return { headline: { label: JSON.parse(String(fs.readFileSync(new URL("./manifest.json", import.meta.url)))).id } };', 'import fs from "node:fs";')));
  assert.deepEqual(await own.call(viewer, "tile", "s"), { headline: { label: "agentv.sample" } });
});

test("an app reaching for Node's modules finds nothing", async () => {
  const h = host(app(tileApp('return { headline: { label: [typeof process.getBuiltinModule, typeof process.kill, typeof process.binding, typeof WebSocket].join(" ") } };')));
  assert.deepEqual(await h.call(viewer, "tile", "s"), { headline: { label: "undefined undefined undefined undefined" } });
});

test("an app can't start a process", async () => {
  // The permission model refuses it even with the module in hand, which the
  // static checks and the worker's clean-up already make hard to get.
  const h = host(app(tileApp("return {};", 'import cp from "node:child_process";\ncp.execSync("true");')));
  await fails(h.start(), "failed", /couldn't load/);
});

test("an app's fetch reaches its declared origins, with its setup fields filled in", async () => {
  const h = host(app(tileApp("const r = await fetch(ctx.settings.serverUrl + '/hello'); return { headline: { label: await r.text(), value: String(r.status) } };")));
  assert.deepEqual(await h.call(viewer, "tile", "s"), { headline: { label: "from the app's own server", value: "200" } });
});

test("an app's fetch can't reach anywhere else", async () => {
  const h = host(app(tileApp(`const r = await fetch("${otherUrl}/"); return { headline: { label: await r.text() } };`)));
  await fails(h.call(viewer, "tile", "s"), "failed", /fetch failed/);
});

test("M1 an app can't open a connection of its own, even with Node's own modules in hand", { skip: !netPermission && noSandbox ? `needs bubblewrap or Node 25: ${noSandbox}` : false }, async () => {
  const port = new URL(serverUrl).port;
  const h = host(app(tileApp(`return await new Promise((resolve, reject) => {
    const socket = net.connect(${port}, "127.0.0.1", () => resolve({ headline: { label: "connected" } }));
    socket.on("error", reject);
  });`, 'import net from "node:net";')));
  await fails(h.call(viewer, "tile", "s"), "failed", /ECONNREFUSED|ENETUNREACH|ERR_ACCESS_DENIED|Access to this API has been restricted/);
});

test("M1 a link out of an app's package leads nowhere", { skip: noSandbox ? `needs bubblewrap: ${noSandbox}` : false }, async () => {
  // The static checks refuse a package with a link in it; the sandbox has
  // nothing at the other end.
  const outside = join(scratch, "outside.txt");
  writeFileSync(outside, "the owner's file");
  const dir = app(tileApp('return { headline: { label: String(fs.readFileSync(new URL("./link.txt", import.meta.url))) } };', 'import fs from "node:fs";'));
  symlinkSync(outside, join(dir, "link.txt"));
  await fails(host(dir).call(viewer, "tile", "s"), "failed", /ENOENT|ERR_ACCESS_DENIED/);
});

test("M1 the worker's sandbox has no network, and only Node, the system's libraries and the app's package to read", { skip: noSandbox ? `needs bubblewrap: ${noSandbox}` : false }, () => {
  const dir = app();
  const node = realpathSync(process.execPath);
  const look = `
    const fs = require("node:fs"), os = require("node:os");
    const there = (path) => { try { return fs.readdirSync(path).length; } catch { return null; } };
    console.log(JSON.stringify({
      root: fs.readdirSync("/").sort(),
      etc: fs.readdirSync("/etc").sort(),
      app: fs.readdirSync(process.cwd()).includes("manifest.json"),
      home: there(${JSON.stringify(homedir())}), state: there("/var/lib/agentv"), keys: there("/etc/agentv"), proc: there("/proc"),
      nets: Object.keys(os.networkInterfaces()),
      writes: (() => { try { fs.writeFileSync(process.cwd() + "/x", "x"); return true; } catch { return false; } })(),
      env: Object.keys(process.env).sort(),
    }));`;
  const ran = spawnSync("bwrap", [...workerJail({ dir, node, read: [], system: systemPaths(), localtime: timeZoneLink() }), node, "-e", look], { env: {}, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  const seen = JSON.parse(ran.stdout);
  const top = new Set(["dev", "etc", "lib", "lib64", "usr", "var", scratch.split("/")[1], node.split("/")[1]]);
  assert.deepEqual(seen.root.filter((name: string) => !top.has(name)), []);
  assert.deepEqual(seen.etc.filter((name: string) => !["ld.so.cache", "localtime"].includes(name)), []);
  assert.equal(seen.app, true);
  assert.deepEqual([seen.home, seen.state, seen.keys, seen.proc], [null, null, null, null]);
  assert.deepEqual(seen.nets, ["lo"]);
  assert.equal(seen.writes, false);
  assert.deepEqual(seen.env, ["PWD"]);
});

test("M1 the sandbox's arguments, exactly", () => {
  // As on the box: the system in /usr, with /lib and /lib64 linking into it,
  // and an installed app under /var/lib/agentv/apps.
  const box = workerJail({
    dir: "/var/lib/agentv/apps/someone.radio",
    node: "/usr/bin/node",
    read: ["/usr/share/agentv/daemon/apps/worker.ts", "/usr/share/agentv/daemon/package.json"],
    system: [{ path: "/usr" }, { path: "/lib", link: "usr/lib" }, { path: "/lib64", link: "usr/lib" }],
    localtime: "/usr/share/zoneinfo/Europe/Oslo",
  });
  assert.deepEqual(box, [
    "--unshare-all", "--unshare-user", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib", "/lib64",
    "--dev", "/dev",
    "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--symlink", "/usr/share/zoneinfo/Europe/Oslo", "/etc/localtime",
    "--ro-bind", "/var/lib/agentv/apps/someone.radio", "/var/lib/agentv/apps/someone.radio",
    "--chdir", "/var/lib/agentv/apps/someone.radio",
    "--",
  ]);
  // Never the network, never anything to write, and nothing of the box's
  // own state but the app's package.
  assert.ok(!box.includes("--share-net"));
  assert.ok(!box.includes("--bind") && !box.includes("--bind-try") && !box.includes("--proc"));
  assert.deepEqual(box.filter((arg) => arg.startsWith("/var/lib/agentv") || arg.startsWith("/etc/agentv") || arg.startsWith("/home")), Array(3).fill("/var/lib/agentv/apps/someone.radio"));
  // A built-in app is in /usr already; a checkout's files are each bound.
  const builtin = workerJail({ dir: "/usr/share/agentv/apps/builtin/clock", node: "/usr/bin/node", read: [], system: [{ path: "/usr" }] });
  assert.deepEqual(builtin.filter((arg) => arg === "--ro-bind").length, 1);
  const checkout = workerJail({ dir: "/src/app", node: "/opt/node/bin/node", read: ["/src/daemon/apps/worker.ts"], system: [{ path: "/usr" }, { path: "/lib" }] });
  assert.deepEqual(checkout.slice(6), [
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--dev", "/dev", "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--ro-bind", "/opt/node/bin/node", "/opt/node/bin/node", "--ro-bind", "/src/daemon/apps/worker.ts", "/src/daemon/apps/worker.ts", "--ro-bind", "/src/app", "/src/app",
    "--chdir", "/src/app", "--",
  ]);
});

test("M1 an app isn't loaded when its sandbox can't start, and never runs outside one instead", async () => {
  const lines: string[] = [];
  const ran = join(scratch, "ran");
  const dir = app(tileApp("return {};"));
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  // A bubblewrap that says what the real one does where a plain user can't
  // make a namespace, and one that isn't there at all.
  const refuses = join(scratch, "bwrap-refuses");
  writeFileSync(refuses, `#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\ntouch ${ran}\nexit 1\n`, { mode: 0o755 });
  for (const bwrap of [refuses, join(scratch, "no-such-bwrap")]) {
    const h = new AppHost({ dir, manifest, settings: { serverUrl }, bwrap, log: (line) => lines.push(line) });
    hosts.push(h);
    await fails(h.call(viewer, "tile", "s"), "failed", /couldn't load: this tv couldn't start it safely/);
  }
  assert.ok(existsSync(ran), "the stand-in bubblewrap was what was started");
  assert.ok(lines.some((line) => /its sandbox didn't start, so it isn't loaded: bwrap: setting up uid map: Permission denied/.test(line)), lines.join("\n"));
  assert.ok(lines.some((line) => /its sandbox didn't start, so it isn't loaded: .*no-such-bwrap didn't run/.test(line)), lines.join("\n"));
});

test("F2 an app's fetch never reaches this box, even as its own declared origin", async () => {
  // As on the box: no harness says the stand-in server may be reached.
  const lines: string[] = [];
  const dir = app(tileApp("const r = await fetch(ctx.settings.serverUrl + '/hello'); return { headline: { label: await r.text() } };"));
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const h = new AppHost({ dir, manifest, settings: { serverUrl }, harness: { noSandbox: harness.noSandbox }, log: (line) => lines.push(line) });
  hosts.push(h);
  await fails(h.call(viewer, "tile", "s"), "failed", /isn't one of the app's origins/);
  assert.ok(lines.some((line) => /refused a fetch to http:\/\/127\.0\.0\.1/.test(line)), lines.join("\n"));
  assert.deepEqual([...allowedOrigins(manifest, { serverUrl: "http://localhost:3000" })], []);
  assert.deepEqual([...allowedOrigins(manifest, { serverUrl: "http://[::ffff:7f00:1]:3000" })], []);
});

test("F2 an app can't speak as one of the box's own screens", async () => {
  const echo = createServer((request, response) => response.end(JSON.stringify(request.headers)));
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  try {
    const at = `http://127.0.0.1:${(echo.address() as { port: number }).port}`;
    const dir = app(tileApp(`const r = await fetch(ctx.settings.serverUrl + "/", { headers: { "X-AgenTV-Screen": "1", "X-AgenTV-Grant": "abc", "X-Own": "kept" } }); return { headline: { label: await r.text() } };`));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const h = new AppHost({ dir, manifest, settings: { serverUrl: at }, harness });
    hosts.push(h);
    const got = JSON.parse((await h.call<{ headline: { label: string } }>(viewer, "tile", "s")).headline.label);
    assert.equal(got["x-own"], "kept");
    assert.deepEqual(Object.keys(got).filter((name) => name.startsWith("x-agentv-")), []);
  } finally {
    echo.close();
  }
});

test("a call that takes too long fails, and the app keeps answering", async () => {
  const h = host(app(tileApp('if (size === "l") await new Promise(() => {}); return {};')), { tile: 300 });
  await fails(h.call(viewer, "tile", "l"), "timeout", /took too long/);
  assert.deepEqual(await h.call(viewer, "tile", "s"), {});
});

test("a stuck app is stopped, and the next call starts it again", async () => {
  const h = host(app(tileApp('if (size === "l") { const end = Date.now() + 5000; while (Date.now() < end) {} } return {};')), { tile: 300 });
  await fails(h.call(viewer, "tile", "l"), "timeout");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(await h.call(viewer, "tile", "s"), {});
});

test("an app that exits mid-call has crashed, and comes back on the next call", async () => {
  const h = host(app(tileApp('if (size === "l") process.exit(3); return {};')));
  await fails(h.call(viewer, "tile", "l"), "crashed");
  assert.deepEqual(await h.call(viewer, "tile", "s"), {});
});

test("an app stopped at any moment of its start leaves no worker behind", { skip: noSandbox !== null && "bubblewrap can't start here" }, async () => {
  // Bubblewrap killed as it starts used to leave the sandbox it had forked,
  // with the worker in it, holding the loader's pipes: the daemon couldn't
  // end, and neither could a test run.
  const dir = app();
  const left = () => spawnSync("pgrep", ["-fc", `apps/worker\\.ts ${dir}/`], { encoding: "utf8" }).stdout.trim();
  for (const wait of [0, 0, 3, 10, 40]) {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const h = new AppHost({ dir, manifest, settings: { serverUrl }, harness: { thisBox: true } });
    const starting = h.start().catch(() => {});
    await new Promise((done) => setTimeout(done, wait));
    h.stop();
    await starting;
  }
  let now = left();
  for (let i = 0; i < 40 && now !== "0"; i++) {
    await new Promise((done) => setTimeout(done, 100));
    now = left();
  }
  assert.equal(now, "0", "no worker of this app is still running");
});

test("a call that arrives as the app is stopped has crashed, and so does one after: a stopped app doesn't start again", async () => {
  // An app is stopped when it's updated or removed, and as the daemon closes.
  // A tile asked for at that moment gets an answer, not a daemon error. One
  // asked for later, by a timer still running as the daemon closes, mustn't
  // start a worker: nothing would stop it, and it kept the daemon's process
  // from ending. Whoever needs the app again makes a new host for it.
  const h = host(app(tileApp("return {};")));
  await h.start();
  const call = h.call(viewer, "tile", "s");
  h.stop();
  await fails(call, "crashed", /Sample stopped/);
  await fails(h.call(viewer, "tile", "s"), "crashed", /Sample stopped/);
  await fails(h.start(), "crashed", /Sample stopped/);
});

test("a failing call says what failed", async () => {
  const h = host(app(tileApp('throw new Error("no such show");')));
  await fails(h.call(viewer, "tile", "s"), "failed", /Sample: no such show/);
});

test("an app is held to its manifest", async () => {
  await fails(host(app(tileApp("return {};").replace("async tile(ctx, size)", "async notTile(ctx, size)"))).start(), "refused", /says it can tile/);
  await fails(host(app(tileApp("return {};").replace('id: "agentv.sample"', 'id: "agentv.other"'))).start(), "refused", /says it's agentv\.other/);
  const h = host(app(undefined, (m) => (m.tv.capabilities = ["launch", "playback"], m.tv.tiles = { s: "logo", m: "continue" })));
  await fails(h.call(viewer, "tile", "m"), "refused", /doesn't have tile/);
  await fails(h.call(viewer, "constructor"), "refused");
});

test("the phone's pause and resume reach an app's own player, and an app without them says so", async () => {
  const player = tileApp("return {};").replace(
    "playback: { async open() {}, async readPlaybackState() { return null; } },",
    `playback: {
    async open() {},
    async readPlaybackState() { return { title: "Sintel", position: 9, duration: 888, playing }; },
    async pause() { playing = false; },
    async resume() { playing = true; },
  },`,
  );
  const h = host(app(player.replace("export default", "let playing = true;\nexport default")));
  await h.call(viewer, "playback.pause");
  assert.equal((await h.call<{ playing: boolean }>(viewer, "playback.readPlaybackState")).playing, false);
  await h.call(viewer, "playback.resume");
  assert.equal((await h.call<{ playing: boolean }>(viewer, "playback.readPlaybackState")).playing, true);
  await fails(host(app(tileApp("return {};"))).call(viewer, "playback.pause"), "failed", /has no playback\.pause/);
});

test("a module that doesn't load says so", async () => {
  await fails(host(app("export default 1;")).start(), "failed", /no default export/);
  await fails(host(app("throw new Error('broken');")).start(), "failed", /broken/);
});

test("the origins an app may reach come from its manifest and settings", () => {
  const manifest = JSON.parse(readFileSync(join(SAMPLE, "manifest.json"), "utf8"));
  assert.deepEqual([...allowedOrigins(manifest, { serverUrl: "http://192.168.1.10:8096/" })], ["http://192.168.1.10:8096"]);
  assert.deepEqual([...allowedOrigins(manifest, {})], []);
  assert.deepEqual([...allowedOrigins(manifest, { serverUrl: "javascript:alert(1)" })], []);
});
