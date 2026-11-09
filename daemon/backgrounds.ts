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
//
// A theme's videos (ADR-064) are kept apart: a video background, which
// loops, and a theme intro, which plays once and ends on its still. The TV
// session serves them where they are and the daemon streams them on to
// home (theme-videos.ts), so only a video background's still, its first
// frame, is kept here. Home plays a video only where the box decodes it in
// hardware, and shows the still otherwise.

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanServe, VIDEO_TYPES, type VideoType } from "./theme-videos.ts";
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

// A background as the TV gets it: a picture, or one of the theme's video
// backgrounds, with the URL of its still, and the URLs of its videos while
// the TV session serves them (ADR-064).
export interface ShownBackground extends Omit<Background, "type"> {
  type: ImageType | VideoType;
  media: "image" | "video";
  // The still: the picture itself, or a video's first frame.
  poster: string;
  // A video background, which loops, and its codec as ffprobe names it.
  video?: string;
  codec?: string | null;
  // The theme intro of a picture, which plays once and ends on it.
  intro?: string;
  introCodec?: string | null;
}

// What home did with an intro that was due: played it, or showed the still
// instead, and why.
export interface IntroShown {
  due: string;
  how: "played" | "still";
  why: string | null;
}

// The Omarchy theme's own backgrounds: the theme, the one Omarchy shows,
// and those that are here, in Omarchy's order. With them, whether
// Omarchy's intros are on, and an intro due since the TV session started
// or the theme changed, until home has shown it.
export interface ThemePictures {
  name: string | null;
  current: string | null;
  items: ShownBackground[];
  intros: boolean;
  introDue: string | null;
  introShown: IntroShown | null;
}

export interface BackgroundState {
  source: Source;
  // The one on screen now, or the newest.
  current: string | null;
  items: ShownBackground[];
  theme: ThemePictures;
  // Videos play without hardware decoding too: only for the image checks,
  // whose VM has none (/etc/agentv/video-in-software).
  softwareVideo: boolean;
}

// A picture is at most this big, and the box keeps this many photos and as
// many works, the newest, and as many of a theme's own as Omarchy's themes
// ship and then some.
export const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_PHOTOS = 60;
export const MAX_THEME = 24;

// A video of the theme's, as the TV session found it with ffprobe.
export interface VideoFacts {
  codec: string | null;
  width: number | null;
  height: number | null;
}

// One of a theme's backgrounds: a picture, by the start of what's in it as
// SHA-256, maybe with its intro; or a video background, by where it is,
// with the still of its first frame. A video's id is the TV session's.
export interface ThemeFile {
  id: string;
  type: ImageType | VideoType;
  video?: VideoFacts & { poster: { id: string; type: ImageType } };
  intro?: VideoFacts & { id: string; type: VideoType };
}

// What the TV session offers of a theme's backgrounds, whether Omarchy's
// intros are on, an intro due, and where it serves the videos.
export interface ThemeOffer {
  theme: string;
  current: string | null;
  files: ThemeFile[];
  intros?: boolean;
  introDue?: string | null;
  serve?: string | null;
}

// A picture's id from what's in it, for the theme's own.
export function pictureId(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

const ID = /^[0-9a-f]{16}$/;
const EXTENSIONS: Record<ImageType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const VIDEOS = new Set<string>(Object.values(VIDEO_TYPES));
const DUE = /^[0-9a-f]{16,32}$/;

function isImage(type: unknown): type is ImageType {
  return typeof type === "string" && type in EXTENSIONS;
}

function isVideo(type: unknown): type is VideoType {
  return typeof type === "string" && VIDEOS.has(type);
}

// ffprobe's facts, as far as they're plain.
function cleanFacts(facts: Partial<VideoFacts> | undefined): VideoFacts {
  const size = (value: unknown) => (Number.isInteger(value) && (value as number) > 0 && (value as number) <= 16384 ? (value as number) : null);
  const codec = typeof facts?.codec === "string" && /^[a-z0-9_]{1,20}$/.test(facts.codec) ? facts.codec : null;
  return { codec, width: size(facts?.width), height: size(facts?.height) };
}

// A theme file as offered, or null when it isn't one.
function cleanThemeFile(file: Partial<ThemeFile> | undefined): ThemeFile | null {
  if (typeof file?.id !== "string" || !ID.test(file.id)) return null;
  if (isImage(file.type)) {
    const intro = file.intro;
    if (intro === undefined || intro === null) return { id: file.id, type: file.type };
    if (typeof intro?.id !== "string" || !ID.test(intro.id) || !isVideo(intro.type)) return null;
    return { id: file.id, type: file.type, intro: { id: intro.id, type: intro.type, ...cleanFacts(intro) } };
  }
  if (isVideo(file.type)) {
    const poster = file.video?.poster;
    if (typeof poster?.id !== "string" || !ID.test(poster.id) || !isImage(poster.type)) return null;
    return { id: file.id, type: file.type, video: { ...cleanFacts(file.video), poster: { id: poster.id, type: poster.type } } };
  }
  return null;
}

// The pictures of a theme's files the daemon keeps: each picture, and each
// video's still.
function themePictures(files: ThemeFile[]): { id: string; type: ImageType }[] {
  const pictures: { id: string; type: ImageType }[] = [];
  for (const file of files) {
    const picture = file.video ? file.video.poster : isImage(file.type) ? { id: file.id, type: file.type } : null;
    if (picture && !pictures.some((one) => one.id === picture.id)) pictures.push(picture);
  }
  return pictures;
}

// Only what a background is kept with.
function stored(item: Background): Background {
  return { id: item.id, type: item.type, kind: item.kind, credit: item.credit, added: item.added };
}

// A picture as the TV gets it.
function shown(item: Background): ShownBackground {
  return { ...item, media: "image", poster: `/api/backgrounds/${item.id}` };
}

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
// shown once its file is here, and a video once its still is.
interface ThemeKept {
  name: string | null;
  current: string | null;
  files: ThemeFile[];
  intros: boolean;
  introDue: string | null;
  introShown: IntroShown | null;
  serve: string | null;
}

function freshTheme(): ThemeKept {
  return { name: null, current: null, files: [], intros: true, introDue: null, introShown: null, serve: null };
}

interface Kept {
  source: Source;
  current: string | null;
  items: Background[];
  theme: ThemeKept;
}

function fresh(): Kept {
  return { source: "theme", current: null, items: [], theme: freshTheme() };
}

export class Backgrounds {
  private dir: string;
  private softwareVideo: string;
  // The theme's state changes one at a time: the TV session's offers and
  // home's word on an intro can come at once.
  private changing: Promise<unknown> = Promise.resolve();

  private oneAtATime<T>(change: () => Promise<T>): Promise<T> {
    const next = this.changing.then(change, change);
    this.changing = next.catch(() => {});
    return next;
  }

  constructor(options: { dir: string; softwareVideo?: string }) {
    this.dir = options.dir;
    this.softwareVideo = options.softwareVideo ?? "/etc/agentv/video-in-software";
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
    const theme = data.theme as Partial<ThemeKept> | undefined;
    const files = (Array.isArray(theme?.files) ? theme.files : [])
      .map((file) => cleanThemeFile(file))
      .filter((file): file is ThemeFile => file !== null)
      .slice(0, MAX_THEME);
    const name = typeof theme?.name === "string" && THEME_NAME.test(theme.name) ? theme.name : null;
    const due = typeof theme?.introDue === "string" && DUE.test(theme.introDue) ? theme.introDue : null;
    const was = theme?.introShown;
    const introShown =
      typeof was?.due === "string" && DUE.test(was.due) && (was.how === "played" || was.how === "still")
        ? { due: was.due, how: was.how, why: typeof was.why === "string" && /^[a-z-]{1,24}$/.test(was.why) ? was.why : null }
        : null;
    return {
      source,
      current,
      items,
      theme: {
        name,
        current: files.some((file) => file.id === theme?.current) ? theme!.current! : null,
        files,
        intros: theme?.intros !== false,
        introDue: due,
        introShown,
        serve: cleanServe(theme?.serve),
      },
    };
  }

  async read(): Promise<BackgroundState> {
    const kept = await this.kept();
    const here = new Set(await readdir(this.themeDir).catch(() => [] as string[]));
    const has = (picture: { id: string; type: ImageType }) => here.has(`${picture.id}.${EXTENSIONS[picture.type]}`);
    const credit = { text: kept.theme.name ? lookName(kept.theme.name) : null, from: "omarchy" };
    const serve = kept.theme.serve;
    const items: ShownBackground[] = [];
    for (const file of kept.theme.files) {
      if (file.video) {
        if (!has(file.video.poster)) continue;
        items.push({
          id: file.id,
          type: file.type,
          kind: "theme",
          credit,
          added: "",
          media: "video",
          poster: `/api/backgrounds/${file.video.poster.id}`,
          ...(serve ? { video: `/api/backgrounds/video/${file.id}` } : {}),
          codec: file.video.codec,
        });
      } else if (isImage(file.type) && has({ id: file.id, type: file.type })) {
        items.push({
          id: file.id,
          type: file.type,
          kind: "theme",
          credit,
          added: "",
          media: "image",
          poster: `/api/backgrounds/${file.id}`,
          ...(file.intro && serve ? { intro: `/api/backgrounds/video/${file.intro.id}`, introCodec: file.intro.codec } : {}),
        });
      }
    }
    const current = items.some((item) => item.id === kept.theme.current) ? kept.theme.current : (items[0]?.id ?? null);
    return {
      source: kept.source,
      current: kept.current,
      items: kept.items.map(shown),
      theme: { name: kept.theme.name, current, items, intros: kept.theme.intros, introDue: kept.theme.introDue, introShown: kept.theme.introShown },
      softwareVideo: existsSync(this.softwareVideo),
    };
  }

  private async save(state: Kept | BackgroundState, theme?: ThemeKept): Promise<BackgroundState> {
    const items = state.items.map((item) => stored(item as Background));
    const kept: Kept = { source: state.source, current: state.current, items, theme: theme ?? (await this.kept()).theme };
    await mkdir(this.dir, { recursive: true });
    const next = join(this.dir, ".backgrounds.json.next");
    await writeFile(next, `${JSON.stringify(kept, null, 2)}\n`);
    await rename(next, join(this.dir, "backgrounds.json"));
    return this.read();
  }

  // What the TV session offers of the theme Omarchy has now: kept, the
  // pictures no longer in it put away, and the ids of those it should send.
  // A video's still and its intro come with it, and the videos themselves
  // stay with the TV session.
  offerTheme(offer: unknown): Promise<{ state?: BackgroundState; need?: string[]; error?: string }> {
    return this.oneAtATime(() => this.takeOffer(offer));
  }

  private async takeOffer(offer: unknown): Promise<{ state?: BackgroundState; need?: string[]; error?: string }> {
    const { theme, current, files, intros, introDue, serve } = (offer ?? {}) as Partial<ThemeOffer>;
    if (typeof theme !== "string" || !THEME_NAME.test(theme)) return { error: "which omarchy theme" };
    if (!Array.isArray(files) || files.length > MAX_THEME) return { error: `up to ${MAX_THEME} of its backgrounds` };
    const clean: ThemeFile[] = [];
    for (const file of files) {
      const one = cleanThemeFile(file);
      if (!one) return { error: "a background's id and kind" };
      if (!clean.some((other) => other.id === one.id)) clean.push(one);
    }
    if (introDue !== undefined && introDue !== null && (typeof introDue !== "string" || !DUE.test(introDue))) return { error: "an intro that's due, by its token" };
    if (serve !== undefined && serve !== null && !cleanServe(serve)) return { error: "where the tv session serves the videos: 127.0.0.1 only" };
    const kept = await this.kept();
    const pictures = themePictures(clean);
    const here = await readdir(this.themeDir).catch(() => [] as string[]);
    const wanted = new Set(pictures.map((picture) => `${picture.id}.${EXTENSIONS[picture.type]}`));
    for (const name of here) if (!wanted.has(name)) await rm(join(this.themeDir, name), { force: true });
    const state = await this.save(kept, {
      name: theme,
      current: typeof current === "string" && clean.some((file) => file.id === current) ? current : null,
      files: clean,
      intros: intros !== false,
      // An offer from before intros keeps the one that was due.
      introDue: introDue === undefined ? kept.theme.introDue : introDue,
      introShown: kept.theme.introShown,
      serve: cleanServe(serve),
    });
    return { state, need: pictures.filter((picture) => !here.includes(`${picture.id}.${EXTENSIONS[picture.type]}`)).map((picture) => picture.id) };
  }

  // What home did with the intro that's due: played it, or showed the still,
  // and why. Only for the one that's due now.
  introShown(shown: unknown): Promise<{ state?: BackgroundState; error?: string }> {
    return this.oneAtATime(async () => {
      const { due, how, why } = (shown ?? {}) as Partial<IntroShown>;
      const kept = await this.kept();
      if (typeof due !== "string" || due !== kept.theme.introDue) return { error: "that intro isn't the one that's due" };
      if (how !== "played" && how !== "still") return { error: "played, or the still" };
      if (why !== undefined && why !== null && (typeof why !== "string" || !/^[a-z-]{1,24}$/.test(why))) return { error: "why, in a word" };
      return { state: await this.save(kept, { ...kept.theme, introShown: { due, how, why: why ?? null } }) };
    });
  }

  // Where the TV session serves one of the theme's videos, a video
  // background or an intro, or null.
  async video(id: string): Promise<{ base: string; id: string } | null> {
    if (!ID.test(id)) return null;
    const { theme } = await this.kept();
    if (!theme.serve) return null;
    const known = theme.files.some((file) => (file.video && file.id === id) || file.intro?.id === id);
    return known ? { base: theme.serve, id } : null;
  }

  // One of the theme's pictures the TV session was asked for, or a video's
  // still: only one it offered, and only what it said it is.
  async addThemeFile(id: string, body: Buffer): Promise<{ state?: BackgroundState; error?: string }> {
    if (body.length > MAX_BYTES) return { error: "that background is too big: 15 mb at most" };
    const file = themePictures((await this.kept()).theme.files).find((one) => one.id === id);
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
    const state = await this.kept();
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
    const state = await this.kept();
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
  // A video background's id gives its still.
  async file(id: string): Promise<{ path: string; type: ImageType } | null> {
    if (!ID.test(id)) return null;
    const kept = await this.kept();
    const item = kept.items.find((one) => one.id === id);
    if (item) return { path: join(this.dir, `${item.id}.${EXTENSIONS[item.type]}`), type: item.type };
    const video = kept.theme.files.find((one) => one.id === id && one.video);
    const own = video?.video ? video.video.poster : themePictures(kept.theme.files).find((one) => one.id === id);
    if (!own) return null;
    const path = join(this.themeDir, `${own.id}.${EXTENSIONS[own.type]}`);
    return existsSync(path) ? { path, type: own.type } : null;
  }
}
