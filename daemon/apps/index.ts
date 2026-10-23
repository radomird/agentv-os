// AgenTV's signed app index (ADR-010): which apps exist, their tier, and the
// exact commit of the public repo each one installs from. The index counts
// only with a good signature from AgenTV's key, the same key the box already
// holds for its packages and tested.json (agentv-keyring), checked with gpgv
// against a keyring that holds that key alone.

import { execFile } from "node:child_process";
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IndexEntry {
  id: string;
  tier: "official" | "community";
  name: string;
  version: string;
  description?: string;
  repo: string; // the app's public git repo, https:// (file:// for tests)
  commit: string; // the exact commit that was checked (ADR-010)
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

// Checks that sig is a good signature of file by a key in keyring. The keyring
// may be armored, as agentv-keyring ships it, or binary.
export async function verifySignature(file: string, sig: string, keyring = DEFAULT_KEYRING): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "agentv-index-"));
  try {
    await access(keyring).catch(() => {
      throw new IndexError(`AgenTV's key isn't on this box (${keyring})`);
    });
    const binary = join(work, "keyring.gpg");
    const gnupg = { GNUPGHOME: work };
    await run("gpg", ["--batch", "--quiet", "--yes", "--dearmor", "--output", binary, keyring], gnupg).catch(() =>
      copyFile(keyring, binary),
    );
    await run("gpgv", ["--quiet", "--keyring", binary, sig, file], gnupg).catch(() => {
      throw new IndexError("the app index isn't signed by AgenTV's key, so nothing was installed");
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const COMMIT = /^[0-9a-f]{40}$/;

// The index's own shape. Anything off is refused as a whole, so a box never
// installs from half an index.
export function parseIndex(text: string): AppIndex {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new IndexError("the app index isn't valid JSON");
  }
  const index = data as Partial<AppIndex>;
  if (typeof data !== "object" || data === null || index.schema !== 1 || !Array.isArray(index.apps)) {
    throw new IndexError("the app index isn't one this box understands (schema 1)");
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
  }
  return index as AppIndex;
}

// Reads index.json and index.json.sig from a folder or an https:// address,
// checks the signature, then the shape. Returns the index.
export async function loadIndex(source: string, keyring = DEFAULT_KEYRING): Promise<AppIndex> {
  const work = await mkdtemp(join(tmpdir(), "agentv-index-"));
  try {
    const file = join(work, "index.json");
    const sig = join(work, "index.json.sig");
    if (/^https?:\/\//.test(source)) {
      for (const [name, path] of [["index.json", file], ["index.json.sig", sig]]) {
        const response = await fetch(`${source.replace(/\/$/, "")}/${name}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
        if (!response?.ok) throw new IndexError(`couldn't fetch the app index from ${source}`);
        await writeFile(path, Buffer.from(await response.arrayBuffer()));
      }
    } else {
      await writeFile(file, await readFile(join(source, "index.json")).catch(() => {
        throw new IndexError(`there's no app index at ${source}`);
      }));
      await writeFile(sig, await readFile(join(source, "index.json.sig")).catch(() => {
        throw new IndexError("the app index has no signature, so nothing was installed");
      }));
    }
    await verifySignature(file, sig, keyring);
    return parseIndex(await readFile(file, "utf8"));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

