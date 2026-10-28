// Shared to the TV (ADR-050, S5.10): a link, a photo or a video a paired
// phone sent, each kept in /var/lib/agentv/shared with who sent it, until
// someone removes it from Apps → Shared. The TV asks first, with Open and
// Not now, and only once nothing's playing: the daemon keeps which ones it
// hasn't had an answer for.
//
// A child's profile takes shares only once an adult has allowed it, which
// is kept here too, by profile. Each file is checked to be what it says by
// its own first bytes, as the backgrounds are, and only links to a web page
// are taken.

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { creditText, imageType, MAX_BYTES, type ImageType } from "./backgrounds.ts";

export type VideoType = "video/mp4" | "video/webm";
export type ShareKind = "link" | "photo" | "video";

export interface Share {
  id: string;
  kind: ShareKind;
  // Who sent it: whose profile was on the TV, on which phone.
  from: string;
  // The profile it was sent to.
  to: string;
  at: string;
  // A link, or a file's name as it came, or the link's own site.
  title: string;
  url?: string;
  // A photo's credit line, as the sender gave it (ADR-012).
  credit?: string | null;
  type?: ImageType | VideoType;
  size?: number;
  // Open or Not now was chosen on the TV.
  answered: boolean;
}

interface Kept {
  shares: Share[];
  // The children's profiles an adult allowed to take shares.
  allowed: string[];
}

// A video is at most 4 GiB, which is a couple of hours of a phone's 1080p,
// and a link at most as long as browsers take.
export const MAX_VIDEO = 4 * 1024 ** 3;
export const MAX_URL = 2048;

const ID = /^[0-9a-f]{16}$/;
const EXTENSIONS: Record<ImageType | VideoType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" };

// What a video is, from its first bytes: an MP4 or QuickTime file's ftyp
// box, or WebM's EBML header. Those are what the TV's Chromium plays.
export function videoType(head: Buffer): VideoType | null {
  if (head.length >= 12 && head.subarray(4, 8).toString("latin1") === "ftyp") return "video/mp4";
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  return null;
}

// A link the TV can open: a web page, http or https, with no name or
// password in it. Its site is what the notice says.
export function cleanLink(value: unknown): { url: string; site: string } | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: "a link to send" };
  if (value.length > MAX_URL) return { error: `a link of up to ${MAX_URL} characters` };
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { error: "that isn't a link the tv can open" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "a link to a web page, http or https" };
  if (url.username || url.password) return { error: "a link without a name and password in it" };
  return { url: url.href, site: url.hostname.replace(/^www\./, "") };
}

// A file's name as it came, one line, for its title.
function fileTitle(name: unknown, fallback: string): string {
  return creditText(name, 80) ?? fallback;
}

export class Shared {
  private dir: string;
  // Changes to shared.json, one after another, so two shares at once don't
  // write over each other.
  private changing: Promise<unknown> = Promise.resolve();

  constructor(options: { dir: string }) {
    this.dir = options.dir;
  }

  private change<T>(change: (kept: Kept) => Promise<{ kept?: Kept; result: T }>): Promise<T> {
    const next = this.changing.then(async () => {
      const { kept, result } = await change(await this.kept());
      if (kept) await this.save(kept);
      return result;
    });
    this.changing = next.catch(() => {});
    return next;
  }

  private async kept(): Promise<Kept> {
    let data: Partial<Kept>;
    try {
      data = JSON.parse(await readFile(join(this.dir, "shared.json"), "utf8"));
    } catch {
      return { shares: [], allowed: [] };
    }
    const shares = (Array.isArray(data.shares) ? data.shares : []).filter(
      (share): share is Share => typeof share?.id === "string" && ID.test(share.id) && ["link", "photo", "video"].includes(share.kind) && typeof share.to === "string",
    );
    const allowed = (Array.isArray(data.allowed) ? data.allowed : []).filter((id): id is string => typeof id === "string");
    return { shares, allowed };
  }

  private async save(kept: Kept): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const next = join(this.dir, ".shared.json.next");
    await writeFile(next, `${JSON.stringify(kept, null, 2)}\n`);
    await rename(next, join(this.dir, "shared.json"));
  }

  // Every share, newest first.
  async list(): Promise<Share[]> {
    return (await this.kept()).shares;
  }

  async get(id: string): Promise<Share | null> {
    return ID.test(id) ? ((await this.list()).find((share) => share.id === id) ?? null) : null;
  }

  // The file of a photo or a video, where it is and what it is.
  async file(id: string): Promise<{ path: string; type: ImageType | VideoType; size: number } | null> {
    const share = await this.get(id);
    if (!share?.type) return null;
    const path = join(this.dir, `${share.id}.${EXTENSIONS[share.type]}`);
    const found = await stat(path).catch(() => null);
    return found ? { path, type: share.type, size: found.size } : null;
  }

  private keep(share: Share): Promise<Share> {
    return this.change(async (kept) => ({ kept: { ...kept, shares: [share, ...kept.shares] }, result: share }));
  }

  private fresh(kind: ShareKind, title: string, who: { from: string; to: string }): Share {
    return { id: randomBytes(8).toString("hex"), kind, from: who.from, to: who.to, at: new Date().toISOString(), title, answered: false };
  }

  async addLink(value: unknown, who: { from: string; to: string }): Promise<{ share?: Share; error?: string }> {
    const link = cleanLink(value);
    if ("error" in link) return link;
    return { share: await this.keep({ ...this.fresh("link", link.site, who), url: link.url }) };
  }

  async addPhoto(body: Buffer, credit: unknown, who: { from: string; to: string }): Promise<{ share?: Share; error?: string }> {
    if (body.length > MAX_BYTES) return { error: "that photo is too big: 15 mb at most" };
    const type = imageType(body);
    if (!type) return { error: "a photo the tv can show: jpeg, png or webp" };
    const share: Share = { ...this.fresh("photo", "a photo", who), credit: creditText(credit), type, size: body.length };
    await mkdir(this.dir, { recursive: true });
    const name = `${share.id}.${EXTENSIONS[type]}`;
    await writeFile(join(this.dir, `.${name}.next`), body);
    await rename(join(this.dir, `.${name}.next`), join(this.dir, name));
    return { share: await this.keep(share) };
  }

  // A video, written to disk as it comes rather than held in memory, and
  // kept only once it's all here and is a video the TV plays.
  async addVideo(body: Readable, name: unknown, who: { from: string; to: string }, most = MAX_VIDEO): Promise<{ share?: Share; error?: string }> {
    const share = this.fresh("video", fileTitle(name, "a video"), who);
    await mkdir(this.dir, { recursive: true });
    const part = join(this.dir, `.${share.id}.part`);
    let size = 0;
    let head = Buffer.alloc(0);
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        if (size > most) done(new Error(`that video is too big: ${Math.round(most / 1024 ** 3)} gb at most`));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(body, count, createWriteStream(part));
    } catch (error) {
      await rm(part, { force: true });
      return { error: (error as Error).message.includes("too big") ? (error as Error).message : "the video didn't all come: try again" };
    }
    const type = videoType(head);
    if (!type || size === 0) {
      await rm(part, { force: true });
      return { error: "a video the tv plays: mp4 or webm" };
    }
    await rename(part, join(this.dir, `${share.id}.${EXTENSIONS[type]}`));
    return { share: await this.keep({ ...share, type, size }) };
  }

  // Open or Not now on the TV: it doesn't ask again.
  answer(id: string): Promise<Share | null> {
    return this.change(async (kept) => {
      const share = kept.shares.find((one) => one.id === id);
      if (!share) return { result: null };
      share.answered = true;
      return { kept, result: share };
    });
  }

  // Taken off the box, with its file.
  remove(id: string): Promise<boolean> {
    return this.change(async (kept) => {
      const share = kept.shares.find((one) => one.id === id);
      if (!share) return { result: false };
      if (share.type) await rm(join(this.dir, `${share.id}.${EXTENSIONS[share.type]}`), { force: true });
      return { kept: { ...kept, shares: kept.shares.filter((one) => one.id !== id) }, result: true };
    });
  }

  // Which children's profiles take shares.
  async allowed(): Promise<string[]> {
    return (await this.kept()).allowed;
  }

  allow(profile: string, on: boolean): Promise<string[]> {
    return this.change(async (kept) => {
      const allowed = kept.allowed.filter((id) => id !== profile);
      if (on) allowed.push(profile);
      return { kept: { ...kept, allowed }, result: allowed };
    });
  }

  // A profile taken off takes its shares and its allowance with it.
  forget(profile: string): Promise<void> {
    return this.change(async (kept) => {
      for (const share of kept.shares) if (share.to === profile && share.type) await rm(join(this.dir, `${share.id}.${EXTENSIONS[share.type]}`), { force: true });
      return { kept: { shares: kept.shares.filter((share) => share.to !== profile), allowed: kept.allowed.filter((id) => id !== profile) }, result: undefined };
    });
  }
}
