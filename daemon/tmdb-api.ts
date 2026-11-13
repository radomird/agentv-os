// TMDB's API with the household's key (stage 8, S8.1, S8.2), on the router's
// side (daemon/router-serve.ts). The key is TMDB_API_KEY in /etc/agentv/env,
// which only agentv-router.service reads, so the daemon asks it over
// router.sock and never holds the key, as with the provider's.
//
// The daemon asks for a path, and only a few read-only paths go through:
// what's new (discover, and the services a region has), a show's air dates,
// and where a title is on, which JustWatch's data says. Nothing here writes
// to TMDB, and nothing logs what a path asked for: a show's name in a
// search is what someone said to the TV.

export const TMDB_BASE = "https://api.themoviedb.org/3";

// The paths the daemon may ask for, each a GET.
const PATHS = [
  /^\/discover\/(movie|tv)$/,
  /^\/search\/tv$/,
  /^\/tv\/\d{1,9}$/,
  /^\/(movie|tv)\/\d{1,9}\/watch\/providers$/,
  /^\/watch\/providers\/(movie|tv|regions)$/,
  /^\/configuration$/,
];

// What a query may hold: TMDB's own parameters, such as watch_region or
// release_date.gte, with plain values. Never the key: the router adds it.
const PARAM = /^[a-z_]+(\.[a-z]+)?$/;
const VALUE = /^[\p{L}\p{N} .,:'!?&|()+-]{0,120}$/u;

// A path and its query, as the daemon asked, if it's one that goes through.
export function tmdbPath(asked: unknown): { path: string; query: URLSearchParams } | string {
  if (typeof asked !== "string" || asked.length > 1000) return "which path";
  let url: URL;
  try {
    url = new URL(asked, "http://tmdb.invalid");
  } catch {
    return "which path";
  }
  if (url.origin !== "http://tmdb.invalid" || url.hash || !PATHS.some((p) => p.test(url.pathname))) return "that isn't a path this TV asks TMDB for";
  for (const [name, value] of url.searchParams) {
    if (!PARAM.test(name) || name === "api_key" || !VALUE.test(value)) return "that isn't a query this TV asks TMDB for";
  }
  return { path: url.pathname, query: url.searchParams };
}

// A TMDB key is either the API key, 32 hex digits, which goes in the query,
// or the API read access token, which goes in the Authorization header.
export function tmdbRequest(key: string, path: string, query: URLSearchParams, base = TMDB_BASE): { url: string; headers: Record<string, string> } {
  const asked = new URLSearchParams(query);
  const headers: Record<string, string> = { accept: "application/json" };
  if (/^[0-9a-f]{32}$/i.test(key)) asked.set("api_key", key);
  else headers.authorization = `Bearer ${key}`;
  const search = asked.toString();
  return { url: `${base.replace(/\/+$/, "")}${path}${search ? `?${search}` : ""}`, headers };
}

export function tmdbKeyFrom(env: string): string | null {
  for (const line of env.split("\n")) {
    const match = /^TMDB_API_KEY=(.*)$/.exec(line.trim());
    if (match && match[1]) return match[1].replace(/^"|"$/g, "");
  }
  return null;
}

export interface TmdbAnswer {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

// At most this much of an answer: a page of discover is about 20 kB.
const MAX_BYTES = 2 * 1024 * 1024;

// One GET to TMDB with the key, within bounds, as the router's service
// answers the daemon.
export async function askTmdb(key: string | null, asked: unknown, options: { base?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<TmdbAnswer> {
  if (!key) return { ok: false, error: "there's no tmdb key on the box" };
  const found = tmdbPath(asked);
  if (typeof found === "string") return { ok: false, error: found };
  const { url, headers } = tmdbRequest(key, found.path, found.query, options.base);
  try {
    const response = await (options.fetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
    const text = await response.text();
    if (text.length > MAX_BYTES) return { ok: false, status: response.status, error: "tmdb's answer was too big" };
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, status: response.status, error: "tmdb's answer wasn't json" };
    }
    if (!response.ok) {
      const said = (data as { status_message?: unknown })?.status_message;
      // TMDB says 401 for a key it doesn't know, whatever the path.
      const error = response.status === 401 ? "tmdb didn't take the key" : typeof said === "string" ? said.slice(0, 120) : `tmdb answered ${response.status}`;
      return { ok: false, status: response.status, error };
    }
    return { ok: true, status: response.status, data };
  } catch (error) {
    return { ok: false, error: (error as Error).name === "TimeoutError" ? "tmdb took too long to answer" : "tmdb couldn't be reached" };
  }
}
