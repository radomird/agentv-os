// A box for the launcher's checks and for working on it without a TV: the
// daemon with AgenTV's files from this checkout and a few apps from each
// kind of maker, made from the sample app. With builtins, AgenTV's own
// Clock and Weather too, in a time zone of the test's choosing, with the
// weather's forecast from a server the test runs.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  zone?: string; // the box's time zone, "Europe/Amsterdam"
  forecast?: string; // where Weather asks for its forecast instead of MET Norway
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

export async function startBox(
  port = 0,
  fixtures = FIXTURES,
  options: BoxOptions = {},
): Promise<{ daemon: Daemon; url: string; apps: string; state: string; updates: string }> {
  const { apps, state, builtins } = makeBox(fixtures, options);
  // What the update check and an install write, empty until a test fills it.
  const updates = join(state, "..", "update");
  mkdirSync(updates, { recursive: true });
  // The phone companion too, on this computer only, as the box serves it on
  // the home network.
  const daemon = new Daemon({ root: ROOT, state, apps, updates, port, builtins: builtins ?? null, log: () => {}, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1" });
  const listening = await daemon.listen();
  return { daemon, url: `http://127.0.0.1:${listening}`, apps, state, updates };
}
