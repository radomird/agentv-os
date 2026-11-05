// The feature switches' routes (daemon/features.ts):
// - GET /api/features: every switch and whether it's on, { "looks": false, ... };
// - PUT /api/features with { "looks": true }: what `agentv feature on` and
//   `off` send, from the box itself. It answers with every switch again;
// - GET /api/phone/features: the same list, for a paired phone.
// A change goes out as the event `features`, with every switch.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { FeatureMap, Features } from "../features.ts";

export interface FeatureRoutes {
  features: Features;
  body: (request: IncomingMessage) => Promise<unknown>;
  json: (response: ServerResponse, status: number, data: unknown) => void;
  changed: (features: FeatureMap) => void;
  log: (line: string) => void;
}

// True when the request was one of these, and has been answered.
export async function featureRoutes(kit: FeatureRoutes, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  const method = request.method;
  if (path === "/api/phone/features" && method === "GET") {
    kit.json(response, 200, await kit.features.read());
    return true;
  }
  if (path !== "/api/features") return false;
  if (method === "GET") {
    kit.json(response, 200, await kit.features.read());
    return true;
  }
  if (method === "PUT") {
    const before = await kit.features.read();
    const changed = await kit.features.set(await kit.body(request));
    if (!changed.ok) {
      kit.json(response, changed.status, { ok: false, error: changed.error });
      return true;
    }
    const turned = Object.keys(changed.features).filter((name) => changed.features[name as keyof FeatureMap] !== before[name as keyof FeatureMap]);
    if (turned.length > 0) {
      kit.log(`switches changed: ${turned.map((name) => `${name} ${changed.features[name as keyof FeatureMap] ? "on" : "off"}`).join(", ")}`);
      kit.changed(changed.features);
    }
    kit.json(response, 200, changed.features);
    return true;
  }
  return false;
}
