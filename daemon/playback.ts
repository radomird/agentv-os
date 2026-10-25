// While an app with playback is open on the TV, its playback state, read
// every 10 s and handed to the daemon's ledger (PHASE-1-PLAN.md, "App
// contract"; S3.3). The screen daemon runs this, since it holds the app's
// page in the services' Chromium: the app reads its state from there, in its
// own worker, through the page the loader relays (apps/loader.ts).
//
// The first read comes as soon as the app opens. Its page may still be
// loading then, so for its first 10 s, until a state comes, it reads every
// second, then every 10 s: its row appears within 10 s. A read that fails is
// logged and the next one tries again. An app without playback isn't read.

import type { PlaybackState } from "../apps/contract/contract.ts";
import type { AppHost, PageBroker, Viewer } from "./apps/loader.ts";

export const EVERY_MS = 10_000;
export const FIRST_MS = 1_000;

export interface PlaybackDeps {
  // The app's worker, when it has playback, or null.
  host(id: string): Promise<AppHost | null>;
  viewer(): Promise<Viewer>;
  record(app: string, state: PlaybackState): Promise<void>;
  every?: number;
  first?: number; // how often it reads until the first state comes
  log?: (line: string) => void;
}

interface Watching {
  timer: ReturnType<typeof setTimeout>;
  host: Promise<AppHost | null>;
  page?: PageBroker;
  busy: boolean;
  quickUntil: number;
}

export class PlaybackWatch {
  private deps: PlaybackDeps;
  private watching = new Map<string, Watching>();
  private log: (line: string) => void;

  constructor(deps: PlaybackDeps) {
    this.deps = deps;
    this.log = deps.log ?? (() => {});
  }

  // An app came on the TV, with its page when it's a web app.
  opened(id: string, page?: PageBroker): void {
    this.closed(id);
    const host = this.deps.host(id).catch((error: Error) => {
      this.log(`${id}'s playback can't be read: ${error.message}`);
      return null;
    });
    const quick = this.deps.every ?? EVERY_MS;
    const watching: Watching = { host, page, busy: false, timer: setTimeout(() => {}, 0), quickUntil: Date.now() + quick };
    this.watching.set(id, watching);
    void this.loop(id, watching, false);
  }

  // Reads now, then again after a second until a state has come or 10 s
  // have gone, and after 10 s from then on.
  private async loop(id: string, watching: Watching, seen: boolean): Promise<void> {
    if (this.watching.get(id) !== watching || !(await watching.host)) return;
    const got = await this.read(id);
    if (this.watching.get(id) !== watching) return;
    const now = seen || got;
    const quick = !now && Date.now() < watching.quickUntil;
    watching.timer = setTimeout(() => void this.loop(id, watching, now), quick ? (this.deps.first ?? FIRST_MS) : (this.deps.every ?? EVERY_MS));
  }

  closed(id: string): void {
    const watching = this.watching.get(id);
    if (!watching) return;
    clearTimeout(watching.timer);
    this.watching.delete(id);
    void watching.host.then((host) => host?.stop());
  }

  open(): string[] {
    return [...this.watching.keys()];
  }

  stop(): void {
    for (const id of this.open()) this.closed(id);
  }

  // One read, unless the last is still going. True when a state came and
  // went to the ledger.
  private async read(id: string): Promise<boolean> {
    const watching = this.watching.get(id);
    if (!watching || watching.busy) return false;
    watching.busy = true;
    try {
      const host = await watching.host;
      if (!host || this.watching.get(id) !== watching) return false;
      host.setPage(watching.page);
      const state = await host.call<PlaybackState | null>(await this.deps.viewer(), "playback.readPlaybackState");
      if (!state || this.watching.get(id) !== watching) return false;
      await this.deps.record(id, state);
      return true;
    } catch (error) {
      this.log(`${id}'s playback state: ${(error as Error).message}`);
      return false;
    } finally {
      watching.busy = false;
    }
  }
}
