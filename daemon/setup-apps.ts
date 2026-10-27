// Setup's apps (board 09): the official apps from AgenTV's signed index
// (ADR-010, ADR-036), the ones for what the TV is for first, and the rest
// under "more", beside the built-in apps that come with AgenTV. Apps → add
// an app hands over the same way, after setup (ADR-042). The daemon
// can't write the apps folder, which is root's, so it leaves the ones picked
// in its own private state, where agentv-setup-apps.path starts
// bin/agentv-setup-apps as root to install each with `agentv app install`,
// in the background. /run/agentv-setup-apps/state.json says how each went.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadIndex, type IndexEntry } from "./apps/index.ts";
import type { Goal } from "./setup.ts";

// The apps each goal puts first, in order, from the official ones and the
// built-in Music. One the index doesn't have yet, such as Plex, isn't shown.
// Streaming services aren't official apps: the household's TV builds those
// ("+ add your own").
export const GOAL_APPS: Record<Goal, string[]> = {
  streaming: ["agentv.jellyfin", "agentv.plex"],
  music: ["agentv.music"],
  media: ["agentv.jellyfin", "agentv.plex", "agentv.immich"],
  gaming: ["agentv.steam"],
};

// The built-in apps setup shows, ticked, since they come with AgenTV.
const SHOWN_BUILTINS = new Set(Object.values(GOAL_APPS).flat());

export type InstallState = "queued" | "installing" | "installed" | "failed";

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
  more: SetupApp[];
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

export interface SetupAppsOptions {
  state: string; // the daemon's own state: the drop goes in <state>/apps-drop
  status?: string; // /run/agentv-setup-apps/state.json
  // Where the index is (AGENTV_INDEX_URL), and the official apps in it.
  source: () => Promise<string | undefined>;
  catalog?: (source: string) => Promise<IndexEntry[]>;
  waitMs?: number; // how long root may take to pick the drop up
  onChange?: (apps: Record<string, Status>) => void;
}

const ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const STATES: InstallState[] = ["queued", "installing", "installed", "failed"];

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

  constructor(options: SetupAppsOptions) {
    this.drop = join(options.state, "apps-drop", "install.json");
    this.statusPath = options.status ?? "/run/agentv-setup-apps/state.json";
    this.source = options.source;
    this.catalog = options.catalog ?? (async (source) => (await loadIndex(source, process.env.AGENTV_KEYRING)).apps);
    this.given = Boolean(options.catalog);
    this.waitMs = options.waitMs ?? 10_000;
    this.onChange = options.onChange;
  }

  // The official apps in the index, or why there are none.
  async official(): Promise<{ apps: IndexEntry[]; error?: string }> {
    if (this.cached && this.cached.until > Date.now()) return this.cached;
    try {
      const source = await this.source();
      if (!source && !this.given) throw new Error("this box has no app index set up yet");
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
        found[id] = { state: app.state as InstallState, ...(typeof app.error === "string" ? { error: app.error.slice(0, 200) } : {}), ...(typeof app.at === "string" ? { at: app.at } : {}) };
      }
    } catch {
      // nothing installed from setup yet
    }
    for (const id of this.queued) {
      if (found[id] && found[id].state !== "queued") this.queued.delete(id);
      else found[id] = { state: "queued" };
    }
    return found;
  }

  // The apps for the goal first, then the rest, each with whether it's on the
  // box already and how its install is going.
  async list(goal: Goal | null, present: Present[]): Promise<SetupAppList> {
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
    const first = goal ? GOAL_APPS[goal] : [];
    const forGoal = first.map((id) => shown.get(id)).filter((app): app is SetupApp => !!app);
    const more = [...shown.values()].filter((app) => !first.includes(app.id)).sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
    return { for: forGoal, more, ...(error ? { error } : {}) };
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

  // One app from Apps → add an app, handed to root as setup's are.
  async add(id: unknown, present: Present[]): Promise<string | null> {
    if (typeof id !== "string" || !ID.test(id)) return "send the app to add as its id";
    if (present.some((app) => app.id === id)) return "that app is on the tv already";
    const why = await this.install([id]);
    if (!why) this.added.add(id);
    return why;
  }

  // Hands the picked apps to root to install. Null once root has them, or
  // why not.
  async install(ids: unknown): Promise<string | null> {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || !ids.every((id) => typeof id === "string" && ID.test(id))) {
      return "send the apps to install as a list of their ids";
    }
    const { apps, error } = await this.official();
    if (error) return error;
    const unknown = (ids as string[]).find((id) => !apps.some((app) => app.id === id));
    if (unknown) return `${unknown} isn't one of AgenTV's official apps`;
    const wanted = [...new Set(ids as string[])];
    mkdirSync(dirname(this.drop), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.drop}.next`, JSON.stringify({ apps: wanted }), { mode: 0o600 });
    renameSync(`${this.drop}.next`, this.drop);
    // Root takes the drop away as it starts.
    const until = Date.now() + this.waitMs;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!existsSync(this.drop)) {
        for (const id of wanted) this.queued.add(id);
        this.watch();
        return null;
      }
    }
    rmSync(this.drop, { force: true });
    return "the apps couldn't be installed: agentv-setup-apps.path isn't running";
  }

  // Tells the TV as each install moves on, until none is left going.
  private watch(): void {
    if (this.watching) return;
    this.watching = setInterval(() => {
      const now = this.status();
      const said = JSON.stringify(now);
      if (said !== this.seen) {
        this.seen = said;
        this.onChange?.(now);
      }
      if (!Object.values(now).some((app) => app.state === "queued" || app.state === "installing")) this.stop();
    }, 1000);
    this.watching.unref?.();
  }

  stop(): void {
    if (this.watching) clearInterval(this.watching);
    this.watching = undefined;
  }
}
