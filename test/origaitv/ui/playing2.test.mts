// What's playing, in full (track 27's T27.1), on the daemon itself, with a
// stand-in video page in a real Chromium held over a DevTools pipe, as the
// screen daemon holds the services' one. The phone is stood in for by its
// requests, signed and sealed, and the screen daemon's part is its own
// code: the stream it takes from the daemon (daemon/remote.ts) and the
// search for what plays (daemon/remote-play.ts). It runs with the playing2
// switch off and on: off, the routes and the state are as they were.

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
import { PhonePlayback, type PlaybackFront } from "../../../daemon/remote-play.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { bothWays, startBox } from "./box.mts";
import { pairPhone, type TestPhone } from "../unit/phone-client.mts";

const PAGES = resolve(import.meta.dirname, "../fixtures/remote");

let server: Server;
let site = "";
let services: ChildProcess;
let cdp: CdpPipe;
const dir = mkdtempSync(join(tmpdir(), "origaitv-playing2-ui-"));

before(async () => {
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
    process.env.ORIGAITV_UI_BROWSER!,
    ["--headless=new", "--no-sandbox", "--remote-debugging-pipe", "--no-first-run", "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${join(dir, "chromium")}`, "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  cdp = new CdpPipe(services.stdio[3] as Writable, services.stdio[4] as Readable);
});

after(async () => {
  // The browser is gone before its folder is, or it writes as it's removed.
  const gone = new Promise((done) => services?.once("exit", done));
  services?.kill();
  await Promise.race([gone, new Promise((done) => setTimeout(done, 3000))]);
  server?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function until(check: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("it didn't happen in time");
    await new Promise((done) => setTimeout(done, 20));
  }
}

// A box with a phone paired, and the screen daemon's half answering for
// whatever the test puts in front.
async function box(options: Parameters<typeof startBox>[2]) {
  const { daemon, url } = await startBox(0, undefined, options);
  let front: PlaybackFront = null;
  const playback = new PhonePlayback({ front: () => front, keys: async () => {} });
  const input = new RemoteInput({ url: `${url}/api/remote`, send: async () => {}, ask: async (ask) => (ask.kind === "playback" ? playback.answer(ask) : { ok: false }), log: () => {} });
  input.start();
  const { pairing } = await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json();
  const phone: TestPhone = await pairPhone(`http://127.0.0.1:${(daemon as Daemon).lanPort}`, pairing.code, "an iphone");
  const press = async (body: object): Promise<{ status: number; body: Record<string, any> }> => {
    const response = await phone.fetch("/api/phone/playback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return {
    press,
    phone,
    state: async () => (await phone.json("GET", "/api/phone/state")).nowPlaying as Record<string, any> | null,
    // What the screen daemon tells the daemon when what's in front changes.
    tv: async (now: PlaybackFront, playing: boolean) => {
      front = now;
      await fetch(`${url}/api/tv/context`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ front: now ? "app" : "home", playing }) });
    },
    close: async () => {
      input.stop();
      await daemon.close();
    },
  };
}

// The stand-in video page, playing, and its video.
async function playing(): Promise<{ target: string; evaluate: (expression: string) => Promise<any> }> {
  const target = await cdp.open(`${site}playing.html`);
  const evaluate = (expression: string) => cdp.evaluateIn(target, expression);
  await until(async () => (await evaluate(`document.readyState === "complete" && !!window.ready`).catch(() => false)) === true);
  assert.equal(await evaluate(`window.ready`), "playing");
  return { target, evaluate };
}

bothWays("playing2", "T27.1 play, pause and a jump are requests of their own, and the state says where the thing is", async (on, options) => {
  const page = await playing();
  const tv = await box(options);
  try {
    await tv.tv({ kind: "page", id: "origaitv.tube", evaluate: page.evaluate }, true);
    if (!on) {
      // As it was: no ledger row for a page with no app behind it, so
      // nothing in the state, and only toggle and next on the route.
      for (const action of ["play", "pause", "previous", "seek"]) {
        assert.deepEqual(await tv.press({ action, position: 60 }), { status: 400, body: { ok: false, error: 'the action is "toggle" or "next"' } }, action);
      }
      assert.equal(await page.evaluate(`video.paused`), false, "nothing touched the video");
      assert.deepEqual(await tv.press({ action: "toggle" }), { status: 200, body: { ok: true, by: "page" } });
      assert.equal(await page.evaluate(`video.paused`), true);
      assert.equal(await tv.state(), null);
      assert.equal((await tv.phone.fetch("/api/phone/playing/picture")).status, 404);
      return;
    }

    // The state says where it is, how long it runs, and when that was read.
    await until(async () => (await tv.state()) !== null);
    const first = (await tv.state())!;
    assert.deepEqual(
      { ...first, position: 0, at: "" },
      { title: "Sintel", app: "Tube", left: 3, position: 0, duration: 180, at: "", playing: true, next: false, previous: false, seek: true, picture: false },
      "the page's own name for it, its app, seconds, and no next or previous on a page that has none",
    );
    assert.ok(first.position >= 0 && first.position < 10, `it's near the start: ${first.position}`);
    assert.ok(Math.abs(Date.parse(first.at) - Date.now()) < 5000, `it was read just now: ${first.at}`);

    // Pause twice stays paused, and play twice stays playing.
    for (const _ of [1, 2]) {
      const paused = await tv.press({ action: "pause" });
      assert.deepEqual([paused.status, paused.body.ok, paused.body.by, paused.body.nowPlaying.playing], [200, true, "page", false]);
      assert.equal(await page.evaluate(`video.paused`), true);
    }
    assert.equal((await tv.state())!.playing, false, "paused, it's still what's playing");
    assert.equal(await page.evaluate(`backdrop.paused`), false, "a background that loops with no sound is left alone");
    for (const _ of [1, 2]) {
      const played = await tv.press({ action: "play" });
      assert.deepEqual([played.body.ok, played.body.by, played.body.nowPlaying.playing], [true, "page", true]);
      assert.equal(await page.evaluate(`video.paused`), false);
    }

    // A jump lands within a second of where it was sent, and is answered
    // with where the thing then is.
    const jumped = await tv.press({ action: "seek", position: 120 });
    assert.deepEqual([jumped.status, jumped.body.ok, jumped.body.by], [200, true, "page"]);
    assert.ok(Math.abs(jumped.body.nowPlaying.position - 120) < 1, `the answer says ${jumped.body.nowPlaying.position}`);
    assert.ok(Math.abs((await page.evaluate(`video.currentTime`)) - 120) < 1.5, "and the video is there");
    const then = (await tv.state())!;
    assert.ok(Math.abs(then.position - 120) < 1, `the state says ${then.position}`);
    assert.equal(then.left, 1);
    assert.ok(Date.parse(then.at) >= Date.parse(first.at));
    // Paused, a jump stays paused, and one past the end stops at the end.
    await tv.press({ action: "pause" });
    const back = await tv.press({ action: "seek", position: 30 });
    assert.ok(Math.abs(back.body.nowPlaying.position - 30) < 0.5);
    assert.equal(back.body.nowPlaying.playing, false);
    assert.equal((await tv.press({ action: "seek", position: 5000 })).body.nowPlaying.position, 180);
    assert.equal((await tv.press({ action: "seek" })).status, 400);

    // Previous and next aren't offered, and asking anyway says why not.
    const previous = await tv.press({ action: "previous" });
    assert.deepEqual([previous.status, previous.body.ok, previous.body.why, previous.body.nowPlaying.title], [200, false, "This app can't go back", "Sintel"]);
    assert.equal((await tv.press({ action: "next" })).body.why, "This app can't skip");

    // No picture for a page the TV knows nothing more about.
    assert.equal((await tv.phone.fetch("/api/phone/playing/picture")).status, 404);

    // The page goes away: nothing is playing, and the state says so.
    await tv.tv(null, false);
    await until(async () => (await tv.state()) === null);
    assert.deepEqual((await tv.press({ action: "pause" })).body, { ok: false, why: "Nothing is playing", nowPlaying: null });
  } finally {
    await tv.close();
    await cdp.close(page.target);
  }
});

test("T27.1 with an app that steers its own player, next and previous are offered where it has them, and a jump goes by the app's own clock", async () => {
  const page = await playing();
  const tv = await box({ features: { playing2: true } });
  try {
    // The app's place runs 20 s behind its video's clock, as a service's
    // does after a recap. It has next and its own pause, and no seek.
    const calls: string[] = [];
    let episode = 1;
    const app = async (path: string) => {
      calls.push(path);
      if (path === "playback.readPlaybackState") {
        const video = await page.evaluate(`({ time: video.currentTime, paused: video.paused })`);
        return { title: "Lantern Bay", season: 1, episode, position: Math.max(0, video.time - 20), duration: 160, playing: !video.paused, hasPrevious: episode > 1 };
      }
      if (path === "playback.pause") return page.evaluate(`video.pause()`);
      if (path === "playback.next") return void episode++;
      if (path === "playback.previous") return void episode--;
      throw new Error(`the app has no ${path}`);
    };
    const has = async (path: string) => ["playback.next", "playback.previous", "playback.pause"].includes(path);
    await page.evaluate(`video.currentTime = 50`);
    await tv.tv({ kind: "page", id: "origaitv.tube", evaluate: page.evaluate, app, has }, true);
    await until(async () => (await tv.state()) !== null);
    const first = (await tv.state())!;
    assert.deepEqual([first.title, first.app, first.duration, first.next, first.previous, first.seek], ["Lantern Bay", "Tube", 160, true, false, true]);
    assert.ok(Math.abs(first.position - 30) < 3, `the app's place, not the video's clock: ${first.position}`);

    // Next is the app's, and after it there's a previous.
    const next = await tv.press({ action: "next" });
    assert.deepEqual([next.body.ok, next.body.by, next.body.nowPlaying.previous], [true, "app", true]);
    // Pause is the app's own, and play, which it hasn't, is the page's.
    assert.deepEqual([(await tv.press({ action: "pause" })).body.by, await page.evaluate(`video.paused`)], ["app", true]);
    assert.deepEqual([(await tv.press({ action: "play" })).body.by, await page.evaluate(`video.paused`)], ["page", false]);
    // A jump to 100 s of the title is 120 s on the video's clock.
    const jumped = await tv.press({ action: "seek", position: 100 });
    assert.deepEqual([jumped.body.ok, jumped.body.by], [true, "page"]);
    assert.ok(Math.abs(jumped.body.nowPlaying.position - 100) < 1, `the answer says ${jumped.body.nowPlaying.position}`);
    assert.ok(Math.abs((await page.evaluate(`video.currentTime`)) - 120) < 1.5);
    assert.ok(calls.includes("playback.seek"), "the app was asked first");
  } finally {
    await tv.close();
    await cdp.close(page.target);
  }
});
