// An app's logo when its package has none, so every tile has one: the
// site's own icon, the one a browser shows in its tab, fetched on the box
// from the app's home address. Agent-built apps get theirs this way. It's
// the same two requests a browser makes when it opens the site, and the
// icon is kept with the daemon's state, never in a repo.

export const ICON_MAX = 512 * 1024;
const PAGE_MAX = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const TYPES = /^image\/(png|jpeg|webp|gif|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/;

// The value of an attribute in one tag, or null.
function attribute(tag: string, name: string): string | null {
  const found = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return found ? (found[1] ?? found[2] ?? found[3] ?? "") : null;
}

// The icons a page names, best first: an apple-touch-icon, made for a phone's
// home screen and so the closest to a logo, then the largest of the others.
// Only http and https addresses, resolved against the page's own.
export function iconLinks(html: string, base: string): string[] {
  const found: { url: string; score: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    const href = attribute(tag, "href");
    if (!href || !(rel.includes("icon") || rel.some((r) => r.startsWith("apple-touch-icon")))) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const sizes = (attribute(tag, "sizes") ?? "").toLowerCase();
    const size = sizes === "any" ? 512 : Math.max(0, ...sizes.split(/\s+/).map((s) => Number(s.split("x")[0]) || 0));
    const touch = rel.some((r) => r.startsWith("apple-touch-icon"));
    found.push({ url: url.href, score: (touch ? 10_000 : 0) + (size || (touch ? 180 : 16)) });
  }
  return [...new Set(found.sort((a, b) => b.score - a.score).map((link) => link.url))];
}

async function limited(response: Response, max: number): Promise<Buffer | null> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > max) return null;
  const body = Buffer.from(await response.arrayBuffer());
  return body.length > max ? null : body;
}

export interface SiteIconOptions {
  userAgent: string;
  fetch?: typeof fetch;
  // Which addresses an icon may come from, besides the page's own origin.
  allowed?: (url: URL) => boolean;
}

// The site's icon for a home address: the best one its page names, or its
// /favicon.ico. Null when there's none worth showing.
export async function siteIcon(home: string, options: SiteIconOptions): Promise<{ type: string; body: Buffer } | null> {
  const get = options.fetch ?? fetch;
  const headers = { "User-Agent": options.userAgent };
  let page: Response;
  try {
    page = await get(home, { headers: { ...headers, Accept: "text/html" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
  const base = page.url || home;
  const origin = new URL(base).origin;
  const html = page.ok && /html/.test(page.headers.get("content-type") ?? "") ? ((await limited(page, PAGE_MAX))?.toString("utf8") ?? "") : "";
  const candidates = [...iconLinks(html, base), `${origin}/favicon.ico`];
  for (const candidate of candidates) {
    const url = new URL(candidate);
    // From the site itself, over https, or wherever the app may reach.
    if (url.origin !== origin && url.protocol !== "https:" && !options.allowed?.(url)) continue;
    try {
      const response = await get(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) continue;
      let type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      // Many servers send a favicon.ico as anything at all.
      if (!TYPES.test(type) && url.pathname.endsWith(".ico")) type = "image/x-icon";
      if (!TYPES.test(type)) continue;
      const body = await limited(response, ICON_MAX);
      if (body && body.length > 0) return { type, body };
    } catch {
      // The next one, then.
    }
  }
  return null;
}
