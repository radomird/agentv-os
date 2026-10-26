// Installs apps into /var/lib/agentv/apps/<id>/ (ADR-010, PHASE-1-PLAN.md),
// from one of two places:
// - The signed index, which pins each app to an exact commit of its public
//   repo, and names its folder there when the repo holds more than one app
//   (ADR-036). The installer fetches that commit and nothing else and takes
//   the app's folder from it.
// - A folder on this box, for an app built here (ADR-039): the builder's
//   build in stage 6, or one written by hand. It's copied first, so what's
//   checked is what's installed, and an adult approves it before it goes in.
// Either way the installer leaves out its fixtures/ (they're for its tests,
// never for a box), checks the package against the app contract as its
// tier, and only then puts it in place, so a box never holds half an app or
// one nobody chose.
// Which tier an app has comes from where it came from, recorded in
// installed.json beside the apps, never from its manifest.

import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validatePackage, type Manifest, type Tier } from "../../apps/contract/manifest.ts";
import { IndexError, loadIndex, run, type IndexEntry } from "./index.ts";

export interface Installed {
  id: string;
  name: string;
  version: string;
  tier: Tier;
  repo?: string;
  commit?: string;
  path?: string;
  source?: string; // the folder a local app was installed from
  installedAt: string;
}

const RECORD = "installed.json";
const ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

// git only over https (and file for the tests), with no prompt for a password
// and no hooks or submodules from the app's repo.
const GIT = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always"];
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

export async function readInstalled(appsDir: string): Promise<Record<string, Installed>> {
  try {
    return JSON.parse(await readFile(join(appsDir, RECORD), "utf8"));
  } catch {
    return {};
  }
}

async function writeInstalled(appsDir: string, record: Record<string, Installed>): Promise<void> {
  const next = join(appsDir, `.${RECORD}.next`);
  await writeFile(next, `${JSON.stringify(record, null, 2)}\n`);
  await rename(next, join(appsDir, RECORD));
}

// Checks the package in pkg as an app of tier: the contract's checks, and
// not built in, since only AgenTV itself brings those. Returns its manifest.
function check(pkg: string, id: string, tier: Tier): Manifest {
  const { manifest, problems } = validatePackage(pkg, tier);
  if (!manifest) throw new IndexError(`${id} doesn't pass the app contract's checks:\n  ${problems.join("\n  ")}`);
  if (manifest.tv.runtime === "builtin") {
    throw new IndexError(`${id} says it's built in, and built-in apps only come with AgenTV itself`);
  }
  return manifest;
}

// Puts the checked package in pkg in place as its app, in place of an older
// version, and records how it came. staging is pkg's own scratch folder.
async function putInPlace(pkg: string, staging: string, appsDir: string, record: Installed): Promise<Installed> {
  const target = join(appsDir, record.id);
  const old = join(staging, "old");
  await rename(target, old).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rename(pkg, target).catch(async (error) => {
    await rename(old, target).catch(() => {});
    throw error;
  });

  const all = await readInstalled(appsDir);
  all[record.id] = record;
  await writeInstalled(appsDir, all);
  return record;
}

// Fetches entry's exact commit, checks it and puts it in place.
export async function installEntry(entry: IndexEntry, appsDir: string): Promise<Installed> {
  await mkdir(appsDir, { recursive: true });
  const staging = await mkdtemp(join(appsDir, `.staging-${entry.id}-`));
  try {
    const checkout = join(staging, "package");
    await run("git", [...GIT, "init", "--quiet", checkout], GIT_ENV);
    await run("git", [...GIT, "-C", checkout, "fetch", "--quiet", "--depth", "1", entry.repo, entry.commit], GIT_ENV).catch(() => {
      throw new IndexError(`couldn't fetch ${entry.id} from ${entry.repo}`);
    });
    await run("git", [...GIT, "-C", checkout, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "FETCH_HEAD"], GIT_ENV);
    const head = (await run("git", [...GIT, "-C", checkout, "rev-parse", "HEAD"], GIT_ENV)).stdout.trim();
    if (head !== entry.commit) throw new IndexError(`${entry.id}'s repo gave a different commit than the index pins`);
    await rm(join(checkout, ".git"), { recursive: true, force: true });

    // The app's own folder, each step of the way a real folder, not a link.
    let pkg = checkout;
    for (const name of entry.path ? entry.path.split("/") : []) {
      pkg = join(pkg, name);
      const found = await lstat(pkg).catch(() => null);
      if (!found?.isDirectory()) throw new IndexError(`${entry.id}'s repo has no folder ${entry.path} at the commit the index pins`);
    }
    await rm(join(pkg, "fixtures"), { recursive: true, force: true });

    const manifest = check(pkg, entry.id, entry.tier);
    if (manifest.id !== entry.id || manifest.version !== entry.version) {
      throw new IndexError(`${entry.id}'s manifest says ${manifest.id} ${manifest.version}, but the index lists ${entry.id} ${entry.version}`);
    }

    return await putInPlace(pkg, staging, appsDir, {
      id: entry.id,
      name: manifest.name,
      version: manifest.version,
      tier: entry.tier,
      repo: entry.repo,
      commit: entry.commit,
      ...(entry.path ? { path: entry.path } : {}),
      installedAt: new Date().toISOString(),
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Every folder 755 and every file 644, whoever made them and however, so the
// daemon, which runs as a user of its own, can read the app, and nothing in
// it is a program.
async function readable(dir: string): Promise<void> {
  await chmod(dir, 0o755);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await readable(path);
    else if (entry.isFile()) await chmod(path, 0o644);
  }
}

// Installs the app in the folder dir as a local app (ADR-039): built on this
// box, by the builder in stage 6 or by hand. The folder is copied, without
// its fixtures/ and any .git, and the copy is checked; links are copied as
// links, so the check refuses them. Then approve sees its manifest, and only
// a yes puts it in place. The record says which folder it came from.
export async function installLocal(dir: string, appsDir: string, approve: (manifest: Manifest) => Promise<boolean>): Promise<Installed> {
  const from = resolve(dir);
  const found = await lstat(from).catch(() => null);
  if (!found?.isDirectory()) throw new IndexError(`there's no app folder at ${dir}`);

  await mkdir(appsDir, { recursive: true });
  const staging = await mkdtemp(join(appsDir, ".staging-local-"));
  try {
    const pkg = join(staging, "package");
    const left = new Set([join(from, "fixtures"), join(from, ".git")]);
    await cp(from, pkg, { recursive: true, verbatimSymlinks: true, filter: (source) => !left.has(source) });
    await readable(pkg);

    const id = JSON.parse(await readFile(join(pkg, "manifest.json"), "utf8").catch(() => "{}"))?.id;
    const manifest = check(pkg, typeof id === "string" && id ? id : "the app", "local");
    if (!(await approve(manifest))) throw new IndexError(`${manifest.id} wasn't approved, so nothing was installed`);

    return await putInPlace(pkg, staging, appsDir, {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      tier: "local",
      source: from,
      installedAt: new Date().toISOString(),
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Installs id from the index at source (a folder or an https:// address).
export async function installFromIndex(id: string, source: string, appsDir: string, keyring?: string): Promise<Installed> {
  const index = await loadIndex(source, keyring);
  const entry = index.apps.find((app) => app.id === id);
  if (!entry) throw new IndexError(`${id} isn't in the app index`);
  return installEntry(entry, appsDir);
}

export async function removeApp(id: string, appsDir: string): Promise<void> {
  if (!ID.test(id)) throw new IndexError(`'${id}' isn't an app id`);
  const record = await readInstalled(appsDir);
  if (!record[id]) throw new IndexError(`${id} isn't installed`);
  await rm(join(appsDir, id), { recursive: true, force: true });
  delete record[id];
  await writeInstalled(appsDir, record);
}
