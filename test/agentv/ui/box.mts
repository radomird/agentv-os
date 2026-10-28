// A box for the launcher's checks and for working on it without a TV: the
// daemon with AgenTV's files from this checkout and a few apps from each
// kind of maker, made from the sample app. With builtins, AgenTV's own
// Clock and Weather too, in a time zone of the test's choosing, with the
// weather's forecast from a server the test runs.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../../daemon/server.ts";

export const ROOT = join(import.meta.dirname, "../../..");
const SAMPLE = join(ROOT, "test/agentv/fixtures/apps/sample");

export interface Fixture {
  id: string;
  name: string;
  tier: "official" | "community" | "local";
  category: string;
  edit?: (manifest: Record<string, any>) => void;
}

export const FIXTURES: Fixture[] = [
  { id: "agentv.sample", name: "Sample", tier: "official", category: "media" },
  {
    id: "agentv.tube",
    name: "Tube",
    tier: "official",
    category: "streaming",
    edit: (m) => ((m.tv.capabilities = ["launch"]), delete m.tv.tiles, (m.tv.homeUrl = "https://tube.example/"), (m.tv.origins = ["https://tube.example"]), (m.tv.setup = [])),
  },
  {
    id: "someone.radio",
    name: "Radio",
    tier: "community",
    category: "music",
    edit: (m) => ((m.author = "someone"), (m.tv.capabilities = ["launch"]), delete m.tv.tiles),
  },
  {
    id: "local.mytv",
    name: "My TV",
    tier: "local",
    category: "streaming",
    edit: (m) => ((m.tv.capabilities = ["launch", "playback"]), (m.tv.tiles = { s: "logo", m: "continue" }), (m.tv.homeUrl = "https://mytv.example/"), (m.tv.origins = ["https://mytv.example"]), (m.tv.setup = [])),
  },
  {
    id: "agentv.games",
    name: "Games",
    tier: "official",
    category: "games",
    edit: (m) => {
      m.tv.runtime = "native";
      delete m.tv.homeUrl;
      delete m.tv.origins;
      delete m.tv.icon;
      m.tv.package = { pacman: "steam" };
      m.tv.exec = ["steam", "-gamepadui"];
      m.tv.capabilities = ["launch"];
      m.tv.setup = [];
      delete m.tv.tiles;
    },
  },
];

// The sample app's code with its id swapped, so the module matches its manifest.
function code(id: string): string {
  return readFileSync(join(SAMPLE, "app.ts"), "utf8").replace('id: "agentv.sample"', `id: "${id}"`);
}

export interface BoxOptions {
  builtins?: boolean;
  // The box's network interfaces, as setup sees them: the machine's own
  // unless a test says otherwise.
  interfaces?: () => Record<string, unknown[]>;
  zone?: string; // the box's time zone, "Europe/Amsterdam"
  forecast?: string; // where Weather asks for its forecast instead of MET Norway
  // The museum archives' stand-in (archives.mts), for the art picker.
  art?: { endpoints: Record<"met" | "aic" | "commons", string>; imageHosts: string[] };
}

// AgenTV's built-ins, with the weather pointed at the test's own server.
function builtins(dir: string, forecast?: string): string {
  const target = join(dir, "builtin");
  cpSync(join(ROOT, "apps/builtin"), target, { recursive: true });
  if (forecast) {
    const path = join(target, "agentv.weather/manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.tv.origins = [new URL(forecast).origin];
    writeFileSync(path, JSON.stringify(manifest, null, 2));
  }
  return target;
}

// The time zone, as the installer leaves it, and the cities zone.tab knows.
export function useZone(dir: string, zone: string): void {
  const link = join(dir, "localtime");
  symlinkSync(`/usr/share/zoneinfo/${zone}`, link);
  process.env.AGENTV_LOCALTIME = link;
  process.env.AGENTV_ZONE_TAB = join(ROOT, "test/agentv/fixtures/met/zone.tab");
}

export function makeBox(fixtures: Fixture[] = FIXTURES, options: BoxOptions = {}): { apps: string; state: string; builtins?: string } {
  const dir = mkdtempSync(join(tmpdir(), "agentv-box-"));
  const apps = join(dir, "apps");
  const state = join(dir, "state");
  mkdirSync(apps);
  mkdirSync(state);
  const installed: Record<string, unknown> = {};
  for (const fixture of fixtures) {
    const target = join(apps, fixture.id);
    cpSync(SAMPLE, target, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
    manifest.id = fixture.id;
    manifest.name = fixture.name;
    manifest.tv.category = fixture.category;
    fixture.edit?.(manifest);
    writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(target, "app.ts"), code(fixture.id));
    installed[fixture.id] = { id: fixture.id, name: fixture.name, version: "1.0.0", tier: fixture.tier, installedAt: "2026-10-23T12:00:00Z" };
  }
  writeFileSync(join(apps, "installed.json"), JSON.stringify(installed, null, 2));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true }));
  // The sample app has a sign-in step, and it's done (ADR-032).
  writeFileSync(join(state, "signins.json"), JSON.stringify({ "agentv.sample": { signedIn: true, at: "2026-10-25T12:00:00Z" } }));
  const settings: Record<string, Record<string, string>> = { "agentv.sample": { serverUrl: "http://127.0.0.1:1" } };
  if (options.forecast) settings["agentv.weather"] = { forecastUrl: options.forecast };
  writeFileSync(join(state, "app-settings.json"), JSON.stringify(settings));
  if (options.zone) useZone(dir, options.zone);
  return { apps, state, builtins: options.builtins ? builtins(dir, options.forecast) : undefined };
}

// What agentv-key-store does as root, for a box with no root: it takes the
// daemon's drop and says which provider has a key, never the key.
function keyMover(state: string, status: string): void {
  const drop = join(state, "key-drop", "key.json");
  setInterval(() => {
    let request: { provider: string | null };
    try {
      request = JSON.parse(readFileSync(drop, "utf8"));
    } catch {
      return;
    }
    rmSync(drop, { force: true });
    writeFileSync(status, JSON.stringify({ set: request.provider !== null, provider: request.provider, at: new Date().toISOString() }));
  }, 50).unref();
}

// The official apps setup offers, as the signed index lists them.
export const OFFICIAL = [
  { id: "agentv.jellyfin", name: "Jellyfin", description: "Your Jellyfin library on the TV" },
  { id: "agentv.immich", name: "Immich", description: "Your Immich photos on the TV" },
  { id: "agentv.steam", name: "Steam", description: "Steam Big Picture on the TV, full screen" },
].map((app) => ({ ...app, tier: "official" as const, version: "1.0.0", repo: "https://example.invalid/agentv-apps.git", commit: "c73732a1416f35af05b89bf1f3586cf2810b5aaa", path: `apps/${app.name.toLowerCase()}` }));

// What agentv-setup-apps does as root, for a box with no root: it takes the
// daemon's drop, puts each app in the apps folder (the sample app, named for
// it) and says how each went.
function appsMover(state: string, apps: string, status: string): void {
  const drop = join(state, "apps-drop", "install.json");
  setInterval(() => {
    let ids: string[];
    try {
      ids = JSON.parse(readFileSync(drop, "utf8")).apps;
    } catch {
      return;
    }
    rmSync(drop, { force: true });
    const said: Record<string, { state: string }> = {};
    const write = () => writeFileSync(status, JSON.stringify({ apps: said }));
    for (const id of ids) said[id] = { state: "installing" };
    write();
    setTimeout(() => {
      const installed = JSON.parse(readFileSync(join(apps, "installed.json"), "utf8"));
      for (const id of ids) {
        const app = OFFICIAL.find((a) => a.id === id)!;
        const target = join(apps, id);
        cpSync(SAMPLE, target, { recursive: true });
        const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
        manifest.id = id;
        manifest.name = app.name;
        writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
        writeFileSync(join(target, "app.ts"), code(id));
        installed[id] = { id, name: app.name, version: "1.0.0", tier: "official", installedAt: new Date().toISOString() };
        said[id] = { state: "installed" };
      }
      writeFileSync(join(apps, "installed.json"), JSON.stringify(installed, null, 2));
      write();
    }, 400);
  }, 50).unref();
}

export async function startBox(
  port = 0,
  fixtures = FIXTURES,
  options: BoxOptions = {},
): Promise<{ daemon: Daemon; url: string; apps: string; state: string; updates: string; hotspot: string; builds: string; themes: string }> {
  const { apps, state, builtins } = makeBox(fixtures, options);
  // What the update check and an install write, empty until a test fills it.
  const updates = join(state, "..", "update");
  mkdirSync(updates, { recursive: true });
  // What agentv-hotspot writes, empty until a test fills it.
  const hotspot = join(state, "..", "hotspot");
  mkdirSync(hotspot, { recursive: true });
  const keyStatus = join(state, "..", "key.json");
  keyMover(state, keyStatus);
  const setupAppsStatus = join(state, "..", "setup-apps.json");
  appsMover(state, apps, setupAppsStatus);
  // The phone companion and the setup hotspot's captive page too, on this
  // computer only, as the box serves them on the home network and on its
  // hotspot.
  const daemon = new Daemon({
    root: ROOT,
    state,
    apps,
    updates,
    port,
    builtins: builtins ?? null,
    log: () => {},
    lanPort: 0,
    lanHost: "127.0.0.1",
    address: () => "127.0.0.1",
    setupPort: 0,
    setupHost: "127.0.0.1",
    hotspotAddress: "127.0.0.1",
    hotspotRun: hotspot,
    interfaces: options.interfaces as never,
    keyStatus,
    setupAppsStatus,
    setupCatalog: async () => OFFICIAL,
    // Omarchy's themes, from this checkout, for setup's look, and the themes
    // your agent made, empty until a test plays root's part in them.
    omarchy: ROOT,
    themes: join(state, "..", "themes"),
    backgrounds: join(state, "..", "backgrounds"),
    shared: join(state, "..", "shared"),
    // No packages' desktop entries or icons until a test puts some there.
    dataDirs: [join(state, "..", "share")],
    art: options.art,
    // The builder's folders, empty until a test plays root's part in them.
    builds: join(state, "..", "build"),
    buildRun: join(state, "..", "build-run"),
    spend: join(state, "..", "spend.json"),
    npmWarnings: join(state, "..", "npm-warnings.json"),
  });
  const listening = await daemon.listen();
  return { daemon, url: `http://127.0.0.1:${listening}`, apps, state, updates, hotspot, builds: join(state, "..", "build"), themes: join(state, "..", "themes") };
}
