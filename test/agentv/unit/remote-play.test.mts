// Play and pause in every app (ADR-065, track 8's T8.2): the app's own
// pause and resume first, then the page's audio or video, then home's
// player and Music, and a native app's media key. The phone always hears
// whether it worked, and why not.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MEDIA_PLAYING, MEDIA_STATE, MEDIA_TOGGLE, PhonePlayback, type PlaybackFront } from "../../../daemon/remote-play.ts";

// A page whose media state is set by the test, and what ran in it.
function page(state: { playing: boolean; any: boolean }, toggled: object = { ok: true, did: "paused" }) {
  const ran: string[] = [];
  return {
    ran,
    evaluate: async (expression: string) => {
      ran.push(expression === MEDIA_STATE ? "state" : expression === MEDIA_TOGGLE ? "toggle" : "other");
      return expression === MEDIA_STATE ? state : expression === MEDIA_TOGGLE ? toggled : null;
    },
  };
}

test("T8.2 an app with its own pause and resume gets them, by whether its page plays", async () => {
  const calls: string[] = [];
  const app = async (path: string) => void calls.push(path);
  let front: PlaybackFront = { kind: "page", id: "agentv.tube", ...page({ playing: true, any: true }), app };
  const playback = new PhonePlayback({ front: () => front, keys: async () => {} });
  assert.deepEqual(await playback.toggle(), { ok: true, by: "app" });
  front = { kind: "page", id: "agentv.tube", ...page({ playing: false, any: true }), app };
  assert.deepEqual(await playback.toggle(), { ok: true, by: "app" });
  assert.deepEqual(calls, ["playback.pause", "playback.resume"]);
});

test("T8.2 a player the page can't see: the app's own state says whether it plays", async () => {
  const calls: string[] = [];
  const app = async (path: string) => {
    calls.push(path);
    return path === "playback.readPlaybackState" ? { title: "Sintel", position: 60, duration: 888, playing: true } : undefined;
  };
  const playback = new PhonePlayback({ front: () => ({ kind: "page", id: "agentv.tube", ...page({ playing: false, any: false }), app }), keys: async () => {} });
  assert.deepEqual(await playback.toggle(), { ok: true, by: "app" });
  assert.deepEqual(calls, ["playback.readPlaybackState", "playback.pause"]);
});

test("T8.2 an app without its own pause falls to the page's video, and with none, nothing is playing", async () => {
  const refused = async (path: string) => {
    throw new Error(`the app has no ${path}`);
  };
  const shown = page({ playing: true, any: true });
  const playback = new PhonePlayback({ front: () => ({ kind: "page", id: "agentv.tube", ...shown, app: refused }), keys: async () => {} });
  assert.deepEqual(await playback.toggle(), { ok: true, by: "page" });
  assert.deepEqual(shown.ran, ["state", "toggle"]);
  const empty = new PhonePlayback({ front: () => ({ kind: "page", id: "x", ...page({ playing: false, any: false }) }), keys: async () => {} });
  assert.deepEqual(await empty.toggle(), { ok: false, why: "nothing is playing" });
  const stuck = new PhonePlayback({ front: () => ({ kind: "page", id: "x", ...page({ playing: true, any: true }, { ok: false, why: "the player didn't pause" }) }), keys: async () => {} });
  assert.deepEqual(await stuck.toggle(), { ok: false, by: "page", why: "the player didn't pause" });
});

test("T8.2 a page that doesn't answer says so, and never hangs the phone", async () => {
  const playback = new PhonePlayback({ front: () => ({ kind: "page", id: "x", evaluate: () => new Promise(() => {}) }), keys: async () => {}, ms: 50 });
  assert.deepEqual(await playback.toggle(), { ok: false, why: "nothing is playing" });
});

test("T8.2 with home in front: a shared video in home's player first, then Music", async () => {
  const music: Record<string, unknown>[] = [];
  let now: { playing: boolean } | null = { playing: true };
  const handle = async (request: Record<string, unknown>) => (music.push(request), request.op === "now" ? { ok: true, now } : { ok: true });
  const video = page({ playing: true, any: true });
  let front: PlaybackFront = { kind: "home", evaluate: video.evaluate, music: handle };
  const playback = new PhonePlayback({ front: () => front, keys: async () => {} });
  assert.deepEqual(await playback.toggle(), { ok: true, by: "page" });
  assert.deepEqual(music, [], "home's own video plays, so Music waits");
  front = { kind: "home", ...page({ playing: false, any: false }), music: handle };
  assert.deepEqual(await playback.toggle(), { ok: true, by: "app" });
  assert.deepEqual(music.at(-1), { op: "pause", on: true });
  now = { playing: false };
  await playback.toggle();
  assert.deepEqual(music.at(-1), { op: "pause", on: false });
  assert.deepEqual(await playback.next(), { ok: true, by: "app" });
  assert.deepEqual(music.at(-1), { op: "next" });
  now = null;
  assert.deepEqual(await playback.toggle(), { ok: false, why: "nothing is playing" });
});

test("T8.2 a native app gets the media key, and next goes to the app's own next", async () => {
  const keys: Record<string, unknown>[] = [];
  let front: PlaybackFront = { kind: "native", id: "0xd" };
  const playback = new PhonePlayback({ front: () => front, keys: async (request) => void keys.push(request) });
  assert.deepEqual(await playback.toggle(), { ok: true, by: "key" });
  assert.deepEqual(await playback.next(), { ok: true, by: "key" });
  assert.deepEqual(keys, [{ key: "playpause" }, { key: "next" }]);
  const calls: string[] = [];
  front = { kind: "page", id: "agentv.tube", ...page({ playing: true, any: true }), app: async (path) => void calls.push(path) };
  assert.deepEqual(await playback.next(), { ok: true, by: "app" });
  assert.deepEqual(calls, ["playback.next"]);
  front = { kind: "page", id: "x", ...page({ playing: true, any: true }) };
  assert.deepEqual(await playback.next(), { ok: false, why: "this app has no next" });
  front = null;
  assert.deepEqual(await playback.toggle(), { ok: false, why: "nothing is playing" });
});

test("T8.2 what plays is found through shadow roots and frames, so the phone switches to playback on a service's player", () => {
  for (const expression of [MEDIA_PLAYING, MEDIA_STATE, MEDIA_TOGGLE]) {
    assert.ok(expression.includes("el.shadowRoot") && expression.includes("contentDocument"), "it looks in shadow roots and frames");
  }
});

test("T8.3 what's playing for the phone's card is the ledger's newest row while it's fresh, with the minutes left", async () => {
  const { nowPlaying } = await import("../../../daemon/routes/remote.ts");
  const row = { id: 1, viewer_id: "radomir", app_id: "local.mytv", kind: "film" as const, title: "Sintel", season: null, episode: null, position_s: 480, duration_s: 888, started_at: "2026-11-05T10:00:00+00:00", updated_at: "2026-11-05T10:00:20+00:00" };
  const at = Date.parse("2026-11-05T10:00:30Z");
  assert.deepEqual(nowPlaying([row], () => "My TV", at), { title: "sintel", app: "my tv", left: 7 });
  assert.deepEqual(nowPlaying([{ ...row, duration_s: null }], () => "My TV", at), { title: "sintel", app: "my tv" });
  assert.equal(nowPlaying([row], () => "My TV", at + 60_000), null, "a row nothing has read for a while isn't playing");
  assert.equal(nowPlaying([], () => "x", at), null);
});
