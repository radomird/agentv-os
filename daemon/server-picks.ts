// A server picked for an app in setup (setup/servers.ts), from the list of
// what's on the network. Setup hands its apps over to install in the
// background, so the app is often still installing when someone picks its
// server. The pick waits here, and fills in the app's address the moment
// the app lands, as typing it on the app's setup page would. Until then,
// and if the app never lands, its tile on home says "set up".

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// What the picks need of home (daemon/home.ts).
export interface PickHome {
  appSetup(id: string): Promise<{ fields: { key: string; address: boolean }[] } | null>;
  saveAppSetup(id: string, change: unknown): Promise<string | null>;
}

export interface ServerPicksOptions {
  state: string; // the daemon's own state: server-picks.json goes in it
  home: PickHome;
  // An app's address was filled in.
  saved?: (app: string) => void;
  log?: (line: string) => void;
}

export type PickAnswer = { ok: true; saved: boolean } | { ok: false; status: number; error: string };

const ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

export class ServerPicks {
  private path: string;
  private options: ServerPicksOptions;
  // One change at a time, so two picks and a landing app can't race.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ServerPicksOptions) {
    this.options = options;
    this.path = join(options.state, "server-picks.json");
  }

  private log(line: string): void {
    (this.options.log ?? ((text: string) => console.log(text)))(line);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(data).filter((pair): pair is [string, string] => ID.test(pair[0]) && typeof pair[1] === "string"));
    } catch {
      return {};
    }
  }

  private async write(picks: Record<string, string>): Promise<void> {
    await mkdir(this.options.state, { recursive: true });
    const temp = `${this.path}.${process.pid}`;
    await writeFile(temp, `${JSON.stringify(picks, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.path);
  }

  // Fills the app's address in, when the app is here and asks for one.
  // Null when it isn't here yet, an error when the address doesn't fit.
  private async fill(app: string, url: string): Promise<{ error: string | null } | null> {
    const setup = await this.options.home.appSetup(app);
    if (!setup) return null;
    const field = setup.fields.find((one) => one.address);
    if (!field) return { error: "that app doesn't ask for a server" };
    const error = await this.options.home.saveAppSetup(app, { [field.key]: url });
    if (!error) {
      this.log(`${app}: its server is ${url}, picked from the network`);
      this.options.saved?.(app);
    }
    return { error };
  }

  // A server picked for an app: its address goes in now if the app's here,
  // or once it lands.
  pick(app: unknown, url: unknown): Promise<PickAnswer> {
    return this.serial(async () => {
      if (typeof app !== "string" || !ID.test(app)) return { ok: false, status: 400, error: "say which app, by its id" };
      if (typeof url !== "string" || url.length > 500 || !/^https?:\/\/[^\s/]+/.test(url)) return { ok: false, status: 400, error: "the server's address, like http://192.168.1.20:8096" };
      const filled = await this.fill(app, url);
      const picks = await this.read();
      if (filled) {
        if (filled.error) return { ok: false, status: 400, error: filled.error };
        if (app in picks) {
          delete picks[app];
          await this.write(picks);
        }
        return { ok: true, saved: true };
      }
      picks[app] = url;
      await this.write(picks);
      this.log(`${app}: its server waits for it to install`);
      return { ok: true, saved: false };
    });
  }

  // What's waiting goes to each app that's here now. One whose install
  // failed lets its pick go, so its tile says "set up" as it would anyway.
  settle(failed: string[] = []): Promise<void> {
    return this.serial(async () => {
      const picks = await this.read();
      let changed = false;
      for (const [app, url] of Object.entries(picks)) {
        if (!failed.includes(app)) {
          const filled = await this.fill(app, url).catch(() => null);
          if (!filled) continue;
          if (filled.error) this.log(`${app}: its picked server didn't fit: ${filled.error}`);
        }
        delete picks[app];
        changed = true;
      }
      if (changed) await this.write(picks);
    });
  }

  // The apps with a pick still waiting.
  async waiting(): Promise<string[]> {
    return Object.keys(await this.read());
  }
}
