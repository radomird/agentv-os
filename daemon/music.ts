// The built-in Music app's library and player (ADR-017): every MP3, AAC,
// FLAC, Ogg Vorbis, Opus and WAV file in the box's folders, USB drives and
// NAS shares (storage.ts), with their tags and cover art in a small index,
// and mpv to play them. mpv-mpris, which Omarchy ships, puts what plays on
// MPRIS, so Omarchy's media controls and the media keys see it. It runs in
// the TV session, as the person the box logs in, who can read those files.
//
// Tags come from ffprobe (mpv brings ffmpeg): the container's, and the audio
// stream's, which is where Ogg keeps them. Cover art is a cover.jpg,
// folder.jpg or front.jpg beside the files, or the picture in one of them,
// made small for the TV.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { run as runCommand, type Run, type Source, type Storage } from "./storage.ts";

export const AUDIO = [".mp3", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".wav"];
const PLAYLISTS = [".m3u", ".m3u8"];
const COVERS = ["cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "front.png"];
const COVER_PX = 320;

export interface Track {
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  albumId: string;
  year: string;
  number: number;
  disc: number;
  duration: number; // seconds
  source: string; // the source's id
  size: number;
  mtime: number;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  year: string;
  cover: string | null; // a small JPEG in the library's folder
  tracks: string[]; // track ids, in order
  source: string;
}

export interface Playlist {
  id: string;
  name: string;
  path: string;
  tracks: string[];
}

export interface Library {
  scannedAt: string;
  tracks: Record<string, Track>;
  albums: Record<string, Album>;
  playlists: Record<string, Playlist>;
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

// Words as the TV matches them: lowercase, accents and punctuation gone.
export function words(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

interface Probe {
  format?: { duration?: string; tags?: Record<string, string> };
  streams?: { codec_type?: string; disposition?: { attached_pic?: number }; tags?: Record<string, string> }[];
}

// The tags ffprobe found, by lowercase name: the container's first, then
// the audio stream's.
export function tagsOf(probe: Probe): { tags: Record<string, string>; duration: number; picture: boolean } {
  const tags: Record<string, string> = {};
  const add = (from?: Record<string, string>) => {
    for (const [key, value] of Object.entries(from ?? {})) {
      const name = key.toLowerCase();
      if (!(name in tags) && typeof value === "string" && value.trim()) tags[name] = value.trim();
    }
  };
  add(probe.format?.tags);
  for (const stream of probe.streams ?? []) if (stream.codec_type === "audio") add(stream.tags);
  const picture = (probe.streams ?? []).some((stream) => stream.disposition?.attached_pic === 1);
  return { tags, duration: Number(probe.format?.duration) || 0, picture };
}

function number(value: string | undefined): number {
  return Number.parseInt((value ?? "").split("/")[0], 10) || 0;
}

export interface MusicOptions {
  dir?: string; // where the index and covers go
  run?: Run;
}

export class MusicLibrary {
  readonly dir: string;
  private run: Run;
  private library?: Library;

  constructor(options: MusicOptions = {}) {
    const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
    this.dir = options.dir ?? join(state, "agentv/music");
    this.run = options.run ?? runCommand;
  }

  async load(): Promise<Library> {
    if (this.library) return this.library;
    try {
      this.library = JSON.parse(await readFile(join(this.dir, "library.json"), "utf8")) as Library;
    } catch {
      this.library = { scannedAt: "", tracks: {}, albums: {}, playlists: {} };
    }
    return this.library;
  }

  private async save(library: Library): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "library.json.next"), JSON.stringify(library));
    await rename(join(this.dir, "library.json.next"), join(this.dir, "library.json"));
    this.library = library;
  }

  // Reads every source again. A file that hasn't changed keeps what was read
  // of it before; one that's gone goes, as do the albums left empty.
  async scan(sources: { source: Source; path: string }[]): Promise<Library> {
    const before = await this.load();
    const known = new Map(Object.values(before.tracks).map((track) => [track.path, track]));
    const tracks: Record<string, Track> = {};
    const albums: Record<string, Album & { years: string[] }> = {};
    const playlistFiles: { path: string; source: string }[] = [];
    const pictures = new Map<string, string>(); // album id -> a file with a picture

    for (const { source, path: root } of sources) {
      for (const file of await walk(root)) {
        const ext = extname(file).toLowerCase();
        if (PLAYLISTS.includes(ext)) {
          playlistFiles.push({ path: file, source: source.id });
          continue;
        }
        if (!AUDIO.includes(ext)) continue;
        const info = await stat(file).catch(() => null);
        if (!info) continue;
        let track = known.get(file);
        let picture = false;
        if (!track || track.size !== info.size || track.mtime !== info.mtimeMs) {
          let probe: Probe = {};
          try {
            probe = JSON.parse(
              await this.run("ffprobe", ["-v", "error", "-show_entries", "format=duration:format_tags:stream=codec_type:stream_tags:stream_disposition=attached_pic", "-of", "json", file]),
            );
          } catch {
            continue; // not something ffprobe can read
          }
          const read = tagsOf(probe);
          const { tags, duration } = read;
          picture = read.picture;
          const artist = tags.album_artist ?? tags.albumartist ?? tags.artist ?? "unknown artist";
          const album = tags.album ?? basename(dirname(file));
          track = {
            id: hash(file),
            path: file,
            title: tags.title ?? basename(file, extname(file)).replace(/^\d+[\s.-]*/, ""),
            artist: tags.artist ?? artist,
            album,
            albumArtist: artist,
            albumId: hash(`${source.id}\n${words(artist)}\n${words(album)}`),
            year: (tags.date ?? tags.year ?? "").slice(0, 4),
            number: number(tags.track),
            disc: number(tags.disc) || 1,
            duration,
            source: source.id,
            size: info.size,
            mtime: info.mtimeMs,
          };
        }
        tracks[track.id] = track;
        const album = (albums[track.albumId] ??= {
          id: track.albumId,
          title: track.album,
          artist: track.albumArtist,
          year: "",
          cover: before.albums[track.albumId]?.cover ?? null,
          tracks: [],
          source: track.source,
          years: [],
        });
        album.tracks.push(track.id);
        if (track.year) album.years.push(track.year);
        if (picture && !pictures.has(track.albumId)) pictures.set(track.albumId, file);
      }
    }

    const finished: Record<string, Album> = {};
    for (const album of Object.values(albums)) {
      album.tracks.sort((a, b) => tracks[a].disc - tracks[b].disc || tracks[a].number - tracks[b].number || tracks[a].path.localeCompare(tracks[b].path));
      const { years, ...rest } = album;
      rest.year = years.sort()[0] ?? before.albums[album.id]?.year ?? "";
      rest.cover = await this.cover(album, tracks, pictures.get(album.id));
      finished[album.id] = rest;
    }

    const playlists: Record<string, Playlist> = {};
    const byPath = new Map(Object.values(tracks).map((track) => [track.path, track.id]));
    for (const { path } of playlistFiles) {
      const text = await readFile(path, "utf8").catch(() => "");
      const ids = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => byPath.get(resolve(dirname(path), line)))
        .filter((id): id is string => id !== undefined);
      if (ids.length) {
        const id = hash(path);
        playlists[id] = { id, name: basename(path, extname(path)), path, tracks: ids };
      }
    }

    const library: Library = { scannedAt: new Date().toISOString(), tracks, albums: finished, playlists };
    await this.save(library);
    return library;
  }

  // A small cover for an album: a picture file beside its first track, else
  // the picture in one of its files. Made once, and kept by the album's id.
  private async cover(album: Album, tracks: Record<string, Track>, embedded?: string): Promise<string | null> {
    const target = join(this.dir, "covers", `${album.id}.jpg`);
    if (album.cover && existsSync(join(this.dir, "covers", album.cover))) return album.cover;
    const folder = dirname(tracks[album.tracks[0]].path);
    const names = await readdir(folder).catch(() => [] as string[]);
    const file = COVERS.map((name) => names.find((found) => found.toLowerCase() === name)).find(Boolean);
    const from = file ? join(folder, file) : embedded;
    if (!from) return null;
    await mkdir(dirname(target), { recursive: true });
    try {
      await this.run("ffmpeg", ["-loglevel", "error", "-y", "-i", from, "-an", "-frames:v", "1", "-vf", `scale=${COVER_PX}:${COVER_PX}:force_original_aspect_ratio=decrease`, target]);
      return basename(target);
    } catch {
      return null;
    }
  }

  async coverData(albumId: string): Promise<string | null> {
    const album = (await this.load()).albums[albumId];
    if (!album?.cover) return null;
    const bytes = await readFile(join(this.dir, "covers", album.cover)).catch(() => null);
    return bytes ? `data:image/jpeg;base64,${bytes.toString("base64")}` : null;
  }

  // What matches a request like "play night shift": albums, artists, tracks
  // and playlists, best first, by their words.
  async search(query: string, limit = 20): Promise<{ kind: "album" | "track" | "playlist"; id: string; title: string; subtitle: string }[]> {
    const library = await this.load();
    const wanted = words(query);
    if (!wanted) return [];
    const scored: { score: number; kind: "album" | "track" | "playlist"; id: string; title: string; subtitle: string }[] = [];
    const score = (text: string) => {
      const w = words(text);
      if (w === wanted) return 3;
      if (w.startsWith(wanted)) return 2;
      return w.includes(wanted) ? 1 : 0;
    };
    for (const album of Object.values(library.albums)) {
      const s = Math.max(score(album.title) + 1, score(album.artist));
      if (s > 1 || score(album.title) > 0) scored.push({ score: s, kind: "album", id: album.id, title: album.title, subtitle: album.artist });
    }
    for (const track of Object.values(library.tracks)) {
      const s = score(track.title);
      if (s > 0) scored.push({ score: s, kind: "track", id: track.id, title: track.title, subtitle: `${track.artist} · ${track.album}` });
    }
    for (const playlist of Object.values(library.playlists)) {
      const s = score(playlist.name);
      if (s > 0) scored.push({ score: s, kind: "playlist", id: playlist.id, title: playlist.name, subtitle: `${playlist.tracks.length} tracks` });
    }
    return scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit).map(({ score: _score, ...rest }) => rest);
  }

  // The files to play for an album, a track or a playlist, in order.
  async queue(kind: string, id: string): Promise<Track[]> {
    const library = await this.load();
    const ids = kind === "album" ? library.albums[id]?.tracks : kind === "playlist" ? library.playlists[id]?.tracks : library.tracks[id] ? [id] : undefined;
    return (ids ?? []).map((track) => library.tracks[track]).filter(Boolean);
  }

  // The albums, by artist then title, with where each came from.
  async albums(): Promise<(Omit<Album, "cover"> & { cover: boolean })[]> {
    const library = await this.load();
    return Object.values(library.albums)
      .sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title))
      .map((album) => ({ ...album, cover: album.cover !== null }));
  }

  async album(id: string): Promise<{ album: Album; tracks: Track[] } | null> {
    const library = await this.load();
    const album = library.albums[id];
    return album ? { album, tracks: album.tracks.map((track) => library.tracks[track]) } : null;
  }

  // Where a track is, relative to its source, for the TV to say.
  where(track: Track, sources: { source: Source; path: string }[]): string {
    const found = sources.find((s) => s.source.id === track.source);
    return found ? `${found.source.name}/${relative(found.path, track.path)}` : track.path;
  }
}

// Every file under a folder, skipping hidden ones; a folder that can't be
// read gives nothing.
async function walk(root: string, depth = 0): Promise<string[]> {
  if (depth > 12) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, depth + 1)));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

// --- mpv ---------------------------------------------------------------------

export interface NowPlaying {
  title: string;
  artist: string;
  album: string;
  albumId: string | null;
  position: number;
  duration: number;
  playing: boolean;
  index: number;
  count: number;
}

// mpv's JSON IPC: one request per line, answered by its request_id.
export interface MpvLink {
  command(args: unknown[]): Promise<unknown>;
  close(): void;
}

export function connectMpv(path: string): Promise<MpvLink> {
  return new Promise((resolvePromise, reject) => {
    const socket: Socket = createConnection(path);
    let buffer = "";
    let next = 1;
    const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: { request_id?: number; error?: string; data?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const call = message.request_id ? waiting.get(message.request_id) : undefined;
        if (!call) continue;
        waiting.delete(message.request_id!);
        if (message.error && message.error !== "success") call.reject(new Error(`mpv: ${message.error}`));
        else call.resolve(message.data);
      }
    });
    socket.on("error", (error) => {
      for (const call of waiting.values()) call.reject(error);
      waiting.clear();
      reject(error);
    });
    socket.on("close", () => {
      for (const call of waiting.values()) call.reject(new Error("mpv went away"));
      waiting.clear();
    });
    socket.on("connect", () =>
      resolvePromise({
        command(args) {
          const id = next++;
          return new Promise((done, fail) => {
            waiting.set(id, { resolve: done, reject: fail });
            socket.write(`${JSON.stringify({ command: args, request_id: id })}\n`);
            setTimeout(() => {
              if (waiting.delete(id)) fail(new Error("mpv didn't answer"));
            }, 5000);
          });
        },
        close: () => socket.destroy(),
      }),
    );
  });
}

export interface PlayerOptions {
  socket?: string;
  // Starts mpv listening on the socket; the tests stand in for it.
  start?: (socket: string) => { stop(): void } | null;
  connect?: (socket: string) => Promise<MpvLink>;
}

export class MusicPlayer {
  private socket: string;
  private startMpv: (socket: string) => { stop(): void } | null;
  private connect: (socket: string) => Promise<MpvLink>;
  private link?: Promise<MpvLink>;
  private process: { stop(): void } | null = null;
  private queued: Track[] = [];

  constructor(options: PlayerOptions = {}) {
    const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
    this.socket = options.socket ?? join(runtime, "agentv", "mpv.sock");
    this.startMpv = options.start ?? startMpv;
    this.connect = options.connect ?? connectMpv;
  }

  // mpv, started when something first plays, and again if it went away.
  private async mpv(): Promise<MpvLink> {
    this.link ??= (async () => {
      try {
        return await this.connect(this.socket);
      } catch {
        await mkdir(dirname(this.socket), { recursive: true });
        this.process = this.startMpv(this.socket);
        for (let tries = 0; tries < 50; tries++) {
          await new Promise((done) => setTimeout(done, 100));
          try {
            return await this.connect(this.socket);
          } catch {
            // not listening yet
          }
        }
        throw new Error("mpv didn't start");
      }
    })().catch((error) => {
      this.link = undefined;
      throw error;
    });
    return this.link;
  }

  private async send(args: unknown[]): Promise<unknown> {
    try {
      return await (await this.mpv()).command(args);
    } catch (error) {
      // mpv may have gone since: once more with a new one.
      this.link = undefined;
      if ((error as Error).message.startsWith("mpv:")) throw error;
      return (await this.mpv()).command(args);
    }
  }

  async play(tracks: Track[], from = 0): Promise<void> {
    if (tracks.length === 0) throw new Error("there's nothing to play there");
    this.queued = tracks;
    await this.send(["loadfile", tracks[from]?.path ?? tracks[0].path, "replace"]);
    for (const track of tracks.slice(from + 1)) await this.send(["loadfile", track.path, "append"]);
    await this.send(["set_property", "pause", false]);
  }

  async pause(on?: boolean): Promise<void> {
    if (on === undefined) await this.send(["cycle", "pause"]);
    else await this.send(["set_property", "pause", on]);
  }

  async next(): Promise<void> {
    await this.send(["playlist-next", "weak"]);
  }

  async previous(): Promise<void> {
    await this.send(["playlist-prev", "weak"]);
  }

  async stop(): Promise<void> {
    this.queued = [];
    await this.send(["stop"]);
  }

  // What's playing now, or null with nothing loaded.
  async now(): Promise<NowPlaying | null> {
    if (this.queued.length === 0) return null;
    const get = (name: string) => this.send(["get_property", name]).catch(() => null);
    const [index, position, duration, paused, idle] = await Promise.all([get("playlist-pos"), get("time-pos"), get("duration"), get("pause"), get("idle-active")]);
    if (idle === true || typeof index !== "number" || index < 0) return null;
    const track = this.queued[index];
    if (!track) return null;
    return {
      title: track.title,
      artist: track.artist,
      album: track.album,
      albumId: track.albumId,
      position: typeof position === "number" ? position : 0,
      duration: typeof duration === "number" ? duration : track.duration,
      playing: paused === false,
      index,
      count: this.queued.length,
    };
  }

  close(): void {
    void this.link?.then((link) => link.close()).catch(() => {});
    this.process?.stop();
  }
}

// mpv for music: no video, waiting when there's nothing to play, its IPC
// on the socket, and its system scripts, mpv-mpris among them, loaded.
function startMpv(socket: string): { stop(): void } | null {
  // PipeWire first, as Omarchy has it. With no sound device at all, mpv
  // still plays to nothing at the right pace, rather than skipping every
  // track at once.
  const args = ["--no-video", "--idle=yes", "--force-window=no", "--audio-display=no", "--no-terminal", "--ao=pipewire,pulse,alsa,null"];
  const child = spawn("mpv", [...args, `--input-ipc-server=${socket}`, "--title=agentv music"], {
    stdio: "ignore",
  });
  child.on("error", () => {});
  return { stop: () => child.kill() };
}

// --- The app, as the screen daemon runs it ------------------------------------

export const MUSIC = "agentv.music";
const LEDGER_MS = 10_000;

export interface MusicAppOptions {
  storage: Storage;
  library: MusicLibrary;
  player: MusicPlayer;
  // Hands what plays to the daemon's ledger (S3.3).
  record?: (state: { title: string; position: number; duration: number; playing: boolean }) => Promise<void>;
  every?: number;
  log?: (line: string) => void;
}

// What the launcher's Music page and agentv music ask for, one request at a
// time: the library, a search, playing and pausing, and the sources.
export class MusicApp {
  private storage: Storage;
  private library: MusicLibrary;
  private player: MusicPlayer;
  private record?: MusicAppOptions["record"];
  private log: (line: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private scanning?: Promise<Library>;
  private again?: Promise<Library>;
  private every: number;

  constructor(options: MusicAppOptions) {
    this.storage = options.storage;
    this.library = options.library;
    this.player = options.player;
    this.record = options.record;
    this.every = options.every ?? LEDGER_MS;
    this.log = options.log ?? (() => {});
  }

  // Reads every source again, mounting the USB drives plugged in and the
  // shares that need no password first. One scan at a time: one asked for
  // while another runs comes after it, so it sees a source added meanwhile.
  scan(): Promise<Library> {
    if (this.scanning) {
      this.again ??= this.scanning
        .catch(() => undefined)
        .then(() => {
          this.again = undefined;
          return this.scan();
        });
      return this.again;
    }
    this.scanning = (async () => {
      for (const source of await this.storage.sources()) {
        if (source.available) continue;
        try {
          if (source.kind === "usb") await this.storage.mountUsb(source.id.slice("usb:".length));
          if (source.kind === "share" && !new URL(source.id.slice("share:".length)).username) await this.storage.mountShare(source.id.slice("share:".length));
        } catch (error) {
          this.log(`music: ${source.name} isn't there: ${(error as Error).message}`);
        }
      }
      const library = await this.library.scan(await this.storage.paths());
      this.log(`music: ${Object.keys(library.albums).length} albums, ${Object.keys(library.tracks).length} tracks`);
      return library;
    })().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  // While something plays, where it is goes to the ledger every 10 s.
  private watch(): void {
    if (this.timer || !this.record) return;
    const tick = async () => {
      const now = await this.player.now().catch(() => null);
      if (!now) {
        clearInterval(this.timer);
        this.timer = undefined;
        return;
      }
      await this.record?.({ title: now.title, position: now.position, duration: now.duration, playing: now.playing }).catch((error: Error) => this.log(`music: the ledger: ${error.message}`));
    };
    this.timer = setInterval(() => void tick(), this.every);
    setTimeout(() => void tick(), 1500);
  }

  // The albums played last, newest first, kept with the library.
  private async recent(): Promise<string[]> {
    try {
      return JSON.parse(await readFile(join(this.library.dir, "recent.json"), "utf8"));
    } catch {
      return [];
    }
  }

  private async played(albumId: string): Promise<void> {
    const recent = [albumId, ...(await this.recent()).filter((id) => id !== albumId)].slice(0, 8);
    await mkdir(this.library.dir, { recursive: true });
    await writeFile(join(this.library.dir, "recent.json"), JSON.stringify(recent));
  }

  async handle(request: Record<string, unknown>): Promise<object> {
    const text = (key: string) => String(request[key] ?? "");
    switch (request.op) {
      case "library": {
        const library = await this.library.load();
        return { ok: true, scannedAt: library.scannedAt, albums: await this.library.albums(), playlists: Object.values(library.playlists) };
      }
      case "album": {
        const found = await this.library.album(text("key"));
        return found ? { ok: true, ...found } : { ok: false, error: "that album isn't in the library" };
      }
      case "cover":
        return { ok: true, cover: await this.library.coverData(text("key")) };
      case "search":
        return { ok: true, results: await this.library.search(text("q")) };
      case "play": {
        // By its key, or by name: the best match, as "play night shift"
        // does. (A request's id is the launcher's own, so items go by key.)
        let kind = text("kind");
        let id = text("key");
        if (!id && request.q !== undefined) {
          const best = (await this.library.search(text("q"))).find((result) => !kind || result.kind === kind);
          if (!best) return { ok: false, error: `nothing in the library matches ${text("q")}` };
          ({ kind, id } = best);
        }
        const tracks = await this.library.queue(kind, id);
        if (tracks.length === 0) return { ok: false, error: "there's nothing to play there" };
        await this.player.play(tracks, Number(request.from) || 0);
        await this.played(tracks[0].albumId);
        this.watch();
        return { ok: true, playing: { kind, key: id, title: kind === "album" ? tracks[0].album : tracks[0].title, tracks: tracks.length } };
      }
      case "pause":
        await this.player.pause(typeof request.on === "boolean" ? request.on : undefined);
        return { ok: true };
      case "next":
        await this.player.next();
        return { ok: true };
      case "previous":
        await this.player.previous();
        return { ok: true };
      case "stop":
        await this.player.stop();
        return { ok: true };
      case "now":
        return { ok: true, now: await this.player.now() };
      case "recent": {
        const library = await this.library.load();
        const albums = (await this.recent()).map((id) => library.albums[id]).filter(Boolean);
        return { ok: true, albums: albums.map((album) => ({ id: album.id, title: album.title, artist: album.artist })) };
      }
      case "sources":
        return { ok: true, sources: await this.storage.sources() };
      case "scan": {
        const library = await this.scan();
        return { ok: true, albums: Object.keys(library.albums).length, tracks: Object.keys(library.tracks).length };
      }
      case "mount":
        return { ok: true, path: await this.storage.mountUsb(text("device")) };
      case "add-share": {
        const source = await this.storage.addShare(text("uri"), request.password === undefined ? undefined : text("password"));
        void this.scan();
        return { ok: true, source };
      }
      case "add-folder": {
        const source = await this.storage.addFolder(text("path"));
        void this.scan();
        return { ok: true, source };
      }
      case "remove":
        return (await this.storage.remove(text("key"))) ? { ok: true } : { ok: false, error: "that isn't one of the sources" };
      default:
        return { ok: false, error: `music can't ${String(request.op)}` };
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.player.close();
  }
}
