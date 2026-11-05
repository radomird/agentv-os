// Omarchy's dynamic backgrounds on the TV (ADR-064, T6): a theme's video
// backgrounds and its intros, found the way Omarchy finds them, served by
// the TV session from where they are with range requests, never copied, and
// streamed on to home by the daemon. An intro is due once when the TV
// session starts and after the theme changes, and Omarchy's intros switch
// is followed. Home's side is layer 4's.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Backgrounds, pictureId } from "../../../daemon/backgrounds.ts";
import { OmarchyThemes } from "../../../daemon/omarchy-themes.ts";
import { Daemon } from "../../../daemon/server.ts";
import { byteRange, cleanServe, firstFrame, probe, VideoServer, videoType } from "../../../daemon/theme-videos.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-theme-videos-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Catppuccin ships a picture with an intro of the same name.
const SHIPPED = join(ROOT, "themes", "catppuccin", "backgrounds");
const STILL = "1-totoro.webp";
const INTRO = "1-totoro.mp4";
// A JPEG, as ffmpeg gives a video's first frame.
const FRAME = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const LOOP = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(5000, 9)]);

// ffprobe and ffmpeg, as the tests have them: what was asked of each.
function standIns() {
  const probed: string[] = [];
  const framed: string[] = [];
  return {
    probed,
    framed,
    probe: async (path: string) => {
      probed.push(path);
      return { codec: path.endsWith(".webm") ? "vp9" : "h264", width: 1920, height: 1080 };
    },
    frame: async (path: string) => {
      framed.push(path);
      return FRAME;
    },
  };
}

// A person's home on Catppuccin, as omarchy-theme-set leaves it: the theme
// copied into current/theme with its intros, a video of the person's own
// for it, and Omarchy showing the picture with the intro.
function catppuccinHome(): { dir: string; state: string; still: string; intro: string; loop: string } {
  const dir = mkdtempSync(join(scratch, "home-"));
  const state = join(dir, ".local", "state", "omarchy", "current");
  const backgrounds = join(state, "theme", "backgrounds");
  mkdirSync(join(backgrounds, "intros"), { recursive: true });
  cpSync(join(SHIPPED, STILL), join(backgrounds, STILL));
  cpSync(join(SHIPPED, "intros", INTRO), join(backgrounds, "intros", INTRO));
  // A picture whose only intro is an AVI, which home's Chromium can't play.
  cpSync(join(SHIPPED, "2-waves.webp"), join(backgrounds, "2-waves.webp"));
  writeFileSync(join(backgrounds, "intros", "2-waves.avi"), "RIFF");
  const own = join(dir, ".config", "omarchy", "backgrounds", "catppuccin");
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "loop.webm"), LOOP);
  // And one Omarchy takes but home can't play at all.
  writeFileSync(join(own, "old.avi"), "RIFF");
  writeFileSync(join(state, "theme.name"), "catppuccin\n");
  symlinkSync(join(backgrounds, STILL), join(state, "background"));
  return { dir, state, still: join(backgrounds, STILL), intro: join(backgrounds, "intros", INTRO), loop: join(own, "loop.webm") };
}

async function daemon(): Promise<{ url: string; backgrounds: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(scratch, "daemon-"));
  mkdirSync(join(dir, "root", "setup"), { recursive: true });
  const backgrounds = join(dir, "backgrounds");
  const d = new Daemon({ root: join(dir, "root"), state: join(dir, "state"), backgrounds, port: 0, log: () => {}, builtins: null, omarchy: ROOT });
  return { url: `http://127.0.0.1:${await d.listen()}`, backgrounds, close: () => d.close() };
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 100 && !ok(value); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

test("T6 the screen daemon finds the theme's video backgrounds and intros where Omarchy does, the one it shows, and only what home can play", async () => {
  const person = catppuccinHome();
  const tools = standIns();
  const themes = new OmarchyThemes({ omarchy: ROOT, home: person.dir, probe: tools.probe, frame: tools.frame, session: null });
  try {
    const found = await themes.backgrounds();
    assert.equal(found?.theme, "catppuccin");
    const [loop, still, waves] = found!.files;
    assert.equal(found!.files.length, 3, "the AVI background is left out");
    assert.deepEqual([loop.type, loop.path, loop.video?.codec, loop.video?.poster.id, loop.video?.poster.type], ["video/webm", person.loop, "vp9", pictureId(FRAME), "image/jpeg"], "the person's own video first, as Omarchy orders them, with its first frame as its still");
    assert.deepEqual([still.id, still.type, still.intro?.path, still.intro?.type, still.intro?.codec], [pictureId(readFileSync(person.still)), "image/webp", person.intro, "video/mp4", "h264"], "a picture with its intro of the same name");
    assert.equal(waves.intro, undefined, "an AVI intro is left out");
    assert.equal(found!.current, still.id, "the one Omarchy shows");
    assert.equal(found!.intros, true, "Omarchy's intros are on");
    assert.deepEqual(tools.framed, [person.loop], "only a video background needs a still");

    // Another look reads nothing again until something changes.
    await themes.backgrounds();
    assert.equal(tools.probed.length, 2);
    assert.equal(tools.framed.length, 1);

    // Omarchy moves to the video.
    rmSync(join(person.state, "background"));
    symlinkSync(person.loop, join(person.state, "background"));
    assert.equal((await themes.backgrounds())?.current, loop.id);
  } finally {
    themes.stop();
  }
});

test("T6 an intro is due once when the TV session starts and again after the theme changes, and Omarchy's intros switch is followed", async () => {
  const person = catppuccinHome();
  const tools = standIns();
  const d = await daemon();
  const make = (session: string | null) => new OmarchyThemes({ omarchy: ROOT, home: person.dir, daemon: `${d.url}/`, probe: tools.probe, frame: tools.frame, session, settleMs: 50, retryMs: 50 });
  let themes = make("session-1");
  const read = async () => (await (await fetch(`${d.url}/api/backgrounds`)).json()).theme;
  try {
    await themes.start();
    const first = await read();
    assert.match(first.introDue ?? "", /^[0-9a-f]{24}$/, "due as the TV session starts");
    assert.equal(first.intros, true);

    // The screen daemon starting again in the same session: not due again.
    themes.stop();
    themes = make("session-1");
    await themes.start();
    assert.equal((await read()).introDue, null);

    // The next TV session, as after Omarchy's desktop: due again.
    themes.stop();
    themes = make("session-2");
    await themes.start();
    const next = (await read()).introDue;
    assert.ok(next && next !== first.introDue);

    // Home said it played it.
    const shown = await fetch(`${d.url}/api/backgrounds/intro`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ due: next, how: "played" }) });
    assert.equal(shown.status, 200);
    assert.deepEqual((await read()).introShown, { due: next, how: "played", why: null });
    const stale = await fetch(`${d.url}/api/backgrounds/intro`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ due: first.introDue, how: "played" }) });
    assert.equal(stale.status, 400, "only the one that's due");

    // A theme picked on the TV: Omarchy names the new one.
    writeFileSync(join(person.state, "theme.name"), "catppuccin-latte\n");
    const changed = await until(read, (theme) => theme.name === "catppuccin-latte");
    assert.ok(changed.introDue && changed.introDue !== next, "due after the theme changed");
    assert.deepEqual(changed.introShown, { due: next, how: "played", why: null }, "and not shown yet");

    // Omarchy's intros switch off (omarchy theme bg intro disable).
    mkdirSync(join(person.dir, ".local", "state", "omarchy", "toggles"), { recursive: true });
    writeFileSync(join(person.dir, ".local", "state", "omarchy", "toggles", "background-intros-off"), "");
    assert.equal((await until(read, (theme) => theme.intros === false)).intros, false, "home hears the switch");
    rmSync(join(person.dir, ".local", "state", "omarchy", "toggles", "background-intros-off"));
    assert.equal((await until(read, (theme) => theme.intros === true)).intros, true, "and when it's on again");
  } finally {
    themes.stop();
    await d.close();
  }
});

test("T6 the videos are served from where they are, in the parts home asks for, and the daemon keeps only a video's still", async () => {
  const person = catppuccinHome();
  const tools = standIns();
  const d = await daemon();
  const themes = new OmarchyThemes({ omarchy: ROOT, home: person.dir, daemon: `${d.url}/`, probe: tools.probe, frame: tools.frame, session: null, settleMs: 50, retryMs: 50 });
  try {
    await themes.start();
    const list = await (await fetch(`${d.url}/api/backgrounds`)).json();
    const [loop, still] = list.theme.items;
    const stillId = pictureId(readFileSync(person.still));
    assert.deepEqual(
      { media: loop.media, type: loop.type, codec: loop.codec, poster: loop.poster, video: loop.video },
      { media: "video", type: "video/webm", codec: "vp9", poster: `/api/backgrounds/${pictureId(FRAME)}`, video: `/api/backgrounds/video/${loop.id}` },
    );
    assert.deepEqual(
      { media: still.media, id: still.id, poster: still.poster, introCodec: still.introCodec },
      { media: "image", id: stillId, poster: `/api/backgrounds/${stillId}`, introCodec: "h264" },
    );
    assert.match(still.intro, /^\/api\/backgrounds\/video\/[0-9a-f]{16}$/);
    assert.equal(list.theme.items[2].intro, undefined, "a picture without an intro home can play has none");
    assert.equal(list.theme.current, stillId);

    // The video, whole and in parts.
    const whole = await fetch(`${d.url}${loop.video}`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "video/webm");
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), LOOP);
    const part = await fetch(`${d.url}${loop.video}`, { headers: { Range: "bytes=100-199" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 100-199/${LOOP.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), LOOP.subarray(100, 200));
    const end = await fetch(`${d.url}${loop.video}`, { headers: { Range: "bytes=-10" } });
    assert.deepEqual(Buffer.from(await end.arrayBuffer()), LOOP.subarray(LOOP.length - 10));
    assert.equal((await fetch(`${d.url}${loop.video}`, { headers: { Range: `bytes=${LOOP.length}-` } })).status, 416);
    const head = await fetch(`${d.url}${still.intro}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(readFileSync(person.intro).length));
    const intro = await fetch(`${d.url}${still.intro}`, { headers: { Range: "bytes=0-" } });
    assert.equal(intro.status, 206);
    assert.deepEqual(Buffer.from(await intro.arrayBuffer()), readFileSync(person.intro));
    assert.equal((await fetch(`${d.url}/api/backgrounds/video/0123456789abcdef`)).status, 404, "only the theme's own");

    // Its still is all the daemon keeps of it, and the video's own id gives
    // the still too, for anything that asks for a picture by id.
    const kept = readdirSync(join(d.backgrounds, "theme")).sort();
    assert.deepEqual(kept, [`${pictureId(FRAME)}.jpg`, `${stillId}.webp`, `${pictureId(readFileSync(join(SHIPPED, "2-waves.webp")))}.webp`].sort());
    assert.deepEqual(Buffer.from(await (await fetch(`${d.url}${loop.poster}`)).arrayBuffer()), FRAME);
    assert.deepEqual(Buffer.from(await (await fetch(`${d.url}/api/backgrounds/${loop.id}`)).arrayBuffer()), FRAME);

    // A video that went away.
    rmSync(person.loop);
    assert.equal((await fetch(`${d.url}${loop.video}`)).status, 404);
  } finally {
    themes.stop();
    await d.close();
  }
});

test("T6 the TV session serves only what it found, under its own path, and the daemon streams only from 127.0.0.1", async () => {
  const server = new VideoServer();
  const file = join(scratch, "clip.webm");
  writeFileSync(file, LOOP);
  try {
    const base = await server.listen();
    assert.equal(cleanServe(base), base);
    server.offer(new Map([["00000000000000aa", { path: file, type: "video/webm" }]]));
    assert.equal((await fetch(`${base}00000000000000aa`)).status, 200);
    assert.equal((await fetch(`${base}00000000000000bb`)).status, 404, "only what it offered");
    assert.equal((await fetch(base.replace(server.token, "f".repeat(32)) + "00000000000000aa")).status, 404, "only under its own path");
    assert.equal((await fetch(`${base}00000000000000aa`, { method: "POST" })).status, 404);
    server.offer(new Map());
    assert.equal((await fetch(`${base}00000000000000aa`)).status, 404, "what it no longer offers is gone");
  } finally {
    await server.close();
  }
  for (const elsewhere of ["http://192.168.1.2:4000/" + "a".repeat(32) + "/", "http://127.0.0.1:80/" + "a".repeat(32) + "/", "http://127.0.0.1:4000/x/", "file:///etc/"]) {
    assert.equal(cleanServe(elsewhere), null, elsewhere);
  }

  const store = new Backgrounds({ dir: join(scratch, "serve-store") });
  const still = { id: "00000000000000cc", type: "image/png" };
  assert.match((await store.offerTheme({ theme: "nord", current: null, files: [still], serve: "http://10.0.0.1:4000/" + "a".repeat(32) + "/" })).error ?? "", /127\.0\.0\.1 only/);
  assert.match((await store.offerTheme({ theme: "nord", current: null, files: [{ id: "00000000000000dd", type: "video/mp4" }] })).error ?? "", /id and kind/, "a video comes with its still");
  assert.match((await store.offerTheme({ theme: "nord", current: null, files: [still], introDue: "not a token" })).error ?? "", /token/);
});

test("T6 with the TV session gone, home hears the video isn't there and keeps the still", async () => {
  const d = await daemon();
  const server = new VideoServer();
  const base = await server.listen();
  await server.close();
  try {
    const offer = { theme: "nord", current: null, serve: base, files: [{ id: "00000000000000ee", type: "video/mp4", video: { codec: "h264", width: 1920, height: 1080, poster: { id: pictureId(FRAME), type: "image/jpeg" } } }] };
    const put = await fetch(`${d.url}/api/backgrounds/theme`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(offer) });
    assert.deepEqual((await put.json()).need, [pictureId(FRAME)]);
    assert.equal((await fetch(`${d.url}/api/backgrounds/theme/${pictureId(FRAME)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: FRAME })).status, 200);
    const answer = await fetch(`${d.url}/api/backgrounds/video/00000000000000ee`);
    assert.equal(answer.status, 502);
    assert.match((await answer.json()).error, /isn't serving/);
    assert.deepEqual(Buffer.from(await (await fetch(`${d.url}/api/backgrounds/${pictureId(FRAME)}`)).arrayBuffer()), FRAME, "the still is still there");
  } finally {
    await d.close();
  }
});

test("T6 the image checks' VM, with no hardware decoding, can play videos anyway, and nothing else can say so", async () => {
  const dir = join(scratch, "software");
  const flag = join(scratch, "video-in-software");
  assert.equal((await new Backgrounds({ dir, softwareVideo: flag }).read()).softwareVideo, false);
  writeFileSync(flag, "");
  assert.equal((await new Backgrounds({ dir, softwareVideo: flag }).read()).softwareVideo, true);
});

test("T6 a range is the part asked for, the end, or the whole", () => {
  assert.deepEqual(byteRange(undefined, 100), { start: 0, end: 99, partial: false });
  assert.deepEqual(byteRange("bytes=10-19", 100), { start: 10, end: 19, partial: true });
  assert.deepEqual(byteRange("bytes=90-", 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(byteRange("bytes=-5", 100), { start: 95, end: 99, partial: true });
  assert.deepEqual(byteRange("bytes=50-500", 100), { start: 50, end: 99, partial: true });
  assert.equal(byteRange("bytes=100-", 100), null);
  assert.deepEqual(byteRange("items=1-2", 100), { start: 0, end: 99, partial: false }, "not bytes: the whole");
  assert.equal(videoType("a/b.MP4"), "video/mp4");
  assert.equal(videoType("a/b.mov"), "video/mp4");
  assert.equal(videoType("a/b.avi"), null);
});

// The box has them, as Omarchy's base packages; a machine running the tests
// may not.
const FFMPEG = spawnSync("ffprobe", ["-version"]).status === 0 && spawnSync("ffmpeg", ["-version"]).status === 0;

test("T6 Omarchy's own ffprobe and ffmpeg read a shipped intro's codec, size and first frame", { skip: FFMPEG ? false : "ffmpeg isn't installed here" }, async () => {
  assert.deepEqual(await probe(join(SHIPPED, "intros", INTRO)), { codec: "h264", width: 2560, height: 1440 });
  const frame = await firstFrame(join(SHIPPED, "intros", INTRO));
  assert.ok(frame && frame[0] === 0xff && frame[1] === 0xd8, "a JPEG");
  assert.equal(await probe(join(scratch, "nothing.mp4")), null);
  assert.equal(await firstFrame(join(scratch, "nothing.mp4")), null);
});
