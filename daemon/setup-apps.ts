// Setup's apps (board 09): the official apps from OrigaiTV's signed index
// (ADR-010, ADR-036), the ones for what the TV is for first, and the rest
// under "more", beside the built-in apps that come with OrigaiTV. Apps → add
// an app hands over the same way, after setup (ADR-042). The daemon
// can't write the apps folder, which is root's, so it leaves the ones picked
// in its own private state, where origaitv-setup-apps.path starts
// bin/origaitv-setup-apps as root to install each with `origaitv app install`,
// in the background. /run/origaitv-setup-apps/state.json says how each went.
//
// Every game platform Omarchy's menu has is an official app (ADR-103), so
// they come the same way: setup's games group, Settings' Games page and Add
// an app. Root takes the hand-overs as a queue, so adding several at once
// waits its turn instead of being refused. A hand-over can also remove an
// official app, which leaves its program, games and saves, and install the
// Xbox controller driver from Settings, Phones and controllers.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadIndex, type IndexEntry } from "./apps/index.ts";
import type { Goal } from "./setup.ts";

// The apps each goal puts first, in order, from the official ones and the
// built-in Music. One the index doesn't have yet, such as Plex, isn't shown.
// With the starter switch off, Streaming has the servers you run yourself,
// and the household's TV builds a streaming service ("+ add your own").
export const GOAL_APPS: Record<Goal, string[]> = {
  streaming: ["origaitv.jellyfin", "origaitv.plex"],
  music: ["origaitv.music"],
  media: ["origaitv.jellyfin", "origaitv.plex", "origaitv.immich"],
  gaming: ["origaitv.steam"],
};

// The built-in apps setup shows, ticked, since they come with OrigaiTV.
const SHOWN_BUILTINS = new Set(Object.values(GOAL_APPS).flat());

// The games, by their manifest's category, which setup shows as a group of
// their own and Settings has a page for (ADR-103).
export const GAMES_CATEGORY = "games";
// The ones that stream their games from somewhere else, so any box plays
// them: a box the box check says isn't for games is offered these alone.
export const STREAMED_GAMES = ["origaitv.xboxcloud", "origaitv.geforcenow", "origaitv.moonlight"];
// The one setup ticks for gaming, on a box that runs games.
export const SUGGESTED_GAME = "origaitv.steam";

// What the box check says about games: "none", "light", "good", or null
// when it hasn't said.
export type GamesVerdict = "none" | "light" | "good" | null;

// The streaming starter pack (ADR-066): every official app the index says is
// for streaming, by its manifest's category. With the starter switch on,
// they're Streaming's own apps, ticked, and one press away for every other
// goal. Which they are is the index's to say, so none is named here.
export const STARTER_CATEGORY = "streaming";

export type InstallState = "queued" | "installing" | "installed" | "failed" | "removing";

export interface SetupApp {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  installed: boolean;
  state: InstallState | null;
  error?: string;
}

// Apps → add an app (ADR-042): an official app that isn't on the TV, or one
// added from there that just landed.
export interface AvailableApp {
  id: string;
  name: string;
  description: string;
  state: InstallState | null;
  error?: string;
}

export interface SetupAppList {
  for: SetupApp[];
  // The games that aren't the goal's own (ADR-103), and which of them start
  // ticked.
  games: SetupApp[];
  suggested: string[];
  more: SetupApp[];
  // The starter pack, with its switch on: none of them is in for or more.
  starter?: SetupApp[];
  // Why the index couldn't be read, when it couldn't.
  error?: string;
}

export interface Present {
  id: string;
  name: string;
  description?: string;
  tier: string;
}

interface Status {
  state: InstallState;
  error?: string;
  at?: string;
}

// The Xbox controller driver (ADR-103): whether it's in, and how its
// install is going.
export interface DriverState {
  installed: boolean;
  state: Exclude<InstallState, "removing"> | null;
  error?: string;
  // In, but the old driver was busy: the new one takes over after a restart.
  restart?: boolean;
}

// Settings' Games page (ADR-103): each game the index has, whether it's on
// the TV, and how adding or removing it is going.
export interface GameApp {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  state: InstallState | null;
  error?: string;
}

// What root takes from the daemon: apps to install, apps to remove, and the
// driver.
interface Drop {
  apps: string[];
  remove: string[];
  driver?: "xpadneo";
}

export interface SetupAppsOptions {
  state: string; // the daemon's own state: the drop goes in <state>/apps-drop
  status?: string; // /run/origaitv-setup-apps/state.json
  // Where the index is (ORIGAITV_INDEX_URL), and the official apps in it.
  source: () => Promise<string | undefined>;
  catalog?: (source: string) => Promise<IndexEntry[]>;
  waitMs?: number; // how long root may take to pick the drop up
  onChange?: (apps: Record<string, Status>) => void;
  // Whether the Xbox controller driver's package is on the box.
  hasDriver?: () => boolean;
  // Whether root's origaitv-setup-apps.service is running: true, false, or
  // null when it can't tell.
  running?: () => Promise<boolean | null>;
}

const ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
// Longer than one app may take as root: 20 minutes to fetch it and 60 for
// its program (bin/origaitv-setup-apps, origaitv-app-package@.service), and
// 30 for the driver (origaitv-xbox-driver.service). A line still installing
// or removing after that was cut short, and so is any line still going once
// root has stopped. A queued line waits as long as the queue takes.
const APP_LIMIT_MS = 90 * 60_000;
const DRIVER_LIMIT_MS = 40 * 60_000;
const STATES: InstallState[] = ["queued", "installing", "installed", "failed", "removing"];
const GOING: (InstallState | null | undefined)[] = ["queued", "installing", "removing"];

// Whether root's unit is running, from systemd. A oneshot unit is
// "activating" while it runs. Null when systemctl can't say.
function setupAppsRunning(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("systemctl", ["is-active", "origaitv-setup-apps.service"], { timeout: 5000 }, (_error, stdout) => {
      const state = String(stdout ?? "").trim();
      if (["active", "activating", "reloading", "deactivating"].includes(state)) resolve(true);
      else if (["inactive", "failed"].includes(state)) resolve(false);
      else resolve(null);
    });
  });
}

// Whether xpadneo's package is installed, from pacman's own record.
function driverPackage(): boolean {
  try {
    return readdirSync("/var/lib/pacman/local").some((name) => name.startsWith("xpadneo-dkms-"));
  } catch {
    return false;
  }
}

export class SetupApps {
  private drop: string;
  private statusPath: string;
  private source: SetupAppsOptions["source"];
  private catalog: (source: string) => Promise<IndexEntry[]>;
  private given: boolean;
  private waitMs: number;
  private onChange?: SetupAppsOptions["onChange"];
  // The index, kept for a while: 10 minutes when it was read, 30 s when not.
  private cached?: { until: number; apps: IndexEntry[]; error?: string };
  // Picked and handed over, until root says how it's going.
  private queued = new Set<string>();
  // Added from Apps, which keeps them on its list once they're installed.
  private added = new Set<string>();
  private watching?: ReturnType<typeof setInterval>;
  private seen = "";
  private hasDriver: () => boolean;
  // Removals handed over, until root says how they went.
  private removing = new Set<string>();
  // The driver, handed over, until root says how it's going.
  private driverQueued = false;
  private isRunning: () => Promise<boolean | null>;
  // What systemd last said about root's unit, and when.
  private running: { at: number; value: boolean | null } = { at: 0, value: null };
  private asking = false;

  constructor(options: SetupAppsOptions) {
    this.drop = join(options.state, "apps-drop", "install.json");
    this.statusPath = options.status ?? "/run/origaitv-setup-apps/state.json";
    this.source = options.source;
    this.catalog = options.catalog ?? (async (source) => (await loadIndex(source, process.env.ORIGAITV_KEYRING)).apps);
    this.given = Boolean(options.catalog);
    this.waitMs = options.waitMs ?? 10_000;
    this.onChange = options.onChange;
    this.hasDriver = options.hasDriver ?? driverPackage;
    this.isRunning = options.running ?? setupAppsRunning;
  }

  // Whether root may still be at it: what systemd last said, asked again
  // every few seconds while a line is going. Until it has answered, or when
  // it can't, root may be.
  private rootMayBeRunning(): boolean {
    if (!this.asking && Date.now() - this.running.at > 5000) {
      this.asking = true;
      void this.isRunning()
        .catch(() => null)
        .then((value) => {
          this.running = { at: Date.now(), value };
          this.asking = false;
        });
    }
    return this.running.value !== false;
  }

  // Whether root's line for an app or the driver says it's going when it
  // can't be any more: root has stopped, or it's been installing or
  // removing for longer than one may take.
  private cutShort(line: Partial<Status> | undefined, limitMs: number): boolean {
    if (!GOING.includes(line?.state)) return false;
    if (line!.state !== "queued" && line!.at && Date.now() - Date.parse(line!.at) > limitMs) return true;
    return !this.rootMayBeRunning();
  }

  // The official apps in the index, or why there are none.
  async official(): Promise<{ apps: IndexEntry[]; error?: string }> {
    if (this.cached && this.cached.until > Date.now()) return this.cached;
    try {
      const source = await this.source();
      if (!source && !this.given) throw new Error("Couldn't load the apps");
      const apps = (await this.catalog(source ?? "")).filter((app) => app.tier === "official");
      this.cached = { until: Date.now() + 600_000, apps };
    } catch (error) {
      this.cached = { until: Date.now() + 30_000, apps: [], error: (error as Error).message };
    }
    return this.cached;
  }

  // How each install went, from root, with the ones still waiting for it.
  status(): Record<string, Status> {
    const found: Record<string, Status> = {};
    try {
      const data = JSON.parse(readFileSync(this.statusPath, "utf8")) as { apps?: Record<string, Partial<Status>> };
      for (const [id, app] of Object.entries(data.apps ?? {})) {
        if (!ID.test(id) || !STATES.includes(app.state as InstallState)) continue;
        const at = typeof app.at === "string" ? { at: app.at } : {};
        // Cut short: an install didn't finish, and a removal left the app.
        if (this.cutShort(app, APP_LIMIT_MS)) {
          found[id] = app.state === "removing" ? { state: "installed", error: "Couldn't remove it", ...at } : { state: "failed", error: "Couldn't install it. Try again.", ...at };
          continue;
        }
        found[id] = { state: app.state as InstallState, ...(typeof app.error === "string" ? { error: app.error.slice(0, 200) } : {}), ...at };
      }
    } catch {
      // nothing installed from setup yet
    }
    for (const id of this.queued) {
      if (found[id] && found[id].state !== "queued") this.queued.delete(id);
      else found[id] = { state: "queued" };
    }
    // A removal root hasn't started yet; once it has, its line says, and
    // once it's done, the line is gone, or says why it isn't. Root may be
    // done before the daemon looks, so once root has taken the hand-over,
    // its line is what counts.
    for (const id of this.removing) {
      if (found[id]?.state === "removing") this.seenRemoving.add(id);
      else if (this.seenRemoving.has(id) || !existsSync(this.drop)) {
        this.removing.delete(id);
        this.seenRemoving.delete(id);
      } else found[id] = { state: "removing" };
    }
    return found;
  }

  private seenRemoving = new Set<string>();

  // The raw status file: the apps' lines, and the driver's.
  private raw(): { apps?: Record<string, Partial<Status>>; drivers?: Record<string, Partial<Status> & { restart?: unknown }> } {
    try {
      return JSON.parse(readFileSync(this.statusPath, "utf8"));
    } catch {
      return {};
    }
  }

  // Whether root has something going: an app queued, installing or being
  // removed, or the driver. One cut short isn't.
  private busy(): boolean {
    const driver = this.raw().drivers?.xpadneo;
    return Object.values(this.status()).some((app) => GOING.includes(app.state)) || (GOING.includes(driver?.state as InstallState) && !this.cutShort(driver, DRIVER_LIMIT_MS)) || this.driverQueued;
  }

  // The apps for the goal first, then the rest, each with whether it's on the
  // box already and how its install is going. With starter, the starter
  // pack on its own: Streaming's own apps then, with the servers under more.
  // The games (ADR-103) go in a group of their own, each game the goal
  // doesn't list already: on a box the box check says isn't for games, only
  // the ones that stream from elsewhere. For gaming, on a box that runs
  // games, Steam starts ticked.
  async list(goal: Goal | null, present: Present[], starter = false, verdict: GamesVerdict = null): Promise<SetupAppList> {
    const { apps, error } = await this.official();
    const status = this.status();
    const here = new Map(present.map((app) => [app.id, app]));
    const shown = new Map<string, SetupApp>();
    for (const app of present) {
      if (app.tier !== "built-in" || !SHOWN_BUILTINS.has(app.id)) continue;
      shown.set(app.id, { id: app.id, name: app.name, description: app.description ?? "", builtin: true, installed: true, state: null });
    }
    for (const entry of apps) {
      const now = status[entry.id];
      shown.set(entry.id, {
        id: entry.id,
        name: entry.name,
        description: entry.description ?? "",
        builtin: false,
        installed: here.has(entry.id),
        state: now?.state ?? null,
        ...(now?.error ? { error: now.error } : {}),
      });
    }
    const byName = (a: SetupApp, b: SetupApp) => a.name.localeCompare(b.name);
    const pack = starter ? apps.filter((entry) => entry.category === STARTER_CATEGORY).map((entry) => shown.get(entry.id)!).sort(byName) : [];
    const packed = new Set(pack.map((app) => app.id));
    const first = goal && !(starter && goal === "streaming") ? GOAL_APPS[goal] : [];
    // A box that isn't for games isn't offered Steam for gaming either.
    const goalFirst = verdict === "none" ? first.filter((id) => !this.isGame(apps, id) || STREAMED_GAMES.includes(id)) : first;
    const forGoal = goalFirst.map((id) => shown.get(id)).filter((app): app is SetupApp => !!app && !packed.has(app.id));
    const gameIds = new Set(apps.filter((entry) => entry.category === GAMES_CATEGORY && !first.includes(entry.id) && !packed.has(entry.id)).map((entry) => entry.id));
    const offered = (id: string) => verdict !== "none" || STREAMED_GAMES.includes(id);
    // Steam first, as the one most have, then by name.
    const games = [...gameIds]
      .filter(offered)
      .map((id) => shown.get(id)!)
      .sort((a, b) => Number(b.id === SUGGESTED_GAME) - Number(a.id === SUGGESTED_GAME) || byName(a, b));
    const suggested = goal === "gaming" && (verdict === "light" || verdict === "good") && shown.has(SUGGESTED_GAME) ? [SUGGESTED_GAME] : [];
    const rest = [...shown.values()]
      .filter((app) => !first.includes(app.id) && !packed.has(app.id) && !gameIds.has(app.id))
      .sort((a, b) => Number(b.builtin) - Number(a.builtin) || byName(a, b));
    // Streaming's servers lead more when the starter pack takes their place.
    const servers = first.length || !goal ? [] : GOAL_APPS[goal].filter((id) => rest.some((app) => app.id === id));
    const more = [...servers.map((id) => rest.find((app) => app.id === id)!), ...rest.filter((app) => !servers.includes(app.id))];
    return { for: forGoal, games, suggested, more, ...(starter ? { starter: pack } : {}), ...(error ? { error } : {}) };
  }

  private isGame(apps: IndexEntry[], id: string): boolean {
    return apps.some((entry) => entry.id === id && entry.category === GAMES_CATEGORY);
  }

  // Settings' Games page (ADR-103): every game in the index, whether it's on
  // the TV, and how adding or removing it is going. Steam first, then by
  // name.
  async games(present: Present[]): Promise<{ apps: GameApp[]; error?: string }> {
    const { apps, error } = await this.official();
    const status = this.status();
    const here = new Set(present.map((app) => app.id));
    const list = apps
      .filter((entry) => entry.category === GAMES_CATEGORY)
      .map((entry): GameApp => {
        const now = status[entry.id];
        const installed = here.has(entry.id);
        // A line from an install that's over says nothing more than whether
        // it's here, unless it didn't work.
        const state = now && (GOING.includes(now.state) || (now.state === "failed" && !installed)) ? now.state : null;
        return { id: entry.id, name: entry.name, description: entry.description ?? "", installed, state, ...(now?.error && (state || installed) ? { error: now.error } : {}) };
      })
      .sort((a, b) => Number(b.id === SUGGESTED_GAME) - Number(a.id === SUGGESTED_GAME) || a.name.localeCompare(b.name));
    return { apps: list, ...(error ? { error } : {}) };
  }

  // Apps → add an app (ADR-042): the official apps that aren't on the TV,
  // by name, each with how its install is going once it's picked. One added
  // from there stays on the list as installed, so it can be opened there.
  async available(present: Present[]): Promise<{ apps: AvailableApp[]; error?: string }> {
    const { apps, error } = await this.official();
    const status = this.status();
    const here = new Set(present.map((app) => app.id));
    const list: AvailableApp[] = [];
    for (const entry of apps) {
      const now = status[entry.id];
      if (here.has(entry.id) && !(this.added.has(entry.id) && now?.state === "installed")) continue;
      // Installed once and taken off since: it can be added again.
      const state = now?.state === "installed" && !here.has(entry.id) ? null : (now?.state ?? null);
      list.push({ id: entry.id, name: entry.name, description: entry.description ?? "", state, ...(state === "failed" && now?.error ? { error: now.error } : {}) });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    return { apps: list, ...(error ? { error } : {}) };
  }

  // One app from Apps → add an app, or Settings' Games page, handed to root
  // as setup's are. Root takes the hand-overs as a queue (ADR-103), so one
  // added while another installs waits its turn.
  async add(id: unknown, present: Present[]): Promise<string | null> {
    if (typeof id !== "string" || !ID.test(id)) return "send the app to add as its id";
    if (present.some((app) => app.id === id)) return "You already have that app";
    const now = this.status()[id];
    if (GOING.includes(now?.state)) return null;
    const why = await this.install([id]);
    if (!why) this.added.add(id);
    return why;
  }

  // An official game off the TV, from Settings' Games page (ADR-103). Root
  // removes the app and leaves its program, its games and its saves.
  async remove(id: unknown, present: Present[]): Promise<string | null> {
    if (typeof id !== "string" || !ID.test(id)) return "send the app to remove as its id";
    const app = present.find((one) => one.id === id);
    if (!app) return "That app isn't on your TV";
    if (app.tier !== "official") return "Only apps from OrigaiTV are removed here";
    // Settings' Games page removes games, and nothing else.
    const { apps } = await this.official();
    if (!this.isGame(apps, id)) return "Only games are removed here";
    if (GOING.includes(this.status()[id]?.state)) return null;
    const why = await this.handOver({ apps: [], remove: [id] });
    if (why) return why;
    this.removing.add(id);
    this.seenRemoving.delete(id);
    this.watch();
    return null;
  }

  // The Xbox controller driver (ADR-103): whether it's in, and how its
  // install is going.
  driver(): DriverState {
    const raw = this.raw().drivers?.xpadneo;
    // Cut short, it didn't install.
    const line = this.cutShort(raw, DRIVER_LIMIT_MS) ? { ...raw, state: "failed", error: "Couldn't install the driver" } : raw;
    const state = STATES.includes(line?.state as InstallState) && line?.state !== "removing" ? (line!.state as DriverState["state"]) : null;
    if (state && state !== "queued") this.driverQueued = false;
    const installed = this.hasDriver() || state === "installed";
    const shown = this.driverQueued ? "queued" : state === "installed" && !installed ? null : state;
    return {
      installed,
      state: shown,
      ...(shown === "failed" && typeof line?.error === "string" ? { error: line.error.slice(0, 200) } : {}),
      ...(state === "installed" && line?.restart === true ? { restart: true } : {}),
    };
  }

  // Hands the driver to root, in turn with the apps.
  async addDriver(): Promise<string | null> {
    const now = this.driver();
    if (now.state === "queued" || now.state === "installing") return null;
    if (now.installed && now.state !== "failed") return "The driver is on your TV already";
    const why = await this.handOver({ apps: [], remove: [], driver: "xpadneo" });
    if (why) return why;
    this.driverQueued = true;
    this.watch();
    return null;
  }

  // Hands the picked apps to root to install. Null once root has them, or
  // why not.
  async install(ids: unknown): Promise<string | null> {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || !ids.every((id) => typeof id === "string" && ID.test(id))) {
      return "send the apps to install as a list of their ids";
    }
    const { apps, error } = await this.official();
    // The list's own error says why it couldn't be read. A person reads what
    // to do.
    if (error) return "Couldn't load the apps. Try again later.";
    const unknown = (ids as string[]).find((id) => !apps.some((app) => app.id === id));
    if (unknown) return `${unknown} isn't one of OrigaiTV's official apps`;
    const wanted = [...new Set(ids as string[])];
    const why = await this.handOver({ apps: wanted, remove: [] });
    if (why) return why;
    for (const id of wanted) this.queued.add(id);
    this.watch();
    return null;
  }

  // Leaves a hand-over for root, with any it hasn't taken yet. While root
  // has something going, it takes this one when it's done with that
  // (ADR-103); with nothing going, root takes it away as it starts, or it
  // isn't there to take it.
  private async handOver(change: Drop): Promise<string | null> {
    const busy = this.busy();
    let drop: Drop = { apps: [], remove: [] };
    try {
      const left = JSON.parse(readFileSync(this.drop, "utf8")) as Partial<Drop>;
      drop = { apps: Array.isArray(left.apps) ? left.apps : [], remove: Array.isArray(left.remove) ? left.remove : [], ...(left.driver === "xpadneo" ? { driver: "xpadneo" } : {}) };
    } catch {
      // none waiting
    }
    const next: Drop = {
      apps: [...new Set([...drop.apps, ...change.apps])].filter((id) => !change.remove.includes(id)),
      remove: [...new Set([...drop.remove, ...change.remove])].filter((id) => !change.apps.includes(id)),
      ...(drop.driver || change.driver ? { driver: "xpadneo" as const } : {}),
    };
    mkdirSync(dirname(this.drop), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.drop}.next`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${this.drop}.next`, this.drop);
    if (busy) return null;
    const until = Date.now() + this.waitMs;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!existsSync(this.drop)) return null;
    }
    rmSync(this.drop, { force: true });
    return "Couldn't install the apps. Restart your TV and try again.";
  }

  // Tells the TV as each install moves on, until none is left going.
  private watch(): void {
    if (this.watching) return;
    this.watching = setInterval(() => {
      const now = this.status();
      const driver = this.driver();
      // The driver's line too, for Settings' Xbox row.
      const said = JSON.stringify([now, driver]);
      if (said !== this.seen) {
        this.seen = said;
        this.onChange?.(now);
      }
      if (!Object.values(now).some((app) => GOING.includes(app.state)) && driver.state !== "queued" && driver.state !== "installing") this.stop();
    }, 1000);
    this.watching.unref?.();
  }

  stop(): void {
    if (this.watching) clearInterval(this.watching);
    this.watching = undefined;
  }
}
