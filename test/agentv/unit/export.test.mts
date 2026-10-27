// Export (daemon/export.ts, ADR-045): an app the agent built, as a .zip for
// an adult's phone. The zip is read back here as any unzip reads it; the
// TV offers it, an adult's phone saves it, and an app that drives a
// service's own site, or isn't a local one, is never exported.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { crc32, inflateRawSync } from "node:zlib";
import type { Manifest } from "../../../apps/contract/manifest.ts";
import { installLocal } from "../../../daemon/apps/install.ts";
import { exportRefusal, zipFolder } from "../../../daemon/export.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-export-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The files in a zip, from its central directory, each inflated and its CRC
// checked, as unzip does.
function unzip(zip: Buffer): Record<string, string> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "it has an end of central directory");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = inflateRawSync(zip.subarray(start, start + size));
    assert.equal(crc32(data) >>> 0, crc, `${name}'s CRC`);
    files[name] = data.toString("utf8");
    at += 46 + nameLength + extra;
  }
  return files;
}

test("ADR-045 Export is the package as a zip any unzip reads, with its manifest and licence, and never its fixtures", () => {
  const dir = join(scratch, "blocks");
  cpSync(join(ROOT, "test/agentv/fixtures/apps/blocks"), dir, { recursive: true });
  mkdirSync(join(dir, "fixtures"));
  writeFileSync(join(dir, "fixtures", "page.html"), "<p>a saved page</p>");
  writeFileSync(join(dir, "LICENSE"), "MIT\n");
  symlinkSync("/etc/hostname", join(dir, "elsewhere"));
  const files = unzip(zipFolder(dir, "local.blocks-1.0.0"));
  assert.ok("local.blocks-1.0.0/manifest.json" in files);
  assert.equal(files["local.blocks-1.0.0/LICENSE"], "MIT\n");
  assert.equal(files["local.blocks-1.0.0/manifest.json"], readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.ok(!Object.keys(files).some((name) => name.includes("/fixtures/")), "no saved pages leave the box");
  assert.ok(!("local.blocks-1.0.0/elsewhere" in files), "nor anything a link points to");
});

test("ADR-045 only a local app is exported, and never one that drives a service's own site (ADR-010)", () => {
  const manifest = (runtime: string) => ({ tv: { runtime } }) as unknown as Manifest;
  assert.equal(exportRefusal(manifest("page"), "local"), null);
  assert.equal(exportRefusal(manifest("native"), "local"), null);
  assert.match(exportRefusal(manifest("web"), "local")!, /drives a service's own site stays on this tv/);
  assert.match(exportRefusal(manifest("page"), "official")!, /only an app your agent made/);
});

test("ADR-045 the TV offers an app, an adult's phone saves it, and a child's doesn't", async () => {
  const { Daemon } = await import("../../../daemon/server.ts");
  const base = join(scratch, "daemon");
  mkdirSync(join(base, "root", "setup"), { recursive: true });
  const apps = join(base, "apps");
  const page = join(scratch, "page-app");
  cpSync(join(ROOT, "test/agentv/fixtures/apps/blocks"), page, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(page, "manifest.json"), "utf8"));
  writeFileSync(join(page, "manifest.json"), JSON.stringify({ ...manifest, id: "local.blocks", author: "your agent" }));
  await installLocal(page, apps, async () => true);
  const web = join(scratch, "web-app");
  cpSync(join(ROOT, "test/agentv/fixtures/stand-in-service/app"), web, { recursive: true });
  await installLocal(web, apps, async () => true);

  const daemon = new Daemon({ root: join(base, "root"), state: join(base, "state"), port: 0, log: () => {}, builtins: null, apps, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1", keyStatus: join(base, "key.json") });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  const lan = `http://127.0.0.1:${daemon.lanPort}`;
  try {
    const send = (method: string, path: string, body?: unknown, grant?: string) =>
      fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const code = (await (await send("POST", "/api/phones/pair", {})).json()).pairing.code;
    const token = (await (await fetch(`${lan}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "iphone" }) })).json()).token;
    const phone = (path: string) => fetch(`${lan}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const state = async () => (await (await phone("/api/phone/state")).json()) as { export: { id: string } | null };

    assert.equal((await state()).export, null);
    assert.match((await (await send("POST", "/api/apps/local.stand-in/export", {})).json()).error, /drives a service's own site/);
    assert.equal((await send("POST", "/api/apps/local.blocks/export", {})).status, 200);
    assert.deepEqual((await state()).export, { id: "local.blocks", name: manifest.name, version: manifest.version });
    assert.equal((await phone("/api/phone/apps/local.stand-in/export")).status, 400, "not even asked for directly");

    const saved = await phone("/api/phone/apps/local.blocks/export");
    assert.equal(saved.headers.get("content-type"), "application/zip");
    assert.match(saved.headers.get("content-disposition")!, new RegExp(`filename="local\\.blocks-${manifest.version.replace(/\./g, "\\.")}\\.zip"`));
    const files = unzip(Buffer.from(await saved.arrayBuffer()));
    assert.ok(`local.blocks-${manifest.version}/manifest.json` in files);
    assert.equal((await state()).export, null, "the offer goes once it's saved");

    // A child watching sees no offer, and can't save one.
    await send("PUT", "/api/pin", { pin: "2468" });
    const grant = (await (await send("POST", "/api/pin/check", { pin: "2468" })).json()).grant;
    const child = (await (await send("POST", "/api/viewers", { name: "leo", role: "child" }, grant)).json()).profile;
    await send("POST", "/api/viewer", { id: child.id });
    assert.equal((await phone("/api/phone/apps/local.blocks/export")).status, 403);
  } finally {
    await daemon.close();
  }
});
