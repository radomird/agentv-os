// The look home is drawn in (ADR-063): Terminal, Glass or Cinema, one for the
// whole box, like the theme. Each look is a folder, launcher/looks/<id>/,
// and its look.json says its name, its line and its font.
//
// GET /api/look → { ok, look, looks }, the one in use and every one there is.
// PUT /api/look with { look } picks one, and the event "look" tells the TV's
// pages. A child's profile needs the adult PIN for it, as for Settings.

import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_LOOK = "terminal";

// The order the looks are offered in: the default first.
const ORDER = ["terminal", "glass", "cinema"];

const ID = /^[a-z][a-z0-9-]{0,31}$/;

export interface Look {
  id: string;
  name: string;
  line: string;
  font: string;
}

export interface LookKit {
  root: string; // AgenTV's files, where launcher/looks/ is
  state: string; // the daemon's state, where look.json is kept
  broadcast(event: string, data: unknown): void;
  // True when the active profile may change it, having answered otherwise.
  adult(request: IncomingMessage, response: ServerResponse, what: string): Promise<boolean>;
}

// Every look in launcher/looks/ with a look.json that says what it is.
export async function looks(root: string): Promise<Look[]> {
  const dir = join(root, "launcher", "looks");
  const found: Look[] = [];
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    if (!ID.test(name)) continue;
    try {
      const look = JSON.parse(await readFile(join(dir, name, "look.json"), "utf8")) as Partial<Look>;
      if (look.id !== name || typeof look.name !== "string" || typeof look.line !== "string" || typeof look.font !== "string") continue;
      found.push({ id: look.id, name: look.name, line: look.line, font: look.font });
    } catch {
      // not a look
    }
  }
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
  return found.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

// The look in use: the one picked, while it's still there, or Terminal.
export async function currentLook(kit: Pick<LookKit, "root" | "state">): Promise<string> {
  const all = await looks(kit.root);
  try {
    const saved = JSON.parse(await readFile(join(kit.state, "look.json"), "utf8")) as { look?: unknown };
    if (typeof saved.look === "string" && all.some((look) => look.id === saved.look)) return saved.look;
  } catch {
    // none picked yet
  }
  return DEFAULT_LOOK;
}

function send(response: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(body);
}

async function json(request: IncomingMessage): Promise<unknown> {
  if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) return undefined;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 4096) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

export async function lookRoute(kit: LookKit, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path !== "/api/look") return false;
  if (request.method === "GET") {
    send(response, 200, { ok: true, look: await currentLook(kit), looks: await looks(kit.root) });
    return true;
  }
  if (request.method !== "PUT") {
    send(response, 405, { ok: false, error: "use GET or PUT" });
    return true;
  }
  if (!(await kit.adult(request, response, "changing the look"))) return true;
  const body = (await json(request)) as { look?: unknown } | undefined;
  const all = await looks(kit.root);
  const id = body?.look;
  if (typeof id !== "string" || !all.some((look) => look.id === id)) {
    send(response, 400, { ok: false, error: `the look is one of ${all.map((look) => look.id).join(", ")}` });
    return true;
  }
  await mkdir(kit.state, { recursive: true });
  const next = join(kit.state, "look.json.next");
  await writeFile(next, `${JSON.stringify({ look: id })}\n`);
  await rename(next, join(kit.state, "look.json"));
  kit.broadcast("look", { look: id });
  send(response, 200, { ok: true, look: id });
  return true;
}
