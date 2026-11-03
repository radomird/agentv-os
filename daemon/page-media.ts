// The box's photos and music for page apps (contract 2, ADR-043), read-only,
// here in the TV session, which can read Music's sources: the folders, the
// USB drives and the NAS shares added in Music → sources (storage.ts). Only
// an app whose manifest lists them in tv.media gets them, and the daemon
// says so for every call before anything is read.
//
// A photo's id names its source and its place there, never a path on the
// box. Nothing outside a source is read: links aren't followed, and a path
// that climbs out of its source is refused. A photo asked for at a width
// comes scaled down by ffmpeg, as Music reads its covers, and kept in a
// cache, so a grid of them doesn't carry whole photos from a NAS.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { lstat, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, posix, sep } from "node:path";
import type { Album as KitAlbum, MediaSource, PhotoPage } from "../apps/contract/kit.ts";
import type { MusicLibrary } from "./music.ts";
import type { Source, Storage } from "./storage.ts";

const PHOTOS = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);
const SOUNDS = new Map([
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
]);
// A whole photo, and a whole track, up to this; anything bigger only scaled.
const PHOTO_MAX = 25 * 1024 * 1024;
const TRACK_MAX = 100 * 1024 * 1024;
const WIDTH_MAX = 3840;
const PAGE_MAX = 200;
const PAGE_DEFAULT = 60;

export type Ask = (app: string, call: string) => Promise<string | null>;

export interface PageMediaOptions {
  storage: Pick<Storage, "paths">;
  library: Pick<MusicLibrary, "albums" | "album" | "load">;
  // The daemon's check of the app's manifest for a call: null when it may,
  // or why not.
  allowed: Ask;
  cache?: string; // scaled photos: ~/.cache/agentv/page-photos
  ffmpeg?: string;
}

function publicId(source: Source): string {
  return createHash("sha256").update(source.id).digest("hex").slice(0, 12);
}

function encode(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

function decode(id: unknown): string[] | null {
  if (typeof id !== "string" || id.length > 4096) return null;
  try {
    const parts = JSON.parse(Buffer.from(id, "base64url").toString("utf8"));
    return Array.isArray(parts) && parts.every((p) => typeof p === "string") ? parts : null;
  } catch {
    return null;
  }
}

// A place inside a source, as the app names it: "" or "2024/summer", never
// with "..", a leading slash or a hidden part.
function safeFolder(value: unknown): string | null {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > 1024 || /[\0\\]/.test(value)) return null;
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.startsWith(".") || part.startsWith("@"))) return null;
  return parts.join("/");
}

export class PageMedia {
  private options: PageMediaOptions;

  constructor(options: PageMediaOptions) {
    this.options = options;
  }

  // One of the kit's calls for app, as home relays it from its frame.
  async handle(app: unknown, call: unknown, args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    if (typeof app !== "string" || typeof call !== "string") return { ok: false, error: "which app, and what" };
    const why = await this.options.allowed(app, call).catch(() => "the daemon didn't answer");
    if (why) return { ok: false, error: why };
    try {
      switch (call) {
        case "photos.sources":
          return { ok: true, value: await this.sources() };
        case "photos.list":
          return { ok: true, value: await this.list(args[0], (args[1] ?? {}) as Record<string, unknown>) };
        case "photos.image":
          return { ok: true, value: await this.image(args[0], args[1]) };
        case "music.albums":
          return { ok: true, value: await this.albums() };
        case "music.track":
          return { ok: true, value: await this.track(args[0]) };
        default:
          return { ok: false, error: `${call} isn't something the app kit does here` };
      }
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  private async roots(): Promise<{ source: Source; path: string; id: string }[]> {
    return (await this.options.storage.paths()).map((found) => ({ ...found, id: publicId(found.source) }));
  }

  async sources(): Promise<MediaSource[]> {
    return (await this.roots()).map(({ source, id }) => ({ id, name: source.name, kind: source.kind }));
  }

  async list(sourceId: unknown, options: Record<string, unknown>): Promise<PhotoPage> {
    const root = (await this.roots()).find((r) => r.id === sourceId);
    if (!root) throw new Error("there's no such source");
    const folder = safeFolder(options.folder);
    if (folder === null) throw new Error("that isn't a folder in the source");
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(options.limit) || PAGE_DEFAULT)));
    const dir = folder ? join(root.path, ...folder.split("/")) : root.path;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => {
      throw new Error("that folder isn't there");
    });
    const folders: string[] = [];
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("@")) continue;
      if (entry.isDirectory()) folders.push(entry.name);
      else if (entry.isFile() && PHOTOS.has(extname(entry.name).toLowerCase())) names.push(entry.name);
    }
    folders.sort((a, b) => a.localeCompare(b));
    names.sort((a, b) => a.localeCompare(b));
    const photos = [];
    for (const name of names.slice(offset, offset + limit)) {
      const info = await stat(join(dir, name)).catch(() => null);
      photos.push({ id: encode([root.id, folder ? `${folder}/${name}` : name]), name, folder, modified: info ? info.mtime.toISOString() : "" });
    }
    return { folders, photos, total: names.length };
  }

  // The file a photo's or a track's id names, inside its source, or an error.
  private async file(parts: string[] | null, kinds: Map<string, string>): Promise<{ path: string; type: string; size: number; mtime: number }> {
    if (!parts || parts.length !== 2) throw new Error("that isn't a photo or a track here");
    const root = (await this.roots()).find((r) => r.id === parts[0]);
    const rel = safeFolder(parts[1]);
    if (!root || !rel) throw new Error("that isn't there now");
    const type = kinds.get(extname(rel).toLowerCase());
    if (!type) throw new Error("that isn't something to show or play");
    const path = join(root.path, ...rel.split("/"));
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) throw new Error("that isn't there now");
    // Each folder on the way, too: a link to elsewhere is refused.
    const real = await realpath(path);
    const base = await realpath(root.path);
    if (!real.startsWith(base + sep)) throw new Error("that isn't in the source");
    return { path, type, size: info.size, mtime: info.mtimeMs };
  }

  // The photo, whole, or scaled to width: its type and its bytes, as base64
  // for the way to home.
  async image(id: unknown, width: unknown): Promise<{ type: string; bytes: string }> {
    const found = await this.file(decode(id), PHOTOS);
    const w = Number(width);
    if (!Number.isFinite(w) || w <= 0) {
      if (found.size > PHOTO_MAX) throw new Error("that photo is too big to show whole; ask for a width");
      return { type: found.type, bytes: (await readFile(found.path)).toString("base64") };
    }
    const scaled = await this.scaled(found, Math.min(WIDTH_MAX, Math.max(16, Math.round(w))));
    return { type: "image/jpeg", bytes: scaled.toString("base64") };
  }

  private async scaled(found: { path: string; size: number; mtime: number }, width: number): Promise<Buffer> {
    const cache = this.options.cache ?? join(homedir(), ".cache", "agentv", "page-photos");
    const name = createHash("sha256").update(`${found.path}\0${found.size}\0${found.mtime}\0${width}`).digest("hex");
    const out = join(cache, `${name}.jpg`);
    const kept = await readFile(out).catch(() => null);
    if (kept) return kept;
    await mkdir(cache, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile(
        this.options.ffmpeg ?? "ffmpeg",
        ["-v", "error", "-y", "-i", found.path, "-vf", `scale='min(${width},iw)':-2`, "-frames:v", "1", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", out],
        { timeout: 30_000 },
        (error) => (error ? reject(new Error("that photo couldn't be scaled")) : resolve()),
      );
    });
    return readFile(out);
  }

  async albums(): Promise<KitAlbum[]> {
    const library = await this.options.library.load();
    const roots = await this.roots();
    const albums: KitAlbum[] = [];
    for (const album of await this.options.library.albums()) {
      if (album.away) continue;
      const tracks = album.tracks.map((id) => library.tracks[id]).filter(Boolean);
      albums.push({
        id: album.id,
        title: album.title,
        artist: album.artist || undefined,
        tracks: tracks.map((track) => {
          const root = roots.find((r) => r.source.id === track.source);
          const rel = root ? posix.normalize(track.path.slice(root.path.length).split(sep).join("/")).replace(/^\/+/, "") : "";
          return { id: encode([root?.id ?? "", rel]), title: track.title, artist: track.artist || undefined, album: album.title, seconds: track.duration || undefined };
        }),
      });
    }
    return albums;
  }

  async track(id: unknown): Promise<{ type: string; bytes: string }> {
    const found = await this.file(decode(id), SOUNDS);
    if (found.size > TRACK_MAX) throw new Error("that track is too big to hand over");
    return { type: found.type, bytes: (await readFile(found.path)).toString("base64") };
  }
}
