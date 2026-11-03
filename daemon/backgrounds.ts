// Backgrounds (ADR-012, ADR-048, board 13, S5.3, S5.8): the pictures
// behind home and on the ambient screen, each kept with its credit, which
// the ambient screen shows: the Omarchy theme's own backgrounds, the
// household's own photos, sent from a phone (Share → TV on the web
// companion), works picked from museum archives (art.ts), and pictures from
// a folder, a USB drive or a NAS share, which the TV session hands over
// (picture-folder.ts), each kept in /var/lib/agentv/backgrounds.
//
// The theme's own are the default. The TV session hands over the ones the
// theme Omarchy has now ships, and which of them Omarchy shows, whenever
// either changes (omarchy-themes.ts). Each is named by what's in it, so one
// that's here already isn't sent again. A theme without backgrounds, like
// the pixel field, leaves the TV in its theme's colours.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lookName, THEME_NAME } from "./themes.ts";

export const SOURCES = ["theme", "field", "photos", "art", "folder"] as const;
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
  // A photo from a phone, a work from an archive, a picture from a folder
  // or a share, or one of the theme's own.
  kind: "photo" | "art" | "folder" | "theme";
  credit: Credit;
  added: string;
}

// The Omarchy theme's own backgrounds: the theme, the one Omarchy shows,
// and those that are here, in Omarchy's order.
export interface ThemePictures {
  name: string | null;
  current: string | null;
  items: Background[];
}

export interface BackgroundState {
  source: Source;
  // The one on screen now, or the newest.
  current: string | null;
  items: Background[];
  theme: ThemePictures;
}

// A picture is at most this big, and the box keeps this many photos and as
// many works, the newest, and as many of a theme's own as Omarchy's themes
// ship and then some.
export const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_PHOTOS = 60;
export const MAX_THEME = 24;

// What the TV session offers of a theme's backgrounds: each one's id, the
// start of what's in it as SHA-256, and what kind of picture it is.
export interface ThemeOffer {
  theme: string;
  current: string | null;
  files: { id: string; type: ImageType }[];
}

// A picture's id from what's in it, for the theme's own.
export function pictureId(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

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

// The kind of picture a source shows. The theme's own are kept apart.
const KIND: Record<Source, Background["kind"] | null> = { theme: null, field: null, photos: "photo", art: "art", folder: "folder" };
const KINDS: Background["kind"][] = ["photo", "art", "folder"];

// What's kept of the theme's own: what was offered last. A picture of it is
// shown once its file is here.
interface ThemeKept {
  name: string | null;
  current: string | null;
  files: { id: string; type: ImageType }[];
}

interface Kept {
  source: Source;
  current: string | null;
  items: Background[];
  theme: ThemeKept;
}

function fresh(): Kept {
  return { source: "theme", current: null, items: [], theme: { name: null, current: null, files: [] } };
}

export class Backgrounds {
  private dir: string;

  constructor(options: { dir: string }) {
    this.dir = options.dir;
  }

  private get themeDir(): string {
    return join(this.dir, "theme");
  }

  private async kept(): Promise<Kept> {
    let data: Partial<Kept>;
    try {
      data = JSON.parse(await readFile(join(this.dir, "backgrounds.json"), "utf8"));
    } catch {
      return fresh();
    }
    // A box from before art kept only photos, with no kind.
    const items = (Array.isArray(data.items) ? data.items : [])
      .filter((item): item is Background => typeof item?.id === "string" && ID.test(item.id) && item.type in EXTENSIONS && typeof item.credit?.from === "string")
      .map((item) => ({ ...item, kind: KINDS.includes(item.kind) ? item.kind : ("photo" as const) }));
    // A box from before the theme's own kept the source it had.
    const chosen = SOURCES.includes(data.source as Source) ? (data.source as Source) : "field";
    const source = KIND[chosen] && !items.some((item) => item.kind === KIND[chosen]) ? "field" : chosen;
    const current = items.some((item) => item.id === data.current) ? (data.current as string) : (items[0]?.id ?? null);
    const theme = data.theme;
    const files = (Array.isArray(theme?.files) ? theme.files : []).filter((file) => typeof file?.id === "string" && ID.test(file.id) && file.type in EXTENSIONS).slice(0, MAX_THEME);
    const name = typeof theme?.name === "string" && THEME_NAME.test(theme.name) ? theme.name : null;
    return { source, current, items, theme: { name, current: files.some((file) => file.id === theme?.current) ? theme!.current : null, files } };
  }

  async read(): Promise<BackgroundState> {
    const kept = await this.kept();
    const here = new Set(await readdir(this.themeDir).catch(() => [] as string[]));
    const items = kept.theme.files
      .filter((file) => here.has(`${file.id}.${EXTENSIONS[file.type]}`))
      .map((file): Background => ({ id: file.id, type: file.type, kind: "theme", credit: { text: kept.theme.name ? lookName(kept.theme.name) : null, from: "omarchy" }, added: "" }));
    const current = items.some((item) => item.id === kept.theme.current) ? kept.theme.current : (items[0]?.id ?? null);
    return { source: kept.source, current: kept.current, items: kept.items, theme: { name: kept.theme.name, current, items } };
  }

  private async save(state: Kept | BackgroundState, theme?: ThemeKept): Promise<BackgroundState> {
    const kept: Kept = { source: state.source, current: state.current, items: state.items, theme: theme ?? (await this.kept()).theme };
    await mkdir(this.dir, { recursive: true });
    const next = join(this.dir, ".backgrounds.json.next");
    await writeFile(next, `${JSON.stringify(kept, null, 2)}\n`);
    await rename(next, join(this.dir, "backgrounds.json"));
    return this.read();
  }

  // What the TV session offers of the theme Omarchy has now: kept, the
  // pictures no longer in it put away, and the ids of those it should send.
  async offerTheme(offer: unknown): Promise<{ state?: BackgroundState; need?: string[]; error?: string }> {
    const { theme, current, files } = (offer ?? {}) as Partial<ThemeOffer>;
    if (typeof theme !== "string" || !THEME_NAME.test(theme)) return { error: "which omarchy theme" };
    if (!Array.isArray(files) || files.length > MAX_THEME) return { error: `up to ${MAX_THEME} of its backgrounds` };
    const clean: ThemeKept["files"] = [];
    for (const file of files) {
      if (typeof file?.id !== "string" || !ID.test(file.id) || !(file.type in EXTENSIONS)) return { error: "a background's id and kind" };
      if (!clean.some((one) => one.id === file.id)) clean.push({ id: file.id, type: file.type });
    }
    const kept = await this.kept();
    const here = await readdir(this.themeDir).catch(() => [] as string[]);
    const wanted = new Set(clean.map((file) => `${file.id}.${EXTENSIONS[file.type]}`));
    for (const name of here) if (!wanted.has(name)) await rm(join(this.themeDir, name), { force: true });
    const state = await this.save(kept, { name: theme, current: typeof current === "string" && clean.some((file) => file.id === current) ? current : null, files: clean });
    return { state, need: clean.filter((file) => !here.includes(`${file.id}.${EXTENSIONS[file.type]}`)).map((file) => file.id) };
  }

  // One of the theme's backgrounds the TV session was asked for: only one
  // it offered, and only what it said it is.
  async addThemeFile(id: string, body: Buffer): Promise<{ state?: BackgroundState; error?: string }> {
    if (body.length > MAX_BYTES) return { error: "that background is too big: 15 mb at most" };
    const file = (await this.kept()).theme.files.find((one) => one.id === id);
    if (!file) return { error: "that background isn't one of the theme's" };
    if (pictureId(body) !== id || imageType(body) !== file.type) return { error: "that isn't the background it said it was" };
    await mkdir(this.themeDir, { recursive: true });
    const name = `${file.id}.${EXTENSIONS[file.type]}`;
    await writeFile(join(this.themeDir, `.${name}.next`), body);
    await rename(join(this.themeDir, `.${name}.next`), join(this.themeDir, name));
    return { state: await this.read() };
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
    state.source = kind === "art" ? "art" : kind === "folder" ? "folder" : "photos";
    state.current = item.id;
    return { item, state: await this.save(state) };
  }

  // Puts away every picture of a kind, as a folder's from before when
  // another folder takes its place.
  async clear(kind: Background["kind"]): Promise<BackgroundState> {
    const state = await this.read();
    for (const old of state.items.filter((one) => one.kind === kind)) await rm(join(this.dir, `${old.id}.${EXTENSIONS[old.type]}`), { force: true });
    state.items = state.items.filter((one) => one.kind !== kind);
    if (state.current && !state.items.some((one) => one.id === state.current)) state.current = state.items[0]?.id ?? null;
    if (KIND[state.source] === kind) state.source = "field";
    return this.save(state);
  }

  // The source the TV shows: the theme's own, its pixel field, the photos,
  // the art or a folder's.
  async choose(source: unknown, current?: unknown): Promise<{ state?: BackgroundState; error?: string }> {
    if (!SOURCES.includes(source as Source)) return { error: `a source: ${SOURCES.join(", ")}` };
    const state = await this.kept();
    if (source === "photos" && !state.items.some((item) => item.kind === "photo")) return { error: "send a photo from your phone first" };
    if (source === "art" && !state.items.some((item) => item.kind === "art")) return { error: "pick a work from an archive first" };
    if (source === "folder" && !state.items.some((item) => item.kind === "folder")) return { error: "pick a folder or a share first" };
    state.source = source as Source;
    if (typeof current === "string" && state.items.some((item) => item.id === current)) state.current = current;
    return { state: await this.save(state) };
  }

  async remove(id: unknown): Promise<{ state?: BackgroundState; error?: string }> {
    const state = await this.kept();
    const item = state.items.find((one) => one.id === id);
    if (!item) return { error: "no such photo" };
    state.items = state.items.filter((one) => one !== item);
    await rm(join(this.dir, `${item.id}.${EXTENSIONS[item.type]}`), { force: true });
    if (state.current === item.id) state.current = state.items[0]?.id ?? null;
    if (KIND[state.source] && !state.items.some((one) => one.kind === KIND[state.source])) state.source = "field";
    return { state: await this.save(state) };
  }

  // A picture's file, for the TV: a photo, a work, a folder's or the theme's.
  async file(id: string): Promise<{ path: string; type: ImageType } | null> {
    if (!ID.test(id)) return null;
    const state = await this.read();
    const item = state.items.find((one) => one.id === id);
    if (item) return { path: join(this.dir, `${item.id}.${EXTENSIONS[item.type]}`), type: item.type };
    const own = state.theme.items.find((one) => one.id === id);
    return own ? { path: join(this.themeDir, `${own.id}.${EXTENSIONS[own.type]}`), type: own.type } : null;
  }
}
