// A headless Chromium with a throwaway profile, driven over its DevTools
// pipe: the test TV's (testtv.ts), and the builder's look at a service's
// pages and its contract tests (builder/browse.ts, builder/contract-run.ts).
// In the builder's sandbox its only way out is the filter, given as proxy.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CdpPipe } from "../../daemon/cdp.ts";

export interface Headless {
  cdp: CdpPipe;
  close: () => Promise<void>;
}

export function headless(chromium: string, o: { proxy?: string; url?: string; flags?: string[] } = {}): Headless {
  const profile = mkdtempSync(join(tmpdir(), "agentv-chromium-"));
  const flags = [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-component-update",
    "--disable-breakpad",
    // The sandbox's /dev is a small one of its own: shared memory goes in /tmp.
    "--disable-dev-shm-usage",
    "--disable-crash-reporter",
    "--mute-audio",
    "--window-size=1920,1080",
    ...(o.flags ?? []),
    ...(o.proxy ? [`--proxy-server=${o.proxy}`, "--proxy-bypass-list=localhost;*.localhost;127.0.0.1"] : []),
    o.url ?? "about:blank",
  ];
  // In a process group of its own, so all of Chromium goes when it's done.
  const browser = spawn(chromium, flags, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], detached: true });
  const cdp = new CdpPipe(browser.stdio[3] as Writable, browser.stdio[4] as Readable);
  return {
    cdp,
    async close() {
      await stop(browser.pid);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {}
    },
  };
}

// Chromium and every process it started, gently, then not.
export async function stop(pid: number | undefined): Promise<void> {
  if (!pid) return;
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 30 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (alive()) process.kill(-pid, "SIGKILL");
}
