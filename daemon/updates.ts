// What the TV knows about updates (ADR-025): what the daily check found
// (bin/agentv-update-check), how an install from the TV is going
// (bin/agentv-update-tv), and which release's toast home has shown. The two
// scripts run as root and write /var/lib/agentv/update/; the daemon only
// reads it, and keeps the toast in its own state.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface UpdateState {
  status: unknown;
  progress: unknown;
  // The AgenTV version whose toast home has shown already.
  toasted: string | null;
}

async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export class Updates {
  private dir: string;
  private state: string;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: { dir: string; state: string }) {
    this.dir = options.dir;
    this.state = options.state;
  }

  async read(): Promise<UpdateState> {
    const toasted = (await json(join(this.state, "update-toast.json"))) as { version?: unknown } | null;
    return {
      status: await json(join(this.dir, "status.json")),
      progress: await json(join(this.dir, "progress.json")),
      toasted: typeof toasted?.version === "string" ? toasted.version : null,
    };
  }

  async markToasted(version: unknown): Promise<string | null> {
    if (typeof version !== "string" || !/^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(version)) return "a version, as text";
    await mkdir(this.state, { recursive: true });
    const next = join(this.state, ".update-toast.json.next");
    await writeFile(next, `${JSON.stringify({ version })}\n`);
    await rename(next, join(this.state, "update-toast.json"));
    return null;
  }

  // Calls changed shortly after either file changes. The folder may not be
  // there until the first check, so it looks again now and then.
  watch(changed: () => void): void {
    const attach = () => {
      if (this.watcher) return;
      try {
        this.watcher = watch(this.dir, () => {
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(changed, 200);
        });
        this.watcher.on("error", () => {
          this.watcher?.close();
          this.watcher = null;
        });
      } catch {
        this.watcher = null;
      }
    };
    attach();
    const again = setInterval(attach, 60_000);
    again.unref();
  }

  stop(): void {
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
  }
}
