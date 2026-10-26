// An Immich album as the background (ADR-012), through the link its owner
// shares it with: Immich's Share on an album gives an address like
// https://photos.example/share/<key>. The box needs that link and nothing
// else, no account and no password, and doesn't keep it. The daemon asks
// Immich's API with the link's key for the album's photos, and only Immich's
// own server, which the link names. Their previews, up to 60, become the
// background beside the household's other pictures.

export const MOST = 60;
const KEY = /^[A-Za-z0-9_-]{8,128}$/;
const ASK_MS = 15_000;
const PICTURE_MS = 30_000;
const PICTURE_BYTES = 15 * 1024 * 1024;
const AT_ONCE = 4;

// An album's shared link: Immich's own address, which can be under a path,
// and the key. Null when it isn't one.
export function shareLink(text: unknown): { server: string; key: string } | null {
  if (typeof text !== "string") return null;
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  const found = /^(.*)\/share\/([^/]+)\/?$/.exec(url.pathname);
  if (!found || !KEY.test(found[2])) return null;
  return { server: `${url.origin}${found[1]}`, key: found[2] };
}

export interface AlbumPicture {
  body: Buffer;
  album: string;
}

export class ImmichAlbum {
  private fetch: typeof fetch;
  private userAgent: string;

  constructor(options: { userAgent: string; fetch?: typeof fetch }) {
    this.fetch = options.fetch ?? fetch;
    this.userAgent = options.userAgent;
  }

  private async get(url: string, ms: number): Promise<Response> {
    return this.fetch(url, { headers: { "User-Agent": this.userAgent }, signal: AbortSignal.timeout(ms), redirect: "error" });
  }

  // What Immich said, from its error's message.
  private async why(response: Response): Promise<string> {
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    return typeof body?.message === "string" ? body.message.toLowerCase().slice(0, 120) : `it answered ${response.status}`;
  }

  // The album's name and up to 60 of its photos' previews, at random. Each
  // picture goes to `each` as it comes, so the first can take the place of
  // the pictures before while the rest are still on their way.
  async pictures(link: unknown, each: (picture: AlbumPicture) => Promise<boolean>): Promise<{ album?: string; count?: number; error?: string }> {
    const share = shareLink(link);
    if (!share) return { error: "an album's shared link looks like https://photos.example/share/…" };
    const key = `key=${encodeURIComponent(share.key)}`;
    let shared: { type?: unknown; password?: unknown; album?: { id?: unknown; albumName?: unknown } };
    try {
      const response = await this.get(`${share.server}/api/shared-links/me?${key}`, ASK_MS);
      if (!response.ok) return { error: `immich didn't take that link: ${await this.why(response)}` };
      shared = await response.json();
    } catch (error) {
      return { error: `immich didn't answer: ${(error as Error).message}` };
    }
    if (shared.type !== "ALBUM" || typeof shared.album?.id !== "string" || !/^[0-9a-f-]{36}$/.test(shared.album.id)) return { error: "that link is to some photos, not an album" };
    if (shared.password) return { error: "that link has a password. share the album without one" };
    const name = typeof shared.album.albumName === "string" && shared.album.albumName.trim() ? shared.album.albumName.trim().slice(0, 60) : "an album";

    let assets: { id?: unknown; type?: unknown }[];
    try {
      const response = await this.get(`${share.server}/api/albums/${shared.album.id}?${key}`, ASK_MS);
      if (!response.ok) return { error: `immich didn't give the album: ${await this.why(response)}` };
      assets = ((await response.json()) as { assets?: { id?: unknown; type?: unknown }[] }).assets ?? [];
    } catch (error) {
      return { error: `immich didn't answer: ${(error as Error).message}` };
    }
    const photos = assets.filter((asset): asset is { id: string; type: string } => asset.type === "IMAGE" && typeof asset.id === "string" && /^[0-9a-f-]{36}$/.test(asset.id)).map((asset) => asset.id);
    if (!photos.length) return { album: name, error: `there are no photos in ${name}` };
    for (let i = photos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [photos[i], photos[j]] = [photos[j], photos[i]];
    }

    // Immich's preview: a JPEG the size of a big screen, whatever the
    // original is, which the TV can always show.
    let count = 0;
    const picked = photos.slice(0, MOST);
    for (let at = 0; at < picked.length; at += AT_ONCE) {
      const bodies = await Promise.all(
        picked.slice(at, at + AT_ONCE).map(async (id) => {
          try {
            const response = await this.get(`${share.server}/api/assets/${id}/thumbnail?size=preview&${key}`, PICTURE_MS);
            if (!response.ok || Number(response.headers.get("content-length")) > PICTURE_BYTES) return null;
            const body = Buffer.from(await response.arrayBuffer());
            return body.length <= PICTURE_BYTES ? body : null;
          } catch {
            return null;
          }
        }),
      );
      // In order, so the first one kept is the first one handed over.
      for (const body of bodies) if (body && (await each({ body, album: name }))) count++;
    }
    return count ? { album: name, count } : { album: name, error: `none of the photos in ${name} came` };
  }
}
