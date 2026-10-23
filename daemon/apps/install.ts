// Installs apps from the signed index into /var/lib/agentv/apps/<id>/ (ADR-010,
// PHASE-1-PLAN.md). The index pins each app to an exact commit of its public
// repo. The installer fetches that commit and nothing else, checks the package
// against the app contract as the tier the index gives it, and only then puts
// it in place, so a box never holds half an app or one the index didn't name.
// Which tier an app has comes from where it came from, recorded in
// installed.json beside the apps, never from its manifest.

import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePackage, type Tier } from "../../apps/contract/manifest.ts";
import { IndexError, loadIndex, run, type IndexEntry } from "./index.ts";

export interface Installed {
  id: string;
  name: string;
  version: string;
  tier: Tier;
  repo?: string;
  commit?: string;
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

    const { manifest, problems } = validatePackage(checkout, entry.tier);
    if (!manifest) throw new IndexError(`${entry.id} doesn't pass the app contract's checks:\n  ${problems.join("\n  ")}`);
    if (manifest.id !== entry.id || manifest.version !== entry.version) {
      throw new IndexError(`${entry.id}'s manifest says ${manifest.id} ${manifest.version}, but the index lists ${entry.id} ${entry.version}`);
    }

    const target = join(appsDir, entry.id);
    const old = join(staging, "old");
    await rename(target, old).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(checkout, target).catch(async (error) => {
      await rename(old, target).catch(() => {});
      throw error;
    });

    const record = await readInstalled(appsDir);
    record[entry.id] = {
      id: entry.id,
      name: manifest.name,
      version: manifest.version,
      tier: entry.tier,
      repo: entry.repo,
      commit: entry.commit,
      installedAt: new Date().toISOString(),
    };
    await writeInstalled(appsDir, record);
    return record[entry.id];
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
