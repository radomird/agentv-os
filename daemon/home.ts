// What the home screen shows, kept by the daemon (ADR-015, ADR-016, ADR-018):
// the apps on the box and who made each one, each viewer's layout, the TV's
// own settings, the content of each tile from its app's tile(), and the
// colours of the Omarchy theme. The launcher draws it; nothing an app writes
// runs on the home screen.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePackage, type Manifest, type Tier } from "../apps/contract/manifest.ts";
import { pin, problem, type Placed, type Size } from "../launcher/layout.ts";
import { AppError, AppHost, allowedOrigins, type Viewer } from "./apps/loader.ts";
import { readInstalled } from "./apps/install.ts";

export interface SizeChoice {
  size: Size;
  label: string;
}

export interface AppSummary {
  id: string;
  name: string;
  version: string;
  tier: Tier | "built-in";
  maker: string; // who made it, in plain words: app details only (ADR-018)
  owner?: string; // the brand note, for an app named after someone else's brand
  description: string;
  category: string;
  runtime: string;
  icon?: string;
  sizes: SizeChoice[];
  reach: string[]; // what it can reach, for app details
  needsSetup: boolean; // a setup field it needs isn't filled in yet
}

export interface TvSettings {
  sound: { on: boolean; volume: number };
  reduceMotion: boolean;
  idleMinutes: number;
}

const DEFAULTS: TvSettings = { sound: { on: true, volume: 0.6 }, reduceMotion: false, idleMinutes: 10 };

// The launcher's own tile, to all apps (board 19). Its id has no dot, so no
// app can take it.
export const APPS_TILE = "apps";

const TILE_MIN = 5;
const TILE_DEFAULT = 30;
const IMAGE_MAX = 5 * 1024 * 1024;
const TMDB_IMAGES = "https://image.tmdb.org";
const COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[0-9.%\s,]+\))$/;

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  const next = `${path}.next`;
  await writeFile(next, `${JSON.stringify(data, null, 2)}\n`);
  await rename(next, path);
}

// The theme's colours as CSS custom properties, and nothing else: a theme's
// launcher.css can only change colours.
export function cleanTheme(css: string): string {
  const lines: string[] = [];
  for (const match of css.slice(0, 16 * 1024).matchAll(/--([a-z][a-z0-9-]{0,40})\s*:\s*([^;{}]+?)\s*;/g)) {
    if (COLOR.test(match[2])) lines.push(`  --${match[1]}: ${match[2]};`);
  }
  return lines.length ? `:root {\n${lines.join("\n")}\n}\n` : "";
}

export function sizesOf(manifest: Manifest): SizeChoice[] {
  const tiles = manifest.tv.tiles ?? {};
  const sizes: SizeChoice[] = [{ size: "s", label: tiles.s ?? "logo" }];
  const tile = manifest.tv.capabilities.includes("tile");
  const playback = manifest.tv.capabilities.includes("playback");
  if (tiles.m && (tile || playback)) sizes.push({ size: "m", label: tiles.m });
  else if (playback) sizes.push({ size: "m", label: "continue" });
  if (tiles.l && tile) sizes.push({ size: "l", label: tiles.l });
  return sizes;
}

function maker(tier: AppSummary["tier"], manifest: Manifest): string {
  if (tier === "built-in") return "built in";
  if (tier === "official") return "official · made by agentv";
  if (tier === "community") return `community · made by ${manifest.author}`;
  return "made by your agent · on this tv only";
}

export class Home {
  private appsDir: string;
  private state: string;
  private hosts = new Map<string, AppHost>();
  private tiles = new Map<string, { at: number; tile: unknown }>();
  private log: (line: string) => void;

  constructor(options: { appsDir: string; state: string; log?: (line: string) => void }) {
    this.appsDir = options.appsDir;
    this.state = options.state;
    this.log = options.log ?? (() => {});
  }

  // --- The viewer -------------------------------------------------------

  // Profiles come with stage 4. Until then the TV has one viewer, the person
  // the box belongs to: the first ordinary user, as first boot finds them.
  async viewer(): Promise<Viewer & { name: string }> {
    const passwd = await readFile(process.env.AGENTV_PASSWD ?? "/etc/passwd", "utf8").catch(() => "");
    for (const line of passwd.split("\n")) {
      const [name, , uid, , , , shell] = line.split(":");
      if (Number(uid) >= 1000 && Number(uid) < 60000 && !/nologin|false/.test(shell ?? "")) {
        return { id: name, name, role: "adult" };
      }
    }
    return { id: "you", name: "you", role: "adult" };
  }

  // --- The apps ---------------------------------------------------------

  // Checked when installed.json changes, not on every request.
  private checked?: { mtime: number; found: { manifest: Manifest; tier: Tier; dir: string }[] };

  async manifests(): Promise<{ manifest: Manifest; tier: Tier; dir: string }[]> {
    const mtime = await stat(join(this.appsDir, "installed.json")).then((info) => info.mtimeMs, () => 0);
    if (this.checked?.mtime === mtime && mtime !== 0) return this.checked.found;
    const record = await readInstalled(this.appsDir);
    const found = [];
    for (const app of Object.values(record)) {
      const dir = join(this.appsDir, app.id);
      // Checked again as it's read: a package changed on disk isn't shown.
      const { manifest } = validatePackage(dir, app.tier);
      if (manifest) found.push({ manifest, tier: app.tier, dir });
      else this.log(`${app.id} doesn't pass the app contract's checks any more, so it isn't shown`);
    }
    this.checked = { mtime, found };
    return found;
  }

  async apps(): Promise<AppSummary[]> {
    const settings = await this.appSettings();
    return (await this.manifests()).map(({ manifest, tier }) => {
      const values = settings[manifest.id] ?? {};
      const fields = (manifest.tv.setup ?? []).filter((step) => step.type === "field");
      const reach = [...allowedOrigins(manifest, values)].map((origin) => origin.replace(/^https?:\/\//, ""));
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        tier,
        maker: maker(tier, manifest),
        owner: `${manifest.name.toLowerCase()} and its logo belong to their owner, who didn't make or endorse this app.`,
        description: manifest.description,
        category: manifest.tv.category,
        runtime: manifest.tv.runtime,
        icon: manifest.tv.icon ? `/api/apps/${manifest.id}/icon` : undefined,
        sizes: sizesOf(manifest),
        reach: reach.length ? reach : manifest.tv.runtime === "native" ? ["its own window on this tv"] : ["nothing yet"],
        needsSetup: fields.some((field) => field.type === "field" && !values[field.key]),
      };
    });
  }

  // Whether each installed app still loads, for the check after an update
  // (ADR-025): its package passes the contract's checks, and its module
  // starts in a worker of its own, apart from the one its tiles use.
  async check(): Promise<{ id: string; name: string; ok: boolean; error?: string }[]> {
    const results = [];
    const settings = await this.appSettings();
    for (const app of Object.values(await readInstalled(this.appsDir))) {
      const dir = join(this.appsDir, app.id);
      const { manifest, problems } = validatePackage(dir, app.tier);
      if (!manifest) {
        results.push({ id: app.id, name: app.name, ok: false, error: problems[0] ?? "it doesn't pass the app contract's checks" });
        continue;
      }
      if (!manifest.entryPoints.tvApp) {
        results.push({ id: app.id, name: manifest.name, ok: true });
        continue;
      }
      const host = new AppHost({ dir, manifest, settings: settings[app.id] ?? {}, log: this.log });
      try {
        await host.start();
        results.push({ id: app.id, name: manifest.name, ok: true });
      } catch (error) {
        results.push({ id: app.id, name: manifest.name, ok: false, error: (error as AppError).message });
      } finally {
        host.stop();
      }
    }
    return results;
  }

  async appSettings(): Promise<Record<string, Record<string, string>>> {
    return readJson(join(this.state, "app-settings.json"), {});
  }

  async icon(id: string): Promise<{ path: string } | null> {
    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    return found?.manifest.tv.icon ? { path: join(found.dir, found.manifest.tv.icon) } : null;
  }

  // What opening an app means, for the screen daemon: its home address with
  // its setup fields filled in, or its command.
  async launch(id: string): Promise<{ runtime: "web"; url: string } | { runtime: "native"; exec: string[] } | null> {
    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    if (!found) return null;
    const tv = found.manifest.tv;
    if (tv.runtime === "native") return { runtime: "native", exec: tv.exec ?? [] };
    const values = (await this.appSettings())[id] ?? {};
    const url = (tv.homeUrl ?? "").replace(/^\{([A-Za-z][A-Za-z0-9]*)\}/, (_, key: string) => (values[key] ?? "").replace(/\/+$/, ""));
    try {
      const parsed = new URL(url);
      if (!allowedOrigins(found.manifest, values).has(parsed.origin)) return null;
      return { runtime: "web", url: parsed.href };
    } catch {
      return null;
    }
  }

  // --- Layouts and settings ---------------------------------------------

  private async sizesById(): Promise<Map<string, Size[]>> {
    const sizes = new Map<string, Size[]>([[APPS_TILE, ["s"]]]);
    for (const app of await this.apps()) sizes.set(app.id, app.sizes.map((choice) => choice.size));
    return sizes;
  }

  // The viewer's layout. Until they change it, every app is pinned small in
  // the order it came, with all apps after them. Tiles of apps that have gone
  // are dropped.
  async layout(viewer: string): Promise<Placed[]> {
    const saved = (await readJson<Record<string, Placed[]>>(join(this.state, "layouts.json"), {}))[viewer];
    const sizes = await this.sizesById();
    if (saved) {
      const kept = saved.filter((tile) => sizes.has(tile.id));
      if (!problem(kept, (id) => sizes.get(id))) return kept;
    }
    let layout: Placed[] = [];
    for (const id of [...sizes.keys()].filter((id) => id !== APPS_TILE).concat(APPS_TILE)) {
      layout = pin(layout, id) ?? layout;
    }
    return layout;
  }

  async saveLayout(viewer: string, layout: unknown): Promise<string | null> {
    const sizes = await this.sizesById();
    const why = problem(layout, (id) => sizes.get(id));
    if (why) return why;
    await mkdir(this.state, { recursive: true });
    const all = await readJson<Record<string, Placed[]>>(join(this.state, "layouts.json"), {});
    all[viewer] = (layout as Placed[]).map(({ id, x, y, size }) => ({ id, x, y, size }));
    await writeJson(join(this.state, "layouts.json"), all);
    return null;
  }

  async settings(): Promise<TvSettings> {
    const saved = await readJson<Partial<TvSettings>>(join(this.state, "settings.json"), {});
    return { ...DEFAULTS, ...saved, sound: { ...DEFAULTS.sound, ...(saved.sound ?? {}) } };
  }

  async saveSettings(change: unknown): Promise<string | null> {
    if (typeof change !== "object" || change === null) return "settings are an object";
    const next = await this.settings();
    const c = change as Partial<TvSettings>;
    if (c.sound !== undefined) {
      if (typeof c.sound.on === "boolean") next.sound.on = c.sound.on;
      if (typeof c.sound.volume === "number" && c.sound.volume >= 0 && c.sound.volume <= 1) next.sound.volume = c.sound.volume;
    }
    if (typeof c.reduceMotion === "boolean") next.reduceMotion = c.reduceMotion;
    if (typeof c.idleMinutes === "number" && [5, 10, 15, 30, 60].includes(c.idleMinutes)) next.idleMinutes = c.idleMinutes;
    await mkdir(this.state, { recursive: true });
    await writeJson(join(this.state, "settings.json"), next);
    return null;
  }

  // --- Tiles ------------------------------------------------------------

  // The content of an app's tile at a size, from its tile(), at most every
  // refreshMins (ADR-016). A tile that doesn't answer in time keeps its last
  // content; with none it's null, and the launcher draws it small.
  async tile(id: string, size: Size, viewer: Viewer): Promise<unknown> {
    const key = `${viewer.id}:${id}:${size}`;
    const cached = this.tiles.get(key);
    const refresh = Math.max(TILE_MIN, Number((cached?.tile as { refreshMins?: number })?.refreshMins) || TILE_DEFAULT);
    if (cached && Date.now() - cached.at < refresh * 60_000) return cached.tile;

    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    if (!found || !found.manifest.tv.capabilities.includes("tile")) return null;
    let host = this.hosts.get(id);
    if (!host) {
      host = new AppHost({ dir: found.dir, manifest: found.manifest, settings: (await this.appSettings())[id] ?? {}, log: this.log });
      this.hosts.set(id, host);
    }
    try {
      const tile = await host.call(viewer, "tile", size);
      this.tiles.set(key, { at: Date.now(), tile });
      return tile;
    } catch (error) {
      this.log(`${id}'s ${size} tile: ${(error as AppError).message}`);
      return cached?.tile ?? null;
    }
  }

  // An image a tile shows, from the app's own origins or TMDB, kept on the box.
  async image(id: string, url: string): Promise<{ type: string; body: Buffer } | null> {
    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    if (!found) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const allowed = allowedOrigins(found.manifest, (await this.appSettings())[id] ?? {});
    if (!allowed.has(parsed.origin) && parsed.origin !== TMDB_IMAGES) return null;

    const dir = join(this.state, "images");
    const name = createHash("sha256").update(parsed.href).digest("hex");
    const cached = await readJson<{ type: string } | null>(join(dir, `${name}.json`), null);
    if (cached) return { type: cached.type, body: await readFile(join(dir, name)) };

    const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const type = response?.headers.get("content-type") ?? "";
    if (!response?.ok || !/^image\/(png|jpeg|webp|gif|avif)$/.test(type)) return null;
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > IMAGE_MAX) return null;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), body);
    await writeJson(join(dir, `${name}.json`), { type, url: parsed.href });
    return { type, body };
  }

  // --- Theme ------------------------------------------------------------

  async theme(): Promise<string> {
    return readFile(join(this.state, "theme.css"), "utf8").catch(() => "");
  }

  async saveTheme(css: string): Promise<boolean> {
    const clean = cleanTheme(css);
    if (!clean) return false;
    await mkdir(this.state, { recursive: true });
    await writeFile(join(this.state, "theme.css"), clean);
    return true;
  }

  stop(): void {
    for (const host of this.hosts.values()) host.stop();
  }
}

