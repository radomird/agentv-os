// What the TV knows about updates (ADR-025): what the daily check found
// (bin/agentv-update-check), how an install from the TV is going
// (bin/agentv-update-tv), what the check after it found
// (bin/agentv-update-after), what Go back returns to (bin/agentv-go-back),
// and which release's toast home has shown. The scripts run as root and
// write /var/lib/agentv/update/; the daemon only reads it, and keeps what the
// TV has dealt with in its own state.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface UpdateState {
  status: unknown;
  progress: unknown;
  // The AgenTV version whose toast home has shown already.
  toasted: string | null;
  // The check after the last update, and the snapshot Go back returns to.
  after: unknown;
  goBack: unknown;
  // The box went back, from which version to which.
  wentBack: unknown;
  // The check whose Keep was chosen, and the going back whose toast showed,
  // by their times.
  seen: { kept: string | null; wentBack: string | null };
}

const AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

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
  private again: ReturnType<typeof setInterval> | null = null;

  constructor(options: { dir: string; state: string }) {
    this.dir = options.dir;
    this.state = options.state;
  }

  async read(): Promise<UpdateState> {
    const toasted = (await json(join(this.state, "update-toast.json"))) as { version?: unknown } | null;
    const seen = (await json(join(this.state, "update-seen.json"))) as { kept?: unknown; wentBack?: unknown } | null;
    return {
      status: await json(join(this.dir, "status.json")),
      progress: await json(join(this.dir, "progress.json")),
      toasted: typeof toasted?.version === "string" ? toasted.version : null,
      after: await json(join(this.dir, "after.json")),
      goBack: await json(join(this.dir, "go-back.json")),
      wentBack: await json(join(this.dir, "went-back.json")),
      seen: {
        kept: typeof seen?.kept === "string" ? seen.kept : null,
        wentBack: typeof seen?.wentBack === "string" ? seen.wentBack : null,
      },
    };
  }

  async markSeen(change: unknown): Promise<string | null> {
    const c = (typeof change === "object" && change !== null ? change : {}) as { kept?: unknown; wentBack?: unknown };
    const valid = (at: unknown) => at === undefined || (typeof at === "string" && AT.test(at));
    if ((c.kept === undefined && c.wentBack === undefined) || !valid(c.kept) || !valid(c.wentBack)) {
      return "kept or wentBack, as the time it names";
    }
    const seen = { ...(await this.read()).seen };
    if (typeof c.kept === "string") seen.kept = c.kept;
    if (typeof c.wentBack === "string") seen.wentBack = c.wentBack;
    await mkdir(this.state, { recursive: true });
    const next = join(this.state, ".update-seen.json.next");
    await writeFile(next, `${JSON.stringify(seen)}\n`);
    await rename(next, join(this.state, "update-seen.json"));
    return null;
  }

  async markToasted(version: unknown): Promise<string | null> {
    if (typeof version !== "string" || !/^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(version)) return "a version, as text";
    await mkdir(this.state, { recursive: true });
    const next = join(this.state, ".update-toast.json.next");
    await writeFile(next, `${JSON.stringify({ version })}\n`);
    await rename(next, join(this.state, "update-toast.json"));
    return null;
  }

  // Calls changed shortly after any of its files changes. On a new box
  // the folder isn't there until the first check makes it, which can be
  // Check now a moment after the box starts, so it looks for it every few
  // seconds, and once it's there, says what was written before it looked.
  watch(changed: () => void, every = 5_000): void {
    const soon = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(changed, 200);
    };
    const attach = (first: boolean) => {
      if (this.watcher) return;
      try {
        this.watcher = watch(this.dir, soon);
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
    this.again = setInterval(() => attach(false), every);
    this.again.unref();
  }

  stop(): void {
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
    if (this.again) clearInterval(this.again);
  }
}
