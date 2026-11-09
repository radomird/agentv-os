// Every theme Omarchy has, as the person sees them (ADR-048): the ones it
// ships in $OMARCHY_PATH/themes and any installed on its desktop in
// ~/.config/omarchy/themes, which wins when both have a name, as Omarchy's
// own omarchy-theme-dir has it. Each one's colours come from Omarchy's own
// omarchy-theme-color, so an older theme's come out the way Omarchy sets
// them.
//
// This runs in the TV session, which can read the person's folder, and hands
// the list to the daemon, which can't: when the session starts, whenever the
// themes folder changes, and whenever Omarchy sets a theme, which
// `omarchy theme install` does last.
//
// With it go the backgrounds of the theme Omarchy has now, and which of them
// Omarchy shows, for home (ADR-048, S5.8): each picture once, as the daemon
// asks for it.
//
// And Omarchy 4.5's videos (ADR-064): a video background, which loops, and
// a picture's theme intro, which plays once and ends on it. They're found
// the way Omarchy finds them, and served from where they are, never copied
// (theme-videos.ts). Only a video background's first frame goes to the
// daemon, as its still. An intro is due once when the TV session starts and
// again after the theme changes, unless Omarchy's intros are off.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { imageType, MAX_BYTES, MAX_THEME, pictureId, type ImageType } from "./backgrounds.ts";
import { firstFrame, isOmarchyVideo, OMARCHY_VIDEO, probe, VideoServer, videoId, videoType, type VideoInfo, type VideoType } from "./theme-videos.ts";
import { KEYS } from "./themes.ts";

// A theme's name, as omarchy-theme-install allows it.
const NAME = /^[a-z0-9_][a-z0-9._+-]{0,63}$/;
// As many as the daemon takes.
const MOST = 150;
// How long it waits after a change for the rest of it, such as a clone.
const SETTLE_MS = 700;
// How often it tries again while the daemon isn't there, at the start.
const RETRY_MS = 5_000;
const RETRIES = 12;

export interface FoundTheme {
  id: string;
  mode: "light" | "dark";
  colors: Record<string, string>;
  // Installed on Omarchy's desktop, rather than shipped with Omarchy.
  installed: boolean;
}

export interface ThemesOptions {
  // Omarchy's own files: $OMARCHY_PATH.
  omarchy: string;
  // The person's home.
  home: string;
  // AgenTV's daemon.
  daemon?: string;
  // Omarchy's colour resolver for one colors.toml, every key it resolves,
  // or null when it couldn't.
  resolve?: (file: string) => Promise<Record<string, string> | null>;
  settleMs?: number;
  retryMs?: number;
  log?: (line: string) => void;
  // A video's codec and size, and its first frame as a JPEG: Omarchy's own
  // ffprobe and ffmpeg, by default.
  probe?: (path: string) => Promise<VideoInfo | null>;
  frame?: (path: string) => Promise<Buffer | null>;
  // This TV session, which an intro is due once for: its Hyprland's.
  session?: string | null;
}

// A video of the theme's as it goes to the daemon: by its id, with its
// codec and size.
export interface FoundVideo extends VideoInfo {
  id: string;
  type: VideoType;
  path: string;
}

// One of the theme's backgrounds as the TV session found it: a picture,
// maybe with its intro, or a video background with the still of its first
// frame.
export interface FoundBackground {
  id: string;
  type: ImageType | VideoType;
  path: string;
  intro?: FoundVideo;
  video?: VideoInfo & { poster: { id: string; type: ImageType; body: Buffer } };
}

export interface FoundBackgrounds {
  theme: string;
  current: string | null;
  files: FoundBackground[];
  // Omarchy's intros switch (omarchy theme bg intro toggle).
  intros: boolean;
  // An intro that's due: a new token each time one is.
  introDue: string | null;
}

// What Omarchy's own omarchy-theme-bg-boot-intro finds as a picture's intro:
// intros/<its name>.<a video kind> beside where the picture really is.
async function introOf(path: string): Promise<string | null> {
  const real = await realpath(path).catch(() => null);
  if (!real || !/\.(jpe?g|png|bmp|webp)$/i.test(real)) return null;
  const stem = basename(real).replace(/\.[^.]+$/, "");
  for (const extension of OMARCHY_VIDEO) {
    const intro = join(dirname(real), "intros", `${stem}.${extension}`);
    if (await stat(intro).then((info) => info.isFile(), () => false)) return intro;
  }
  return null;
}

function token(): string {
  return randomBytes(12).toString("hex");
}

// omarchy-theme-color --all: a key and its value on each line.
export function resolver(omarchy: string): (file: string) => Promise<Record<string, string> | null> {
  return (file) =>
    new Promise((resolve) => {
      execFile(join(omarchy, "bin", "omarchy-theme-color"), ["--file", file, "--all"], { timeout: 10_000, env: { ...process.env, OMARCHY_PATH: omarchy } }, (error, stdout) => {
        if (error) return resolve(null);
        const colors: Record<string, string> = {};
        for (const line of stdout.split("\n")) {
          const [key, value] = line.split("\t");
          if (key && value !== undefined) colors[key] = value.trim();
        }
        resolve(colors);
      });
    });
}

export class OmarchyThemes {
  private options: ThemesOptions;
  private resolve: (file: string) => Promise<Record<string, string> | null>;
  private watchers = new Map<string, FSWatcher>();
  private settle?: NodeJS.Timeout;
  private pushing: Promise<boolean> | null = null;
  private again = false;
  private videos = new VideoServer();
  private serving: string | null = null;
  // The theme of the last look, so a change is seen, and the intro that's
  // due, if one is.
  private theme: string | null = null;
  private introDue: string | null = null;

  constructor(options: ThemesOptions) {
    this.options = options;
    this.resolve = options.resolve ?? resolver(options.omarchy);
  }

  private get stateDir(): string {
    return join(this.options.home, ".local", "state", "omarchy");
  }

  private get installedDir(): string {
    return join(this.options.home, ".config", "omarchy", "themes");
  }

  // Every theme, the installed ones in place of shipped ones of the same name.
  async list(): Promise<FoundTheme[]> {
    const found = new Map<string, FoundTheme>();
    for (const [dir, installed] of [
      [join(this.options.omarchy, "themes"), false],
      [this.installedDir, true],
    ] as const) {
      for (const id of (await readdir(dir).catch(() => [] as string[])).sort()) {
        if (!NAME.test(id)) continue;
        const file = join(dir, id, "colors.toml");
        if (!(await stat(file).then((info) => info.isFile(), () => false))) continue;
        const resolved = await this.resolve(file);
        if (!resolved) continue;
        // Only the colours the TV draws, so the list fits in one request.
        const colors = Object.fromEntries(KEYS.filter((key) => resolved[key]).map((key) => [key, resolved[key]]));
        found.set(id, { id, mode: resolved.mode === "light" ? "light" : "dark", colors, installed });
      }
    }
    return [...found.values()].slice(0, MOST);
  }

  // The list and the theme's backgrounds to the daemon. One at a time: a
  // change while one goes sends another after it.
  push(): Promise<boolean> {
    if (this.pushing) {
      this.again = true;
      return this.pushing;
    }
    this.pushing = (async () => {
      let sent = false;
      do {
        this.again = false;
        sent = await this.send(await this.list());
        if (sent) sent = await this.sendBackgrounds();
      } while (this.again);
      return sent;
    })().finally(() => (this.pushing = null));
    return this.pushing;
  }

  // What's in each background, by its path, size and time, so one isn't
  // read again until it changes.
  private seen = new Map<string, { size: number; at: number; id: string; type: ImageType }>();
  // And each video: its codec and size, and a video background's still.
  private seenVideos = new Map<string, { size: number; at: number; facts: VideoInfo | null; poster?: { id: string; type: ImageType; body: Buffer } | null }>();

  // A video's id, codec and size, and with still, its first frame, read
  // again only when it changes. Null for one home can't play.
  private async video(path: string, still: boolean): Promise<(FoundVideo & { poster?: { id: string; type: ImageType; body: Buffer } }) | null> {
    const type = videoType(path);
    const info = type ? await stat(path).catch(() => null) : null;
    if (!type || !info?.isFile() || info.size === 0) return null;
    let known = this.seenVideos.get(path);
    if (!known || known.size !== info.size || known.at !== info.mtimeMs) {
      known = { size: info.size, at: info.mtimeMs, facts: await (this.options.probe ?? probe)(path) };
      this.seenVideos.set(path, known);
    }
    if (!known.facts) return null;
    if (still && known.poster === undefined) {
      const body = await (this.options.frame ?? firstFrame)(path);
      const picture = body && body.length <= MAX_BYTES ? imageType(body) : null;
      known.poster = body && picture ? { id: pictureId(body), type: picture, body } : null;
    }
    const found = { id: videoId(path, info.size, info.mtimeMs), type, path, ...known.facts };
    return still ? (known.poster ? { ...found, poster: known.poster } : null) : found;
  }

  // The theme Omarchy has now, its backgrounds as Omarchy finds them when it
  // sets a theme (omarchy-theme-set): the person's own for the theme, then
  // the theme's, in the order of their paths, and the one Omarchy shows.
  // Only what the TV can show: JPEG, PNG and WebP pictures, each with its
  // intro, and the videos home's Chromium plays, each with its still.
  async backgrounds(): Promise<FoundBackgrounds | null> {
    const state = join(this.stateDir, "current");
    const theme = (await readFile(join(state, "theme.name"), "utf8").catch(() => "")).trim();
    if (!NAME.test(theme)) return null;
    // Another theme than at the last look: its intro is due.
    if (this.theme !== null && this.theme !== theme) this.introDue = token();
    this.theme = theme;
    const paths: string[] = [];
    for (const dir of [join(this.options.home, ".config", "omarchy", "backgrounds", theme), join(state, "theme", "backgrounds")]) {
      for (const name of await readdir(dir).catch(() => [] as string[])) if (/\.(jpe?g|png|webp)$/i.test(name) || isOmarchyVideo(name)) paths.push(join(dir, name));
    }
    paths.sort();
    const link = await readlink(join(state, "background")).catch(() => null);
    const real = link ? await realpath(join(state, "background")).catch(() => null) : null;
    const files: FoundBackground[] = [];
    let current: string | null = null;
    for (const path of paths) {
      if (files.length >= MAX_THEME) break;
      let file: FoundBackground | null = null;
      if (isOmarchyVideo(path)) {
        const video = await this.video(path, true);
        if (video?.poster) file = { id: video.id, type: video.type, path, video: { codec: video.codec, width: video.width, height: video.height, poster: video.poster } };
      } else {
        const info = await stat(path).catch(() => null);
        if (!info?.isFile() || info.size > MAX_BYTES) continue;
        let known = this.seen.get(path);
        if (!known || known.size !== info.size || known.at !== info.mtimeMs) {
          const body = await readFile(path).catch(() => null);
          const type = body && imageType(body);
          if (!body || !type) continue;
          known = { size: info.size, at: info.mtimeMs, id: pictureId(body), type };
          this.seen.set(path, known);
        }
        const introPath = await introOf(path);
        const intro = introPath ? await this.video(introPath, false) : null;
        file = { id: known.id, type: known.type, path, ...(intro ? { intro } : {}) };
      }
      if (!file || files.some((one) => one.id === file!.id)) continue;
      files.push(file);
      if (path === link || (real && (await realpath(path).catch(() => null)) === real)) current = file.id;
    }
    // Only these are served, from where they are.
    const served = new Map<string, { path: string; type: VideoType }>();
    for (const file of files) {
      if (file.video) served.set(file.id, { path: file.path, type: file.type as VideoType });
      if (file.intro) served.set(file.intro.id, { path: file.intro.path, type: file.intro.type });
    }
    this.videos.offer(served);
    const intros = !existsSync(join(this.stateDir, "toggles", "background-intros-off"));
    return { theme, current, files, intros, introDue: this.introDue };
  }

  // Where the videos are served, once there are any.
  private async serve(found: FoundBackgrounds): Promise<string | null> {
    if (this.serving || !found.files.some((file) => file.video || file.intro)) return this.serving;
    this.serving = await this.videos.listen().catch((error: Error) => {
      this.options.log?.(`themes: can't serve the theme's videos: ${error.message}`);
      return null;
    });
    return this.serving;
  }

  // An intro is due once in each TV session, as Omarchy plays one at each
  // login: the first time this one looks, and not again if the screen
  // daemon starts again in the same session.
  private async sessionIntro(): Promise<void> {
    const session = this.options.session === undefined ? (process.env.HYPRLAND_INSTANCE_SIGNATURE ?? null) : this.options.session;
    if (!session) return;
    const marker = join(this.options.home, ".local", "state", "agentv", "background-intro.session");
    if ((await readFile(marker, "utf8").catch(() => "")).trim() === session) return;
    await mkdir(dirname(marker), { recursive: true }).catch(() => {});
    await writeFile(marker, `${session}\n`).catch(() => {});
    this.introDue = token();
  }

  // The theme's backgrounds to the daemon: what there is and which one
  // Omarchy shows, with each picture's intro and each video's still, then
  // each picture the daemon asks for.
  private async sendBackgrounds(): Promise<boolean> {
    const found = await this.backgrounds();
    if (!found) return true;
    const serve = await this.serve(found);
    const daemon = this.options.daemon ?? "http://127.0.0.1:3000/";
    const facts = (video: VideoInfo) => ({ codec: video.codec, width: video.width, height: video.height });
    const files = found.files.map((file) => ({
      id: file.id,
      type: file.type,
      ...(file.intro ? { intro: { id: file.intro.id, type: file.intro.type, ...facts(file.intro) } } : {}),
      ...(file.video ? { video: { ...facts(file.video), poster: { id: file.video.poster.id, type: file.video.poster.type } } } : {}),
    }));
    const response = await fetch(`${daemon}api/backgrounds/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: found.theme, current: found.current, files, intros: found.intros, introDue: found.introDue, serve }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    const answer = (await response?.json().catch(() => null)) as { need?: string[] } | null;
    if (!response?.ok || !Array.isArray(answer?.need)) {
      this.options.log?.(`themes: the daemon didn't take ${found.theme}'s backgrounds (${response?.status ?? "not there"})`);
      return false;
    }
    let all = true;
    for (const id of answer.need) {
      const still = found.files.find((one) => one.video?.poster.id === id)?.video?.poster.body;
      const file = found.files.find((one) => one.id === id && !one.video);
      const body = still ?? (file && (await readFile(file.path).catch(() => null)));
      const sent = body
        ? await fetch(`${daemon}api/backgrounds/theme/${id}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(body), signal: AbortSignal.timeout(60_000) }).catch(() => null)
        : null;
      if (!sent?.ok) {
        all = false;
        this.options.log?.(`themes: a background of ${found.theme} didn't reach the daemon (${sent?.status ?? "not sent"})`);
      }
    }
    return all;
  }

  private async send(themes: FoundTheme[]): Promise<boolean> {
    const response = await fetch(`${this.options.daemon ?? "http://127.0.0.1:3000/"}api/themes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themes }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response?.ok) this.options.log?.(`themes: the daemon didn't take the list (${response?.status ?? "not there"})`);
    return Boolean(response?.ok);
  }

  // At the start, until the daemon takes it.
  async start(): Promise<void> {
    await this.sessionIntro();
    this.watch();
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      if (await this.push()) return;
      await new Promise((resolve) => setTimeout(resolve, this.options.retryMs ?? RETRY_MS));
    }
  }

  // Follows the themes folder, the folder it appears in, the theme Omarchy
  // has now, and Omarchy's switches, its intros' among them.
  watch(): void {
    this.follow();
  }

  private soon(): void {
    clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.follow();
      void this.push();
    }, this.options.settleMs ?? SETTLE_MS);
  }

  // A watch on each of those folders that's there now, made again after
  // each change, since one that went and came back needs a new one.
  private follow(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const dir of [this.installedDir, join(this.options.home, ".config", "omarchy"), join(this.stateDir, "current"), this.stateDir, join(this.stateDir, "toggles")]) {
      try {
        const watcher = watch(dir, () => this.soon());
        watcher.on("error", () => watcher.close());
        this.watchers.set(dir, watcher);
      } catch {
        // Not there yet: found at the next change.
      }
    }
  }

  stop(): void {
    clearTimeout(this.settle);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    void this.videos.close();
  }
}
