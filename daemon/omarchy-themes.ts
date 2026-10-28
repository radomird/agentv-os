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

import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
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

  constructor(options: ThemesOptions) {
    this.options = options;
    this.resolve = options.resolve ?? resolver(options.omarchy);
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

  // The list to the daemon. One at a time: a change while one goes sends
  // another after it.
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
      } while (this.again);
      return sent;
    })().finally(() => (this.pushing = null));
    return this.pushing;
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
    this.watch();
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      if (await this.push()) return;
      await new Promise((resolve) => setTimeout(resolve, this.options.retryMs ?? RETRY_MS));
    }
  }

  // Follows the themes folder, the folder it appears in, and the theme
  // Omarchy has now.
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
    for (const dir of [this.installedDir, join(this.options.home, ".config", "omarchy"), join(this.options.home, ".local", "state", "omarchy", "current")]) {
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
  }
}
