// Art from museum archives, as a background (ADR-012, board 13): The Met,
// the Art Institute of Chicago and Wikimedia Commons, each through its own
// public API, which needs no key. The daemon asks them, never the TV's
// page: a search gives works whose pictures can be shown, the TV's
// thumbnails come through the daemon from the archive's own image host, and
// the one picked is fetched whole and kept with its credit beside the
// household's photos. Nothing here reads an archive's web pages.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { imageType, MAX_BYTES, type ImageType } from "./backgrounds.ts";

export const ARCHIVE_IDS = ["met", "aic", "commons"] as const;
export type ArchiveId = (typeof ARCHIVE_IDS)[number];

export const ARCHIVES: { id: ArchiveId; name: string }[] = [
  { id: "met", name: "the met" },
  { id: "aic", name: "art institute of chicago" },
  { id: "commons", name: "wikimedia commons" },
];

// Where each archive's API is, and the hosts its pictures come from.
const ENDPOINTS: Record<ArchiveId, string> = {
  met: "https://collectionapi.metmuseum.org/public/collection",
  aic: "https://api.artic.edu/api/v1",
  commons: "https://commons.wikimedia.org/w/api.php",
};
const IMAGE_HOSTS = ["images.metmuseum.org", "www.artic.edu", "upload.wikimedia.org"];

// A work the TV can show, as the picker lists it.
export interface Art {
  archive: ArchiveId;
  id: string;
  title: string;
  artist: string | null;
  date: string | null;
  // The line the ambient screen shows under it.
  credit: string;
  // Its page at the archive, for app details and the phone.
  page: string | null;
}

// What the daemon keeps of a work while it's listed: where its pictures are.
interface Found extends Art {
  thumb: string;
  image: string;
  // A smaller one, for a work whose whole picture is too big to keep.
  fallback?: string;
}

const ID = /^\d{1,12}$/;
const THUMB_BYTES = 3 * 1024 * 1024;
const API_MS = 15_000;
const IMAGE_MS = 60_000;
const LIMIT = 12;
const MET_AT_ONCE = 4;

// Plain text from an archive's field, which can hold HTML (Commons does).
export function plain(value: unknown, most = 120): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&[a-z]+;/g, " ")
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, most) : null;
}

function creditOf(title: string, artist: string | null, date: string | null, archive: ArchiveId, licence?: string): string {
  const who = [artist, date].filter(Boolean).join(", ");
  const name = ARCHIVES.find((one) => one.id === archive)!.name;
  return [title, who, licence, name].filter(Boolean).join(" · ").slice(0, 200);
}

// A licence the TV can show a work under, as Commons names it: public
// domain, CC0, or a Creative Commons licence that asks for a credit, which
// the ambient screen gives. Null for anything else.
export function licenceOf(short: string | null): string | null {
  if (!short) return null;
  const text = short.toLowerCase().replace(/\s+/g, " ").trim();
  if (text === "public domain" || text === "pdm" || text.startsWith("pd-")) return "public domain";
  if (text === "cc0" || text === "cc0 1.0") return "cc0";
  const cc = /^cc by(-sa)? (\d\.\d)$/.exec(text);
  return cc ? `cc by${cc[1] ?? ""} ${cc[2]}` : null;
}

// Commons makes a thumbnail at any width: from a thumbnail's address, or
// from the original's, which a picture narrower than the TV comes as.
export function commonsThumb(url: string, width = 640): string {
  if (/\/\d+px-[^/]+$/.test(url)) return url.replace(/\/\d+px-([^/]+)$/, `/${width}px-$1`);
  return url.replace(/\/wikipedia\/commons\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)$/, `/wikipedia/commons/thumb/$1/$2/$3/${width}px-$3`);
}

export interface ArtOptions {
  // Where the thumbnails are kept: the daemon's own state.
  cache: string;
  userAgent: string;
  fetch?: typeof fetch;
  // Tests point the archives at their own server.
  endpoints?: Partial<Record<ArchiveId, string>>;
  imageHosts?: string[];
}

export class ArtArchives {
  private found = new Map<string, Found>();
  private options: ArtOptions;
  private endpoints: Record<ArchiveId, string>;
  private hosts: Set<string>;

  constructor(options: ArtOptions) {
    this.options = options;
    this.endpoints = { ...ENDPOINTS, ...options.endpoints };
    this.hosts = new Set(options.imageHosts ?? IMAGE_HOSTS);
  }

  private async get(url: string, ms: number, accept = "application/json"): Promise<Response> {
    const response = await (this.options.fetch ?? fetch)(url, {
      headers: { "User-Agent": this.options.userAgent, "AIC-User-Agent": this.options.userAgent, Accept: accept },
      signal: AbortSignal.timeout(ms),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`it answered ${response.status}`);
    return response;
  }

  private async json(url: string): Promise<any> {
    return (await this.get(url, API_MS)).json();
  }

  // Works matching the words, with pictures the TV can show.
  async search(archive: unknown, words: unknown): Promise<{ items?: Art[]; error?: string }> {
    if (!ARCHIVE_IDS.includes(archive as ArchiveId)) return { error: `an archive: ${ARCHIVE_IDS.join(", ")}` };
    const query = plain(words, 80);
    if (!query) return { error: "say what to look for" };
    let found: Found[];
    try {
      found = await this.find(archive as ArchiveId, query);
    } catch (error) {
      const name = ARCHIVES.find((one) => one.id === archive)!.name;
      return { error: `${name} didn't answer: ${(error as Error).message}` };
    }
    for (const item of found) this.found.set(`${item.archive}:${item.id}`, item);
    return { items: found.map(({ thumb, image, fallback, ...art }) => art) };
  }

  private async find(archive: ArchiveId, query: string): Promise<Found[]> {
    const base = this.endpoints[archive];
    if (archive === "met") {
      // The search lists works that aren't public domain too, so it asks
      // for more than it shows, and looks each one up, a few at a time, as
      // The Met turns away a burst, until there are enough.
      const search = await this.json(`${base}/v1.1/search?q=${encodeURIComponent(query)}&hasImages=true&isPublicDomain=true&limit=${LIMIT * 3}`);
      const ids: number[] = (Array.isArray(search?.objectIDs) ? search.objectIDs : []).filter((id: unknown) => Number.isInteger(id)).slice(0, LIMIT * 3);
      const works: Found[] = [];
      for (let at = 0; at < ids.length && works.length < LIMIT; at += MET_AT_ONCE) {
        const batch = await Promise.all(ids.slice(at, at + MET_AT_ONCE).map((id) => this.lookup("met", String(id)).catch(() => null)));
        works.push(...batch.filter((one): one is Found => one !== null));
      }
      return works.slice(0, LIMIT);
    }
    if (archive === "aic") {
      const fields = "id,title,image_id,artist_title,date_display,is_public_domain";
      const search = await this.json(`${base}/artworks/search?q=${encodeURIComponent(query)}&query[term][is_public_domain]=true&limit=${LIMIT}&fields=${fields}`);
      return (Array.isArray(search?.data) ? search.data : []).flatMap((work: any) => this.aic(work, search?.config?.iiif_url) ?? []);
    }
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      generator: "search",
      gsrsearch: `filetype:bitmap ${query}`,
      gsrnamespace: "6",
      gsrlimit: String(LIMIT * 2),
      prop: "imageinfo",
      iiprop: "url|mime|extmetadata",
      iiurlwidth: "3840",
      iiextmetadatafilter: "ObjectName|Artist|DateTimeOriginal|LicenseShortName",
    });
    const search = await this.json(`${base}?${params}`);
    return (Array.isArray(search?.query?.pages) ? search.query.pages : []).flatMap((page: any) => this.commons(page) ?? []).slice(0, LIMIT);
  }

  // One work again by its id, as when it's picked after the daemon restarted.
  private async lookup(archive: ArchiveId, id: string): Promise<Found | null> {
    const base = this.endpoints[archive];
    if (archive === "met") {
      const work = await this.json(`${base}/v1/objects/${id}`);
      if (work?.isPublicDomain !== true || !this.allowed(work.primaryImageSmall) || !this.allowed(work.primaryImage)) return null;
      const title = plain(work.title) ?? "untitled";
      const artist = plain(work.artistDisplayName);
      const date = plain(work.objectDate, 40);
      return {
        archive,
        id: String(work.objectID ?? id),
        title,
        artist,
        date,
        credit: creditOf(title, artist, date, archive),
        page: typeof work.objectURL === "string" && work.objectURL.startsWith("https://") ? work.objectURL : null,
        thumb: work.primaryImageSmall,
        image: work.primaryImage,
        fallback: work.primaryImageSmall,
      };
    }
    if (archive === "aic") {
      const work = await this.json(`${base}/artworks/${id}?fields=id,title,image_id,artist_title,date_display,is_public_domain`);
      return this.aic(work?.data, work?.config?.iiif_url);
    }
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      pageids: id,
      prop: "imageinfo",
      iiprop: "url|mime|extmetadata",
      iiurlwidth: "3840",
      iiextmetadatafilter: "ObjectName|Artist|DateTimeOriginal|LicenseShortName",
    });
    const page = (await this.json(`${base}?${params}`))?.query?.pages?.[0];
    return this.commons(page);
  }

  private aic(work: any, iiif: unknown): Found | null {
    const base = typeof iiif === "string" ? iiif.replace(/\/+$/, "") : "https://www.artic.edu/iiif/2";
    if (work?.is_public_domain !== true || typeof work.image_id !== "string" || !/^[0-9a-f-]{8,64}$/.test(work.image_id)) return null;
    // The sizes the Art Institute's IIIF server gives every public-domain
    // work: 843 wide is its own default, 1686 the largest it promises.
    const at = (width: number) => `${base}/${work.image_id}/full/${width},/0/default.jpg`;
    if (!this.allowed(at(843))) return null;
    const title = plain(work.title) ?? "untitled";
    const artist = plain(work.artist_title);
    const date = plain(work.date_display, 40);
    return {
      archive: "aic",
      id: String(work.id),
      title,
      artist,
      date,
      credit: creditOf(title, artist, date, "aic"),
      page: `https://www.artic.edu/artworks/${work.id}`,
      thumb: at(843),
      image: at(1686),
      fallback: at(843),
    };
  }

  private commons(page: any): Found | null {
    const info = page?.imageinfo?.[0];
    const meta = info?.extmetadata ?? {};
    const licence = licenceOf(plain(meta.LicenseShortName?.value, 40));
    if (!info || !licence || !/^image\/(jpeg|png|webp)$/.test(info.mime ?? "") || !Number.isInteger(page.pageid)) return null;
    const image = typeof info.thumburl === "string" ? info.thumburl : info.url;
    const thumb = typeof image === "string" ? commonsThumb(image) : null;
    if (!this.allowed(image) || !this.allowed(thumb)) return null;
    const title = plain(meta.ObjectName?.value) ?? plain(String(page.title ?? "").replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "")) ?? "untitled";
    const artist = plain(meta.Artist?.value, 80);
    const date = plain(meta.DateTimeOriginal?.value, 40);
    return {
      archive: "commons",
      id: String(page.pageid),
      title,
      artist,
      date,
      credit: creditOf(title, artist, date, "commons", licence),
      page: typeof info.descriptionurl === "string" && info.descriptionurl.startsWith("https://") ? info.descriptionurl : null,
      thumb: thumb!,
      image,
    };
  }

  // Only an archive's own image hosts, over https, or the test server's.
  private allowed(url: unknown): url is string {
    if (typeof url !== "string") return false;
    try {
      const parsed = new URL(url);
      return this.hosts.has(parsed.host) && (parsed.protocol === "https:" || parsed.hostname === "127.0.0.1");
    } catch {
      return false;
    }
  }

  private async work(archive: unknown, id: unknown): Promise<Found | null> {
    if (!ARCHIVE_IDS.includes(archive as ArchiveId) || typeof id !== "string" || !ID.test(id)) return null;
    const key = `${archive}:${id}`;
    const known = this.found.get(key) ?? (await this.lookup(archive as ArchiveId, id).catch(() => null));
    if (known) this.found.set(key, known);
    return known;
  }

  private async picture(url: string, most: number, ms: number): Promise<{ type: ImageType; body: Buffer }> {
    if (!this.allowed(url)) throw new Error("that picture isn't on the archive's own host");
    const response = await this.get(url, ms, "image/*");
    if (Number(response.headers.get("content-length")) > most) throw new Error("it's too big");
    const reader = response.body?.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > most) {
        await reader.cancel();
        throw new Error("it's too big");
      }
      chunks.push(Buffer.from(value));
    }
    const body = Buffer.concat(chunks);
    const type = imageType(body);
    if (!type) throw new Error("it isn't a picture the tv can show");
    return { type, body };
  }

  // A work's thumbnail, for the picker, kept so it's fetched once.
  async thumb(archive: unknown, id: unknown): Promise<{ type: ImageType; body: Buffer } | null> {
    const work = await this.work(archive, id);
    if (!work) return null;
    const name = createHash("sha256").update(work.thumb).digest("hex");
    const dir = join(this.options.cache, "art");
    try {
      const body = await readFile(join(dir, name));
      const type = imageType(body);
      if (type) return { type, body };
    } catch {
      // not kept yet
    }
    const got = await this.picture(work.thumb, THUMB_BYTES, API_MS).catch(() => null);
    if (!got) return null;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.next`), got.body);
    await rename(join(dir, `${name}.next`), join(dir, name));
    return got;
  }

  // The whole picture of a work, to keep as a background, with its credit.
  async whole(archive: unknown, id: unknown): Promise<{ body?: Buffer; art?: Art; error?: string }> {
    const work = await this.work(archive, id);
    if (!work) return { error: "that work isn't in the archive, or can't be shown" };
    let got: { body: Buffer } | null = null;
    let why = "";
    for (const url of [work.image, work.fallback].filter((one): one is string => Boolean(one))) {
      try {
        got = await this.picture(url, MAX_BYTES, IMAGE_MS);
        break;
      } catch (error) {
        why = (error as Error).message;
      }
    }
    if (!got) return { error: `the picture didn't come: ${why}` };
    const { thumb, image, fallback, ...art } = work;
    return { body: got.body, art };
  }
}
