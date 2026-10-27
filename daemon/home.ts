// What the home screen shows, kept by the daemon (ADR-015, ADR-016, ADR-018):
// the apps on the box and who made each one, each viewer's layout, the TV's
// own settings, the content of each tile from its app's tile(), and the
// colours of the Omarchy theme. The launcher draws it; nothing an app writes
// runs on the home screen.

import { createHash } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePackage, type Manifest, type Tier } from "../apps/contract/manifest.ts";
import { pagePermissions } from "../apps/contract/page.ts";
import { pin, problem, type Placed, type Size } from "../launcher/layout.ts";
import { AppError, AppHost, allowedOrigins, type Viewer } from "./apps/loader.ts";
import { readInstalled } from "./apps/install.ts";
import type { Ledger, WatchRow } from "./ledger.ts";
import { boxZone, cities, cityOf, placeSettings, type City } from "./place.ts";
import { siteIcon } from "./site-icon.ts";

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
  // Its service wants a sign-in (ADR-032): the app said so the last time it
  // was asked, or it has a sign-in step and hasn't been asked yet.
  signIn?: "needed";
  credit?: string; // whose data it shows, for app details: "weather data from met norway"
  // A child's profile can open it (ADR-009): an adult ticked it, or its
  // manifest says it's child-safe and no one unticked it.
  forChildren: boolean;
  // An app with profiles: its service's own profiles, once it has listed
  // them, and the one an adult picked for children (ADR-009).
  profiles?: ServiceProfiles;
}

// An app's service's own profiles, as it listed them, and the one an adult
// picked for children, which a child watching opens. Null until one is
// picked.
export interface ServiceProfiles {
  names: string[];
  forChildren: string | null;
}

const PROFILE_NAMES_MAX = 20;
const PROFILE_NAME_MAX = 60;

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

// An app's own setup, for its setup page: its fields and whether a sign-in
// comes after them.
export interface AppSetup {
  id: string;
  name: string;
  fields: { key: string; label: string; value: string; address: boolean }[];
  signIn: boolean;
}

// The fields an app's origins or home page start with, as {serverUrl}.
function addressKeys(manifest: Manifest): Set<string> {
  const keys = new Set<string>();
  for (const template of [...(manifest.tv.origins ?? []), manifest.tv.homeUrl ?? ""]) {
    const key = /^\{([A-Za-z][A-Za-z0-9]*)\}/.exec(template)?.[1];
    if (key) keys.add(key);
  }
  return keys;
}

// A server's address as typed, made whole: http when no scheme is given, no
// sign-in in it, nothing after the path, and no slash at the end. Null when
// it isn't one.
export function asAddress(typed: string): string | null {
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// Whose data a built-in app shows, as its terms ask.
const CREDITS: Record<string, string> = {
  "agentv.weather": "weather data from met norway, under cc by 4.0",
};

const WEATHER = "agentv.weather";
const CLOCK = "agentv.clock";
// The built-ins on every home from the start (ADR-015). Music joins them
// when it's the household's goal, which setup asks (ADR-017); otherwise it's
// in Apps.
const PINNED = [CLOCK, WEATHER];
const MUSIC_APP = "agentv.music";

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

// What a page app reaches, as its details say (ADR-043): what it declared,
// or nothing outside this TV.
function pageReach(manifest: Manifest): string[] {
  const { declared } = pagePermissions(manifest);
  return declared.length ? declared : ["nothing outside this tv"];
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
  ledger?: () => Ledger; // for the free continue tile (ADR-016)
  // Who's watching now (daemon/profiles.ts). Without it, the box's owner.
  viewer?: () => Promise<Viewer & { name: string; avatar?: string }>;
  // What a page app's tile shows: what it last set (ADR-043).
  pageTile?: (id: string) => Promise<unknown>;
  // What the TV is for, from setup (ADR-006): Music is on home from the
  // start when it's music.
  goal?: () => Promise<string | null>;
  // Something home shows changed by itself: a site's icon came, say.
  changed?: (event: string) => void;
  log?: (line: string) => void;
}

// How long before a site's icon that didn't come is asked for again.
const ICON_RETRY_MS = 6 * 3600_000;

// The free continue tile's entries: how far in, and how long is left.
function caption(row: WatchRow): string {
  const what = [row.season !== null ? `S${row.season}` : "", row.episode !== null ? `E${row.episode}` : ""].filter(Boolean).join(" ") || row.kind;
  if (row.duration_s === null || row.position_s === null || row.duration_s <= 0) return what;
  const left = Math.max(0, Math.ceil((row.duration_s - row.position_s) / 60));
  return left > 0 ? `${what} · ${left} min left` : `${what} · watched`;
}

// A medium "continue" tile from the ledger, for an app with playback and no
// tile() of its own (ADR-016, S3.10): its newest rows for the viewer, each
// an item to open where it was. Null with nothing in the ledger yet, and the
// tile shows the app's logo.
export function continueTile(rows: WatchRow[]): unknown {
  if (rows.length === 0) return null;
  return {
    headline: { label: "continue" },
    entries: rows.map((row) => ({
      label: row.title,
      caption: caption(row),
      progress: row.duration_s && row.position_s !== null ? Math.min(1, row.position_s / row.duration_s) : undefined,
      item: {
        id: `ledger:${row.id}`,
        kind: row.kind,
        title: row.title,
        ...(row.season !== null ? { season: row.season } : {}),
        ...(row.episode !== null ? { episode: row.episode } : {}),
      },
    })),
  };
}

export class Home {
  private appsDir: string;
  private state: string;
  private builtins?: string;
  private userAgent?: string;
  private ledger?: () => Ledger;
  private hosts = new Map<string, AppHost>();
  private tiles = new Map<string, { at: number; tile: unknown; settings: string }>();
  private iconTried = new Map<string, number>();
  private changed: (event: string) => void;
  private log: (line: string) => void;
  private viewerOf?: () => Promise<Viewer & { name: string; avatar?: string }>;
  private goal?: () => Promise<string | null>;
  private pageTile?: (id: string) => Promise<unknown>;

  constructor(options: HomeOptions) {
    this.appsDir = options.appsDir;
    this.state = options.state;
    this.builtins = options.builtins;
    this.userAgent = options.userAgent;
    this.ledger = options.ledger;
    this.changed = options.changed ?? (() => {});
    this.log = options.log ?? (() => {});
    this.viewerOf = options.viewer;
    this.goal = options.goal;
    this.pageTile = options.pageTile;
  }

  // --- The viewer -------------------------------------------------------

  // Who's watching now, from the profiles; without them, the person the box
  // belongs to: the first ordinary user, as first boot finds them.
  async viewer(): Promise<Viewer & { name: string; avatar?: string }> {
    if (this.viewerOf) return this.viewerOf();
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

  // The apps on the box, or the ones a child's profile can open.
  async apps(viewer?: Viewer): Promise<AppSummary[]> {
    const settings = await this.appSettings();
    const signIns = await this.signIns();
    const children = await this.childrenApps();
    const profiles = await this.allServiceProfiles();
    const all = (await this.manifests()).map(({ manifest, tier }): AppSummary => {
      const values = settings[manifest.id] ?? {};
      const builtin = tier === "built-in";
      const fields = (manifest.tv.setup ?? []).filter((step) => step.type === "field");
      const signedIn = signIns[manifest.id]?.signedIn;
      const signInStep = (manifest.tv.setup ?? []).some((step) => step.type === "signIn");
      const icon = manifest.tv.icon || this.hasSiteIcon(manifest.id, tier) ? `/api/apps/${manifest.id}/icon` : undefined;
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
        icon,
        sizes: sizesOf(manifest),
        reach:
          manifest.tv.runtime === "page"
            ? pageReach(manifest)
            : reach.length
              ? reach
              : manifest.tv.runtime === "native"
                ? ["its own window on this tv"]
                : builtin
                  ? ["nothing outside this tv"]
                  : ["nothing yet"],
        needsSetup: fields.some((field) => field.type === "field" && !values[field.key]),
        signIn: manifest.tv.capabilities.includes("signIn") && (signedIn === false || (signedIn === undefined && signInStep)) ? "needed" : undefined,
        credit: builtin ? CREDITS[manifest.id] : undefined,
        forChildren: children[manifest.id] ?? manifest.tv.childSafe === true,
        profiles: manifest.tv.capabilities.includes("profiles") ? { names: profiles[manifest.id]?.names ?? [], forChildren: profiles[manifest.id]?.forChildren ?? null } : undefined,
      };
    });
    return viewer?.role === "child" ? all.filter((app) => app.forChildren) : all;
  }

  // --- Children's apps (ADR-009) -----------------------------------------------

  // What an adult ticked or unticked for children, by app. A box from before
  // ADR-035 kept it as kids-apps.json, which takes the new name here.
  private async childrenApps(): Promise<Record<string, boolean>> {
    const path = join(this.state, "children-apps.json");
    const before = join(this.state, "kids-apps.json");
    if (!existsSync(path) && existsSync(before)) await rename(before, path).catch(() => {});
    return readJson(path, {});
  }

  // Ticks an app for children, or unticks it. False when it isn't an app here.
  async setForChildren(id: string, allowed: boolean): Promise<boolean> {
    if (!(await this.manifests()).some(({ manifest }) => manifest.id === id)) return false;
    const all = await this.childrenApps();
    all[id] = allowed;
    await mkdir(this.state, { recursive: true });
    await writeJson(join(this.state, "children-apps.json"), all);
    return true;
  }

  // A profile that's gone takes its layout with it.
  async forgetViewer(id: string): Promise<void> {
    for (const name of ["layouts.json", "builtins-pinned.json"]) {
      const all = await readJson<Record<string, unknown>>(join(this.state, name), {});
      if (!(id in all)) continue;
      delete all[id];
      await writeJson(join(this.state, name), all);
    }
  }

  // --- Sign-ins (ADR-032) -----------------------------------------------

  // What each app said the last time it was asked whether it's signed in.
  // The services' Chromium is the box's, so a sign-in is too, not a viewer's.
  private signIns(): Promise<Record<string, { signedIn: boolean; at: string }>> {
    return readJson(join(this.state, "signins.json"), {});
  }

  // Notes what an app said. False when it isn't an app here, or it has no
  // signIn.
  async signedIn(id: string, signedIn: boolean): Promise<boolean> {
    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    if (!found?.manifest.tv.capabilities.includes("signIn")) return false;
    const all = await this.signIns();
    if (all[id]?.signedIn === signedIn) return true;
    all[id] = { signedIn, at: new Date().toISOString() };
    await mkdir(this.state, { recursive: true });
    await writeJson(join(this.state, "signins.json"), all);
    this.changed("apps");
    return true;
  }

  // --- The service's own profiles (ADR-009) ------------------------------

  // For each app with profiles: its service's profiles, as it listed them
  // the first time an adult opened it, and the one an adult picked for
  // children. The services' Chromium is the box's, so they are too, and
  // none of it goes in the ledger.
  private allServiceProfiles(): Promise<Record<string, ServiceProfiles & { listedAt?: string }>> {
    return readJson(join(this.state, "service-profiles.json"), {});
  }

  private async hasProfiles(id: string): Promise<boolean> {
    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    return found?.manifest.tv.capabilities.includes("profiles") === true;
  }

  // An app's, or null when it isn't an app here with profiles.
  async serviceProfiles(id: string): Promise<ServiceProfiles | null> {
    if (!(await this.hasProfiles(id))) return null;
    const found = (await this.allServiceProfiles())[id];
    return { names: found?.names ?? [], forChildren: found?.forChildren ?? null };
  }

  // Keeps the profiles an app listed, from the screen daemon. Says what's
  // wrong with them, or null once they're kept. The pick for children stays,
  // even when the service no longer lists it: opening it then fails, and the
  // TV says so, rather than a child getting whichever profile is there.
  async listedProfiles(id: string, names: unknown): Promise<string | null> {
    if (!(await this.hasProfiles(id))) return "that isn't an app here with profiles";
    if (!Array.isArray(names) || names.length > PROFILE_NAMES_MAX) return `names is a list of up to ${PROFILE_NAMES_MAX} profiles`;
    const clean = [...new Set(names.map((name) => (typeof name === "string" ? name.trim() : "")))];
    if (clean.some((name) => !name || name.length > PROFILE_NAME_MAX || /[\u0000-\u001f]/.test(name))) {
      return `each profile is a name of up to ${PROFILE_NAME_MAX} characters`;
    }
    const all = await this.allServiceProfiles();
    all[id] = { names: clean, forChildren: all[id]?.forChildren ?? null, listedAt: new Date().toISOString() };
    await mkdir(this.state, { recursive: true });
    await writeJson(join(this.state, "service-profiles.json"), all);
    this.changed("apps");
    return null;
  }

  // An adult's pick of the profile children open, one the app listed, or
  // null for none. Says what's wrong, or null once it's kept.
  async setChildProfile(id: string, name: unknown): Promise<string | null> {
    if (!(await this.hasProfiles(id))) return "that isn't an app here with profiles";
    const all = await this.allServiceProfiles();
    const known = all[id]?.names ?? [];
    if (name !== null && (typeof name !== "string" || !known.includes(name))) return "that isn't one of the app's profiles";
    all[id] = { names: known, forChildren: name, ...(all[id]?.listedAt ? { listedAt: all[id].listedAt } : {}) };
    await mkdir(this.state, { recursive: true });
    await writeJson(join(this.state, "service-profiles.json"), all);
    this.changed("apps");
    return null;
  }

  // --- Site icons ---------------------------------------------------------

  // Whether a web app with no icon of its own has its site's, kept here. One
  // that doesn't yet is fetched in the background, and home is told when it
  // comes.
  private hasSiteIcon(id: string, tier: AppTier): boolean {
    if (tier === "built-in") return false;
    if (existsSync(join(this.state, "icons", `${id}.json`))) return true;
    const tried = this.iconTried.get(id);
    if (tried === undefined || Date.now() - tried > ICON_RETRY_MS) {
      this.iconTried.set(id, Date.now());
      void this.fetchSiteIcon(id).catch((error: Error) => this.log(`${id}'s site icon: ${error.message}`));
    }
    return false;
  }

  private async fetchSiteIcon(id: string): Promise<void> {
    const target = await this.launch(id);
    if (target?.runtime !== "web") return;
    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    const allowed = found ? allowedOrigins(found.manifest, (await this.appSettings())[id] ?? {}) : new Set<string>();
    const icon = await siteIcon(target.url, { userAgent: `${this.userAgent ?? "AgenTV"} ${id}`, allowed: (url) => allowed.has(url.origin) });
    if (!icon) {
      this.log(`${id}: its site has no icon to show, so its tile keeps its letters`);
      return;
    }
    const dir = join(this.state, "icons");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, id), icon.body);
    await writeJson(join(dir, `${id}.json`), { type: icon.type, from: target.url, at: new Date().toISOString() });
    this.log(`${id}: its site's icon is its logo now`);
    this.changed("apps");
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

  // --- An app's own setup ("Setup flow", ADR-011) -------------------------

  // What an app asks for before it opens: its own fields, filled in as far
  // as they are, and whether a sign-in comes after. Nothing for a built-in,
  // whose settings are the TV's own.
  async appSetup(id: string): Promise<AppSetup | null> {
    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    if (!found || found.tier === "built-in") return null;
    const values = (await this.appSettings())[id] ?? {};
    const steps = found.manifest.tv.setup ?? [];
    const addresses = addressKeys(found.manifest);
    return {
      id,
      name: found.manifest.name,
      fields: steps.flatMap((step) => (step.type === "field" ? [{ key: step.key, label: step.label, value: values[step.key] ?? "", address: addresses.has(step.key) }] : [])),
      signIn: steps.some((step) => step.type === "signIn"),
    };
  }

  // Fills in an app's fields, from its setup page. A field its origins or
  // home page start with is an address: http or https, and plain http when
  // it's typed without, as a server on the home network usually is.
  async saveAppSetup(id: string, change: unknown): Promise<string | null> {
    const setup = await this.appSetup(id);
    if (!setup) return "that isn't an app here with a setup";
    if (typeof change !== "object" || change === null || Array.isArray(change)) return "send the fields to fill in";
    const all = await readJson<Record<string, Record<string, string>>>(join(this.state, "app-settings.json"), {});
    const next = { ...(all[id] ?? {}) };
    for (const [key, raw] of Object.entries(change)) {
      const field = setup.fields.find((f) => f.key === key);
      if (!field) return `${setup.name.toLowerCase()} has no field called ${key.slice(0, 40)}`;
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value || value.length > 500) return `${field.label.toLowerCase()} is up to 500 characters, and not empty`;
      if (!field.address) {
        next[key] = value;
        continue;
      }
      const address = asAddress(value);
      if (!address) return `${field.label.toLowerCase()} is an address like http://192.168.1.20:8096`;
      next[key] = address;
    }
    all[id] = next;
    await mkdir(this.state, { recursive: true });
    await writeJson(join(this.state, "app-settings.json"), all);
    return null;
  }

  // Where an app's package is, how it was installed and its settings, for
  // the screen daemon's worker that reads its playback while it's open.
  async package(id: string): Promise<{ dir: string; tier: AppTier; category: string; settings: Record<string, string> } | null> {
    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    if (!found) return null;
    return { dir: found.dir, tier: found.tier, category: found.manifest.tv.category, settings: (await this.appSettings())[id] ?? {} };
  }

  // An app's logo: its package's own, or its site's, kept here.
  async icon(id: string): Promise<{ path: string; type?: string } | null> {
    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    if (!found) return null;
    if (found.manifest.tv.icon) return { path: join(found.dir, found.manifest.tv.icon) };
    if (found.tier === "built-in") return null;
    const site = await readJson<{ type?: string } | null>(join(this.state, "icons", `${id}.json`), null);
    return site?.type ? { path: join(this.state, "icons", id), type: site.type } : null;
  }

  // What opening an app means, for the screen daemon: its home address with
  // its setup fields filled in, or its command. Nothing, for an app a child's
  // profile can't open.
  async launch(id: string, viewer?: Viewer): Promise<{ runtime: "web"; url: string; name: string } | { runtime: "native"; exec: string[]; name: string } | { runtime: "page"; name: string } | null> {
    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    if (!found) return null;
    if (viewer?.role === "child" && !(await this.apps(viewer)).some((app) => app.id === id)) return null;
    const tv = found.manifest.tv;
    const name = found.manifest.name;
    if (tv.runtime === "native") return { runtime: "native", exec: tv.exec ?? [], name };
    // A page app opens on home, in its frame (ADR-043).
    if (tv.runtime === "page") return { runtime: "page", name };
    const values = (await this.appSettings())[id] ?? {};
    const url = (tv.homeUrl ?? "").replace(/^\{([A-Za-z][A-Za-z0-9]*)\}/, (_, key: string) => (values[key] ?? "").replace(/\/+$/, ""));
    try {
      const parsed = new URL(url);
      if (!allowedOrigins(found.manifest, values).has(parsed.origin)) return null;
      return { runtime: "web", url: parsed.href, name };
    } catch {
      return null;
    }
  }

  // --- Layouts and settings ---------------------------------------------

  private async sizesById(viewer?: Viewer): Promise<Map<string, Size[]>> {
    const sizes = new Map<string, Size[]>([[APPS_TILE, ["s"]]]);
    for (const app of await this.apps(viewer)) sizes.set(app.id, app.sizes.map((choice) => choice.size));
    return sizes;
  }

  // The viewer's layout. Until they change it, every app is pinned small in
  // the order it came, the built-ins first and all apps last. Tiles of apps
  // that have gone are dropped. A built-in is pinned for each viewer once,
  // when there's room (ADR-015), so a box from before it gets it too; one the
  // viewer unpins stays off. A child's has only the apps children can open.
  async layout(viewer: string, role: Viewer["role"] = "adult"): Promise<Placed[]> {
    const saved = (await readJson<Record<string, Placed[]>>(join(this.state, "layouts.json"), {}))[viewer];
    const sizes = await this.sizesById({ id: viewer, role });
    const all = (await this.builtinApps()).map(({ manifest }) => manifest.id);
    const goal = (await this.goal?.().catch(() => null)) ?? null;
    const first = goal === "music" ? [...PINNED, MUSIC_APP] : PINNED;
    const builtins = all.filter((id) => first.includes(id));
    const unpinned = all.filter((id) => !first.includes(id));
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
    for (const id of [...sizes.keys()].filter((id) => id !== APPS_TILE && !unpinned.includes(id)).concat(APPS_TILE)) {
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

  async saveLayout(viewer: string, layout: unknown, role: Viewer["role"] = "adult"): Promise<string | null> {
    const sizes = await this.sizesById({ id: viewer, role });
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
  // as the weather's city or the box's time zone, or when asked for a fresh
  // one, as agentv selftest does to compare a tile with where it comes from.
  // A tile that doesn't answer in time keeps its last content; with none
  // it's null, and the launcher draws it small.
  async tile(id: string, size: Size, viewer: Viewer, fresh = false): Promise<unknown> {
    const key = `${viewer.id}:${id}:${size}`;
    const settings = (await this.appSettings())[id] ?? {};
    const signature = JSON.stringify(settings);
    const cached = this.tiles.get(key);
    const refresh = Math.max(TILE_MIN, Number((cached?.tile as { refreshMins?: number })?.refreshMins) || TILE_DEFAULT);
    if (!fresh && cached && cached.settings === signature && Date.now() - cached.at < refresh * 60_000) return cached.tile;

    const found = (await this.manifests()).find(({ manifest }) => manifest.id === id);
    if (!found) return null;
    const capabilities = found.manifest.tv.capabilities;
    // A page app sets its tile through the kit while it runs (ADR-043).
    if (found.manifest.tv.runtime === "page") return capabilities.includes("tile") ? ((await this.pageTile?.(id)) ?? null) : null;
    if (!capabilities.includes("tile")) {
      // The free medium continue tile, drawn from the ledger each time.
      if (size !== "m" || !capabilities.includes("playback") || !this.ledger) return null;
      return continueTile(this.ledger().recent(viewer.id, { app: id, limit: 2 }));
    }
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

  // --- Installs from the command line -----------------------------------

  private watcher: FSWatcher | null = null;
  private watchSoon?: NodeJS.Timeout;
  private watchAgain?: NodeJS.Timeout;

  // Calls changed("apps") shortly after an app is installed or removed
  // outside the daemon, as agentv app install and remove do as root
  // (ADR-039), so the launcher shows it at once. An app that changed starts
  // its worker again from its new package. On a box with no apps yet the
  // folder isn't there until the first install, so it looks for it every
  // few seconds, and once it's there, says what came before it looked.
  watchApps(every = 5_000): void {
    const soon = (_event?: string, name?: string | Buffer | null) => {
      if (name && String(name) !== "installed.json") return;
      if (this.watchSoon) clearTimeout(this.watchSoon);
      this.watchSoon = setTimeout(() => void this.appsChanged(), 200);
    };
    const attach = (first: boolean) => {
      if (this.watcher) return;
      try {
        this.watcher = watch(this.appsDir, soon);
        this.watcher.on("error", () => {
          this.watcher?.close();
          this.watcher = null;
        });
        if (!first) soon();
      } catch {
        this.watcher = null;
      }
    };
    attach(true);
    this.watchAgain = setInterval(() => attach(false), every);
    this.watchAgain.unref();
  }

  private async appsChanged(): Promise<void> {
    const builtins = new Set((await this.builtinApps()).map(({ manifest }) => manifest.id));
    for (const [id, host] of this.hosts) {
      if (builtins.has(id)) continue;
      host.stop();
      this.hosts.delete(id);
      for (const key of this.tiles.keys()) if (key.includes(`:${id}:`)) this.tiles.delete(key);
    }
    this.checked = undefined;
    this.changed("apps");
  }

  stop(): void {
    for (const host of this.hosts.values()) host.stop();
    this.watcher?.close();
    if (this.watchSoon) clearTimeout(this.watchSoon);
    if (this.watchAgain) clearInterval(this.watchAgain);
  }
}

