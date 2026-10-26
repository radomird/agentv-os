// A service's own profiles, for who's watching (ADR-009). When a child is
// watching, an app with profiles opens the service's profile an adult picked
// for children, as the app opens and when a child starts watching with it
// open, so a child never browses an adult's profile. An adult's viewing
// leaves the service's profile as it is; the first time an adult opens the
// app, it lists the service's profiles, so an adult can pick one in its
// details. With nothing picked, a child's app opens as it is, and that's
// logged.
//
// The screen daemon runs this, since it holds the app's page in the
// services' Chromium. The daemon keeps the list and the pick.

import type { AppHost, PageBroker, Viewer } from "./apps/loader.ts";

// As signin.ts: the page gets a moment to come up, and a call that fails
// while it's loading is tried again each second for up to 30 s.
export const SETTLE_MS = 3_000;
export const PAGE_WITHIN_MS = 30_000;
const RETRY_MS = 1_000;

export interface ServiceProfileDeps {
  // The app's worker, when it's a web app with profiles, or null.
  host(id: string): Promise<AppHost | null>;
  viewer(): Promise<Viewer>;
  // The profiles the app listed before, and the one picked for children.
  known(id: string): Promise<{ names: string[]; forChildren: string | null } | null>;
  // What the app listed, for the daemon to keep.
  listed(id: string, names: string[]): Promise<void>;
  settle?: number;
  pageWithin?: number;
  retry?: number;
  log?: (line: string) => void;
}

// What happened: the child's profile opened or didn't, the profiles were
// listed or weren't, or a child is watching and nothing is picked. Null when
// there was nothing to do.
export type ProfileOutcome = "selected" | "not selected" | "listed" | "not listed" | "none picked" | null;

export class ServiceProfiles {
  private deps: ServiceProfileDeps;
  private log: (line: string) => void;

  constructor(deps: ServiceProfileDeps) {
    this.deps = deps;
    this.log = deps.log ?? (() => {});
  }

  // As the app opens, or someone else is watching with it open.
  async apply(id: string, page: PageBroker): Promise<ProfileOutcome> {
    const host = await this.deps.host(id).catch(() => null);
    if (!host) return null;
    try {
      const viewer = await this.deps.viewer();
      const known = await this.deps.known(id).catch(() => null);
      if (viewer.role === "child") {
        const name = known?.forChildren;
        if (!name) {
          this.log(`${id}: no profile is picked for children, so it opens as it is`);
          return "none picked";
        }
        const done = await this.call(id, host, page, viewer, "profiles.select", name);
        if (done === undefined) return "not selected";
        this.log(`${id}: opened the profile for children`);
        return "selected";
      }
      if (known && known.names.length > 0) return null;
      const names = await this.call(id, host, page, viewer, "profiles.list");
      if (!Array.isArray(names)) return "not listed";
      await this.deps.listed(id, names as string[]);
      this.log(`${id}: listed ${names.length} profiles for an adult to pick from`);
      return "listed";
    } catch (error) {
      this.log(`${id}'s profiles: ${(error as Error).message}`);
      return null;
    } finally {
      host.stop();
    }
  }

  // One call, after the page has had a moment, tried each second while it
  // comes up. Undefined when it never took.
  private async call(id: string, host: AppHost, page: PageBroker, viewer: Viewer, method: string, ...args: unknown[]): Promise<unknown> {
    await sleep(this.deps.settle ?? SETTLE_MS);
    const started = Date.now();
    for (;;) {
      host.setPage(page);
      try {
        return (await host.call(viewer, method, ...args)) ?? null;
      } catch (error) {
        if (Date.now() - started + (this.deps.retry ?? RETRY_MS) > (this.deps.pageWithin ?? PAGE_WITHIN_MS)) {
          this.log(`${id}'s ${method} didn't work: ${(error as Error).message}`);
          return undefined;
        }
        await sleep(this.deps.retry ?? RETRY_MS);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
