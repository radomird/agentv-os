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

// The icons a page names, best first: the largest, so a tile on a big TV is
// sharp. An apple-touch-icon that says no size is 180 px, as phones take
// it, and wins a tie, being made for a home screen and so the closest to a
// logo. Only http and https addresses, resolved against the page's own.
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
    found.push({ url: url.href, score: (size || (touch ? 180 : 16)) * 2 + (touch ? 1 : 0) });
  }
  return [...new Set(found.sort((a, b) => b.score - a.score).map((link) => link.url))];
}

async function limited(response: Response, max: number): Promise<Buffer | null> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > max) return null;
  const body = Buffer.from(await response.arrayBuffer());
  return body.length > max ? null : body;
}

// A page's first max bytes: its icons are in its head, however big the
// rest of it is.
async function head(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
  }
  void reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

function failure(error: unknown): string {
  const cause = (error as { cause?: { message?: string } })?.cause?.message;
  return cause ?? (error as Error)?.message ?? String(error);
}

export interface SiteIconOptions {
  userAgent: string;
  fetch?: typeof fetch;
  // Which addresses an icon may come from, besides the page's own origin.
  allowed?: (url: URL) => boolean;
  // Why each step came to nothing, for the log: the address and its HTTP
  // status, or the error.
  reasons?: string[];
}

// The site's icon for a home address: the best one its page names, or its
// /favicon.ico. Null when there's none worth showing.
export async function siteIcon(home: string, options: SiteIconOptions): Promise<{ type: string; body: Buffer } | null> {
  const get = options.fetch ?? fetch;
  const why = (reason: string) => options.reasons?.push(reason);
  const headers = { "User-Agent": options.userAgent };
  let page: Response;
  try {
    page = await get(home, { headers: { ...headers, Accept: "text/html" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    why(`${home}: ${failure(error)}`);
    return null;
  }
  const base = page.url || home;
  const origin = new URL(base).origin;
  const type = page.headers.get("content-type") ?? "";
  let html = "";
  if (!page.ok) why(`${base} answered ${page.status}`);
  else if (!/html/.test(type)) why(`${base} is ${type || "of no type"}, not a page`);
  else html = await head(page, PAGE_MAX).catch((error) => (why(`${base}: ${failure(error)}`), ""));
  if (page.ok && html && !iconLinks(html, base).length) why(`${base} names no icon`);
  const candidates = [...iconLinks(html, base), `${origin}/favicon.ico`];
  for (const candidate of candidates) {
    const url = new URL(candidate);
    // From the site itself, over https, or wherever the app may reach.
    if (url.origin !== origin && url.protocol !== "https:" && !options.allowed?.(url)) {
      why(`${url.href} is on another site, not over https`);
      continue;
    }
    try {
      const response = await get(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) {
        why(`${url.href} answered ${response.status}`);
        continue;
      }
      let type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      // Many servers send a favicon.ico as anything at all.
      if (!TYPES.test(type) && url.pathname.endsWith(".ico")) type = "image/x-icon";
      if (!TYPES.test(type)) {
        why(`${url.href} is ${type || "of no type"}, not an image`);
        continue;
      }
      const body = await limited(response, ICON_MAX);
      if (body && body.length > 0) return { type, body };
      why(`${url.href} is ${body ? "empty" : `over ${ICON_MAX / 1024} KB`}`);
    } catch (error) {
      why(`${url.href}: ${failure(error)}`);
    }
  }
  return null;
}
