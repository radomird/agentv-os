// The box check's routes (ADR-061):
// - GET /api/box: what the box is, and the verdicts, in the shape
//   PHASE-2-PLAN.md's "Shared interfaces" sets;
// - GET /api/box/readings: everything it read, as `agentv box readings`
//   prints it, with the TV's serial numbers zeroed;
// - GET and POST /api/box/smooth: whether the 4K test should run, and its
//   result from the TV's page;
// - POST /api/box/widevine: the services' Chromium's Widevine, from the
//   screen daemon;
// - GET /api/phone/box, for a paired phone: the box in one line, for its
//   menu's about line.
// The TV's pages hear "box" when something changed.

import type { IncomingMessage, ServerResponse } from "node:http";
import { summary } from "../../launcher/box-lines.ts";
import type { Box } from "../box.ts";
import type { RouteHost } from "./host.ts";

export async function boxRoute(host: RouteHost, box: Box, method: string | undefined, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (!path.startsWith("/api/box")) return false;
  if (method === "GET" && path === "/api/box") {
    host.json(response, 200, await box.report());
    return true;
  }
  if (method === "GET" && path === "/api/box/readings") {
    host.json(response, 200, await box.readings());
    return true;
  }
  if (method === "GET" && path === "/api/box/smooth") {
    host.json(response, 200, { ok: true, ...(await box.smooth()) });
    return true;
  }
  if (method === "POST" && path === "/api/box/smooth") {
    const saved = await box.saveSmooth(await host.body(request));
    if (!saved.result) {
      host.json(response, 400, { ok: false, error: saved.error });
      return true;
    }
    const { result } = saved;
    host.log(`the 4k test drew ${result.width} × ${result.height} at ${result.fps} fps with ${Math.round(result.slow * 100)}% late frames, on gpu ${result.gpu}`);
    const smooth = await box.smooth();
    host.broadcast("box", { smooth });
    host.json(response, 200, { ok: true, ...smooth });
    return true;
  }
  if (method === "POST" && path === "/api/box/widevine") {
    const version = ((await host.body(request)) as { version?: unknown } | undefined)?.version;
    const saved = await box.saveWidevine(version === undefined ? null : version);
    if (saved.error) {
      host.json(response, 400, { ok: false, error: saved.error });
      return true;
    }
    if (saved.changed) {
      host.log(version ? `the services' chromium has widevine ${String(version)}` : "the services' chromium has no widevine");
      host.broadcast("box", {});
    }
    host.json(response, 200, { ok: true });
    return true;
  }
  host.json(response, 404, { ok: false, error: "not found" });
  return true;
}

// The phone's, past pairing.
export async function phoneBoxRoute(host: RouteHost, box: Box, method: string | undefined, path: string, response: ServerResponse): Promise<boolean> {
  if (method !== "GET" || path !== "/api/phone/box") return false;
  const report = await box.report();
  host.json(response, 200, { ok: true, line: summary(report), box: report });
  return true;
}
