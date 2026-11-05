// The switches for what's still being built. Something people can see lands
// switched off on stable, so it can merge before its design is done, and an
// edge box can turn it on to try it.
//
// The defaults are here, and an edge box's changes are in features.json in
// the daemon's own state. `agentv feature list|on|off <name>` and the TV's
// pages read and change them over GET and PUT /api/features.
//
// Each switch goes away once what it guards is finished.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

export const FEATURES = ["boxcheck", "sizes", "looks", "dynamicbg", "setup2", "remote2", "starter", "discover", "askbuilds"] as const;
export type Feature = (typeof FEATURES)[number];
export type Switches = Record<Feature, boolean>;

// Every switch is off until what it guards is finished.
export const DEFAULTS: Switches = {
  boxcheck: false,
  sizes: false,
  looks: false,
  dynamicbg: false,
  setup2: false,
  remote2: false,
  starter: false,
  discover: false,
  askbuilds: false,
};

export interface FeaturesOptions {
  // The daemon's own state: /var/lib/agentv/daemon.
  state: string;
  // The channel the box updates from. Only edge changes a switch.
  channel: () => Promise<string>;
}

export class Features {
  private options: FeaturesOptions;

  constructor(options: FeaturesOptions) {
    this.options = options;
  }

  private get file(): string {
    return join(this.options.state, "features.json");
  }

  // The defaults, with what an edge box changed on top. A name that isn't a
  // switch any more is left out.
  async read(): Promise<Switches> {
    const switches = { ...DEFAULTS };
    let kept: Record<string, unknown> = {};
    try {
      kept = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return switches;
    }
    for (const name of FEATURES) if (typeof kept?.[name] === "boolean") switches[name] = kept[name] as boolean;
    return switches;
  }

  async on(name: Feature): Promise<boolean> {
    return (await this.read())[name];
  }

  // A switch turned on or off, on edge only.
  async set(name: unknown, on: unknown): Promise<{ features?: Switches; error?: string; status?: number }> {
    if (!FEATURES.includes(name as Feature)) return { error: `a switch: ${FEATURES.join(", ")}`, status: 400 };
    if (typeof on !== "boolean") return { error: 'send {"name": "<switch>", "on": true} or "on": false', status: 400 };
    if ((await this.options.channel()) !== "edge") return { error: "switches change on edge only: agentv channel edge", status: 403 };
    const switches = await this.read();
    switches[name as Feature] = on;
    // Only what differs from the defaults is kept, so a default that flips
    // reaches boxes that never touched it.
    const changed = Object.fromEntries(FEATURES.filter((one) => switches[one] !== DEFAULTS[one]).map((one) => [one, switches[one]]));
    await mkdir(this.options.state, { recursive: true });
    const next = join(this.options.state, ".features.json.next");
    await writeFile(next, `${JSON.stringify(changed, null, 2)}\n`);
    await rename(next, this.file);
    return { features: switches };
  }
}

// What a route needs from the daemon.
export interface RouteContext {
  method: string | undefined;
  path: string;
  request: IncomingMessage;
  response: ServerResponse;
  body: () => Promise<unknown>;
  json: (status: number, data: unknown) => void;
  broadcast: (event: string, data: unknown) => void;
}

// GET /api/features: every switch. PUT /api/features with a name and on or
// off, on edge. Pages hear a change as the event "features". True when it
// was one of these.
export async function featuresRoute(features: Features, context: RouteContext): Promise<boolean> {
  if (context.path !== "/api/features") return false;
  if (context.method === "GET") {
    context.json(200, await features.read());
    return true;
  }
  if (context.method === "PUT") {
    const body = ((await context.body()) ?? {}) as { name?: unknown; on?: unknown };
    const result = await features.set(body.name, body.on);
    if (!result.features) {
      context.json(result.status ?? 400, { ok: false, error: result.error });
      return true;
    }
    context.broadcast("features", result.features);
    context.json(200, result.features);
    return true;
  }
  context.json(405, { ok: false, error: "GET or PUT" });
  return true;
}
