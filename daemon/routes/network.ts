// Settings, network (ADR-084), for the TV's own page: these are on the
// daemon's port for the TV (127.0.0.1), never on the phones' port or the
// hotspot's.
//
// GET /api/network → { ok, online, via, name, wifi, looking, joining,
//   problem, hotspot, change }, how the TV is online. `change` says whether
//   who's watching may change it. Anyone watching may ask.
// GET /api/network/networks → { ok, networks }, the Wi-Fi nearby, strongest
//   first, as root last saw it, with the one the TV is on marked.
// POST /api/network/scan has root look again.
// POST /api/network/join with { ssid, password } joins one. The password
//   goes to root's drop and nowhere else.
//
// Looking and joining are an adult's. A child's profile gets neither, with
// the PIN or without, and a join needs the PIN's grant when a PIN is set, as
// pairing a phone does. The event "network" tells the TV's pages what
// changed.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TvNetwork } from "../network.ts";

export interface NetworkKit {
  network: TvNetwork;
  json(response: ServerResponse, status: number, data: unknown): void;
  body(request: IncomingMessage): Promise<unknown>;
  log(line: string): void;
  // Whether a child's profile is on the TV.
  child(): Promise<boolean>;
  // True when the request has the PIN's grant, or no PIN is set, having
  // answered otherwise.
  guarded(request: IncomingMessage, response: ServerResponse, what: string): boolean;
}

// What the page says for each reason a look or a join wasn't started.
const REFUSED: Record<string, [number, string]> = {
  busy: [409, "busy"],
  hotspot: [409, "hotspot"],
  name: [400, "name"],
  password: [400, "password"],
};

export async function networkRoute(kit: NetworkKit, method: string | undefined, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (path !== "/api/network" && !path.startsWith("/api/network/")) return false;
  const { network } = kit;
  if (method === "GET" && path === "/api/network") {
    kit.json(response, 200, { ok: true, ...network.state(), change: !(await kit.child()) });
    return true;
  }
  if (method === "GET" && path === "/api/network/networks") {
    kit.json(response, 200, { ok: true, networks: network.networks() });
    return true;
  }
  const scan = method === "POST" && path === "/api/network/scan";
  const join = method === "POST" && path === "/api/network/join";
  if (!scan && !join) {
    kit.json(response, 404, { ok: false, error: "not found" });
    return true;
  }
  if (await kit.child()) {
    kit.log(`refused ${scan ? "a look at the wi-fi nearby" : "changing the wi-fi"}: a child's profile is on`);
    kit.json(response, 403, { ok: false, error: "child" });
    return true;
  }
  if (scan) {
    const why = network.look();
    if (why) kit.json(response, REFUSED[why][0], { ok: false, error: REFUSED[why][1] });
    else kit.json(response, 200, { ok: true, ...network.state() });
    return true;
  }
  if (!kit.guarded(request, response, "changing the wi-fi")) return true;
  const body = (await kit.body(request)) as { ssid?: unknown; password?: unknown } | undefined;
  const why = network.join(body?.ssid, body?.password ?? "");
  if (why) {
    kit.json(response, REFUSED[why][0], { ok: false, error: REFUSED[why][1] });
    return true;
  }
  kit.log(`settings asked to join ${String(body?.ssid)}`);
  kit.json(response, 200, { ok: true, ...network.state() });
  return true;
}
