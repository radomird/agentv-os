// Servers and shares on the home network (daemon/discover.ts), for the TV's
// lists and the phone's:
//
// - GET /api/discover?kinds=jellyfin,plex starts a look, or keeps the one
//   going, and says what it found so far and whether it's still looking.
//   New finds come on the event stream as "discover".
// - GET /api/discover/shares?host=nas.local lists a NAS's shares, for one
//   the box found.
//
// A paired phone asks the same at /api/phone/discover and
// /api/phone/discover/shares.

import type { ServerResponse } from "node:http";
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

// Answers the request when it's one of these, and says whether it was.
export async function discoverRoute(discover: Discover, method: string | undefined, path: string, url: URL, response: ServerResponse, phone = false): Promise<boolean> {
  const route = phone ? path.replace(/^\/api\/phone\//, "/api/") : path;
  if (phone && !path.startsWith("/api/phone/")) return false;
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
