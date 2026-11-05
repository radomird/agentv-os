// GET /api/features: every feature switch, on or off (daemon/features.ts).

import type { ServerResponse } from "node:http";
import type { Features } from "../features.ts";
import type { RouteHost } from "./host.ts";

export async function featuresRoute(host: RouteHost, features: Features, method: string | undefined, path: string, response: ServerResponse): Promise<boolean> {
  if (method !== "GET" || path !== "/api/features") return false;
  host.json(response, 200, await features.all());
  return true;
}
