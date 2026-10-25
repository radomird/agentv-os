// What the home screen shows, kept by the daemon (ADR-015, ADR-016, ADR-018):
// the apps on the box and who made each one, each viewer's layout, the TV's
// own settings, the content of each tile from its app's tile(), and the
// colours of the Omarchy theme. The launcher draws it; nothing an app writes
// runs on the home screen.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePackage, type Manifest, type Tier } from "../apps/contract/manifest.ts";
import { pin, problem, type Placed, type Size } from "../launcher/layout.ts";
import { AppError, AppHost, allowedOrigins, type Viewer } from "./apps/loader.ts";
import { readInstalled } from "./apps/install.ts";
import { boxZone, cities, cityOf, placeSettings, type City } from "./place.ts";

// Where an app came from: the signed index, this box's agent, or AgenTV
// itself, for the built-ins in apps/builtin/ (ADR-015, ADR-017).
export type AppTier = Tier | "built-in";

export interface SizeChoice {
  size: Size;
  label: string;
}

export interface AppSummary {
  id: string;
  name: string;
  version: string;
  tier: AppTier;
  maker: string; // who made it, in plain words: app details only (ADR-018)
  owner?: string; // the brand note, for an app named after someone else's brand
  description: string;
  category: string;
  runtime: string;
  icon?: string;
  sizes: SizeChoice[];
  reach: string[]; // what it can reach, for app details
  needsSetup: boolean; // a setup field it needs isn't filled in yet
  credit?: string; // whose data it shows, for app details: "weather data from met norway"
}

// What Settings → Weather shows and changes: the city the forecast is for,
// and the cities it can be.
export interface WeatherPlace {
  zone: string;
  name: string;
  lat?: number; // rounded, as MET gets them
  lon?: number;
  units: "c" | "f";
  chosen: boolean; // false: the box's own time zone
  cities: { zone: string; name: string }[];
}

// Whose data a built-in app shows, as its terms ask.
const CREDITS: Record<string, string> = {
  "agentv.weather": "weather data from met norway, under cc by 4.0",
};

const WEATHER = "agentv.weather";
const CLOCK = "agentv.clock";

export interface TvSettings {
  sound: { on: boolean; volume: number };
  reduceMotion: boolean;
  idleMinutes: number;
  // Settings → Updates: install an update each night on its own, off by
  // default (ADR-025, Q79).
  updateOvernight: boolean;
}

const DEFAULTS: TvSettings = { sound: { on: true, volume: 0.6 }, reduceMotion: false, idleMinutes: 10, updateOvernight: false };

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

function maker(tier: AppTier, manifest: Manifest): string {
  if (tier === "built-in") return "built in";
  if (tier === "official") return "official · made by agentv";
  if (tier === "community") return `community · made by ${manifest.author}`;
  return "made by your agent · on this tv only";
}

export interface HomeOptions {
  appsDir: string; // the box's apps: /var/lib/agentv/apps
  state: string; // the daemon's own state
  builtins?: string; // AgenTV's own apps: /usr/share/agentv/apps/builtin
  userAgent?: string; // what every app's requests say they are
  log?: (line: string) => void;
}

export class Home {
  private appsDir: string;
  private state: string;
  private builtins?: string;
  private userAgent?: string;
  private hosts = new Map<string, AppHost>();
  private tiles = new Map<string, { at: number; tile: unknown; settings: string }>();
  private log: (line: string) => void;

  constructor(options: HomeOptions) {
    this.appsDir = options.appsDir;
    this.state = options.state;
    this.builtins = options.builtins;
    this.userAgent = options.userAgent;
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

  // AgenTV's own apps, which come with the agentv package: checked once,
  // since the package only changes with an update, which restarts the daemon.
  private builtin?: Promise<{ manifest: Manifest; tier: AppTier; dir: string }[]>;

  builtinApps(): Promise<{ manifest: Manifest; tier: AppTier; dir: string }[]> {
    this.builtin ??= (async () => {
      if (!this.builtins) return [];
      const names = await readdir(this.builtins).catch(() => [] as string[]);
      const found = [];
      for (const name of names.sort()) {
        const dir = join(this.builtins, name);
        const { manifest, problems } = validatePackage(dir, "official");
        if (manifest?.tv.runtime === "builtin") found.push({ manifest, tier: "built-in" as const, dir });
        else this.log(`the built-in ${name} isn't shown: ${problems[0] ?? "it doesn't say it's built in"}`);
      }
      return found;
    })();
    return this.builtin;
  }

  // Checked when installed.json changes, not on every request.
  private checked?: { mtime: number; found: { manifest: Manifest; tier: AppTier; dir: string }[] };

  async manifests(): Promise<{ manifest: Manifest; tier: AppTier; dir: string }[]> {
    const builtins = await this.builtinApps();
    const mtime = await stat(join(this.appsDir, "installed.json")).then((info) => info.mtimeMs, () => 0);
    if (this.checked?.mtime === mtime && mtime !== 0) return [...builtins, ...this.checked.found];
    const record = await readInstalled(this.appsDir);
    const found = [];
    for (const app of Object.values(record)) {
      const dir = join(this.appsDir, app.id);
      // Checked again as it's read: a package changed on disk isn't shown.
      const { manifest } = validatePackage(dir, app.tier);
      if (!manifest) {
        this.log(`${app.id} doesn't pass the app contract's checks any more, so it isn't shown`);
      } else if (manifest.tv.runtime === "builtin" || builtins.some((b) => b.manifest.id === manifest.id)) {
        this.log(`${app.id} isn't shown: only AgenTV itself brings built-in apps`);
      } else {
        found.push({ manifest, tier: app.tier, dir });
      }
    }
    this.checked = { mtime, found };
    return [...builtins, ...found];
  }

  async apps(): Promise<AppSummary[]> {
    const settings = await this.appSettings();
    return (await this.manifests()).map(({ manifest, tier }) => {
      const values = settings[manifest.id] ?? {};
      const builtin = tier === "built-in";
      const fields = (manifest.tv.setup ?? []).filter((step) => step.type === "field");
      const reach = [...allowedOrigins(manifest, values)].map((origin) => origin.replace(/^https?:\/\//, ""));
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        tier,
        maker: maker(tier, manifest),
        owner: builtin ? undefined : `${manifest.name.toLowerCase()} and its logo belong to their owner, who didn't make or endorse this app.`,
        description: manifest.description,
        category: manifest.tv.category,
        runtime: manifest.tv.runtime,
        icon: manifest.tv.icon ? `/api/apps/${manifest.id}/icon` : undefined,
        sizes: sizesOf(manifest),
        reach: reach.length ? reach : manifest.tv.runtime === "native" ? ["its own window on this tv"] : builtin ? ["nothing outside this tv"] : ["nothing yet"],
        needsSetup: fields.some((field) => field.type === "field" && !values[field.key]),
        credit: builtin ? CREDITS[manifest.id] : undefined,
      };
    });
  }

  // Whether each installed app still loads, for the check after an update
  // (ADR-025): its package passes the contract's checks, and its module
  // starts in a worker of its own, apart from the one its tiles use.
  async check(): Promise<{ id: string; name: string; ok: boolean; error?: string }[]> {
    const results = [];
    const settings = await this.appSettings();
    // The built-ins first: they come with the update itself.
    for (const { manifest, dir } of await this.builtinApps()) {
      const host = new AppHost({ dir, manifest, settings: settings[manifest.id] ?? {}, userAgent: this.userAgent, log: this.log });
      try {
        await host.start();
        results.push({ id: manifest.id, name: manifest.name, ok: true });
      } catch (error) {
        results.push({ id: manifest.id, name: manifest.name, ok: false, error: (error as AppError).message });
      } finally {
        host.stop();
      }
    }
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
      const host = new AppHost({ dir, manifest, settings: settings[app.id] ?? {}, userAgent: this.userAgent, log: this.log });
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

  // Each app's setup values. The built-ins get where the box is from the
  // daemon instead (place.ts): Clock the box's own time zone, and Weather
  // that, or the city Settings → Weather picked.
  async appSettings(): Promise<Record<string, Record<string, string>>> {
    const saved = await readJson<Record<string, Record<string, string>>>(join(this.state, "app-settings.json"), {});
    const zone = await boxZone();
    const box = placeSettings(zone, await cityOf(zone));
    const weather = saved[WEATHER] ?? {};
    const picked = weather.zone ? await cityOf(weather.zone) : null;
    const units = weather.units === "c" || weather.units === "f" ? weather.units : undefined;
    // A test points the forecast at its own server, with a package whose
    // origins say so; nothing on a box sets forecastUrl.
    const test: Record<string, string> = weather.forecastUrl ? { forecastUrl: weather.forecastUrl } : {};
    return {
      ...saved,
      [CLOCK]: box,
      [WEATHER]: { ...(picked ? placeSettings(picked.zone, picked, units) : { ...box, ...(units ? { units } : {}) }), ...test },
    };
  }

  // --- Settings → Weather (ADR-015) -------------------------------------

  async weather(): Promise<WeatherPlace> {
    const settings = (await this.appSettings())[WEATHER];
    const saved = (await readJson<Record<string, Record<string, string>>>(join(this.state, "app-settings.json"), {}))[WEATHER] ?? {};
    const zone = settings.timeZone;
    // The cities in the same part of the world as the one shown, by name, or
    // every city for a zone like UTC, which has none.
    const region = zone.split("/")[0];
    const all = [...(await cities()).values()].sort((a, b) => a.name.localeCompare(b.name));
    const near = all.filter((city: City) => city.zone.split("/")[0] === region);
    const list = (near.length ? near : all).map((city) => ({ zone: city.zone, name: city.name }));
    return {
      zone,
      name: settings.place ?? "",
      lat: settings.lat ? Number(settings.lat) : undefined,
      lon: settings.lon ? Number(settings.lon) : undefined,
      units: settings.units === "f" ? "f" : "c",
      chosen: Boolean(saved.zone),
      cities: list,
    };
  }

  // Picks the weather's city (a zone from zone.tab, or null for the box's
  // own) and its units (c, f, or null for the country's).
  async saveWeather(change: unknown): Promise<string | null> {
    if (typeof change !== "object" || change === null) return "send the city's zone or the units";
    const c = change as { zone?: unknown; units?: unknown };
    const all = await readJson<Record<string, Record<string, string>>>(join(this.state, "app-settings.json"), {});
    const next = { ...(all[WEATHER] ?? {}) };
    if (c.zone !== undefined) {
      if (c.zone === null) delete next.zone;
      else if (typeof c.zone === "string" && (await cityOf(c.zone))) next.zone = c.zone;
      else return "that isn't a city the weather knows";
    }
    if (c.units !== undefined) {
      if (c.units === null) delete next.units;
      else if (c.units === "c" || c.units === "f") next.units = c.units;
      else return "the units are c or f";
    }
    all[WEATHER] = next;
    await mkdir(this.state, { recursive: true });
    await writeJson(join(this.state, "app-settings.json"), all);
    return null;
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
  // the order it came, the built-ins first and all apps last. Tiles of apps
  // that have gone are dropped. A built-in is pinned for each viewer once,
  // when there's room (ADR-015), so a box from before it gets it too; one the
  // viewer unpins stays off.
  async layout(viewer: string): Promise<Placed[]> {
    const saved = (await readJson<Record<string, Placed[]>>(join(this.state, "layouts.json"), {}))[viewer];
    const sizes = await this.sizesById();
    const builtins = (await this.builtinApps()).map(({ manifest }) => manifest.id);
    const pinned = await readJson<Record<string, string[]>>(join(this.state, "builtins-pinned.json"), {});
    const fresh = builtins.filter((id) => !(pinned[viewer] ?? []).includes(id));
    if (saved) {
      let kept = saved.filter((tile) => sizes.has(tile.id));
      if (!problem(kept, (id) => sizes.get(id))) {
        if (fresh.length === 0) return kept;
        for (const id of fresh) kept = pin(kept, id) ?? kept;
        await this.markPinned(viewer, fresh, kept);
        return kept;
      }
    }
    let layout: Placed[] = [];
    for (const id of [...sizes.keys()].filter((id) => id !== APPS_TILE).concat(APPS_TILE)) {
      layout = pin(layout, id) ?? layout;
    }
    if (fresh.length) await this.markPinned(viewer, fresh, saved ? layout : undefined);
    return layout;
  }

  // Notes that these built-ins have had their turn on the viewer's home,
  // and keeps the layout they were pinned to, when there is one to keep.
  private async markPinned(viewer: string, ids: string[], layout?: Placed[]): Promise<void> {
    await mkdir(this.state, { recursive: true });
    if (layout) {
      const all = await readJson<Record<string, Placed[]>>(join(this.state, "layouts.json"), {});
      all[viewer] = layout;
      await writeJson(join(this.state, "layouts.json"), all);
    }
    const pinned = await readJson<Record<string, string[]>>(join(this.state, "builtins-pinned.json"), {});
    pinned[viewer] = [...new Set([...(pinned[viewer] ?? []), ...ids])];
    await writeJson(join(this.state, "builtins-pinned.json"), pinned);
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
    if (typeof c.updateOvernight === "boolean") next.updateOvernight = c.updateOvernight;
    await mkdir(this.state, { recursive: true });
    await writeJson(join(this.state, "settings.json"), next);
    return null;
  }

  // --- Tiles ------------------------------------------------------------

  // The content of an app's tile at a size, from its tile(), at most every
  // refreshMins (ADR-016), and again at once when its settings change, such
  // as the weather's city or the box's time zone. A tile that doesn't answer
  // in time keeps its last content; with none it's null, and the launcher
  // draws it small.
  async tile(id: string, size: Size, viewer: Viewer): Promise<unknown> {
    const key = `${viewer.id}:${id}:${size}`;
    const settings = (await this.appSettings())[id] ?? {};
    const signature = JSON.stringify(settings);
    const cached = this.tiles.get(key);
    const refresh = Math.max(TILE_MIN, Number((cached?.tile as { refreshMins?: number })?.refreshMins) || TILE_DEFAULT);
    if (cached && cached.settings === signature && Date.now() - cached.at < refresh * 60_000) return cached.tile;

    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    if (!found || !found.manifest.tv.capabilities.includes("tile")) return null;
    let host = this.hosts.get(id);
    if (!host) {
      host = new AppHost({ dir: found.dir, manifest: found.manifest, settings, userAgent: this.userAgent, log: this.log });
      this.hosts.set(id, host);
    }
    host.setSettings(settings);
    try {
      const tile = await host.call(viewer, "tile", size);
      this.tiles.set(key, { at: Date.now(), tile, settings: signature });
      return tile;
    } catch (error) {
      this.log(`${id}'s ${size} tile: ${(error as AppError).message}`);
      return cached?.settings === signature ? cached.tile : null;
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

