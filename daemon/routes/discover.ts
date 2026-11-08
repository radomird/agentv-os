// Servers and shares on the home network (daemon/discover.ts), for the TV's
// lists and the phone's:
//
// - GET /api/discover?kinds=jellyfin,plex starts a look, or keeps the one
//   going, and says what it found so far and whether it's still looking.
//   New finds come on the event stream as "discover".
// - GET /api/discover/shares?host=nas.local lists a NAS's shares, for one
//   the box found. POST it { host, user, password } for a NAS that lists
//   them only for a user, with what was typed on the phone.
//
// A paired phone asks the same at /api/phone/discover and
// /api/phone/discover/shares. And for the phone's line "on your network":
//
// - POST /api/discover/screen { kinds, machines } or { host }, from the
//   TV's page, says which list it shows, and {} that it shows none.
// - POST /api/phone/discover/pick { key } picks a row of that list, as the
//   TV would: the TV's page hears it as "discover-pick".
// - POST /api/discover/pick { app, url }, from setup's server page, fills
//   in an app's server now, or once the app has installed.

import type { IncomingMessage, ServerResponse } from "node:http";
import { KINDS, type Discover, type Kind, type TvList } from "../discover.ts";
import type { ServerPicks } from "../server-picks.ts";

function json(response: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

// The kinds asked for: every one, with none named.
export function kindsOf(text: string | null): Kind[] | null {
  if (!text) return [...KINDS];
  const kinds = text.split(",").map((one) => one.trim()).filter(Boolean);
  return kinds.length && kinds.every((one) => (KINDS as readonly string[]).includes(one)) ? (kinds as Kind[]) : null;
}

// A user name and password for a NAS's list: what a share's address can
// hold, and nothing that would break smbclient's.
export function loginOf(body: unknown): { host: string; user: string; password: string } | string {
  const { host, user, password } = (body ?? {}) as Record<string, unknown>;
  if (typeof host !== "string" || !host || host.length > 255) return "say which nas";
  if (typeof user !== "string" || !/^[^\s:@/\\%]{1,64}$/.test(user)) return "a user name like the nas has it, with no spaces";
  if (typeof password !== "string" || password.length > 256 || /[\r\n\0]/.test(password)) return "a password of up to 256 characters, on one line";
  return { host, user, password };
}

// The list on the TV, as its page says it: undefined when it doesn't make
// sense, null for none.
export function listOf(sent: unknown): TvList | null | undefined {
  if (typeof sent !== "object" || sent === null || Array.isArray(sent)) return undefined;
  const { kinds, machines, host } = sent as Record<string, unknown>;
  if (kinds === undefined && host === undefined) return null;
  if (typeof host === "string") return host && host.length <= 255 && kinds === undefined ? { host } : undefined;
  const list = typeof kinds === "string" ? kindsOf(kinds) : null;
  return list && (machines === undefined || typeof machines === "boolean") ? { kinds: list, machines: machines === true } : undefined;
}

async function body(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 4096) throw new Error("too long");
  }
  return JSON.parse(text);
}

// Answers the request when it's one of these, and says whether it was.
export async function discoverRoute(discover: Discover, method: string | undefined, path: string, url: URL, response: ServerResponse, phone = false, request?: IncomingMessage): Promise<boolean> {
  const route = phone ? path.replace(/^\/api\/phone\//, "/api/") : path;
  if (phone && !path.startsWith("/api/phone/")) return false;
  if (method === "POST" && request && ((route === "/api/discover/screen" && !phone) || (route === "/api/discover/pick" && phone))) {
    let sent: unknown;
    try {
      sent = await body(request);
    } catch {
      sent = undefined;
    }
    if (route === "/api/discover/screen") {
      const list = listOf(sent);
      if (list === undefined) {
        json(response, 400, { ok: false, error: "the list on the tv: { kinds, machines }, { host } or {}" });
        return true;
      }
      discover.showing(list);
      json(response, 200, { ok: true });
      return true;
    }
    const key = (sent as { key?: unknown } | undefined)?.key;
    if (typeof key !== "string" || !key || key.length > 600) {
      json(response, 400, { ok: false, error: "say which one, by its key" });
      return true;
    }
    if (!discover.pick(key)) {
      json(response, 409, { ok: false, error: "the tv isn't showing what's on your network" });
      return true;
    }
    json(response, 200, { ok: true });
    return true;
  }
  if (method === "POST" && route === "/api/discover/shares" && request) {
    let login: ReturnType<typeof loginOf>;
    try {
      login = loginOf(await body(request));
    } catch {
      login = "send the nas, the user name and the password";
    }
    if (typeof login === "string") {
      json(response, 400, { ok: false, error: login });
      return true;
    }
    const shares = await discover.shares(login.host, { user: login.user, password: login.password });
    json(response, shares.ok ? 200 : 404, shares);
    return true;
  }
  if (method !== "GET" || (route !== "/api/discover" && route !== "/api/discover/shares")) return false;
  if (route === "/api/discover") {
    const kinds = kindsOf(url.searchParams.get("kinds"));
    if (!kinds) {
      json(response, 400, { ok: false, error: `kinds are some of ${KINDS.join(", ")}` });
      return true;
    }
    json(response, 200, { ok: true, ...discover.look(kinds) });
    return true;
  }
  const host = url.searchParams.get("host") ?? "";
  if (!host || host.length > 255) {
    json(response, 400, { ok: false, error: "say which nas: ?host=nas.local" });
    return true;
  }
  const shares = await discover.shares(host);
  json(response, shares.ok ? 200 : 404, shares);
  return true;
}

// What setup's server page needs of the daemon: the picks, and the PIN's
// say, as an app's own setup page has it.
export interface PickKit {
  picks: ServerPicks;
  allowed(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

// POST /api/discover/pick { app, url }: a server picked for an app in setup.
// It answers { ok, saved }, where saved is false while the app installs.
export async function serverPickRoute(kit: PickKit, method: string | undefined, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (method !== "POST" || path !== "/api/discover/pick") return false;
  if (!(await kit.allowed(request, response))) return true;
  let sent: { app?: unknown; url?: unknown } | undefined;
  try {
    sent = (await body(request)) as typeof sent;
  } catch {
    sent = undefined;
  }
  const answer = await kit.picks.pick(sent?.app, sent?.url);
  if (answer.ok) json(response, 200, answer);
  else json(response, answer.status, { ok: false, error: answer.error });
  return true;
}
