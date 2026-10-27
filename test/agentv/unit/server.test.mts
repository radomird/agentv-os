// AgenTV's daemon (daemon/server.ts): TV setup's page and /health as the
// stage 0 placeholder had them (S0.1, S1.3 and S1.6 read them), the home
// screen once setup is done, the launcher's TypeScript as JavaScript, and
// nothing for a request that isn't addressed to this box or comes from
// someone else's page.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { installedPackage } from "../../../daemon/identity.ts";
import { Daemon } from "../../../daemon/server.ts";
import { Updates } from "../../../daemon/updates.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-daemon-"));
const root = join(scratch, "root");
const state = join(scratch, "state");
let daemon: Daemon;
let url = "";
let port = 0;
const lines: string[] = [];

before(async () => {
  // AgenTV's files as the package lays them out, with a launcher.
  mkdirSync(join(root, "branding"), { recursive: true });
  cpSync(join(ROOT, "setup"), join(root, "setup"), { recursive: true });
  cpSync(join(ROOT, "branding/logo.svg"), join(root, "branding/logo.svg"));
  mkdirSync(join(root, "launcher"));
  writeFileSync(join(root, "launcher/index.html"), "<!doctype html><title>Home</title><h1>home</h1>");
  writeFileSync(join(root, "launcher/focus.ts"), "export function next(index: number, count: number): number {\n  return (index + 1) % count;\n}\n");
  writeFileSync(join(root, "settings"), "AGENTV_VERSION=0.2.0\nAGENTV_CHANNEL=edge\n");
  writeFileSync(join(scratch, "secret.txt"), "not for the TV");

  daemon = new Daemon({ root, state, port: 0, log: (line) => lines.push(line), running: "0.2.0-3" });
  port = await daemon.listen();
  url = `http://127.0.0.1:${port}`;
});

after(async () => {
  await daemon.close();
  rmSync(scratch, { recursive: true, force: true });
});

// A raw request, so the test can set Host and Origin as a browser elsewhere would.
function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function health(): Promise<Record<string, unknown>> {
  return (await fetch(`${url}/health`)).json() as Promise<Record<string, unknown>>;
}

async function setup(done: boolean): Promise<Response> {
  return fetch(`${url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done }) });
}

test("S0.1 /health starts on the welcome screen, not yet shown, as the placeholder did", async () => {
  const h = await health();
  assert.deepEqual(
    { ok: h.ok, service: h.service, version: h.version, channel: h.channel, screen: h.screen, shown: h.welcome_shown, count: h.welcome_shown_count },
    { ok: true, service: "agentv", version: "0.2.0", channel: "edge", screen: "welcome", shown: false, count: 0 },
  );
});

test("/health says which agentv this daemon runs, from when it started, beside what's on disk", async () => {
  assert.equal((await health()).running, "0.2.0-3");
  // An update puts a newer one on disk; the daemon still runs the one it started with.
  writeFileSync(join(root, "settings"), "AGENTV_VERSION=0.3.0\nAGENTV_CHANNEL=edge\n");
  const h = await health();
  assert.deepEqual([h.version, h.running], ["0.3.0", "0.2.0-3"]);
  writeFileSync(join(root, "settings"), "AGENTV_VERSION=0.2.0\nAGENTV_CHANNEL=edge\n");
});

test("the agentv package installed is read from pacman's own records, with its release", () => {
  const db = join(scratch, "pacman");
  for (const entry of ["agentv-keyring-20261020-1", "agentv-0.2.0.r84.g8651ebebc-99", "omarchy-4.0.6-1"]) mkdirSync(join(db, entry), { recursive: true });
  assert.equal(installedPackage(db), "0.2.0.r84.g8651ebebc-99");
  assert.equal(installedPackage(join(scratch, "no-pacman")), "dev");
});

test("S0.1 setup's page is served, and each time it's drawn /health counts it", async () => {
  const page = await (await fetch(`${url}/`)).text();
  assert.match(page, /<title>AgenTV setup<\/title>/);
  assert.match(page, /\/setup\/main\.ts/);
  assert.match(await (await fetch(`${url}/setup/main.ts`)).text(), /\/api\/welcome-shown/);
  assert.equal((await fetch(`${url}/logo.svg`)).headers.get("content-type"), "image/svg+xml");

  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${url}/api/welcome-shown`, { method: "POST", headers: { Origin: url } });
    assert.equal(response.status, 204);
  }
  const h = await health();
  assert.equal(h.welcome_shown, true);
  assert.equal(h.welcome_shown_count, 2);
  assert.match(String(h.welcome_shown_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
});

test("once setup is done, the home screen takes the place of setup, and it can go back", async () => {
  const events = await fetch(`${url}/api/events`);
  const reader = events.body!.getReader();
  assert.equal((await setup(true)).status, 200);
  let seen = "";
  while (!seen.includes("event: setup")) seen += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();

  assert.equal((await health()).screen, "home");
  assert.match(await (await fetch(`${url}/`)).text(), /<h1>home<\/h1>/);
  const saved = await (await fetch(`${url}/api/state`)).json();
  assert.equal(saved.setup.done, true);

  assert.equal((await setup(false)).status, 200);
  assert.equal((await health()).screen, "welcome");
  assert.match(await (await fetch(`${url}/`)).text(), /<title>AgenTV setup<\/title>/);
});

test("setup takes only a done of true or false, as JSON", async () => {
  assert.equal((await fetch(`${url}/api/setup`, { method: "POST", body: "done" })).status, 400);
  assert.equal((await fetch(`${url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"done":"yes"}' })).status, 400);
});

test("the launcher's TypeScript is served as JavaScript, with its types stripped", async () => {
  const response = await fetch(`${url}/launcher/focus.ts`);
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  const code = await response.text();
  assert.doesNotMatch(code, /: number/);
  assert.match(code, /export function next\(index\s*, count\s*\)/);
});

test("setup's soundtrack is served as audio: HEAD says it's there, and a range sends part of it", async () => {
  mkdirSync(join(root, "setup/audio"), { recursive: true });
  writeFileSync(join(root, "setup/audio/track.mp3"), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  const head = await fetch(`${url}/setup/audio/track.mp3`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "audio/mpeg");
  assert.equal(head.headers.get("content-length"), "256");
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(`${url}/setup/audio/missing.mp3`, { method: "HEAD" })).status, 404);

  const part = async (range: string) => {
    const response = await fetch(`${url}/setup/audio/track.mp3`, { headers: { Range: range } });
    return { status: response.status, range: response.headers.get("content-range"), bytes: [...new Uint8Array(await response.arrayBuffer())] };
  };
  assert.deepEqual(await part("bytes=0-3"), { status: 206, range: "bytes 0-3/256", bytes: [0, 1, 2, 3] });
  assert.deepEqual(await part("bytes=254-"), { status: 206, range: "bytes 254-255/256", bytes: [254, 255] });
  assert.deepEqual(await part("bytes=-2"), { status: 206, range: "bytes 254-255/256", bytes: [254, 255] });
  assert.deepEqual(await part("bytes=250-999"), { status: 206, range: "bytes 250-255/256", bytes: [250, 251, 252, 253, 254, 255] });
  assert.equal((await part("bytes=300-")).status, 416);
  // No range, or one it doesn't read, is the whole file.
  assert.equal((await part("items=0-3")).bytes.length, 256);
  assert.equal((await fetch(`${url}/setup/audio/track.mp3`)).status, 200);
  // The pages' TypeScript is still whole, with its types stripped.
  assert.equal((await fetch(`${url}/launcher/focus.ts`, { headers: { Range: "bytes=0-3" } })).status, 200);
});

test("only the TV's page folders are served", async () => {
  for (const path of ["/launcher/../secret.txt", "/launcher/%2e%2e/%2e%2e/secret.txt", "/../secret.txt", "/settings", "/daemon/server.ts", "/launcher/missing.ts", "/launcher/"]) {
    assert.equal((await raw("GET", path, { Host: `127.0.0.1:${port}` })).status, 404, path);
  }
  assert.equal((await raw("GET", "/launcher/%E0%A4%A", { Host: `127.0.0.1:${port}` })).status, 400);
});

test("a request addressed to another name is refused, which stops DNS rebinding", async () => {
  assert.equal((await raw("GET", "/health", { Host: "evil.example:3000" })).status, 403);
  assert.equal((await raw("GET", "/health", { Host: `localhost:${port}` })).status, 200);
});

test("a page on another site can't change anything here", async () => {
  const json = { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" };
  assert.equal((await raw("POST", "/api/setup", { ...json, Origin: "https://evil.example" }, '{"done":true}')).status, 403);
  assert.equal((await raw("POST", "/api/welcome-shown", { ...json, Origin: "http://192.168.1.20:3000" })).status, 403);
  assert.equal((await health()).screen, "welcome");
  // A command on the box sends no Origin.
  assert.equal((await raw("POST", "/api/setup", json, '{"done":false}')).status, 200);
  assert.ok(lines.some((line) => /refused POST \/api\/setup: not from one of this box's own pages/.test(line)));
});

test("S2.12 home hears about an update even when the update folder comes after the daemon", async () => {
  const dir = join(scratch, "update");
  const updates = new Updates({ dir, state: join(scratch, "update-state") });
  let heard = 0;
  updates.watch(() => heard++, 50);
  const until = async (done: () => boolean) => {
    for (let tries = 0; tries < 100 && !done(); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
    return done();
  };
  // A new box: the first check makes the folder, and an install starts, before
  // the daemon has looked again.
  mkdirSync(dir);
  writeFileSync(join(dir, "progress.json"), '{"state": "running"}');
  assert.ok(await until(() => heard > 0), "what was written before it looked");
  const before = heard;
  writeFileSync(join(dir, "after.json"), '{"ok": false}');
  assert.ok(await until(() => heard > before), "and what's written after");
  updates.stop();
});
