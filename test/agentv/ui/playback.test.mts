// Play and pause in every app (ADR-065, track 8's T8.2), on the daemon
// itself, with a stand-in streaming site's player in a real Chromium held
// over a DevTools pipe, as the screen daemon holds the services' one. Its
// video is inside a shadow root, or inside a frame, the way a service's
// player keeps it out of plain sight. The phone is stood in for by its
// requests, and the screen daemon's part is its own code: the stream it
// takes from the daemon (daemon/remote.ts) and the play and pause search
// (daemon/remote-play.ts).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { after, before, test } from "node:test";
import { CdpPipe } from "../../../daemon/cdp.ts";
import { RemoteInput } from "../../../daemon/remote.ts";
import { MEDIA_PLAYING, PhonePlayback, type PlaybackFront } from "../../../daemon/remote-play.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";
import { pairPhone, type TestPhone } from "../unit/phone-client.mts";

const PAGES = resolve(import.meta.dirname, "../fixtures/remote");

let daemon: Daemon;
let url = "";
let phoneUrl = "";
let token: TestPhone;
let server: Server;
let site = "";
let services: ChildProcess;
let cdp: CdpPipe;
let input: RemoteInput;
let front: PlaybackFront = null;
const keys: Record<string, unknown>[] = [];
const dir = mkdtempSync(join(tmpdir(), "agentv-playback-ui-"));

before(async () => {
  ({ daemon, url } = await startBox());
  phoneUrl = `http://127.0.0.1:${daemon.lanPort}`;
  server = createServer((request, response) => {
    const name = new URL(request.url ?? "/", "http://x").pathname.slice(1);
    if (!/^[a-z-]+\.(html|js)$/.test(name)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": name.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" });
    response.end(readFileSync(join(PAGES, name)));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  services = spawn(
    process.env.AGENTV_UI_BROWSER!,
    ["--headless=new", "--no-sandbox", "--remote-debugging-pipe", "--no-first-run", "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${join(dir, "chromium")}`, "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  cdp = new CdpPipe(services.stdio[3] as Writable, services.stdio[4] as Readable);
  const playback = new PhonePlayback({ front: () => front, keys: async (request) => void keys.push(request) });
  input = new RemoteInput({
    url: `${url}/api/remote`,
    send: async (request) => void keys.push(request),
    ask: async (ask) => (ask.kind === "playback" ? (ask.action === "next" ? playback.next() : playback.toggle()) : { ok: false }),
    log: () => {},
  });
  input.start();
  const { pairing } = await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json();
  token = await pairPhone(phoneUrl, pairing.code, "android phone");
});

after(async () => {
  input?.stop();
  services?.kill();
  server?.close();
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("it didn't happen in time");
    await new Promise((done) => setTimeout(done, 20));
  }
}

async function press(action: "toggle" | "next"): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await token.fetch(`/api/phone/playback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
  return { status: response.status, body: await response.json() };
}

// The stand-in player, playing, and where its video is.
async function player(where: "shadow" | "frame"): Promise<{ target: string; paused: () => Promise<boolean>; evaluate: (expression: string) => Promise<unknown> }> {
  const target = await cdp.open(`${site}player.html?in=${where}`);
  const evaluate = (expression: string) => cdp.evaluateIn(target, expression);
  await until(async () => (await evaluate(`document.readyState === "complete" && !!window.ready`).catch(() => false)) === true);
  assert.equal(await evaluate(`window.ready`), "playing");
  const video = where === "shadow" ? `document.getElementById("host").shadowRoot.getElementById("video")` : `document.getElementById("frame").contentDocument.getElementById("video")`;
  return { target, evaluate, paused: async () => (await evaluate(`${video}.paused`)) === true };
}

for (const where of ["shadow", "frame"] as const) {
  test(`T8.2 play and pause stop and start a video inside a ${where === "shadow" ? "shadow root" : "frame"}, and the phone hears it worked`, async () => {
    const page = await player(where);
    front = { kind: "page", id: "agentv.tube", evaluate: page.evaluate };
    assert.equal(await page.evaluate(MEDIA_PLAYING), true, "something is playing, as the phone's remote follows");
    assert.deepEqual(await press("toggle"), { status: 200, body: { ok: true, by: "page" } });
    assert.equal(await page.paused(), true);
    assert.equal(await page.evaluate(MEDIA_PLAYING), false);
    assert.deepEqual(await press("toggle"), { status: 200, body: { ok: true, by: "page" } });
    assert.equal(await page.paused(), false);
    assert.equal(await page.evaluate(MEDIA_PLAYING), true);
    await cdp.close(page.target);
  });
}

test("T8.2 with nothing to play, the phone hears so, and a native app gets the media key", async () => {
  const target = await cdp.open(`${site}stream.html`);
  await until(async () => (await cdp.evaluateIn(target, `document.readyState`).catch(() => "")) === "complete");
  front = { kind: "page", id: "agentv.tube", evaluate: (expression) => cdp.evaluateIn(target, expression) };
  assert.deepEqual(await press("toggle"), { status: 200, body: { ok: false, why: "Nothing is playing" } });
  await cdp.close(target);
  front = { kind: "native", id: "0xd" };
  assert.deepEqual(await press("toggle"), { status: 200, body: { ok: true, by: "key" } });
  assert.deepEqual(keys.at(-1), { key: "playpause" });
  assert.equal((await press("next")).body.ok, true);
  assert.deepEqual(keys.at(-1), { key: "next" });
});

test("T8.2 a bad press is refused, and with no TV session the phone hears that too", async () => {
  const response = await token.fetch(`/api/phone/playback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rewind" }) });
  assert.equal(response.status, 400);
  // The screen daemon stops: the stream closes, and the next press says so.
  input.stop();
  await new Promise((done) => setTimeout(done, 300));
  assert.deepEqual(await press("toggle"), { status: 503, body: { ok: false, why: "Your TV isn't ready yet" } });
});
