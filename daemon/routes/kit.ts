// What a track's routes get from AgenTV's daemon (PHASE-2-PLAN.md, "Files"):
// each track's new routes live in a file of its own here, and server.ts
// lists each file with one line. A route answers the requests it knows and
// says false to the rest.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Features } from "../features.ts";

export interface Kit {
  // The daemon's own state: /var/lib/agentv/daemon.
  state: string;
  features: Features;
  log(line: string): void;
  json(response: ServerResponse, status: number, data: unknown): void;
  // A request's JSON body, or undefined when it has none.
  body(request: IncomingMessage): Promise<unknown>;
  // Tells the TV's pages and the phones what changed (/api/events).
  broadcast(event: string, data: unknown): void;
  // The port the daemon answers on, for a route that asks another route.
  port(): number;
}

export interface Route {
  handle(method: string, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  // As the daemon stops.
  close?(): void;
}
