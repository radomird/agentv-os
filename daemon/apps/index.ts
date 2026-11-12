// AgenTV's signed app index (ADR-010): which apps exist, their tier, and the
// exact commit of the public repo each one installs from, and the app's folder
// in that repo when it shares one with others, as the official apps share
// agentv-apps (ADR-036). The index counts
// only with a good signature from AgenTV's key, the same key the box already
// holds for its packages and tested.json (agentv-keyring), checked with gpgv
// against a keyring that holds that key alone.

import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface IndexEntry {
  id: string;
  tier: "official" | "community";
  name: string;
  version: string;
  description?: string;
  category?: string; // its manifest's category, such as streaming or media
  repo: string; // the app's public git repo, https:// (file:// for tests)
  commit: string; // the exact commit that was checked (ADR-010)
  path?: string; // the app's folder in the repo, like apps/jellyfin; the repo itself without it
}

export interface AppIndex {
  schema: 1;
  date: string;
  apps: IndexEntry[];
}

// A problem with the index, said so the TV or the command line can show it.
export class IndexError extends Error {}

export const DEFAULT_KEYRING = "/usr/share/pacman/keyrings/agentv.gpg";

export function run(command: string, args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr: String(stderr) }));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

// Who signed a file and when: the key's fingerprint, and the time the
// signature itself carries, in seconds.
export interface Signed {
  key: string;
  at: number;
}

// Checks that sig is a good signature of file by a key in keyring, and says
// which key and when. The keyring may be armored, as agentv-keyring ships it,
// or binary.
export async function verifySignature(file: string, sig: string, keyring = DEFAULT_KEYRING): Promise<Signed> {
  const work = await mkdtemp(join(tmpdir(), "agentv-index-"));
  try {
    await access(keyring).catch(() => {
      console.error(`agentv: AgenTV's key isn't at ${keyring}`);
      throw new IndexError("Couldn't verify the app list, so nothing was installed");
    });
    const binary = join(work, "keyring.gpg");
    const gnupg = { GNUPGHOME: work };
    await run("gpg", ["--batch", "--quiet", "--yes", "--dearmor", "--output", binary, keyring], gnupg).catch(() =>
      copyFile(keyring, binary),
    );
    const unsigned = new IndexError("Couldn't verify the app list, so nothing was installed");
    const { stdout } = await run("gpgv", ["--quiet", "--status-fd", "1", "--keyring", binary, sig, file], gnupg).catch(() => {
      throw unsigned;
    });
    const valid = /^\[GNUPG:\] VALIDSIG ([0-9A-F]{40,}) \S+ (\d+) /m.exec(stdout);
    if (!valid) throw unsigned;
    return { key: valid[1], at: Number(valid[2]) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const COMMIT = /^[0-9a-f]{40}$/;
// A folder in the repo: plain names joined by slashes, none of them . or ..
const PATH = /^(?!\.{1,2}(\/|$))[A-Za-z0-9_][A-Za-z0-9._-]*(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

// The index's own shape. Anything off is refused as a whole, so a box never
// installs from half an index.
export function parseIndex(text: string): AppIndex {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new IndexError("Couldn't read the app list");
  }
  const index = data as Partial<AppIndex>;
  if (typeof data !== "object" || data === null || index.schema !== 1 || !Array.isArray(index.apps)) {
    throw new IndexError("Couldn't read the app list. Update AgenTV and try again.");
  }
  const seen = new Set<string>();
  for (const entry of index.apps as Partial<IndexEntry>[]) {
    const id = String(entry?.id);
    if (!ID.test(id)) throw new IndexError(`the app index lists an app with the id '${id}', which isn't valid`);
    if (seen.has(id)) throw new IndexError(`the app index lists ${id} twice`);
    seen.add(id);
    if (entry.tier !== "official" && entry.tier !== "community") throw new IndexError(`${id} has no tier in the app index`);
    if (typeof entry.name !== "string" || typeof entry.version !== "string") throw new IndexError(`${id} has no name or version in the app index`);
    if (typeof entry.commit !== "string" || !COMMIT.test(entry.commit)) {
      throw new IndexError(`${id} isn't pinned to an exact commit in the app index`);
    }
    if (typeof entry.repo !== "string" || !/^(https|file):\/\//.test(entry.repo)) {
      throw new IndexError(`${id}'s repo in the app index isn't an https:// address`);
    }
    if (entry.category !== undefined && typeof entry.category !== "string") throw new IndexError(`${id}'s category in the app index isn't a word`);
    if (entry.path !== undefined && (typeof entry.path !== "string" || !PATH.test(entry.path))) {
      throw new IndexError(`${id}'s folder in the app index isn't a plain folder in its repo`);
    }
  }
  return index as AppIndex;
}

// A good signature says who made an index, not that it's the latest: an old
// one handed over again would install an app's older commit. So the box
// keeps, in the file seen, the time of the newest index it has taken from
// each key, and refuses an older one. It compares signatures' own times,
// never the box's clock, which can be wrong. The same index again is fine.
async function newestOnly(signed: Signed, seen: string): Promise<void> {
  let newest: Record<string, number> = {};
  try {
    newest = JSON.parse(await readFile(seen, "utf8"));
  } catch {
    // The first index this box takes.
  }
  const had = Number(newest?.[signed.key]) || 0;
  if (signed.at < had) {
    console.error(`agentv: refused an app index signed at ${new Date(signed.at * 1000).toISOString()}, older than the one this box already took (${new Date(had * 1000).toISOString()})`);
    throw new IndexError("The app list is older than the one on this TV, so nothing was installed");
  }
  if (signed.at === had) return;
  await mkdir(dirname(seen), { recursive: true });
  await writeFile(`${seen}.next`, `${JSON.stringify({ ...newest, [signed.key]: signed.at })}\n`);
  await rename(`${seen}.next`, seen);
}

// Reads index.json and index.json.sig from a folder or an https:// address,
// checks the signature, then the shape. Returns the index. With seen, a
// file to remember in, an index older than the newest taken is refused.
export async function loadIndex(source: string, keyring = DEFAULT_KEYRING, seen?: string): Promise<AppIndex> {
  const work = await mkdtemp(join(tmpdir(), "agentv-index-"));
  try {
    const file = join(work, "index.json");
    const sig = join(work, "index.json.sig");
    if (/^https?:\/\//.test(source)) {
      for (const [name, path] of [["index.json", file], ["index.json.sig", sig]]) {
        const response = await fetch(`${source.replace(/\/$/, "")}/${name}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
        if (!response?.ok) {
          console.error(`agentv: couldn't fetch the app index from ${source}`);
          throw new IndexError("Couldn't load the app list");
        }
        await writeFile(path, Buffer.from(await response.arrayBuffer()));
      }
    } else {
      await writeFile(file, await readFile(join(source, "index.json")).catch(() => {
        console.error(`agentv: there's no app index at ${source}`);
        throw new IndexError("Couldn't load the app list");
      }));
      await writeFile(sig, await readFile(join(source, "index.json.sig")).catch(() => {
        throw new IndexError("Couldn't verify the app list, so nothing was installed");
      }));
    }
    const signed = await verifySignature(file, sig, keyring);
    const index = parseIndex(await readFile(file, "utf8"));
    if (seen) await newestOnly(signed, seen);
    return index;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

