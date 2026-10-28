// Every night, each built app's packages against OSV.dev again (ADR-044):
// a package that was fine when it was approved can turn out to be malware,
// or to have a high or critical vulnerability, later. This writes what it
// finds to /var/lib/agentv/npm-check/warnings.json, and the TV and the
// phone warn about it, with Remove or Rebuild.
//
// It reads each kept build's lockfile, as approved, and runs outside the
// builder's sandbox (agentv-npm-check.service), so it asks OSV.dev itself.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BuildStatus } from "./build.ts";
import { advisories, lockedPackages, type PackagesOptions } from "./packages.ts";

export interface Warning {
  id: string;
  version: string;
  build: string;
  malware: string[];
  serious: string[];
  since: string; // when this app first had a warning, so a new one shows once
}

export interface Warnings {
  checked: string;
  apps: Warning[];
  failed?: string;
}

// The builds whose app is approved or installed, with a lockfile.
export function keptBuilds(root: string): { id: string; version: string; dir: string; build: string }[] {
  const found: { id: string; version: string; dir: string; build: string }[] = [];
  if (!existsSync(root)) return found;
  for (const id of readdirSync(root)) {
    if (!id.startsWith("local.")) continue;
    for (const version of readdirSync(join(root, id))) {
      const dir = join(root, id, version);
      try {
        const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as BuildStatus;
        if (!["approve", "installed"].includes(status.state)) continue;
        if (!existsSync(join(dir, "work", "package-lock.json"))) continue;
        found.push({ id, version, dir, build: status.build });
      } catch {}
    }
  }
  return found;
}

export async function check(root: string, previous: Warnings | null, osv: { batch: PackagesOptions["osvBatch"]; vuln: PackagesOptions["osvVuln"] }, now = new Date()): Promise<Warnings> {
  const apps: Warning[] = [];
  for (const kept of keptBuilds(root)) {
    const tree = lockedPackages(JSON.parse(readFileSync(join(kept.dir, "work", "package-lock.json"), "utf8")));
    const found = await advisories(tree, osv.batch, osv.vuln);
    if (!found.malware.length && !found.serious.length) continue;
    const before = previous?.apps.find((a) => a.id === kept.id && a.version === kept.version);
    apps.push({ id: kept.id, version: kept.version, build: kept.build, malware: found.malware, serious: found.serious, since: before?.since ?? now.toISOString() });
  }
  return { checked: now.toISOString(), apps };
}

// OSV.dev, asked directly.
export function osvDirect(base = "https://api.osv.dev/v1/") {
  return {
    async batch(packages: { name: string; version: string }[]): Promise<string[][]> {
      const ids: string[][] = [];
      for (let start = 0; start < packages.length; start += 1000) {
        const queries = packages.slice(start, start + 1000).map((p) => ({ package: { ecosystem: "npm", name: p.name }, version: p.version }));
        const answer = await fetch(`${base}querybatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queries }), signal: AbortSignal.timeout(60_000) });
        if (!answer.ok) throw new Error(`OSV.dev answered ${answer.status}`);
        const results = ((await answer.json()) as { results?: { vulns?: { id: string }[] }[] }).results ?? [];
        for (let i = 0; i < queries.length; i++) ids.push((results[i]?.vulns ?? []).map((v) => v.id));
      }
      return ids;
    },
    async vuln(id: string) {
      const answer = await fetch(`${base}vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(60_000) });
      return answer.ok ? await answer.json() : null;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.removeAllListeners("warning");
  const out = join(process.env.STATE_DIRECTORY ?? "/var/lib/agentv/npm-check", "warnings.json");
  let previous: Warnings | null = null;
  try {
    previous = JSON.parse(readFileSync(out, "utf8"));
  } catch {}
  let warnings: Warnings;
  try {
    warnings = await check(process.env.AGENTV_BUILDS ?? "/var/lib/agentv/build", previous, osvDirect());
  } catch (error) {
    // Last night's warnings stand when OSV.dev can't be asked tonight.
    warnings = { ...(previous ?? { apps: [] }), checked: new Date().toISOString(), failed: (error as Error).message.slice(0, 200) };
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.next`, `${JSON.stringify(warnings, null, 2)}\n`, { mode: 0o644 });
  renameSync(`${out}.next`, out);
  console.log(`checked ${keptBuilds(process.env.AGENTV_BUILDS ?? "/var/lib/agentv/build").length} apps: ${warnings.apps.length} with a warning${warnings.failed ? ` (OSV.dev: ${warnings.failed})` : ""}`);
  process.exit(warnings.failed ? 1 : 0);
}
