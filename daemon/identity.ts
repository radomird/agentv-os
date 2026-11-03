// What AgenTV's requests say they are (ADR-015): AgenTV, its version and
// where to find it, from the package's settings, so no owner is written in
// code. "AgenTV/0.1.2 (+https://github.com/<owner>/agentv-os)". Each app's
// requests add the app's own id and version (apps/loader.ts).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function userAgent(root = process.env.AGENTV_PATH ?? "/usr/share/agentv"): string {
  const value = settings(root);
  const version = value("AGENTV_VERSION") ?? "dev";
  const home = homepage(value);
  return home ? `AgenTV/${version} (+${home})` : `AgenTV/${version}`;
}

// Who AgenTV's own repos belong to on GitHub, from the same settings, or
// null in a checkout. Export never pushes to them (ADR-045).
export function agentvOwner(root = process.env.AGENTV_PATH ?? "/usr/share/agentv"): string | null {
  return /^https:\/\/github\.com\/([A-Za-z0-9-]+)\//.exec(homepage(settings(root)) ?? "")?.[1] ?? null;
}

// The package's settings, a value at a time.
function settings(root: string): (key: string) => string | undefined {
  let text = "";
  try {
    text = readFileSync(join(root, "settings"), "utf8");
  } catch {
    // A checkout has no settings: AgenTV, in development.
  }
  return (key) => text.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim();
}

function homepage(value: (key: string) => string | undefined): string | undefined {
  return value("AGENTV_HOMEPAGE") ?? value("AGENTV_TESTED_URL")?.replace(/\/releases\/download\/tested$/, "");
}

// The agentv package a process started from, as pacman has it, with its
// release: "0.1.1.r84.g8651ebebc-1", or "dev" in a checkout. The daemon and
// the screen daemon read it once as they start, so after an update puts a
// newer one on disk it still says what's running until they restart.
export function installedPackage(db = process.env.AGENTV_PACMAN_DB ?? "/var/lib/pacman/local"): string {
  try {
    for (const entry of readdirSync(db)) {
      const found = /^agentv-(\d[^-]*-\d+)$/.exec(entry);
      if (found) return found[1];
    }
  } catch {
    // No pacman here.
  }
  return "dev";
}
