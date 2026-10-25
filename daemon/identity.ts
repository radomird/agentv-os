// What AgenTV's requests say they are (ADR-015): AgenTV, its version and
// where to find it, from the package's settings, so no owner is written in
// code. "AgenTV/0.1.2 (+https://github.com/<owner>/agentv-os)". Each app's
// requests add the app's own id and version (apps/loader.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function userAgent(root = process.env.AGENTV_PATH ?? "/usr/share/agentv"): string {
  let text = "";
  try {
    text = readFileSync(join(root, "settings"), "utf8");
  } catch {
    // A checkout has no settings: AgenTV, in development.
  }
  const value = (key: string) => text.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim();
  const version = value("AGENTV_VERSION") ?? "dev";
  const home = value("AGENTV_HOMEPAGE") ?? value("AGENTV_TESTED_URL")?.replace(/\/releases\/download\/tested$/, "");
  return home ? `AgenTV/${version} (+${home})` : `AgenTV/${version}`;
}
