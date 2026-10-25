// The signed app index and the installer (daemon/apps/index.ts, install.ts):
// a sample app installs from a signed test index, and a tampered index is
// refused (S2.1). The index here is signed by a throwaway key made for the
// test, which stands in for AgenTV's own.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { IndexError, loadIndex, parseIndex } from "../../../daemon/apps/index.ts";
import { installFromIndex, readInstalled, removeApp } from "../../../daemon/apps/install.ts";

const SAMPLE = join(import.meta.dirname, "../fixtures/apps/sample");
const scratch = mkdtempSync(join(tmpdir(), "agentv-index-"));
const gnupg = join(scratch, "gnupg");
const keyring = join(scratch, "agentv.asc");
const otherKeyring = join(scratch, "other.asc");
const repo = join(scratch, "repo");
let first = "";
let second = "";
let count = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

function sh(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GNUPGHOME: gnupg, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeKey(name: string, out: string): string {
  sh("gpg", ["--batch", "--passphrase", "", "--quick-gen-key", `${name} <${name}@agentv.invalid>`, "ed25519", "sign", "never"]);
  const fingerprint = sh("gpg", ["--batch", "--with-colons", "--list-keys", `${name}@agentv.invalid`])
    .split("\n")
    .find((line) => line.startsWith("fpr:"))!
    .split(":")[9];
  writeFileSync(out, sh("gpg", ["--batch", "--armor", "--export", fingerprint]));
  return fingerprint;
}

let signer = "";
let otherSigner = "";

function commit(message: string): string {
  sh("git", ["add", "-A"], repo);
  sh("git", ["-c", "user.name=AgenTV", "-c", "user.email=test@agentv.invalid", "commit", "--quiet", "-m", message], repo);
  return sh("git", ["rev-parse", "HEAD"], repo).trim();
}

before(() => {
  mkdirSync(gnupg, { mode: 0o700 });
  signer = makeKey("agentv", keyring);
  otherSigner = makeKey("other", otherKeyring);

  // The sample app's repo: 1.0.0, then 1.0.1.
  cpSync(SAMPLE, repo, { recursive: true });
  sh("git", ["init", "--quiet"], repo);
  first = commit("Sample 1.0.0");
  const manifest = JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8"));
  manifest.version = "1.0.1";
  writeFileSync(join(repo, "manifest.json"), JSON.stringify(manifest, null, 2));
  second = commit("Sample 1.0.1");
});

// A folder with index.json listing apps, signed by key.
function index(apps: object[], key = signer, extra: object = {}): string {
  const dir = join(scratch, `index-${++count}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "index.json"), JSON.stringify({ schema: 1, date: "2026-10-23T00:00:00Z", apps, ...extra }, null, 2));
  sh("gpg", ["--batch", "--yes", "--local-user", key, "--detach-sign", "--output", join(dir, "index.json.sig"), join(dir, "index.json")]);
  return dir;
}

function sample(commitId = first, version = "1.0.0", more: object = {}): object {
  return { id: "agentv.sample", tier: "official", name: "Sample", version, repo: `file://${repo}`, commit: commitId, ...more };
}

function apps(): string {
  return join(scratch, `apps-${++count}`);
}

async function refused(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: Error) => {
    assert.ok(error instanceof IndexError, `expected an IndexError, got ${error}`);
    assert.match(error.message, pattern);
    return true;
  });
}

test("S2.1 a sample app installs from a signed test index", async () => {
  const dir = apps();
  const installed = await installFromIndex("agentv.sample", index([sample()]), dir, keyring);
  assert.equal(installed.version, "1.0.0");
  assert.equal(installed.tier, "official");
  assert.ok(existsSync(join(dir, "agentv.sample", "manifest.json")));
  assert.ok(existsSync(join(dir, "agentv.sample", "app.ts")));
  assert.ok(!existsSync(join(dir, "agentv.sample", ".git")), "the app's folder has no git history");
  const record = await readInstalled(dir);
  assert.equal(record["agentv.sample"].commit, first);
  assert.deepEqual(readdirSync(dir).sort(), ["agentv.sample", "installed.json"]);
});

test("S2.1 a tampered index is refused, and nothing is installed", async () => {
  const dir = apps();
  const source = index([sample()]);
  const text = readFileSync(join(source, "index.json"), "utf8").replace(first, second);
  writeFileSync(join(source, "index.json"), text);
  await refused(installFromIndex("agentv.sample", source, dir, keyring), /isn't signed by AgenTV's key/);
  assert.ok(!existsSync(join(dir, "agentv.sample")));
});

test("an index signed by another key is refused", async () => {
  await refused(installFromIndex("agentv.sample", index([sample()], otherSigner), apps(), keyring), /isn't signed by AgenTV's key/);
});

test("an index without a signature is refused", async () => {
  const source = index([sample()]);
  rmSync(join(source, "index.json.sig"));
  await refused(installFromIndex("agentv.sample", source, apps(), keyring), /has no signature/);
});

test("the box's key has to be there", async () => {
  await refused(loadIndex(index([sample()]), join(scratch, "missing.asc")), /AgenTV's key isn't on this box/);
});

test("an app that isn't in the index isn't installed", async () => {
  await refused(installFromIndex("agentv.other", index([sample()]), apps(), keyring), /isn't in the app index/);
});

test("an app that fails the contract's checks isn't installed, and leaves nothing behind", async () => {
  const dir = apps();
  // A community listing can't carry an agentv.* app.
  await refused(installFromIndex("agentv.sample", index([sample(first, "1.0.0", { tier: "community" })]), dir, keyring), /agentv\.\*/);
  assert.deepEqual(readdirSync(dir), []);
});

test("the manifest has to be the app and version the index names", async () => {
  await refused(installFromIndex("agentv.sample", index([sample(first, "2.0.0")]), apps(), keyring), /says agentv\.sample 1\.0\.0/);
});

test("a commit the repo doesn't have isn't installed", async () => {
  await refused(installFromIndex("agentv.sample", index([sample("0".repeat(40))]), apps(), keyring), /couldn't fetch agentv\.sample/);
});

test("an app that says it's built in isn't installed from the index, since built-ins come only with AgenTV", async () => {
  const path = join(repo, "manifest.json");
  const before = readFileSync(path, "utf8");
  const manifest = JSON.parse(before);
  manifest.version = "1.0.2";
  manifest.tv.runtime = "builtin";
  delete manifest.tv.homeUrl;
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  const builtin = commit("Sample 1.0.2, built in");
  writeFileSync(path, before);
  commit("Sample, back to 1.0.1");
  const dir = apps();
  await refused(installFromIndex("agentv.sample", index([sample(builtin, "1.0.2")]), dir, keyring), /built in/);
  assert.deepEqual(await readInstalled(dir), {});
});

test("installing a newer version replaces the old one", async () => {
  const dir = apps();
  await installFromIndex("agentv.sample", index([sample()]), dir, keyring);
  await installFromIndex("agentv.sample", index([sample(second, "1.0.1")]), dir, keyring);
  const manifest = JSON.parse(readFileSync(join(dir, "agentv.sample", "manifest.json"), "utf8"));
  assert.equal(manifest.version, "1.0.1");
  assert.equal((await readInstalled(dir))["agentv.sample"].commit, second);
  assert.deepEqual(readdirSync(dir).sort(), ["agentv.sample", "installed.json"]);
});

test("an app can be removed", async () => {
  const dir = apps();
  await installFromIndex("agentv.sample", index([sample()]), dir, keyring);
  await removeApp("agentv.sample", dir);
  assert.ok(!existsSync(join(dir, "agentv.sample")));
  assert.deepEqual(await readInstalled(dir), {});
  await refused(removeApp("agentv.sample", dir), /isn't installed/);
  await refused(removeApp("../etc", dir), /isn't an app id/);
});

test("the index has to have the shape this box understands", () => {
  const entry = sample() as Record<string, unknown>;
  assert.throws(() => parseIndex("{"), /isn't valid JSON/);
  assert.throws(() => parseIndex(JSON.stringify({ schema: 2, apps: [] })), /schema 1/);
  assert.throws(() => parseIndex(JSON.stringify({ schema: 1, apps: [{ ...entry, commit: "main" }] })), /exact commit/);
  assert.throws(() => parseIndex(JSON.stringify({ schema: 1, apps: [{ ...entry, repo: "http://example.org/x" }] })), /https/);
  assert.throws(() => parseIndex(JSON.stringify({ schema: 1, apps: [{ ...entry, tier: "local" }] })), /no tier/);
  assert.throws(() => parseIndex(JSON.stringify({ schema: 1, apps: [entry, entry] })), /twice/);
  assert.throws(() => parseIndex(JSON.stringify({ schema: 1, apps: [{ ...entry, id: "../x" }] })), /isn't valid/);
});

test("the index can come from an address", async () => {
  const source = index([sample()]);
  const server = createServer((request, response) => {
    const name = request.url?.split("/").pop() ?? "";
    if (!["index.json", "index.json.sig"].includes(name)) {
      response.writeHead(404).end();
      return;
    }
    response.end(readFileSync(join(source, name)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const loaded = await loadIndex(`http://127.0.0.1:${port}/index`, keyring);
    assert.equal(loaded.apps[0].id, "agentv.sample");
    await assert.rejects(loadIndex(`http://127.0.0.1:${port}/nothing/`, join(scratch, "missing.asc")));
  } finally {
    server.close();
  }
});
