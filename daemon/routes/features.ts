// GET /api/features: every switch and whether it's on, for the TV's pages
// and the phone (PHASE-2-PLAN.md, "Shared interfaces"). Track 12 owns the
// switches; this is the spec's answer until its version lands.

import type { IncomingMessage, ServerResponse } from "node:http";
import { features } from "../features.ts";

export async function featuresRoute(state: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method !== "GET" || path !== "/api/features") return false;
  const body = JSON.stringify(await features(state));
  response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(body);
  return true;
}
