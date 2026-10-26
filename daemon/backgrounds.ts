// Backgrounds (ADR-012, board 13, S5.3): the pictures behind home and on
// the ambient screen, each kept with its credit, which the ambient screen
// shows: the household's own photos, sent from a phone (Share → TV on the
// web companion), and works picked from museum archives (art.ts), each kept
// in /var/lib/agentv/backgrounds. With none chosen, the TV keeps its
// theme's pixel field.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SOURCES = ["field", "photos", "art"] as const;
export type Source = (typeof SOURCES)[number];

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

// Who to thank for a picture, as the ambient screen says it.
export interface Credit {
  // The line the sender gave it, such as "photo by ana on unsplash".
  text: string | null;
  // Where it came from: whose phone, or which archive.
  from: string;
}

export interface Background {
  id: string;
  type: ImageType;
  // A photo from a phone, or a work from an archive.
  kind: "photo" | "art";
  credit: Credit;
  added: string;
}

export interface BackgroundState {
  source: Source;
  // The one on screen now, or the newest.
  current: string | null;
  items: Background[];
}

// A picture is at most this big, and the box keeps this many photos and as
// many works, the newest.
export const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_PHOTOS = 60;

const ID = /^[0-9a-f]{16}$/;
const EXTENSIONS: Record<ImageType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// What a picture is, from its first bytes rather than what it says it is.
export function imageType(body: Buffer): ImageType | null {
  if (body.length > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length > 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (body.length > 12 && body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

// A credit line as people type it: one line, plain text, not too long.
export function creditText(text: unknown, most = 120): string | null {
  if (typeof text !== "string") return null;
  const clean = text.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, most) : null;
}

// The kind of picture a source shows.
const KIND: Record<Source, Background["kind"] | null> = { field: null, photos: "photo", art: "art" };

function fresh(): BackgroundState {
  return { source: "field", current: null, items: [] };
}

export class Backgrounds {
  private dir: string;

  constructor(options: { dir: string }) {
    this.dir = options.dir;
  }

  async read(): Promise<BackgroundState> {
    let data: Partial<BackgroundState>;
    try {
      data = JSON.parse(await readFile(join(this.dir, "backgrounds.json"), "utf8"));
    } catch {
      return fresh();
    }
    // A box from before art kept only photos, with no kind.
    const items = (Array.isArray(data.items) ? data.items : [])
      .filter((item): item is Background => typeof item?.id === "string" && ID.test(item.id) && item.type in EXTENSIONS && typeof item.credit?.from === "string")
      .map((item) => ({ ...item, kind: item.kind === "art" ? ("art" as const) : ("photo" as const) }));
    const chosen = SOURCES.includes(data.source as Source) ? (data.source as Source) : "field";
    const source = KIND[chosen] && !items.some((item) => item.kind === KIND[chosen]) ? "field" : chosen;
    const current = items.some((item) => item.id === data.current) ? (data.current as string) : (items[0]?.id ?? null);
    return { source, current, items };
  }

  private async save(state: BackgroundState): Promise<BackgroundState> {
    await mkdir(this.dir, { recursive: true });
    const next = join(this.dir, ".backgrounds.json.next");
    await writeFile(next, `${JSON.stringify(state, null, 2)}\n`);
    await rename(next, join(this.dir, "backgrounds.json"));
    return state;
  }

  // A photo from a phone, or a work from an archive, becomes the
  // background, newest first; the oldest of its kind goes once there are
  // more than the box keeps.
  async add(body: Buffer, credit: { text?: unknown; from: string }, kind: Background["kind"] = "photo"): Promise<{ item?: Background; state?: BackgroundState; error?: string }> {
    if (body.length > MAX_BYTES) return { error: "that photo is too big: 15 mb at most" };
    const type = imageType(body);
    if (!type) return { error: "a photo the tv can show: jpeg, png or webp" };
    const state = await this.read();
    const item: Background = {
      id: randomBytes(8).toString("hex"),
      type,
      kind,
      credit: { text: creditText(credit.text, kind === "art" ? 200 : 120), from: creditText(credit.from) ?? "a phone" },
      added: new Date().toISOString(),
    };
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${item.id}.${EXTENSIONS[type]}`), body);
    state.items.unshift(item);
    const same = state.items.filter((one) => one.kind === kind);
    for (const old of same.slice(MAX_PHOTOS)) {
      state.items = state.items.filter((one) => one !== old);
      await rm(join(this.dir, `${old.id}.${EXTENSIONS[old.type]}`), { force: true });
    }
    state.source = kind === "art" ? "art" : "photos";
    state.current = item.id;
    return { item, state: await this.save(state) };
  }

  // The source the TV shows: its pixel field, the photos or the art.
  async choose(source: unknown, current?: unknown): Promise<{ state?: BackgroundState; error?: string }> {
    if (!SOURCES.includes(source as Source)) return { error: `a source: ${SOURCES.join(", ")}` };
    const state = await this.read();
    if (source === "photos" && !state.items.some((item) => item.kind === "photo")) return { error: "send a photo from your phone first" };
    if (source === "art" && !state.items.some((item) => item.kind === "art")) return { error: "pick a work from an archive first" };
    state.source = source as Source;
    if (typeof current === "string" && state.items.some((item) => item.id === current)) state.current = current;
    return { state: await this.save(state) };
  }

  async remove(id: unknown): Promise<{ state?: BackgroundState; error?: string }> {
    const state = await this.read();
    const item = state.items.find((one) => one.id === id);
    if (!item) return { error: "no such photo" };
    state.items = state.items.filter((one) => one !== item);
    await rm(join(this.dir, `${item.id}.${EXTENSIONS[item.type]}`), { force: true });
    if (state.current === item.id) state.current = state.items[0]?.id ?? null;
    if (KIND[state.source] && !state.items.some((one) => one.kind === KIND[state.source])) state.source = "field";
    return { state: await this.save(state) };
  }

  // A picture's file, for the TV.
  async file(id: string): Promise<{ path: string; type: ImageType } | null> {
    if (!ID.test(id)) return null;
    const item = (await this.read()).items.find((one) => one.id === id);
    return item ? { path: join(this.dir, `${item.id}.${EXTENSIONS[item.type]}`), type: item.type } : null;
  }
}
