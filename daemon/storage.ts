// Where the box's own media is (ADR-017, ADR-012): folders on the box, USB
// drives and NAS shares (SMB or NFS), set up once and shared by Music and,
// in stage 5, the background sources. It runs in the TV session, as the
// person the box logs in, since that's who can read their folders, mount a
// USB drive through udisks2 and a share through gvfs (Omarchy ships both).
//
// An SMB share with a user name is root's to mount (ADR-038). Its password
// goes in a drop folder only root can read, where agentv-share.path starts
// bin/agentv-share-store as root to keep it and mount the share read-only,
// at boot too. The TV session never has the password again: it reads the
// files from that mount, and what happened from /etc/agentv/shares.json.
// NFS shares, and SMB shares with no user, mount through gvfs, as before.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  // A share root mounts: why it isn't there, when root said, such as the
  // NAS turning down its password, or that it needs its password again.
  error?: string;
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
  if (/[\x00-\x1f\\]/.test(uri)) return "a share's address can't have that in it";
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
  return `${url.hostname}${decodeURIComponent(url.pathname.replace(/\/+$/, ""))}`;
}

// Whether root mounts a share (ADR-038): SMB with a user name.
export function rootShare(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "smb:" && url.username !== "";
  } catch {
    return false;
  }
}

// What agentv-share-store says of the shares it mounts.
interface RootStatus {
  uri: string;
  path: string;
  mounted: boolean;
  error?: string;
  at?: string;
}

// The words for what gio's mount said, or didn't.
export function gioProblem(uri: string, message: string): string {
  const user = new URL(uri).username;
  if (/not mounted|Command failed|^$/.test(message.trim()) && !user) return `${shareName(uri)} wants a user name and password. add it as smb://you@${shareName(uri)}`;
  return message;
}

export interface StorageOptions {
  config?: string; // where the folders and shares are kept
  run?: Run;
  home?: string;
  drop?: string; // where a share's password goes for root: /var/lib/agentv/share-drop
  status?: string; // what root says: /etc/agentv/shares.json
  mounted?: () => Promise<Set<string>>; // where something is mounted now
  waitMs?: number; // how long root may take
}

// Where something is mounted now, from the kernel.
async function mountPoints(): Promise<Set<string>> {
  const info = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  // The fifth field, with the kernel's escapes for spaces and the like.
  return new Set(info.split("\n").map((line) => (line.split(" ")[4] ?? "").replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))).filter(Boolean));
}

export class Storage {
  private config: string;
  private run: Run;
  private home: string;
  private drop: string;
  private statusPath: string;
  private mounted: () => Promise<Set<string>>;
  private waitMs: number;

  constructor(options: StorageOptions = {}) {
    this.home = options.home ?? homedir();
    const state = process.env.XDG_STATE_HOME ?? join(this.home, ".local/state");
    this.config = options.config ?? join(state, "agentv/storage.json");
    this.run = options.run ?? run;
    this.drop = options.drop ?? "/var/lib/agentv/share-drop";
    this.statusPath = options.status ?? "/etc/agentv/shares.json";
    this.mounted = options.mounted ?? mountPoints;
    this.waitMs = options.waitMs ?? 45_000;
  }

  private async rootStatus(): Promise<RootStatus[]> {
    try {
      const data = JSON.parse(await readFile(this.statusPath, "utf8"));
      return Object.values((data?.shares ?? {}) as Record<string, RootStatus>).filter((share) => typeof share?.uri === "string");
    } catch {
      return [];
    }
  }

  // Hands root a request about a share: add (with its password), mount or
  // remove. Waits for root to say, and gives back what it said.
  private async ask(op: "add" | "mount" | "remove", uri: string, password?: string): Promise<RootStatus | null> {
    const before = (await this.rootStatus()).find((share) => share.uri === uri)?.at;
    const name = `${Date.now()}-${randomBytes(6).toString("hex")}`;
    // Written whole, then renamed in, so root never reads half of it. The
    // folder lets anyone add but only root read (1733), and the file is
    // this person's alone.
    await writeFile(join(this.drop, `.${name}`), JSON.stringify({ op, uri, ...(password === undefined ? {} : { password }) }), { mode: 0o600 });
    await rename(join(this.drop, `.${name}`), join(this.drop, `${name}.json`));
    const until = Date.now() + this.waitMs;
    while (Date.now() < until) {
      await new Promise((done) => setTimeout(done, 200));
      const now = (await this.rootStatus()).find((share) => share.uri === uri);
      if (op === "remove" ? !now : now && now.at !== before) return now ?? null;
    }
    throw new Error("the box didn't answer about that share in time");
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
    const root = saved.shares.some(rootShare) ? await this.rootStatus() : [];
    const mounted = root.length ? await this.mounted() : new Set<string>();
    for (const uri of saved.shares) {
      if (rootShare(uri)) {
        // Root's word and the kernel's: after a restart, the word can be
        // from before it.
        const said = root.find((share) => share.uri === uri);
        const here = Boolean(said?.mounted && mounted.has(said.path));
        const error = here ? undefined : (said?.error ?? (said ? undefined : "it needs its password again"));
        shares.push({ id: `share:${uri}`, kind: "share", name: shareName(uri), path: here ? said!.path : null, available: here, ...(error ? { error } : {}) });
        continue;
      }
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

  // Mounts a share that's away: one root mounts, from the password root
  // keeps; one through gvfs, anonymous, or with a password given now, which
  // gvfs doesn't keep (an NFS share with a user name in its address).
  async mountShare(uri: string, password?: string): Promise<string> {
    const why = shareProblem(uri);
    if (why) throw new Error(why);
    if (rootShare(uri)) {
      const said = await this.ask("mount", uri);
      if (!said?.mounted) throw new Error(said?.error ?? `${shareName(uri)} didn't mount`);
      return said.path;
    }
    const already = await this.sharePath(uri);
    if (already) return already;
    const user = new URL(uri).username;
    if (user && password === undefined) throw new Error(`${shareName(uri)} needs its password`);
    const args = user ? ["mount", uri] : ["mount", "--anonymous", uri];
    // gio asks for the domain and the password on stdin.
    try {
      await this.run("gio", args, user ? `\n${password ?? ""}\n` : "");
    } catch (error) {
      throw new Error(gioProblem(uri, (error as Error).message));
    }
    const path = await this.sharePath(uri);
    if (!path) throw new Error(`${shareName(uri)} didn't mount`);
    return path;
  }

  // Adds a share and mounts it. An SMB share with a user name goes to root
  // with its password, which root keeps and nothing here does.
  async addShare(uri: string, password?: string): Promise<Source> {
    const why = shareProblem(uri);
    if (why) throw new Error(why);
    let path: string;
    if (rootShare(uri)) {
      if (!password) throw new Error("a share with a user name needs its password");
      if (/[\r\n]/.test(password)) throw new Error("a password can't have a line break in it");
      const said = await this.ask("add", uri, password);
      if (!said?.mounted) throw new Error(said?.error ?? `${shareName(uri)} didn't mount`);
      path = said.path;
    } else {
      path = await this.mountShare(uri, password);
    }
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

  // Forgets a source. Forgetting a share root mounts takes its password and
  // its mount away too.
  async remove(id: string): Promise<boolean> {
    const saved = await this.saved();
    const share = saved.shares.find((uri) => `share:${uri}` === id);
    if (share && rootShare(share)) await this.ask("remove", share).catch(() => null);
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
