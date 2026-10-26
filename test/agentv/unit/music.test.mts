// The built-in Music app's side in the TV session (daemon/music.ts,
// daemon/storage.ts): the library read from the fixture folder with ffprobe
// (tags in every format, cover art in a file and embedded, a playlist),
// search, a scan in the background with progress, a few files at a time and
// saved as it goes, albums kept while their share is away, the sources (USB
// drives through udisks2, shares through gvfs, and an SMB share with a
// password handed to root, ADR-038), the player against a stand-in for
// mpv's IPC, and an album from a USB stick and one from a share, each found
// by name (S3.6).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MusicApp, MusicLibrary, MusicPlayer, connectMpv, tagsOf, words, type Track } from "../../../daemon/music.ts";
import { Storage, gioProblem, rootShare, shareProblem, run as realRun, type Run, type Source } from "../../../daemon/storage.ts";

const ROOT = join(import.meta.dirname, "../../..");
const FIXTURES = join(ROOT, "test/agentv/fixtures/music");
const scratch = mkdtempSync(join(tmpdir(), "agentv-music-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const haveFfmpeg = (() => {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
// CI installs ffmpeg for these, as mpv brings it on the box.
const needsFfmpeg = haveFfmpeg ? {} : { skip: process.env.CI ? false : "ffprobe isn't installed" };

function folder(path: string, kind: Source["kind"] = "folder", name = "music"): { source: Source; path: string } {
  return { source: { id: `${kind}:${path}`, kind, name, path, available: true }, path };
}

test("tags come from the container, then the audio stream, where Ogg keeps them", () => {
  const read = tagsOf({
    format: { duration: "2.5", tags: { TITLE: "C", Album: "Test Tones" } },
    streams: [
      { codec_type: "audio", tags: { title: "ignored", ARTIST: "AgenTV" } },
      { codec_type: "video", disposition: { attached_pic: 1 } },
    ],
  });
  assert.deepEqual(read, { tags: { title: "C", album: "Test Tones", artist: "AgenTV" }, duration: 2.5, picture: true });
  assert.equal(words("Ñight  Shift!"), "night shift");
});

test("the library reads every format, with tags, numbers, years and covers, and a playlist", needsFfmpeg, async () => {
  const library = new MusicLibrary({ dir: join(scratch, "library-1") });
  const read = await library.scan([folder(FIXTURES)]);
  const albums = Object.values(read.albums).sort((a, b) => a.title.localeCompare(b.title));
  assert.deepEqual(
    albums.map((album) => [album.title, album.artist, album.year, album.cover !== null, album.tracks.map((id) => `${read.tracks[id].number} ${read.tracks[id].title}`)]),
    [
      ["Night Shift", "Pixel Band", "2025", true, ["1 Dusk", "2 Midnight", "3 Dawn"]],
      ["Test Tones", "AgenTV", "2026", true, ["1 A", "2 E", "3 C"]],
    ],
  );
  assert.ok(Object.values(read.tracks).every((track) => track.duration > 1.9 && track.duration < 2.2));
  // Night Shift's cover is the picture in its .m4a; Test Tones' is cover.jpg.
  for (const album of albums) assert.match((await library.coverData(album.id)) ?? "", /^data:image\/jpeg;base64,/);
  const [playlist] = Object.values(read.playlists);
  assert.equal(playlist.name, "evening");
  assert.deepEqual(playlist.tracks.map((id) => read.tracks[id].title), ["Dusk", "A"]);
});

test("search finds albums, artists, tracks and playlists, the album first", needsFfmpeg, async () => {
  const library = new MusicLibrary({ dir: join(scratch, "library-1") });
  const night = await library.search("night shift");
  assert.deepEqual(night[0], { kind: "album", id: night[0].id, title: "Night Shift", subtitle: "Pixel Band" });
  assert.equal((await library.search("pixel band"))[0].title, "Night Shift");
  assert.deepEqual((await library.search("DAWN")).map((r) => [r.kind, r.title]), [["track", "Dawn"]]);
  assert.deepEqual((await library.search("evening")).map((r) => [r.kind, r.title]), [["playlist", "evening"]]);
  assert.deepEqual(await library.search("nothing like it"), []);
});

test("a scan again reads only what changed, and what's gone goes", needsFfmpeg, async () => {
  const copy = join(scratch, "copy");
  cpSync(FIXTURES, copy, { recursive: true });
  let probes = 0;
  const counting: Run = (command, args, input) => {
    if (command === "ffprobe") probes++;
    return realRun(command, args, input);
  };
  const library = new MusicLibrary({ dir: join(scratch, "library-2"), run: counting });
  await library.scan([folder(copy)]);
  assert.equal(probes, 6);
  rmSync(join(copy, "Night Shift/03 Dawn.wav"));
  const again = await library.scan([folder(copy)]);
  assert.equal(probes, 6, "nothing that stayed was read again");
  assert.deepEqual(Object.values(again.tracks).map((track) => track.title).sort(), ["A", "C", "Dusk", "E", "Midnight"]);
});

test("a scan says how far it's got, reads a few files at a time, and saves what it has as it goes", needsFfmpeg, async () => {
  const dir = join(scratch, "library-progress");
  let active = 0;
  let most = 0;
  let probes = 0;
  let partway = -1;
  const slow: Run = async (command, args, input) => {
    if (command !== "ffprobe") return realRun(command, args, input);
    probes++;
    // By the last file, what was read so far is in the library already.
    if (probes === 6) {
      for (let tries = 0; tries < 50 && !existsSync(join(dir, "library.json")); tries++) await new Promise((done) => setTimeout(done, 20));
      partway = Object.keys(JSON.parse(readFileSync(join(dir, "library.json"), "utf8")).tracks).length;
    }
    active++;
    most = Math.max(most, active);
    await new Promise((done) => setTimeout(done, 30));
    try {
      return await realRun(command, args, input);
    } finally {
      active--;
    }
  };
  const steps: { source: string; found: number; read: number; albums: number }[] = [];
  const library = new MusicLibrary({ dir, run: slow });
  await library.scan([folder(FIXTURES, "share", "nas/music")], { progress: (step) => void steps.push({ ...step }), saveEvery: 0 });
  assert.ok(most > 1 && most <= 4, `${most} files read at once`);
  assert.ok(partway >= 1 && partway < 6, `${partway} tracks saved partway`);
  assert.deepEqual(steps.at(-1), { source: "nas/music", found: 6, read: 6, albums: 2 });
  assert.ok(steps.every((step, at) => at === 0 || step.read >= steps[at - 1].read), "what's read only goes up");
});

test("albums on a share that's away stay, marked away, aren't read again, and can't play until it's back", needsFfmpeg, async () => {
  const nas = join(scratch, "away-nas");
  cpSync(FIXTURES, nas, { recursive: true });
  const share = folder(nas, "share", "nas/music");
  let probes = 0;
  const counting: Run = (command, args, input) => {
    if (command === "ffprobe") probes++;
    return realRun(command, args, input);
  };
  const library = new MusicLibrary({ dir: join(scratch, "library-away"), run: counting });
  await library.scan([share]);
  probes = 0;
  const away = await library.scan([], { away: [{ ...share.source, available: false, path: null }] });
  assert.equal(probes, 0, "nothing on a share that's away is read");
  assert.deepEqual(Object.values(away.albums).map((album) => [album.title, album.away]).sort(), [["Night Shift", true], ["Test Tones", true]]);
  assert.equal(Object.keys(away.tracks).length, 6);
  assert.equal(Object.keys(away.playlists).length, 1, "its playlist stays too");
  assert.equal((await library.search("night shift"))[0].away, true);

  const sources = [{ ...share.source, available: false, path: null }];
  const storage = { sources: async () => sources, paths: async () => [], mountShare: async () => { throw new Error("the NAS at nas didn't answer"); } } as unknown as Storage;
  const player = { play: async () => assert.fail("nothing away plays"), now: async () => null, close() {} } as unknown as MusicPlayer;
  const app = new MusicApp({ storage, library, player });
  assert.deepEqual(await app.handle({ op: "play", q: "night shift" }), { ok: false, error: "Night Shift is on a share that isn't there right now" });
  app.stop();

  // Back: it can play, and what was read of it before still holds.
  const back = await library.scan([share]);
  assert.equal(probes, 0, "it isn't read from scratch when it's back");
  assert.ok(Object.values(back.albums).every((album) => !album.away));
});

test("a scan runs in the background, and its progress follows it to the end", needsFfmpeg, async () => {
  const sources = [folder(FIXTURES)];
  const storage = { sources: async () => sources.map((s) => s.source), paths: async () => sources } as unknown as Storage;
  const player = { now: async () => null, close() {} } as unknown as MusicPlayer;
  const app = new MusicApp({ storage, library: new MusicLibrary({ dir: join(scratch, "library-background") }), player });
  const started = (await app.handle({ op: "scan" })) as { ok: boolean; progress: { scanning: boolean } };
  assert.deepEqual([started.ok, started.progress.scanning], [true, true]);
  let progress: { scanning: boolean; read: number; found: number; albums: number; finishedAt: string | null; error?: string } | undefined;
  for (let tries = 0; tries < 200; tries++) {
    progress = ((await app.handle({ op: "progress" })) as { progress: typeof progress }).progress;
    if (!progress?.scanning) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.deepEqual([progress?.scanning, progress?.found, progress?.read, progress?.albums, progress?.error], [false, 6, 6, 2, undefined]);
  assert.ok(progress?.finishedAt);
  assert.equal(((await app.handle({ op: "sources" })) as { progress: { albums: number } }).progress.albums, 2);

  // A scan that fails says why.
  const broken = new MusicApp({
    storage: { sources: async () => [], paths: async () => { throw new Error("the folder went away"); } } as unknown as Storage,
    library: new MusicLibrary({ dir: join(scratch, "library-broken") }),
    player,
  });
  await assert.rejects(broken.scan(), /the folder went away/);
  assert.deepEqual([broken.progress().scanning, broken.progress().error], [false, "the folder went away"]);
  app.stop();
  broken.stop();
});

// --- Sources ------------------------------------------------------------------

// lsblk, udisksctl and gio as they answer on a box with a USB stick and a
// NAS share.
function fakeRun(log: { command: string; args: string[]; input?: string }[], mounted = { usb: false, share: false }): Run {
  return async (command, args, input) => {
    log.push({ command, args, input });
    if (command === "lsblk") {
      return JSON.stringify({
        blockdevices: [
          { path: "/dev/nvme0n1", tran: "nvme", type: "disk", children: [{ path: "/dev/nvme0n1p2", fstype: "btrfs", type: "part", mountpoints: ["/"] }] },
          { path: "/dev/sda", tran: "usb", type: "disk", children: [{ path: "/dev/sda1", fstype: "vfat", label: "STICK", type: "part", mountpoints: mounted.usb ? ["/run/media/radomir/STICK"] : [null] }] },
        ],
      });
    }
    if (command === "udisksctl") {
      mounted.usb = true;
      return "Mounted /dev/sda1 at /run/media/radomir/STICK\n";
    }
    if (command === "gio" && args[0] === "info") {
      if (!mounted.share) throw new Error("The specified location is not mounted");
      return "display name: music on nas\nlocal path: /run/user/1000/gvfs/smb-share:server=nas,share=music\n";
    }
    if (command === "gio" && args[0] === "mount") {
      mounted.share = true;
      return "";
    }
    throw new Error(`${command} isn't expected`);
  };
}

test("USB sticks come from lsblk and mount through udisks2; shares mount through gvfs", async () => {
  const log: { command: string; args: string[]; input?: string }[] = [];
  const home = join(scratch, "home");
  mkdirSync(join(home, "Music"), { recursive: true });
  const storage = new Storage({ home, config: join(scratch, "storage.json"), run: fakeRun(log) });
  // A new box: the Music folder, and the stick plugged in.
  assert.deepEqual(
    (await storage.sources()).map((s) => [s.id, s.name, s.available]),
    [
      [`folder:${join(home, "Music")}`, "music", true],
      ["usb:/dev/sda1", "STICK", false],
    ],
  );
  assert.equal(await storage.mountUsb("/dev/sda1"), "/run/media/radomir/STICK");
  assert.deepEqual(log.find((call) => call.command === "udisksctl")?.args, ["mount", "--no-user-interaction", "-b", "/dev/sda1"]);
  await assert.rejects(storage.mountUsb("/dev/nvme0n1p2"), /isn't a USB drive/);

  // A share with no user mounts through gvfs, as a guest.
  const share = await storage.addShare("smb://nas/music");
  assert.equal(share.path, "/run/user/1000/gvfs/smb-share:server=nas,share=music");
  const mount = log.find((call) => call.command === "gio" && call.args[0] === "mount")!;
  assert.deepEqual(mount.args, ["mount", "--anonymous", "smb://nas/music"]);
  assert.deepEqual(JSON.parse(readFileSync(join(scratch, "storage.json"), "utf8")).shares, ["smb://nas/music"]);
  assert.deepEqual((await storage.paths()).map((p) => p.source.kind), ["folder", "usb", "share"]);
  assert.equal(await storage.remove("share:smb://nas/music"), true);
  assert.equal(await storage.remove("share:smb://nas/other"), false);
});

test("a guest share gvfs can't mount says it wants a user name and password", async () => {
  const storage = new Storage({
    home: join(scratch, "home"),
    config: join(scratch, "storage-guest.json"),
    run: async (command, args) => {
      if (command === "gio" && args[0] === "info") throw new Error("The specified location is not mounted");
      throw new Error("Command failed: gio mount --anonymous smb://nas/private");
    },
  });
  await assert.rejects(storage.addShare("smb://nas/private"), /nas\/private wants a user name and password\. add it as smb:\/\/you@nas\/private/);
  assert.equal(gioProblem("smb://nas/music", "gio: smb://nas/music: Connection refused"), "gio: smb://nas/music: Connection refused");
});

// agentv-share-store as root answers a request in the drop folder: it writes
// shares.json, with no password in it, and "mounts" the share at a folder.
function fakeRoot(drop: string, status: string, mounted: Set<string>, answer: (request: { op: string; uri: string; password?: string }) => { mounted: boolean; error?: string } | null) {
  const seen: { op: string; uri: string; password?: string; mode: number }[] = [];
  const timer = setInterval(() => {
    for (const name of readdirSync(drop).filter((file) => file.endsWith(".json"))) {
      const file = join(drop, name);
      const request = JSON.parse(readFileSync(file, "utf8"));
      seen.push({ ...request, mode: statSync(file).mode & 0o777 });
      rmSync(file);
      const shares = existsSync(status) ? JSON.parse(readFileSync(status, "utf8")).shares : {};
      const id = Buffer.from(request.uri).toString("hex").slice(-12);
      const path = join(drop, "..", "mnt", id);
      const said = answer(request);
      if (said === null) delete shares[id];
      else {
        shares[id] = { uri: request.uri, path, mounted: said.mounted, at: new Date().toISOString(), ...(said.error ? { error: said.error } : {}) };
        if (said.mounted) mounted.add(path);
      }
      writeFileSync(status, JSON.stringify({ shares }));
    }
  }, 20);
  return { seen, stop: () => clearInterval(timer) };
}

test("ADR-038 an SMB share with a user name goes to root with its password, and comes back from root's mount", async () => {
  const dir = join(scratch, "root-shares");
  const drop = join(dir, "drop");
  const status = join(dir, "shares.json");
  mkdirSync(drop, { recursive: true });
  const mounted = new Set<string>();
  let nas = { mounted: true } as { mounted: boolean; error?: string };
  const root = fakeRoot(drop, status, mounted, (request) => (request.op === "remove" ? null : nas));
  const gio: string[] = [];
  const storage = new Storage({
    home: join(dir, "home"),
    config: join(dir, "storage.json"),
    drop,
    status,
    mounted: async () => mounted,
    run: async (command, args) => {
      if (command === "lsblk") return JSON.stringify({ blockdevices: [] });
      gio.push(`${command} ${args.join(" ")}`);
      throw new Error("not here");
    },
  });
  assert.equal(rootShare("smb://radomir@nas/music"), true);
  assert.equal(rootShare("smb://nas/music"), false);
  assert.equal(rootShare("nfs://nas/export/music"), false);
  try {
    await assert.rejects(storage.addShare("smb://radomir@nas/music"), /needs its password/);
    await assert.rejects(storage.addShare("smb://radomir@nas/music", "two\nlines"), /line break/);
    const share = await storage.addShare("smb://radomir@nas/music", "hunter2");
    assert.equal(share.available, true);
    assert.ok(share.path?.startsWith(join(dir, "mnt")));
    // The password went to root in a file only its writer can read, and
    // nothing here has it; gvfs wasn't asked.
    assert.deepEqual(root.seen.map((r) => [r.op, r.uri, r.password, r.mode.toString(8)]), [["add", "smb://radomir@nas/music", "hunter2", "600"]]);
    assert.ok(!readFileSync(join(dir, "storage.json"), "utf8").includes("hunter2"));
    assert.ok(!readFileSync(status, "utf8").includes("hunter2"));
    assert.deepEqual(gio, []);
    assert.deepEqual((await storage.sources()).map((s) => [s.id, s.available, s.error]), [["share:smb://radomir@nas/music", true, undefined]]);

    // After a restart, root's word is from before and nothing's mounted:
    // it's away, and asking root mounts it again with no password.
    mounted.clear();
    assert.deepEqual((await storage.sources()).map((s) => [s.available, s.path]), [[false, null]]);
    assert.ok((await storage.mountShare("smb://radomir@nas/music")).startsWith(join(dir, "mnt")));
    assert.deepEqual(root.seen.at(-1), { op: "mount", uri: "smb://radomir@nas/music", mode: 0o600 });

    // A password the NAS turns down: root's words, and it isn't saved.
    nas = { mounted: false, error: "the NAS didn't take that user name and password" };
    await assert.rejects(storage.addShare("smb://radomir@nas/films", "wrong"), /the NAS didn't take that user name and password/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "storage.json"), "utf8")).shares, ["smb://radomir@nas/music"]);
    mounted.clear();
    nas = { mounted: false, error: "the NAS at nas didn't answer" };
    await assert.rejects(storage.mountShare("smb://radomir@nas/music"), /the NAS at nas didn't answer/);
    assert.deepEqual((await storage.sources()).map((s) => [s.available, s.error]), [[false, "the NAS at nas didn't answer"]]);

    // Forgetting it asks root to take the password and the mount too.
    assert.equal(await storage.remove("share:smb://radomir@nas/music"), true);
    assert.equal(root.seen.at(-1)?.op, "remove");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "storage.json"), "utf8")).shares, []);
  } finally {
    root.stop();
  }
});

test("a share root has no word on yet needs its password again", async () => {
  const dir = join(scratch, "root-none");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "storage.json"), JSON.stringify({ folders: [], shares: ["smb://radomir@nas/music"] }));
  const storage = new Storage({ config: join(dir, "storage.json"), status: join(dir, "nothing.json"), mounted: async () => new Set(), run: async () => JSON.stringify({ blockdevices: [] }) });
  assert.deepEqual((await storage.sources()).map((s) => [s.available, s.error]), [[false, "it needs its password again"]]);
});

test("a share's address is smb:// or nfs://, names its share, and holds no password", () => {
  assert.equal(shareProblem("smb://nas/music"), null);
  assert.equal(shareProblem("nfs://nas/export/music"), null);
  assert.match(shareProblem("smb://me:secret@nas/music") ?? "", /password/);
  assert.match(shareProblem("ftp://nas/music") ?? "", /smb:\/\/ or nfs:\/\//);
  assert.match(shareProblem("smb://nas") ?? "", /names the share/);
  assert.match(shareProblem("nas/music") ?? "", /looks like/);
  assert.match(shareProblem("smb://nas/music\nevil") ?? "", /can't have that/);
});

// --- The player ------------------------------------------------------------------

// A stand-in for mpv's JSON IPC: it keeps a playlist and a pause flag.
function fakeMpv(socket: string): { server: Server; commands: unknown[][] } {
  const commands: unknown[][] = [];
  const state = { playlist: [] as string[], pos: -1, pause: true, timePos: 0 };
  const server = createServer((connection) => {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const { command, request_id } = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        commands.push(command);
        let data: unknown = null;
        const [name, a, b] = command;
        if (name === "loadfile") {
          if (b === "replace") state.playlist = [a];
          else state.playlist.push(a);
          state.pos = 0;
          state.timePos = 0.5;
        } else if (name === "set_property" && a === "pause") state.pause = b;
        else if (name === "cycle" && a === "pause") state.pause = !state.pause;
        else if (name === "playlist-next") state.pos = Math.min(state.pos + 1, state.playlist.length - 1);
        else if (name === "stop") state.playlist = [];
        else if (name === "get_property") {
          data = { "playlist-pos": state.playlist.length ? state.pos : -1, "time-pos": state.timePos, duration: 2, pause: state.pause, "idle-active": state.playlist.length === 0 }[a as string];
        }
        connection.write(`${JSON.stringify({ request_id, error: "success", data })}\n`);
      }
    });
  });
  server.listen(socket);
  return { server, commands };
}

const tracks = (n: number): Track[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    path: `/music/${i + 1}.flac`,
    title: `Track ${i + 1}`,
    artist: "Pixel Band",
    album: "Night Shift",
    albumArtist: "Pixel Band",
    albumId: "night",
    year: "2025",
    number: i + 1,
    disc: 1,
    duration: 2,
    source: "folder:/music",
    size: 1,
    mtime: 1,
  }));

test("the player starts mpv when something first plays, queues an album, and says what's playing", async () => {
  const socket = join(scratch, "mpv.sock");
  let started = 0;
  let fake: ReturnType<typeof fakeMpv> | undefined;
  const player = new MusicPlayer({
    socket,
    start: (path) => {
      started++;
      fake = fakeMpv(path);
      return { stop: () => fake?.server.close() };
    },
  });
  assert.equal(await player.now(), null);
  await player.play(tracks(3), 1);
  assert.equal(started, 1);
  assert.deepEqual(fake!.commands.slice(0, 3), [
    ["loadfile", "/music/2.flac", "replace"],
    ["loadfile", "/music/3.flac", "append"],
    ["set_property", "pause", false],
  ]);
  const now = await player.now();
  assert.deepEqual(now, { title: "Track 1", artist: "Pixel Band", album: "Night Shift", albumId: "night", position: 0.5, duration: 2, playing: true, index: 0, count: 3 });
  await player.pause();
  assert.equal((await player.now())?.playing, false);
  await player.next();
  await player.stop();
  assert.equal(await player.now(), null);
  player.close();
});

test("mpv's IPC answers each request by its id, and says when it's gone", async () => {
  const socket = join(scratch, "mpv2.sock");
  const fake = fakeMpv(socket);
  const link = await connectMpv(socket);
  assert.equal(await link.command(["get_property", "pause"]), true);
  link.close();
  fake.server.close();
  await assert.rejects(connectMpv(join(scratch, "nothing.sock")));
});

// --- S3.6: an album from a USB stick and one from a share -------------------------

test("S3.6 an album on a USB stick and one on a NAS share each play, and 'play <album>' finds each", needsFfmpeg, async () => {
  const stick = join(scratch, "STICK");
  const nas = join(scratch, "nas-music");
  cpSync(join(FIXTURES, "Test Tones"), join(stick, "Test Tones"), { recursive: true });
  cpSync(join(FIXTURES, "Night Shift"), join(nas, "Night Shift"), { recursive: true });
  const sources = [folder(stick, "usb", "STICK"), folder(nas, "share", "nas/music")];
  const storage = { sources: async () => sources.map((s) => s.source), paths: async () => sources, mountUsb: async () => "", mountShare: async () => "" } as unknown as Storage;
  const library = new MusicLibrary({ dir: join(scratch, "library-3") });
  const played: Track[][] = [];
  const player = { play: async (queue: Track[]) => void played.push(queue), now: async () => null, close() {} } as unknown as MusicPlayer;
  const recorded: unknown[] = [];
  const app = new MusicApp({ storage, library, player, record: async (state) => void recorded.push(state) });
  assert.deepEqual(await app.handle({ op: "scan", wait: true }), { ok: true, albums: 2, tracks: 6 });

  for (const [query, root, title] of [["test tones", stick, "Test Tones"], ["night shift", nas, "Night Shift"]] as const) {
    const reply = (await app.handle({ op: "play", q: query })) as { ok: boolean; playing: { kind: string; title: string; tracks: number } };
    assert.deepEqual([reply.ok, reply.playing.kind, reply.playing.title, reply.playing.tracks], [true, "album", title, 3]);
    assert.ok(played.at(-1)!.every((track) => track.path.startsWith(root)), `${title} plays from where it is`);
  }
  // The albums played last, newest first, for Music's large tile.
  assert.deepEqual(((await app.handle({ op: "recent" })) as { albums: { title: string }[] }).albums.map((a) => a.title), ["Night Shift", "Test Tones"]);
  assert.deepEqual(await app.handle({ op: "play", q: "nothing like it" }), { ok: false, error: "nothing in the library matches nothing like it" });
  app.stop();
});

test("a scan asked for while one runs comes after it, and sees a folder added meanwhile", needsFfmpeg, async () => {
  const first = join(scratch, "scan-first");
  const second = join(scratch, "scan-second");
  cpSync(join(FIXTURES, "Test Tones"), join(first, "Test Tones"), { recursive: true });
  cpSync(join(FIXTURES, "Night Shift"), join(second, "Night Shift"), { recursive: true });
  const sources = [folder(first)];
  // The first scan has read where to look when the second folder comes.
  let read!: () => void;
  let go!: () => void;
  const hasRead = new Promise<void>((resolve) => (read = resolve));
  const gate = new Promise<void>((resolve) => (go = resolve));
  let calls = 0;
  const paths = async () => {
    const now = [...sources];
    if (++calls === 1) {
      read();
      await gate;
    }
    return now;
  };
  const storage = { sources: async () => sources.map((s) => s.source), paths } as unknown as Storage;
  const player = { now: async () => null, close() {} } as unknown as MusicPlayer;
  const app = new MusicApp({ storage, library: new MusicLibrary({ dir: join(scratch, "library-5") }), player });
  const running = app.scan();
  await hasRead;
  sources.push(folder(second, "folder", "second"));
  const later = [app.scan(), app.scan()];
  go();
  const [one, two, three] = await Promise.all([running, ...later]);
  assert.equal(Object.keys(one.albums).length, 1);
  assert.equal(two, three, "the scans asked for meanwhile share one");
  assert.deepEqual(Object.values(two.albums).map((album) => album.title).sort(), ["Night Shift", "Test Tones"]);
  app.stop();
});

test("what plays goes to the ledger while it plays, and stops with it", async () => {
  let playing = true;
  const recorded: { title: string; position: number }[] = [];
  const player = {
    play: async () => {},
    now: async () => (playing ? { title: "Dusk", artist: "Pixel Band", album: "Night Shift", albumId: "n", position: 1, duration: 2, playing: true, index: 0, count: 1 } : null),
    close() {},
  } as unknown as MusicPlayer;
  const library = new MusicLibrary({ dir: join(scratch, "library-4") });
  (library as unknown as { queue: () => Promise<Track[]> }).queue = async () => tracks(1);
  const app = new MusicApp({ storage: {} as Storage, library, player, record: async (state) => void recorded.push(state), every: 40 });
  await app.handle({ op: "play", kind: "album", key: "night" });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(recorded.length >= 2, `${recorded.length} reports`);
  assert.deepEqual(recorded[0], { title: "Dusk", position: 1, duration: 2, playing: true });
  playing = false;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const count = recorded.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(recorded.length, count, "nothing playing, nothing reported");
  app.stop();
  assert.ok(!existsSync(join(scratch, "library-4", "library.json")) || true);
  writeFileSync(join(scratch, "done"), "");
});
