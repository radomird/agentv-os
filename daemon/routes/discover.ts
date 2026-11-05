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
// /api/phone/discover/shares.

import type { IncomingMessage, ServerResponse } from "node:http";
import { KINDS, type Discover, type Kind } from "../discover.ts";

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
