// Page apps on the box (contract 2, ADR-043). Each one is served from an
// origin of its own, http://<id>.app.localhost:3000, which Chromium keeps
// on this box, and home shows it full screen in a sandboxed frame. Its files
// come with the Content-Security-Policy the box writes from its manifest,
// so a request to anywhere it didn't declare fails, and the daemon's own
// pages and API answer only 127.0.0.1 and localhost by name, never this.
//
// The app reaches the box only through AgenTV's app kit (apps/contract/
// kit.ts), served at /_agentv/kit.js on its own origin. Home relays each of
// the kit's calls, knowing which app asked by which frame it came from, and
// the daemon checks each one against the manifest here: its storage, with
// its quota, its tile and its notices, and who's watching. The photos and
// music come from the TV session (daemon/page-media.ts), with the same
// check.

import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, posix } from "node:path";
import type { Tile } from "../apps/contract/contract.ts";
import { KIT_PATH, NEEDS, NOTICE_MAX, STORAGE_KEY_MAX, STORAGE_QUOTA, type Call } from "../apps/contract/kit.ts";
import type { Manifest } from "../apps/contract/manifest.ts";
import { pagePolicy } from "../apps/contract/page.ts";

// Every page app's host ends with this, after its id.
export const PAGE_HOST = ".app.localhost";
const ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

// What a page app's frame may use: input and sound, and none of the
// browser's own ways to the camera, the microphone, the screen or where the
// box is.
const PERMISSIONS =
  "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), midi=(), payment=(), publickey-credentials-get=(), clipboard-read=(), clipboard-write=(), screen-wake-lock=(), idle-detection=()";

// The kit, the daemon's own calls of it. photos.* and music.* are the TV
// session's, and ready and exit are home's.
export const DAEMON_CALLS: Call[] = ["viewer", "storage.get", "storage.set", "storage.remove", "storage.keys", "tile.set", "notify"];
export const MEDIA_CALLS: Call[] = ["photos.sources", "photos.list", "photos.image", "music.albums", "music.track"];
const NOTICE_EVERY_MS = 60_000;

export function pageHost(id: string, port: number): string {
  return `${id}${PAGE_HOST}:${port}`;
}

export function pageOrigin(id: string, port: number): string {
  return `http://${pageHost(id, port)}`;
}

// The page app a request's Host names, or null when it names none.
export function pageAppId(host: string | undefined, port: number): string | null {
  const suffix = `${PAGE_HOST}:${port}`;
  if (!host || !host.toLowerCase().endsWith(suffix)) return null;
  const id = host.slice(0, -suffix.length).toLowerCase();
  return ID.test(id) && id.split(".").every((label) => label.length <= 63) ? id : null;
}

// Whether a call is one the manifest declared what it needs for.
export function declares(manifest: Manifest, call: Call): boolean {
  const needs = NEEDS[call];
  if (!needs) return true;
  if (needs.media && !manifest.tv.media?.includes(needs.media)) return false;
  if (needs.capability && !manifest.tv.capabilities.includes(needs.capability)) return false;
  if (needs.notices && manifest.tv.notices !== true) return false;
  return true;
}

// Why a call, as the kit sends it, can't be done, or null: one of the
// daemon's own calls, or with media, one of the TV session's.
export function refusal(manifest: Manifest, call: unknown, media = false): string | null {
  const calls = media ? MEDIA_CALLS : DAEMON_CALLS;
  if (typeof call !== "string" || !calls.includes(call as Call)) return `${String(call)} isn't something the app kit does here`;
  if (manifest.tv.runtime !== "page") return `${manifest.name} isn't a page app`;
  if (!declares(manifest, call as Call)) return `${manifest.name} didn't declare what ${call} needs`;
  return null;
}

// A tile as a page app sets it: words, an icon from the launcher's pixel
// set and pictures from the app's own origins, no items to open, and a few
// entries at most.
function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : undefined;
}

export function cleanTile(value: unknown): Omit<Tile, "refreshMins"> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = (raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, unknown>;
    const out = { label: text(e.label, 24), value: text(e.value, 24), caption: text(e.caption, 40), icon: text(e.icon, 24), image: text(e.image, 500) };
    if (out.image && !/^https?:\/\//.test(out.image)) delete out.image;
    for (const key of Object.keys(out) as (keyof typeof out)[]) if (out[key] === undefined) delete out[key];
    return Object.keys(out).length ? out : null;
  };
  const tile = value as Record<string, unknown>;
  const headline = entry(tile.headline);
  const entries = Array.isArray(tile.entries) ? tile.entries.slice(0, 8).map(entry).filter((e) => e !== null) : [];
  if (!headline && entries.length === 0) return null;
  return { ...(headline ? { headline } : {}), ...(entries.length ? { entries } : {}) };
}

interface Found {
  manifest: Manifest;
  dir: string;
}

export interface PageAppsOptions {
  state: string; // the daemon's own state: each app's storage and tiles
  // The page app with this id on the box, checked against the contract.
  find: (id: string) => Promise<Found | null>;
  // The daemon's own source: the kit is served from it.
  root: string;
  // Who's watching, for the kit's viewer().
  viewer: () => Promise<{ id: string; name: string; role: "adult" | "child" }>;
  // A notice from an app, to the TV and the phones.
  notice?: (app: { id: string; name: string }, text: string) => void;
  // An app's tile changed: home draws it again.
  tileChanged?: (id: string) => void;
  now?: () => number;
  log?: (line: string) => void;
}

export class PageApps {
  private options: PageAppsOptions;
  private kit?: { at: number; code: string };
  // One write at a time to each app's storage.
  private writing = new Map<string, Promise<unknown>>();
  private noticed = new Map<string, number>();

  constructor(options: PageAppsOptions) {
    this.options = options;
  }

  private get storageDir(): string {
    return join(this.options.state, "page-storage");
  }

  private get tilesPath(): string {
    return join(this.options.state, "page-tiles.json");
  }

  // --- The app's own origin ---------------------------------------------

  // Answers a request to a page app's origin: its own files and the kit,
  // read only, under its policy. port is the daemon's, which home is on.
  async serve(id: string, request: IncomingMessage, response: ServerResponse, port: number): Promise<void> {
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "Content-Type": type, "Content-Length": String(Buffer.byteLength(body)), "X-Content-Type-Options": "nosniff", ...headers });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(405, "text/plain; charset=utf-8", "a page app's files are read only\n", { Allow: "GET, HEAD" });
      return;
    }
    const found = await this.options.find(id);
    if (!found || found.manifest.tv.runtime !== "page") {
      send(404, "text/plain; charset=utf-8", "there's no such app on this box\n");
      return;
    }
    const home = `http://127.0.0.1:${port} http://localhost:${port}`;
    const headers = {
      "Content-Security-Policy": pagePolicy(found.manifest, home),
      "Permissions-Policy": PERMISSIONS,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-cache",
      // The frame's origin is opaque, so its own files are another origin's
      // to it: they're the app's, and nothing in them is a secret.
      "Access-Control-Allow-Origin": "*",
    };

    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", "http://page").pathname);
    } catch {
      send(400, "text/plain; charset=utf-8", "that isn't an address\n");
      return;
    }
    if (path === KIT_PATH) {
      send(200, TYPES[".js"], await this.kitCode(), headers);
      return;
    }
    if (path === "/") path = `/${found.manifest.entryPoints.page}`;
    const rel = posix.normalize(path).replace(/^\/+/, "");
    const ext = extname(rel).toLowerCase();
    const bad = rel === "" || rel.startsWith("..") || rel.split("/").some((part) => part.startsWith(".")) || rel === "manifest.json" || !(ext in TYPES);
    const file = join(found.dir, rel);
    const info = bad ? null : await lstat(file).catch(() => null);
    if (!info?.isFile()) {
      send(404, "text/plain; charset=utf-8", "that isn't one of the app's files\n", headers);
      return;
    }
    send(200, TYPES[ext], await readFile(file), headers);
  }

  // The kit, as the frame runs it: launcher/kit-frame.ts with its types
  // stripped, as the daemon serves the launcher's own TypeScript.
  private async kitCode(): Promise<string> {
    const path = join(this.options.root, "launcher", "kit-frame.ts");
    const info = await lstat(path);
    if (this.kit?.at !== info.mtimeMs) this.kit = { at: info.mtimeMs, code: stripTypeScriptTypes(await readFile(path, "utf8"), { mode: "strip" }) };
    return this.kit.code;
  }

  // --- The kit's calls ----------------------------------------------------

  // Whether the TV session may do a photos or music call for the app id:
  // null when it may, or why not.
  async allows(id: string, call: unknown): Promise<string | null> {
    const found = ID.test(id) ? await this.options.find(id) : null;
    if (!found) return "there's no such app on this box";
    return refusal(found.manifest, call, true);
  }

  // One of the kit's calls from home, for the app id: checked against its
  // manifest, then done. Returns what the kit gives back, or why not.
  async call(id: unknown, call: unknown, args: unknown[]): Promise<{ value?: unknown; error?: string }> {
    if (typeof id !== "string" || !ID.test(id)) return { error: "which app" };
    const found = await this.options.find(id);
    if (!found) return { error: "there's no such app on this box" };
    const why = refusal(found.manifest, call);
    if (why) return { error: why };
    switch (call as Call) {
      case "viewer":
        return { value: await this.options.viewer() };
      case "storage.get":
      case "storage.keys":
      case "storage.set":
      case "storage.remove":
        return this.storage(id, call as Call, args);
      case "tile.set":
        return this.setTile(id, args[0]);
      case "notify":
        return this.notify(found.manifest, args[0]);
      default:
        return { error: `${String(call)} isn't something the app kit does here` };
    }
  }

  private async readStorage(id: string): Promise<Record<string, unknown>> {
    try {
      const data = JSON.parse(await readFile(join(this.storageDir, `${id}.json`), "utf8"));
      return typeof data === "object" && data !== null && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  private async storage(id: string, call: Call, args: unknown[]): Promise<{ value?: unknown; error?: string }> {
    const key = args[0];
    if (call === "storage.keys") return { value: Object.keys(await this.readStorage(id)) };
    if (typeof key !== "string" || key.length === 0 || key.length > STORAGE_KEY_MAX) return { error: `a storage key is up to ${STORAGE_KEY_MAX} characters` };
    if (call === "storage.get") {
      const all = await this.readStorage(id);
      return { value: Object.hasOwn(all, key) ? all[key] : null };
    }
    // Writes, one after another, so two at once can't lose either.
    const before = this.writing.get(id) ?? Promise.resolve();
    const write = before.then(async (): Promise<{ value?: unknown; error?: string }> => {
      const all = await this.readStorage(id);
      if (call === "storage.remove") delete all[key];
      else if (args[1] === undefined) return { error: "storage.set needs a value" };
      else all[key] = args[1];
      const json = JSON.stringify(all);
      if (Buffer.byteLength(json) > STORAGE_QUOTA) return { error: `that's more than the ${STORAGE_QUOTA / 1024 / 1024} mb an app may keep` };
      await mkdir(this.storageDir, { recursive: true });
      const path = join(this.storageDir, `${id}.json`);
      await writeFile(`${path}.next`, json);
      await rename(`${path}.next`, path);
      return {};
    });
    this.writing.set(id, write.catch(() => {}));
    return write;
  }

  // An app's storage, gone with the app.
  async forget(id: string): Promise<void> {
    if (!ID.test(id)) return;
    await rm(join(this.storageDir, `${id}.json`), { force: true });
    const tiles = await this.tiles();
    if (id in tiles) {
      delete tiles[id];
      await this.writeTiles(tiles);
    }
  }

  async tiles(): Promise<Record<string, Omit<Tile, "refreshMins">>> {
    try {
      return JSON.parse(await readFile(this.tilesPath, "utf8"));
    } catch {
      return {};
    }
  }

  private async writeTiles(tiles: Record<string, unknown>): Promise<void> {
    await mkdir(this.options.state, { recursive: true });
    await writeFile(`${this.tilesPath}.next`, JSON.stringify(tiles, null, 2));
    await rename(`${this.tilesPath}.next`, this.tilesPath);
  }

  // What a page app's tile shows: what it last set.
  async tile(id: string): Promise<Omit<Tile, "refreshMins"> | null> {
    return (await this.tiles())[id] ?? null;
  }

  private async setTile(id: string, value: unknown): Promise<{ value?: unknown; error?: string }> {
    const tile = cleanTile(value);
    if (!tile) return { error: "a tile has a headline or entries, each with a label, a value or a caption" };
    const tiles = await this.tiles();
    tiles[id] = tile;
    await this.writeTiles(tiles);
    this.options.tileChanged?.(id);
    return {};
  }

  private notify(manifest: Manifest, value: unknown): { value?: unknown; error?: string } {
    const words = text(value, NOTICE_MAX);
    if (!words) return { error: `a notice is a few words, up to ${NOTICE_MAX} characters` };
    const now = (this.options.now ?? Date.now)();
    const last = this.noticed.get(manifest.id);
    if (last !== undefined && now - last < NOTICE_EVERY_MS) return { error: "one notice a minute" };
    this.noticed.set(manifest.id, now);
    this.options.notice?.({ id: manifest.id, name: manifest.name }, words);
    return {};
  }
}
