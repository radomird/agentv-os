// What's playing, in full (track 27, behind the playing2 switch): play and
// pause as two requests that leave what's already so alone, previous, a
// jump to a place in seconds, and where the thing is. The TV session's half
// is daemon/remote-play.ts, the app's own player first and the page's video
// after it. The daemon's half is daemon/routes/remote.ts: the requests, the
// state's nowPlaying and its picture. What the page's own script does is
// checked in a real Chromium, in test/origaitv/ui/playing2.test.mts.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { MUSIC } from "../../../daemon/music.ts";
import { MEDIA_NOW, mediaSeek, mediaSet, PhonePlayback, type PlaybackFront, type PlayingNow } from "../../../daemon/remote-play.ts";
import { RemoteInput } from "../../../daemon/remote.ts";
import { cleanAnswer, cleanNow, moved, PhoneRemote, PLAYBACK_FULL_MS, toldNow, type PlayingOptions } from "../../../daemon/routes/remote.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("it didn't happen in time");
    await sleep(10);
  }
}

// A page whose video is where the test says, and what was run in it.
function page(video: { position: number; duration: number | null; playing: boolean; title?: string } | null) {
  const ran: string[] = [];
  const names = new Map([
    [MEDIA_NOW, "now"],
    [mediaSet("playing"), "play"],
    [mediaSet("paused"), "pause"],
  ]);
  return {
    ran,
    evaluate: async (expression: string) => {
      const jump = /const jump = (\{[^}]*\});/.exec(expression)?.[1];
      ran.push(names.get(expression) ?? (jump ? `seek ${jump}` : "other"));
      if (expression === MEDIA_NOW) return video && { title: video.title ?? "A page", position: video.position, duration: video.duration, playing: video.playing, seek: video.duration !== null, at: 1_000 };
      return video ? { ok: true } : { ok: false, why: "Nothing is playing" };
    },
  };
}

// An app that steers its own player: every call it got, and what it has.
function player(has: string[], state: object | null = { title: "Sintel", position: 100, duration: 888, playing: true }) {
  const calls: unknown[][] = [];
  return {
    calls,
    app: async (path: string, ...args: unknown[]) => {
      calls.push([path, ...args]);
      if (path === "playback.readPlaybackState") return state;
      if (!has.includes(path)) throw new Error(`the app has no ${path}`);
      return undefined;
    },
    has: async (path: string) => has.includes(path),
  };
}

const ALL = ["playback.next", "playback.pause", "playback.resume", "playback.previous", "playback.seek"];

test("T27.2 an app that declares its own playback gets each request, the jump with its seconds", async () => {
  const own = player(ALL);
  const shown = page({ position: 100, duration: 888, playing: true });
  const playback = new PhonePlayback({ front: () => ({ kind: "page", id: "origaitv.tube", evaluate: shown.evaluate, app: own.app, has: own.has }), keys: async () => {} });
  for (const action of ["play", "pause", "previous", "next"] as const) assert.deepEqual(await playback.answer({ action }), { ok: true, by: "app" }, action);
  assert.deepEqual(await playback.answer({ action: "seek", position: 754 }), { ok: true, by: "app" });
  assert.deepEqual(own.calls, [["playback.resume"], ["playback.pause"], ["playback.previous"], ["playback.next"], ["playback.seek", 754]]);
  assert.deepEqual(shown.ran, [], "its page's video is left alone");
});

test("T27.2 an app without its own falls back to the page's video: play, pause, and a jump by as far as the place is from where the app says it is", async () => {
  const own = player([]);
  const shown = page({ position: 130, duration: 918, playing: true });
  const front: PlaybackFront = { kind: "page", id: "origaitv.tube", evaluate: shown.evaluate, app: own.app, has: own.has };
  const playback = new PhonePlayback({ front: () => front, keys: async () => {} });
  assert.deepEqual(await playback.answer({ action: "pause" }), { ok: true, by: "page" });
  assert.deepEqual(await playback.answer({ action: "play" }), { ok: true, by: "page" });
  // The app says 100 s where the video's own clock says 130: 160 is 60 on.
  assert.deepEqual(await playback.answer({ action: "seek", position: 160 }), { ok: true, by: "page" });
  assert.deepEqual(shown.ran, ["pause", "play", 'seek {"by":60}']);
  assert.deepEqual(await playback.answer({ action: "previous" }), { ok: false, why: "This app can't go back" });

  // With no app at all, the video goes to the place itself.
  const bare = page({ position: 10, duration: 60, playing: false });
  const plain = new PhonePlayback({ front: () => ({ kind: "page", id: "local.clips", evaluate: bare.evaluate }), keys: async () => {} });
  assert.deepEqual(await plain.answer({ action: "seek", position: 42 }), { ok: true, by: "page" });
  assert.deepEqual(bare.ran, ['seek {"to":42}']);
  const empty = new PhonePlayback({ front: () => ({ kind: "page", id: "x", ...page(null) }), keys: async () => {} });
  for (const action of ["play", "pause"] as const) assert.deepEqual(await empty.answer({ action }), { ok: false, why: "Nothing is playing" });
  assert.deepEqual(await empty.answer({ action: "seek", position: 5 }), { ok: false, why: "Nothing is playing" });
});

test("T27.2 where the thing is comes from the app's own word, with what it can do, and from the page's video when the app has none", async () => {
  const shown = page({ position: 130, duration: 918, playing: true, title: "tube" });
  let own = player(["playback.next", "playback.seek"], { title: "Sintel", season: 1, episode: 2, position: 100.4, duration: 888, playing: false, picture: "https://tube.example/sintel.jpg" });
  const playback = new PhonePlayback({ front: () => ({ kind: "page", id: "origaitv.tube", evaluate: shown.evaluate, app: own.app, has: own.has }), keys: async () => {} });
  const now = (await playback.now())!;
  assert.ok(Math.abs(now.at - Date.now()) < 2000, "it says when it was read");
  assert.deepEqual({ ...now, at: 0 }, { by: "app", id: "origaitv.tube", title: "Sintel", position: 100.4, duration: 888, playing: false, at: 0, next: true, previous: false, seek: true, picture: "https://tube.example/sintel.jpg" });

  // The app says there's nothing after this one, and has no seek: the
  // page's video can still jump.
  own = player(["playback.next", "playback.previous"], { title: "Sintel", position: 5, duration: 888, playing: true, hasNext: false });
  assert.deepEqual({ ...(await playback.now())!, at: 0 }, { by: "app", id: "origaitv.tube", title: "Sintel", position: 5, duration: 888, playing: true, at: 0, next: false, previous: true, seek: true });

  // Nothing from the app: the page's video, which has no next or previous.
  own = player(ALL, null);
  assert.deepEqual(await playback.now(), { by: "page", id: "origaitv.tube", title: "tube", position: 130, duration: 918, playing: true, seek: true, at: 1_000, next: false, previous: false });

  // Something live has no length, and nowhere to jump to.
  const live = new PhonePlayback({ front: () => ({ kind: "page", id: "local.cam", ...page({ position: 12, duration: null, playing: true }) }), keys: async () => {} });
  assert.equal((await live.now())!.seek, false);
  assert.equal((await live.now())!.duration, null);

  // The answer to a request can carry it, read after the request was done.
  const after = await playback.answer({ action: "pause", now: true });
  assert.equal(after.ok, true);
  assert.equal(after.now?.title, "tube");
  assert.deepEqual(await playback.answer({ action: "now" }), { ok: true, now: after.now });
});

test("T27.2 looking again doesn't read the app again: its last read for the ledger does while it's fresh, until something is asked of its player", async () => {
  const own = player(["playback.pause"], { title: "Sintel", position: 300, duration: 888, playing: false });
  const shown = page({ position: 130, duration: 918, playing: false });
  let last: { state: any; at: number } | null = { state: { title: "Sintel", position: 100, duration: 888, playing: true }, at: Date.now() - 4000 };
  const playback = new PhonePlayback({ front: () => ({ kind: "page", id: "origaitv.tube", evaluate: shown.evaluate, app: own.app, has: own.has, last: () => last }), keys: async () => {} });
  const first = (await playback.now())!;
  assert.deepEqual([first.position, first.at, first.playing], [100, last.at, false], "the reading from 4 s back, with when it was read, and the page's word on whether it plays now");
  assert.deepEqual(own.calls, [], "the app wasn't read for it");

  // A pause from the phone: what was read before it is out of date, so the
  // app is read for the answer, and again until the ledger has read it anew.
  const paused = await playback.answer({ action: "pause", now: true });
  assert.equal(paused.now?.position, 300);
  assert.equal((await playback.now())!.position, 300);
  assert.deepEqual(own.calls, [["playback.pause"], ["playback.readPlaybackState"], ["playback.readPlaybackState"]]);
  last = { state: { title: "Sintel", position: 301, duration: 888, playing: false }, at: Date.now() + 1 };
  assert.equal((await playback.now())!.position, 301);
  assert.equal(own.calls.length, 3);

  // One that's gone stale, or gone, isn't used.
  last = { state: last.state, at: Date.now() - 60_000 };
  assert.equal((await playback.now())!.position, 300);
  last = null;
  assert.equal((await playback.now())!.position, 300);
  assert.equal(own.calls.length, 5);
});

test("T27.2 with home in front: a shared video in home's player, then Music, which says what its queue has and can't jump", async () => {
  const music: Record<string, unknown>[] = [];
  let now: object | null = { title: "Night Shift", artist: "Lucy Dacus", album: "Historian", albumId: "a1", position: 31.5, duration: 392, playing: true, index: 0, count: 3 };
  const handle = async (request: Record<string, unknown>) => (music.push(request), request.op === "now" ? { ok: true, now } : request.op === "cover" ? { ok: true, cover: "data:image/jpeg;base64,/9j/4AAQ" } : { ok: true });
  let front: PlaybackFront = { kind: "home", evaluate: page(null).evaluate, music: handle };
  const playback = new PhonePlayback({ front: () => front, keys: async () => {} });
  assert.deepEqual({ ...(await playback.now())!, at: 0 }, { by: "app", id: MUSIC, title: "Night Shift", position: 31.5, duration: 392, playing: true, at: 0, next: true, previous: false, seek: false, cover: true });
  assert.deepEqual(await playback.answer({ action: "pause" }), { ok: true, by: "app" });
  assert.deepEqual(music.at(-1), { op: "pause", on: true });
  assert.deepEqual(await playback.answer({ action: "pause" }), { ok: true, by: "app" });
  assert.deepEqual(music.at(-1), { op: "pause", on: true }, "pause twice asks for paused twice, never a toggle");
  assert.deepEqual(await playback.answer({ action: "play" }), { ok: true, by: "app" });
  assert.deepEqual(music.at(-1), { op: "pause", on: false });
  assert.deepEqual(await playback.answer({ action: "previous" }), { ok: true, by: "app" });
  assert.deepEqual(music.at(-1), { op: "previous" });
  assert.deepEqual(await playback.answer({ action: "seek", position: 60 }), { ok: false, why: "This app can't jump to a time" });
  assert.deepEqual(await playback.answer({ action: "picture" }), { ok: true, picture: "data:image/jpeg;base64,/9j/4AAQ" });
  assert.deepEqual(music.at(-1), { op: "cover", key: "a1" });

  // A shared video in home's own player comes first while it plays.
  const video = page({ position: 3, duration: 20, playing: true, title: "clip.webm" });
  front = { kind: "home", evaluate: video.evaluate, music: handle };
  assert.equal((await playback.now())!.id, "home");
  assert.deepEqual(await playback.answer({ action: "seek", position: 12 }), { ok: true, by: "page" });
  assert.deepEqual(await playback.answer({ action: "pause" }), { ok: true, by: "page" });
  assert.deepEqual(
    video.ran.filter((what) => what !== "now"),
    ['seek {"to":12}', "pause"],
  );

  now = null;
  front = { kind: "home", evaluate: page(null).evaluate, music: handle };
  assert.equal(await playback.now(), null);
  assert.deepEqual(await playback.answer({ action: "play" }), { ok: false, why: "Nothing is playing" });
  assert.deepEqual(await playback.answer({ action: "previous" }), { ok: false, why: "This app can't go back" });
  assert.deepEqual(await playback.answer({ action: "picture" }), { ok: false });
});

test("T27.2 a native app has one key for play and pause, so the two requests are refused there, and nothing says where it is", async () => {
  const keys: Record<string, unknown>[] = [];
  const playback = new PhonePlayback({ front: () => ({ kind: "native", id: "0xd" }), keys: async (request) => void keys.push(request) });
  assert.deepEqual(await playback.answer({ action: "play" }), { ok: false, why: "This app can't do that" });
  assert.deepEqual(await playback.answer({ action: "pause" }), { ok: false, why: "This app can't do that" });
  assert.deepEqual(await playback.answer({ action: "seek", position: 9 }), { ok: false, why: "This app can't jump to a time" });
  assert.deepEqual(await playback.answer({ action: "previous", now: true }), { ok: true, by: "key", now: null });
  assert.deepEqual(keys, [{ key: "previous" }]);
  const none = new PhonePlayback({ front: () => null, keys: async () => {} });
  assert.deepEqual(await none.answer({ action: "pause", now: true }), { ok: false, why: "Nothing is playing", now: null });
  assert.deepEqual(await none.answer({ action: "seek", position: -1 }), { ok: false, why: "Couldn't jump there" });
});

test("T27.2 on Omarchy's desktop, with nothing to see what plays, the keys still go and the rest says it can't", async () => {
  const streams = new Set<ServerResponse>();
  const answers: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      answers.push(JSON.parse(text));
      response.writeHead(200).end("{}");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(": origaitv remote\n\n");
    streams.add(response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const sent: unknown[] = [];
  const input = new RemoteInput({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/remote`, as: "desktop", send: async (request) => void sent.push(request), log: () => {}, retryMs: 20 });
  input.start();
  await until(() => streams.size === 1);
  const say = (ask: object) => [...streams][0].write(`data: ${JSON.stringify({ ask })}\n\n`);
  say({ n: 1, kind: "playback", action: "previous", now: true });
  say({ n: 2, kind: "playback", action: "pause", now: true });
  say({ n: 3, kind: "playback", action: "now" });
  await until(() => answers.length === 3);
  assert.deepEqual(sent, [{ key: "previous" }]);
  assert.deepEqual(answers, [{ ok: true, by: "key", now: null }, { ok: false, why: "This app can't do that", now: null }, { ok: true, now: null }]);
  input.stop();
  for (const stream of streams) stream.destroy();
  server.close();
});

// --- The daemon's half ---------------------------------------------------

const NOW: PlayingNow = { by: "app", id: "origaitv.tube", title: "Sintel", position: 100, duration: 888, playing: true, at: Date.parse("2026-11-17T20:00:00Z"), next: true, previous: false, seek: true };

test("T27.1 what a phone is told: seconds, when they were read, playing or paused, and what can be asked", () => {
  const at = NOW.at + 30_000;
  assert.deepEqual(toldNow(NOW, "Tube", true, at), { title: "Sintel", app: "Tube", left: 13, position: 100, duration: 888, at: "2026-11-17T20:00:00.000Z", playing: true, next: true, previous: false, seek: true, picture: true });
  assert.deepEqual(toldNow({ ...NOW, duration: null, playing: false, seek: false }, "Cam", false, at), { title: "Sintel", app: "Cam", position: 100, duration: null, at: "2026-11-17T20:00:00.000Z", playing: false, next: true, previous: false, seek: false, picture: false });
  assert.equal(toldNow({ ...NOW, title: "" }, "Tube", false).title, "Tube", "a page with no title is called by its app");
});

test("T27.1 a reading that only ran on with the clock isn't news; a pause, a jump or another length is", () => {
  const later = { ...NOW, position: 110.3, at: NOW.at + 10_000 };
  assert.equal(moved(NOW, later), false);
  assert.equal(moved(NOW, { ...later, position: 400 }), true, "a jump made on the TV itself");
  assert.equal(moved(NOW, { ...later, playing: false }), true);
  assert.equal(moved(NOW, { ...later, next: false }), true);
  assert.equal(moved(NOW, { ...later, duration: null }), true);
  const paused = { ...NOW, playing: false };
  assert.equal(moved(paused, { ...paused, at: NOW.at + 60_000 }), false, "paused, it stays where it is");
  assert.equal(moved(paused, { ...paused, position: 103, at: NOW.at + 60_000 }), true);
});

test("T27.1 only what a reading can be gets through from the TV session", () => {
  assert.deepEqual(cleanNow({ ...NOW, extra: "x", picture: "https://tube.example/a.jpg" }), { ...NOW, picture: "https://tube.example/a.jpg" });
  assert.equal(cleanNow({ ...NOW, position: "100" }), null);
  assert.equal(cleanNow({ ...NOW, id: "" }), null);
  assert.equal(cleanNow(null), null);
  assert.equal(cleanNow({ ...NOW, position: 9000 })!.position, 888, "never past its own length");
  assert.equal(cleanNow({ ...NOW, duration: Infinity })!.duration, null);
  assert.equal(cleanNow({ ...NOW, title: "a\u0000b" })!.title, "a b");
  assert.equal(cleanAnswer({ ok: true, now: null }).now, null);
  assert.equal("now" in cleanAnswer({ ok: true }), false);
  assert.equal(cleanAnswer({ ok: true, picture: "data:text/html;base64,PGI+" }).picture, undefined, "a picture is a picture");
  assert.equal(cleanAnswer({ ok: true, picture: "data:image/png;base64,iVBORw0KGgo=" }).picture, "data:image/png;base64,iVBORw0KGgo=");
});

// The daemon's routes on a server of the test's own, with the TV session
// stood in for by what it answers.
async function routes(options: { on?: boolean; answer?: (ask: any) => object | null; picture?: PlayingOptions["picture"]; playing?: boolean } = {}) {
  const asks: any[] = [];
  let on = options.on ?? true;
  let changes = 0;
  let remote: PhoneRemote;
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    void remote.phone(request.method!, path, request, response).then(async (done) => {
      if (!done && !(await remote.local(request.method!, path, request, response))) response.writeHead(404).end(JSON.stringify({ ok: false, error: "not found" }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  remote = new PhoneRemote({
    send: (event) => {
      const ask = (event as { ask: any }).ask;
      asks.push(ask);
      const said = options.answer ? options.answer(ask) : { ok: true, by: "page" };
      if (said) setTimeout(() => void fetch(`${base}/api/remote/answer/${ask.n}`, { method: "POST", headers: { "Content-Type": "application/json", "X-OrigaiTV-Screen": "1" }, body: JSON.stringify(said) }), 5);
      return true;
    },
    tv: () => ({ field: null, front: "app", playing: options.playing ?? false }),
    viewer: async () => ({ name: "Radomir" }),
    toPages: () => {},
    json: (response: ServerResponse, status: number, data: unknown) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data)),
    body: async (request: IncomingMessage) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    },
    answerMs: 300,
    playing2: {
      on: async () => on,
      name: async (app) => (app === "origaitv.tube" ? "Tube" : app),
      picture: options.picture ?? (async () => null),
      changed: () => void changes++,
      send: (response, type, body) => response.writeHead(200, { "Content-Type": type }).end(body),
      lookMs: 40,
    },
  });
  const post = async (body: unknown) => {
    const response = await fetch(`${base}/api/phone/playback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return {
    remote,
    asks,
    post,
    changes: () => changes,
    turn: (to: boolean) => (on = to),
    picture: () => fetch(`${base}/api/phone/playing/picture`),
    close: () => {
      remote.close();
      server.close();
    },
  };
}

test("T27.1 with the switch off, the routes and the state are as they were: no play, no picture, and nothing asked of the TV session", async () => {
  const box = await routes({ on: false, playing: true });
  assert.deepEqual(await box.post({ action: "play" }), { status: 400, body: { ok: false, error: 'the action is "toggle" or "next"' } });
  assert.deepEqual(await box.post({ action: "seek", position: 5 }), { status: 400, body: { ok: false, error: 'the action is "toggle" or "next"' } });
  assert.deepEqual(await box.post({ action: "next" }), { status: 200, body: { ok: true, by: "page" } });
  assert.deepEqual(box.asks.at(-1), { n: 1, kind: "playback", action: "next" }, "next asks for nothing more than it did");
  assert.equal((await box.picture()).status, 404);
  box.remote.tvChanged();
  await box.remote.look();
  assert.equal(box.asks.length, 1, "nothing looks at what plays");
  assert.equal(box.remote.nowPlaying(), null);
  assert.equal(box.changes(), 0);
  box.close();
});

test("T27.1 with it on, each request of its own is answered with where the thing then is, and the state says the same", async () => {
  let now: PlayingNow | null = { ...NOW, at: Date.now() };
  const box = await routes({ answer: (ask) => (ask.action === "now" ? { ok: true, now } : { ok: true, by: "app", ...(ask.now ? { now } : {}) }) });
  const paused = await box.post({ action: "pause" });
  assert.equal(paused.status, 200);
  assert.deepEqual({ ...paused.body, nowPlaying: { ...paused.body.nowPlaying, at: "" } }, { ok: true, by: "app", nowPlaying: { title: "Sintel", app: "Tube", left: 13, position: 100, duration: 888, at: "", playing: true, next: true, previous: false, seek: true, picture: false } });
  assert.deepEqual(box.asks.at(-1), { n: 1, kind: "playback", action: "pause", now: true });
  assert.deepEqual(box.remote.nowPlaying(), paused.body.nowPlaying);
  assert.equal(box.changes(), 1, "the phones heard that something plays");

  now = { ...now, position: 754, at: Date.now() };
  const jumped = await box.post({ action: "seek", position: 754 });
  assert.equal(jumped.body.nowPlaying.position, 754);
  assert.deepEqual(box.asks.at(-1), { n: 2, kind: "playback", action: "seek", now: true, position: 754 });
  assert.equal(box.changes(), 2, "a jump is news");
  for (const action of ["play", "previous", "next"]) assert.equal((await box.post({ action })).body.nowPlaying.title, "Sintel", action);
  assert.equal(box.changes(), 2, "the same place again isn't");

  // Toggle stays as it is, for the web remote.
  assert.deepEqual(await box.post({ action: "toggle" }), { status: 200, body: { ok: true, by: "app" } });
  assert.deepEqual(box.asks.at(-1), { n: 6, kind: "playback", action: "toggle" });

  for (const bad of [{ action: "seek" }, { action: "seek", position: "754" }, { action: "seek", position: -1 }, { action: "seek", position: 1e9 }]) {
    assert.deepEqual(await box.post(bad), { status: 400, body: { ok: false, error: "seek takes a position in seconds" } });
  }
  assert.equal((await box.post({ action: "rewind" })).status, 400);
  assert.ok(PLAYBACK_FULL_MS <= 20_000, "a request never waits longer than the doc says");

  // It stops: the state lets go, and the phones hear.
  now = null;
  await box.remote.look();
  assert.equal(box.remote.nowPlaying(), null);
  assert.equal(box.changes(), 3);
  box.close();
});

test("T27.1 while something plays it's read again now and then, so a jump made on the TV reaches the phones, and with the switch turned off it's let go", async () => {
  let now: PlayingNow = { ...NOW, at: Date.now() };
  const box = await routes({ playing: true, answer: (ask) => (ask.action === "now" ? { ok: true, now } : { ok: true }) });
  box.remote.tvChanged();
  await until(() => box.remote.nowPlaying() !== null);
  assert.equal(box.changes(), 1);
  const looks = box.asks.length;
  await until(() => box.asks.length >= looks + 2);
  assert.equal(box.changes(), 1, "reading it again changes nothing by itself");
  now = { ...now, position: 500, at: Date.now() };
  await until(() => box.changes() === 2);
  assert.equal(box.remote.nowPlaying()!.position, 500);
  box.turn(false);
  await until(() => box.remote.nowPlaying() === null);
  assert.equal(box.changes(), 3);
  const quiet = box.asks.length;
  await sleep(150);
  assert.equal(box.asks.length, quiet, "and nothing looks any more");
  box.close();
});

test("T27.1 a picture for what's playing: what the TV already has for the title, or the cover the TV session holds, to whoever the route lets in", async () => {
  const wanted: PlayingNow[] = [];
  let now: PlayingNow = { ...NOW, at: Date.now(), picture: "https://tube.example/sintel.jpg" };
  const box = await routes({
    answer: (ask) => (ask.action === "now" ? { ok: true, now } : ask.action === "picture" ? { ok: true, picture: `data:image/jpeg;base64,${Buffer.from("a cover").toString("base64")}` } : { ok: true }),
    picture: async (playing) => (wanted.push(playing), playing.title === "Sintel" ? { type: "image/png", body: Buffer.from("a poster") } : null),
  });
  assert.equal((await box.picture()).status, 404, "nothing plays yet");
  await box.remote.look();
  await until(() => box.remote.nowPlaying()?.picture === true);
  assert.equal(box.changes(), 2, "once for the title, once for its picture");
  assert.equal(wanted[0].picture, "https://tube.example/sintel.jpg");
  const poster = await box.picture();
  assert.equal(poster.headers.get("content-type"), "image/png");
  assert.equal(await poster.text(), "a poster");

  // Another title with no picture anywhere.
  now = { ...now, title: "Spring", picture: undefined };
  await box.remote.look();
  assert.equal(box.remote.nowPlaying()!.picture, false);
  assert.deepEqual(await (await box.picture()).json(), { ok: false, error: "There's no picture for what's playing" });

  // Music's cover is the TV session's to hand over.
  now = { ...now, id: MUSIC, title: "Night Shift", cover: true };
  await box.remote.look();
  await until(() => box.remote.nowPlaying()?.picture === true);
  const cover = await box.picture();
  assert.equal(cover.headers.get("content-type"), "image/jpeg");
  assert.equal(await cover.text(), "a cover");
  assert.equal(wanted.length, 2, "the daemon isn't asked for a cover");
  box.close();
});
