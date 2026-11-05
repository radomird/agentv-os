// GET /api/features: every feature switch and whether it's on
// (daemon/features.ts).

import type { Kit, Route } from "./kit.ts";

export function features(kit: Kit): Route {
  return {
    async handle(method, path, _request, response) {
      if (method !== "GET" || path !== "/api/features") return false;
      kit.json(response, 200, kit.features.all());
      return true;
    },
  };
}
