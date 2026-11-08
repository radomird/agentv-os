// Settings → Omarchy desktop's password, behind setup's own switch
// (daemon/desktop-password.ts).
//
// GET /api/desktop/password → { ok, password: { managed, name, known } }
// PUT /api/desktop/password with { password } sets it, for an adult and past
// the PIN, and answers with the same as GET. Both are not found while the
// switch is off.

import type { IncomingMessage, ServerResponse } from "node:http";
import { type DesktopPassword, passwordProblem } from "../desktop-password.ts";

export interface PasswordKit {
  setup2(): Promise<boolean>;
  password: DesktopPassword;
  json(response: ServerResponse, status: number, data: unknown): void;
  body(request: IncomingMessage): Promise<unknown>;
  log(line: string): void;
  // The grant the page got for the PIN, which root checks again.
  grant(request: IncomingMessage): string | undefined;
  // True when the request may go ahead, having answered otherwise.
  adult(request: IncomingMessage, response: ServerResponse, what: string): Promise<boolean>;
}

const PATH = "/api/desktop/password";

export async function desktopPasswordRoute(kit: PasswordKit, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  if (path !== PATH) return false;
  if (!(await kit.setup2())) {
    kit.json(response, 404, { ok: false, error: "not found" });
    return true;
  }
  if (request.method === "GET") {
    kit.json(response, 200, { ok: true, password: await kit.password.state() });
    return true;
  }
  if (request.method !== "PUT") {
    kit.json(response, 405, { ok: false, error: "GET or PUT" });
    return true;
  }
  if (!(await kit.adult(request, response, "the desktop's password"))) return true;
  const state = await kit.password.state();
  if (!state.managed) {
    kit.json(response, 409, { ok: false, error: "this box's password is the one typed when it was installed" });
    return true;
  }
  const password = ((await kit.body(request)) as { password?: unknown } | undefined)?.password;
  const problem = passwordProblem(password);
  if (problem) {
    kit.json(response, 400, { ok: false, error: problem });
    return true;
  }
  const why = await kit.password.set(password as string, kit.grant(request));
  if (why) {
    kit.log(`the desktop's password wasn't set: ${why}`);
    kit.json(response, why === "that needs the pin" ? 403 : 500, { ok: false, error: why, ...(why === "that needs the pin" ? { pin: true } : {}) });
    return true;
  }
  kit.log("the desktop's password was set");
  kit.json(response, 200, { ok: true, password: await kit.password.state() });
  return true;
}
