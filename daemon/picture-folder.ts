// Pictures from a folder, a USB drive or a NAS share as the background
// (ADR-012): the sources are Music's (storage.ts), here in the TV session,
// which can read them. Up to 60 of a source's pictures, at random, are handed
// to the daemon one by one, which keeps them beside the photos and the art
// and makes them the background. Only pictures the TV can show, not too big,
// and nothing outside the source: links aren't followed.

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";

export const MOST = 60;
const KINDS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_BYTES = 15 * 1024 * 1024;
// How deep it looks, and how many entries at most, so a big share doesn't
// keep it busy.
const DEPTH = 4;
const LOOK_AT = 5000;

// Up to `most` pictures under a folder, at random.
export async function findPictures(dir: string, most = MOST): Promise<string[]> {
  const found: string[] = [];
  let seen = 0;
  const walk = async (at: string, depth: number): Promise<void> => {
    const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++seen > LOOK_AT) return;
      // Hidden folders, and the thumbnails a NAS keeps beside the pictures
      // (Synology's @eaDir, QNAP's .@__thumb).
      if (entry.name.startsWith(".") || entry.name.startsWith("@")) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory() && depth < DEPTH) await walk(path, depth + 1);
      else if (entry.isFile() && KINDS.has(extname(entry.name).toLowerCase())) found.push(path);
    }
  };
  await walk(dir, 0);
  for (let i = found.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [found[i], found[j]] = [found[j], found[i]];
  }
  const picked: string[] = [];
  for (const path of found) {
    if (picked.length >= most) break;
    const size = (await stat(path).catch(() => null))?.size ?? 0;
    if (size > 0 && size <= MAX_BYTES) picked.push(path);
  }
  return picked;
}

export interface FolderSource {
  name: string;
  path: string;
}

export class FolderPictures {
  private home: string;

  constructor(options: { home?: string } = {}) {
    this.home = options.home ?? "http://127.0.0.1:3000/";
  }

  // A source's pictures to the daemon: the first one says to put away the
  // folder's pictures from before. A grant goes with them, for a child's
  // profile, past the PIN.
  async send(source: FolderSource, grant?: string): Promise<{ ok: boolean; count?: number; error?: string }> {
    const found = await findPictures(source.path);
    if (!found.length) return { ok: false, error: `there are no pictures in ${source.name}` };
    let sent = 0;
    for (const path of found) {
      const body = await readFile(path).catch(() => null);
      if (!body) continue;
      const response = await fetch(`${this.home}api/backgrounds/folder?from=${encodeURIComponent(source.name)}${sent === 0 ? "&first=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
      if (response?.status === 403) return { ok: false, error: "that needs the pin" };
      if (response?.ok) sent++;
    }
    return sent ? { ok: true, count: sent } : { ok: false, error: `none of the pictures in ${source.name} can be shown` };
  }
}
