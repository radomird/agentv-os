// Where the box's own media is (ADR-017, ADR-012): folders on the box, USB
// drives and NAS shares (SMB or NFS), set up once and shared by Music and,
// in stage 5, the background sources. It runs in the TV session, as the
// person the box logs in, since that's who can read their folders, mount a
// USB drive through udisks2 and a share through gvfs (Omarchy ships both).
//
// A share's password, if it has one, goes to gvfs's mount once and is never
// kept (ADR-032): after a restart, the share asks again.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SourceKind = "folder" | "usb" | "share";

export interface Source {
  id: string; // "folder:/home/radomir/Music", "usb:/dev/sdb1", "share:smb://nas/music"
  kind: SourceKind;
  name: string; // what the TV calls it: "music", "STICK", "nas/music"
  path: string | null; // where its files are, once it's there
  available: boolean;
}

interface Saved {
  folders: string[];
  shares: string[];
}

export type Run = (command: string, args: string[], input?: string) => Promise<string>;

export const run: Run = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim().split("\n").pop() || error.message));
      else resolve(String(stdout));
    });
    if (input !== undefined) child.stdin?.end(input);
  });

// A share's address: smb:// or nfs://, a host and a path, and a user name at
// most, never a password.
export function shareProblem(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "a share's address looks like smb://nas/music or nfs://nas/export/music";
  }
  if (url.protocol !== "smb:" && url.protocol !== "nfs:") return "a share is smb:// or nfs://";
  if (!url.hostname) return "a share's address names its server";
  if (url.password) return "a share's address doesn't hold its password; it's asked for when it mounts";
  if (url.pathname.replace(/\/+$/, "") === "") return "a share's address names the share, like smb://nas/music";
  return null;
}

// The name the TV gives a share: its server and its path.
function shareName(uri: string): string {
  const url = new URL(uri);
  return `${url.hostname}${url.pathname.replace(/\/+$/, "")}`;
}

export interface StorageOptions {
  config?: string; // where the folders and shares are kept
  run?: Run;
  home?: string;
}

export class Storage {
  private config: string;
  private run: Run;
  private home: string;

  constructor(options: StorageOptions = {}) {
    this.home = options.home ?? homedir();
    const state = process.env.XDG_STATE_HOME ?? join(this.home, ".local/state");
    this.config = options.config ?? join(state, "agentv/storage.json");
    this.run = options.run ?? run;
  }

  private async saved(): Promise<Saved> {
    try {
      const saved = JSON.parse(await readFile(this.config, "utf8"));
      return { folders: Array.isArray(saved.folders) ? saved.folders : [], shares: Array.isArray(saved.shares) ? saved.shares : [] };
    } catch {
      // A new box: the person's Music folder, when there is one.
      const music = join(this.home, "Music");
      return { folders: existsSync(music) ? [music] : [], shares: [] };
    }
  }

  private async save(saved: Saved): Promise<void> {
    await mkdir(dirname(this.config), { recursive: true });
    await writeFile(`${this.config}.next`, `${JSON.stringify(saved, null, 2)}\n`);
    await rename(`${this.config}.next`, this.config);
  }

  // Every source: the folders, the USB drives plugged in now, and the shares.
  async sources(): Promise<Source[]> {
    const saved = await this.saved();
    const folders: Source[] = saved.folders.map((path) => ({
      id: `folder:${path}`,
      kind: "folder",
      name: path.split("/").filter(Boolean).pop()?.toLowerCase() ?? path,
      path,
      available: existsSync(path),
    }));
    const shares: Source[] = [];
    for (const uri of saved.shares) {
      const path = await this.sharePath(uri);
      shares.push({ id: `share:${uri}`, kind: "share", name: shareName(uri), path, available: path !== null });
    }
    return [...folders, ...(await this.usb()), ...shares];
  }

  // USB drives, from lsblk: partitions on a USB disk with a filesystem.
  async usb(): Promise<Source[]> {
    let tree: { blockdevices?: Block[] };
    try {
      tree = JSON.parse(await this.run("lsblk", ["-J", "-o", "PATH,TRAN,FSTYPE,LABEL,MOUNTPOINTS,TYPE"]));
    } catch {
      return [];
    }
    const found: Source[] = [];
    const visit = (device: Block, usb: boolean) => {
      const onUsb = usb || device.tran === "usb";
      const mount = (device.mountpoints ?? []).find((point): point is string => typeof point === "string" && point !== "");
      // A partition with a filesystem, or a whole stick formatted without a
      // partition table.
      const usable = onUsb && device.fstype && device.fstype !== "swap" && (device.type === "part" || !device.children?.length);
      if (usable) {
        found.push({
          id: `usb:${device.path}`,
          kind: "usb",
          name: device.label || device.path.split("/").pop() || device.path,
          path: mount ?? null,
          available: Boolean(mount),
        });
      }
      for (const child of device.children ?? []) visit(child, onUsb);
    };
    for (const device of tree.blockdevices ?? []) visit(device, false);
    return found;
  }

  // Mounts a USB drive through udisks2, where the person at the TV may.
  async mountUsb(device: string): Promise<string> {
    const drive = (await this.usb()).find((source) => source.id === `usb:${device}`);
    if (!drive) throw new Error(`${device} isn't a USB drive here`);
    if (drive.path) return drive.path;
    const said = await this.run("udisksctl", ["mount", "--no-user-interaction", "-b", device]);
    const match = / at (.+?)\.?\s*$/.exec(said.trim());
    if (!match) throw new Error(`udisks didn't say where it mounted ${device}`);
    return match[1];
  }

  // Where a share's files are once gvfs has it mounted, or null.
  private async sharePath(uri: string): Promise<string | null> {
    try {
      const info = await this.run("gio", ["info", "-a", "standard::type", uri]);
      const local = /^local path: (.+)$/m.exec(info);
      return local ? local[1] : null;
    } catch {
      return null;
    }
  }

  // Mounts a share through gvfs: anonymous unless it has a user name, and
  // then with the password given now, which isn't kept.
  async mountShare(uri: string, password?: string): Promise<string> {
    const why = shareProblem(uri);
    if (why) throw new Error(why);
    const already = await this.sharePath(uri);
    if (already) return already;
    const user = new URL(uri).username;
    const args = user ? ["mount", uri] : ["mount", "--anonymous", uri];
    // gio asks for the domain and the password on stdin.
    await this.run("gio", args, user ? `\n${password ?? ""}\n` : "");
    const path = await this.sharePath(uri);
    if (!path) throw new Error(`${shareName(uri)} didn't mount`);
    return path;
  }

  async addShare(uri: string, password?: string): Promise<Source> {
    const path = await this.mountShare(uri, password);
    const saved = await this.saved();
    if (!saved.shares.includes(uri)) saved.shares.push(uri);
    await this.save(saved);
    return { id: `share:${uri}`, kind: "share", name: shareName(uri), path, available: true };
  }

  async addFolder(path: string): Promise<Source> {
    const full = resolve(this.home, path);
    if (!existsSync(full)) throw new Error(`there's no folder at ${full}`);
    const saved = await this.saved();
    if (!saved.folders.includes(full)) saved.folders.push(full);
    await this.save(saved);
    return { id: `folder:${full}`, kind: "folder", name: full.split("/").filter(Boolean).pop() ?? full, path: full, available: true };
  }

  async remove(id: string): Promise<boolean> {
    const saved = await this.saved();
    const before = saved.folders.length + saved.shares.length;
    saved.folders = saved.folders.filter((path) => `folder:${path}` !== id);
    saved.shares = saved.shares.filter((uri) => `share:${uri}` !== id);
    if (saved.folders.length + saved.shares.length === before) return false;
    await this.save(saved);
    return true;
  }

  // The paths to read media from now: folders, the USB drives that are
  // mounted, and the shares that are.
  async paths(): Promise<{ source: Source; path: string }[]> {
    return (await this.sources()).filter((source) => source.available && source.path).map((source) => ({ source, path: source.path! }));
  }
}

interface Block {
  path: string;
  tran?: string | null;
  fstype?: string | null;
  label?: string | null;
  type?: string;
  mountpoints?: (string | null)[];
  children?: Block[];
}
