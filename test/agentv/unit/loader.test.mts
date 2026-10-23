// The app loader and its per-app worker (daemon/apps/loader.ts, worker.ts):
// an app runs in a process of its own that reads only its own package, starts
// no processes, and reaches only its declared origins; every call has a time
// limit and fails with a typed error.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { validatePackage } from "../../../apps/contract/manifest.ts";
import { AppError, AppHost, allowedOrigins } from "../../../daemon/apps/loader.ts";

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
  const h = new AppHost({ dir, manifest, settings: { serverUrl }, limits });
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

test("an app can't open a connection of its own", { skip: !netPermission && "needs Node 25 or later" }, async () => {
  const port = new URL(serverUrl).port;
  const h = host(app(tileApp(`return await new Promise((resolve, reject) => {
    const socket = net.connect(${port}, "127.0.0.1", () => resolve({ headline: { label: "connected" } }));
    socket.on("error", reject);
  });`, 'import net from "node:net";')));
  await fails(h.call(viewer, "tile", "s"), "failed", /ERR_ACCESS_DENIED|Access to this API has been restricted/);
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
