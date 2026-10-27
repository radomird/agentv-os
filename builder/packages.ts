// npm packages in a built app (ADR-044): any package from the npm registry,
// bundled into the app when it's built, so nothing is fetched while it runs.
//
// Guarded by default:
// - install scripts don't run;
// - every package in the tree has an exact version and its integrity hash,
//   and comes from the registry itself, never a git or tarball address;
// - a version published in the last 7 days is refused, and so is one
//   anywhere in its tree;
// - the whole tree is checked against OSV.dev, and a package with a known
//   high or critical vulnerability is refused.
//
// An adult can uncheck "safeguards" behind the PIN. Then install scripts
// run, under bubblewrap, with the builder's home (its CLI and any sign-in)
// out of sight and only the build's work folder to write; the 7-day wait
// and the refusal over vulnerabilities are off. Known malware is refused
// either way, and the approval lists every package by name and version.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WAIT_DAYS = 7;
export const REGISTRY = "https://registry.npmjs.org/";
const NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const PACKAGES_MAX = 400;

export interface Packument {
  name: string;
  description?: string;
  license?: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, { deprecated?: string; license?: string; description?: string }>;
  time?: Record<string, string>;
  repository?: { url?: string } | string;
}

export interface Vuln {
  id: string;
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string; cwe_ids?: string[] };
}

export interface Locked {
  name: string;
  version: string;
  resolved?: string;
  integrity?: string;
}

export interface PackagesOptions {
  work: string;
  safeguards: boolean;
  home: string; // the builder's home, hidden from install scripts
  // The registry's document for a package, OSV.dev's ids for each package
  // in a tree, and an advisory: through the sandbox's filter on the box.
  packument: (name: string) => Promise<Packument | null>;
  osvBatch: (packages: { name: string; version: string }[]) => Promise<string[][]>;
  osvVuln: (id: string) => Promise<Vuln | null>;
  run: (command: string, args: string[], cwd: string, env: Record<string, string>) => Promise<{ code: number | null; out: string }>;
  proxy?: string;
  npm?: string;
  bwrap?: string;
  esbuild?: string;
  now?: () => Date;
}

export class PackageError extends Error {}

const day = 24 * 60 * 60 * 1000;

// Whether an advisory is malware: OpenSSF's MAL- ids, or GitHub's CWE-506.
export function isMalware(vuln: Vuln): boolean {
  const ids = [vuln.id, ...(vuln.aliases ?? [])];
  return ids.some((id) => id.startsWith("MAL-")) || (vuln.database_specific?.cwe_ids ?? []).includes("CWE-506");
}

export function isSerious(vuln: Vuln): boolean {
  return ["HIGH", "CRITICAL"].includes(String(vuln.database_specific?.severity ?? "").toUpperCase());
}

// Every package in a lockfile, by name and version: what's installed, not
// a link to a folder of the app's own.
export function lockedPackages(lock: unknown): Locked[] {
  const packages = (lock as { packages?: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }> })?.packages ?? {};
  return Object.entries(packages)
    .filter(([path, info]) => path.includes("node_modules/") && !info.link)
    .map(([path, info]) => ({ name: path.replace(/^.*node_modules\//, ""), version: String(info.version ?? ""), resolved: info.resolved, integrity: info.integrity }));
}

// What's wrong with a tree's lock, whatever the safeguards say: a package
// from anywhere but the registry, or without its integrity.
export function lockProblems(packages: Locked[]): string[] {
  const problems: string[] = [];
  for (const p of packages) {
    if (!NAME.test(p.name) || !EXACT.test(p.version)) problems.push(`${p.name}@${p.version} isn't a registry package at an exact version`);
    else if (!p.resolved?.startsWith(REGISTRY)) problems.push(`${p.name}@${p.version} comes from ${p.resolved ?? "nowhere it says"}, not the npm registry`);
    else if (!/^sha512-[A-Za-z0-9+/=]+$/.test(p.integrity ?? "")) problems.push(`${p.name}@${p.version} has no sha512 integrity hash`);
  }
  return problems;
}

export interface Advisories {
  malware: string[];
  serious: string[];
  other: string[];
}

// A tree's advisories, from OSV.dev: what's malware, what's high or
// critical, and the rest, a line each.
export async function advisories(
  packages: { name: string; version: string }[],
  batch: PackagesOptions["osvBatch"],
  vuln: PackagesOptions["osvVuln"],
): Promise<Advisories> {
  const found: Advisories = { malware: [], serious: [], other: [] };
  if (!packages.length) return found;
  const ids = await batch(packages);
  const seen = new Map<string, Vuln | null>();
  for (const [index, list] of ids.entries()) {
    for (const id of list) {
      if (!seen.has(id)) seen.set(id, await vuln(id));
      const v = seen.get(id) ?? { id };
      const line = `${packages[index].name}@${packages[index].version}: ${id}${v.summary ? ` (${v.summary.slice(0, 120)})` : ""}`;
      if (isMalware(v)) found.malware.push(line);
      else if (isSerious(v)) found.serious.push(line);
      else found.other.push(line);
    }
  }
  return found;
}

export class Packages {
  private o: PackagesOptions;

  constructor(options: PackagesOptions) {
    this.o = options;
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  private age(published: string | undefined): number {
    return published ? (this.now().getTime() - Date.parse(published)) / day : 0;
  }

  // npm_info: a package's versions, newest first, with how old each is.
  async info(name: unknown): Promise<string> {
    if (typeof name !== "string" || !NAME.test(name)) throw new PackageError("a package's name, like lodash or @scope/name");
    const doc = await this.o.packument(name);
    if (!doc) throw new PackageError(`there's no ${name} in the npm registry`);
    const versions = Object.keys(doc.versions ?? {})
      .filter((v) => doc.time?.[v])
      .sort((a, b) => Date.parse(doc.time![b]) - Date.parse(doc.time![a]))
      .slice(0, 12);
    const lines = [
      `${doc.name}: ${doc.description ?? "no description"}`,
      `licence: ${doc.license ?? "not given"}; latest: ${doc["dist-tags"]?.latest ?? "none"}`,
      "versions, newest first:",
      ...versions.map((v) => {
        const days = Math.floor(this.age(doc.time?.[v]));
        const wait = this.o.safeguards && days < WAIT_DAYS ? ` (too new: published ${days} days ago, the wait is ${WAIT_DAYS})` : "";
        const deprecated = doc.versions?.[v]?.deprecated ? " (deprecated)" : "";
        return `- ${v}, ${doc.time?.[v]?.slice(0, 10)}${wait}${deprecated}`;
      }),
    ];
    return lines.join("\n");
  }

  // The version to add: the one asked for, or the newest the safeguards let in.
  private pick(doc: Packument, version: unknown): string {
    if (version !== undefined) {
      if (typeof version !== "string" || !EXACT.test(version)) throw new PackageError("an exact version, like 4.17.21");
      if (!doc.versions?.[version]) throw new PackageError(`${doc.name} has no version ${version}`);
      const days = this.age(doc.time?.[version]);
      if (this.o.safeguards && days < WAIT_DAYS) {
        throw new PackageError(`${doc.name}@${version} was published ${Math.floor(days)} days ago, and the wait is ${WAIT_DAYS} days: pick an older version`);
      }
      return version;
    }
    const candidates = Object.keys(doc.versions ?? {})
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && !doc.versions![v].deprecated && doc.time?.[v])
      .filter((v) => !this.o.safeguards || this.age(doc.time?.[v]) >= WAIT_DAYS)
      .sort((a, b) => Date.parse(doc.time![b]) - Date.parse(doc.time![a]));
    if (!candidates.length) throw new PackageError(`${doc.name} has no released version ${this.o.safeguards ? `older than ${WAIT_DAYS} days` : "to add"}`);
    return candidates[0];
  }

  private npmEnv(): Record<string, string> {
    const env: Record<string, string> = {
      HOME: this.o.home,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      npm_config_registry: REGISTRY,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_save_exact: "true",
    };
    if (this.o.proxy) Object.assign(env, { npm_config_https_proxy: this.o.proxy, npm_config_proxy: this.o.proxy, HTTPS_PROXY: this.o.proxy, NO_PROXY: "127.0.0.1,localhost" });
    return env;
  }

  check(packages: { name: string; version: string }[]): Promise<Advisories> {
    return advisories(packages, this.o.osvBatch, this.o.osvVuln);
  }

  // npm_add: the package at an exact version, and its whole tree, checked
  // before anything of it is installed. A refusal leaves the build as it was.
  async add(name: unknown, version: unknown): Promise<string> {
    if (typeof name !== "string" || !NAME.test(name)) throw new PackageError("a package's name, like lodash or @scope/name");
    const doc = await this.o.packument(name);
    if (!doc) throw new PackageError(`there's no ${name} in the npm registry`);
    const exact = this.pick(doc, version);

    const pkgPath = join(this.o.work, "package.json");
    const lockPath = join(this.o.work, "package-lock.json");
    const before = { pkg: existsSync(pkgPath) ? readFileSync(pkgPath, "utf8") : null, lock: existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null };
    const putBack = () => {
      if (before.pkg === null) rmSync(pkgPath, { force: true });
      else writeFileSync(pkgPath, before.pkg);
      if (before.lock === null) rmSync(lockPath, { force: true });
      else writeFileSync(lockPath, before.lock);
    };
    if (before.pkg === null) writeFileSync(pkgPath, `${JSON.stringify({ name: "app", private: true, version: "0.0.0" }, null, 2)}\n`);

    try {
      // The tree, resolved into the lockfile only: nothing runs, nothing's
      // unpacked. With safeguards, every package in it is from before the wait.
      const npm = this.o.npm ?? "npm";
      const args = ["install", `${name}@${exact}`, "--package-lock-only", "--ignore-scripts", "--save-exact", "--no-audit", "--no-fund"];
      if (this.o.safeguards) args.push(`--before=${new Date(this.now().getTime() - WAIT_DAYS * day).toISOString()}`);
      const resolved = await this.o.run(npm, args, this.o.work, this.npmEnv());
      if (resolved.code !== 0) throw new PackageError(`npm couldn't resolve ${name}@${exact}: ${lastLine(resolved.out)}`);

      const tree = lockedPackages(JSON.parse(readFileSync(lockPath, "utf8")));
      if (tree.length > PACKAGES_MAX) throw new PackageError(`${name}@${exact} brings ${tree.length} packages; an app may have up to ${PACKAGES_MAX}`);
      const problems = lockProblems(tree);
      if (problems.length) throw new PackageError(problems[0]);

      const found = await this.check(tree);
      if (found.malware.length) throw new PackageError(`known malware, refused whatever the safeguards say: ${found.malware[0]}`);
      if (this.o.safeguards && found.serious.length) throw new PackageError(`a known high or critical vulnerability: ${found.serious[0]}. Try another version or another package`);

      // Then install exactly the lock, checking each package's integrity.
      const ci = await this.install();
      if (ci.code !== 0) throw new PackageError(`npm couldn't install the tree: ${lastLine(ci.out)}`);
      return [
        `added ${name}@${exact}; the tree has ${tree.length} package${tree.length === 1 ? "" : "s"}, each at an exact version with its integrity, checked against OSV.dev`,
        found.serious.length ? `known high or critical vulnerabilities, which the safeguards would refuse: ${found.serious.join("; ")}` : "",
        found.other.length ? `known advisories below high: ${found.other.join("; ")}` : "",
        "import it from src/main.js, and bundle builds app/main.js",
      ]
        .filter(Boolean)
        .join("\n");
    } catch (error) {
      putBack();
      throw error instanceof PackageError ? error : new PackageError(String((error as Error).message ?? error));
    }
  }

  // npm ci, as the lock says. With safeguards, no script runs. Without, the
  // scripts run under bubblewrap: the system read-only, the builder's home
  // an empty folder, and only the work folder to write.
  private install(): Promise<{ code: number | null; out: string }> {
    const npm = this.o.npm ?? "npm";
    if (this.o.safeguards) return this.o.run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], this.o.work, this.npmEnv());
    const env = { ...this.npmEnv(), HOME: "/tmp/home", npm_config_cache: "/tmp/npm-cache" };
    return this.o.run(this.o.bwrap ?? "bwrap", [...jail(this.o.work, this.o.home), npm, "ci", "--foreground-scripts", "--no-audit", "--no-fund"], this.o.work, env);
  }

  // bundle: src/main.js and what it imports, into app/main.js, for a
  // browser. esbuild reads the packages; nothing of theirs runs.
  async bundle(): Promise<string> {
    if (!existsSync(join(this.o.work, "src/main.js"))) throw new PackageError("there's no src/main.js to bundle");
    const args = ["src/main.js", "--bundle", "--format=iife", "--platform=browser", "--target=chrome120", "--outfile=app/main.js", "--log-level=warning", "--legal-comments=eof"];
    const done = await this.o.run(this.o.esbuild ?? "esbuild", args, this.o.work, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
    if (done.code !== 0) throw new PackageError(`esbuild says: ${done.out.trim().split("\n").slice(0, 6).join("\n")}`);
    return `bundled src/main.js into app/main.js${done.out.trim() ? `\n${done.out.trim().slice(0, 800)}` : ""}`;
  }
}

// bubblewrap's arguments for a package's install scripts, up to the
// command: the system read-only, the builder's home hidden, the work
// folder writable, and its own namespaces but the sandbox's network,
// whose only way out is the filter.
export function jail(work: string, home: string): string[] {
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", home,
    "--bind", work, work,
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
    "--die-with-parent", "--new-session",
    "--chdir", work,
    "--",
  ];
}

function lastLine(out: string): string {
  const lines = out.trim().split("\n").filter((l) => l.trim());
  return (lines.find((l) => /ERR!|error/i.test(l)) ?? lines.at(-1) ?? "no answer").slice(0, 300);
}
