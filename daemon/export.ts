// Export (ADR-045): an app the agent built, as a file for the person's
// phone, the package as a .zip with its manifest and licence. The box's
// copy is the installed one, so its fixtures, which can hold a service's
// saved pages, never leave. An app that drives a service's own site (a web
// app) is never exported, since AgenTV can't tell that the service permits
// it (ADR-010).

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import type { Manifest } from "../apps/contract/manifest.ts";

const FILES_MAX = 2000;
const BYTES_MAX = 50 * 1024 * 1024;

// Why an installed app can't be exported, or null when it can.
export function exportRefusal(manifest: Manifest, tier: string): string | null {
  if (tier !== "local") return "only an app your agent made is exported";
  if (manifest.tv.runtime === "web") return "an app that drives a service's own site stays on this tv";
  return null;
}

// Every file in the package, by its path in it, without links, fixtures or
// a git folder: what the .zip has, and what a push puts in the repo.
export function packageFiles(dir: string): { path: string; data: Buffer }[] {
  const found: { path: string; data: Buffer }[] = [];
  let bytes = 0;
  const walk = (at: string, prefix: string) => {
    for (const name of readdirSync(at).sort()) {
      if ((!prefix && name === "fixtures") || name === ".git") continue;
      const path = join(at, name);
      const stat = lstatSync(path);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (stat.isDirectory()) walk(path, rel);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (found.length >= FILES_MAX || bytes > BYTES_MAX) throw new Error("the app is too big to export");
        found.push({ path: rel, data: readFileSync(path) });
      }
    }
  };
  walk(dir, "");
  return found;
}

// A .zip of the folder, as any unzip reads it: each file deflated, with its
// CRC, and the central directory at the end.
export function zipFolder(dir: string, top: string, at = new Date()): Buffer {
  const time = ((at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1)) & 0xffff;
  const date = (((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()) & 0xffff;
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of packageFiles(dir)) {
    const name = Buffer.from(`${top}/${file.path}`, "utf8");
    const packed = deflateRawSync(file.data);
    const crc = crc32(file.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names in UTF-8
    local.writeUInt16LE(8, 8); // deflated
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a plain file, rw-r--r--
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
