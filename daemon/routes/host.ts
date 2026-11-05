// What a route file gets from the daemon (PHASE-2-PLAN.md, "How phase 2
// runs"): each track's routes live in daemon/routes/<name>.ts and join
// daemon/server.ts with one line, so two tracks never write the same file.

import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteHost {
  // Answers with JSON.
  json(response: ServerResponse, status: number, data: unknown): void;
  // A request's JSON body, or undefined when it isn't JSON.
  body(request: IncomingMessage): Promise<unknown>;
  // Tells the TV's pages, and the phones, what changed.
  broadcast(event: string, data: unknown): void;
  log(line: string): void;
}
