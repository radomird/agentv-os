// Where the router runs on the box (ADR-013, ADR-022, ADR-023): two small
// services, so the daemon never holds the household's key and the plan's
// CLI never reaches more than its provider.
//
// - api (agentv-router.service, as agentv-router): the provider's API with
//   the key, which only this service reads, as a credential systemd hands
//   it from /etc/agentv/env. It answers on /run/agentv-router/router.sock.
//   It's also the plan's CLI's way out, on cli-net.sock: the plans'
//   providers' own hosts, on 443, and nothing else.
// - cli (agentv-router-cli.service, as agentv-builder): a plan's CLI once
//   per sentence, signed in through its own login as the builder (ADR-022,
//   ADR-040). It has no network of its own, only cli-net.sock, and answers
//   on /run/agentv-router-cli/route.sock.
//
// Each takes one sentence a request, POST /route with the provider, the
// sentence and the apps who's watching can open, and answers with the
// route. The daemon's group, agentv-router, is the only one that reaches
// them. Neither logs what was said.
//
// Usage: node router-serve.ts api|cli

import { chmodSync, chownSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join, resolve } from "node:path";
import type { Provider } from "./ai.ts";
import { NetFilter, type Policy } from "./net-filter.ts";
import { cliBackend, CLI_PROVIDERS, isCliProvider } from "./providers/cli.ts";
import { apiBackend } from "./providers/index.ts";
import { Router, type Routed, type RouterApp } from "./router.ts";
import { forward } from "../builder/sandbox/forward.ts";
import { PLAN_HOSTS } from "../builder/sandbox/net.ts";
import { keyFrom } from "../builder/sandbox/relay.ts";

const PROVIDERS: Provider[] = ["claude", "chatgpt", "gemini", "grok", "muse"];

// At most this many sentences a minute: a household talks slower than
// that, and a stuck page can't spend the key.
export const PER_MINUTE = 30;

export interface RouteRequest {
  provider: Provider;
  sentence: string;
  apps: RouterApp[];
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "");

// A request as the services take it, within bounds, or why not.
export function routeRequest(body: unknown): RouteRequest | string {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!PROVIDERS.includes(b.provider as Provider)) return "which provider";
  if (typeof b.sentence !== "string") return "which sentence";
  const apps = Array.isArray(b.apps) ? b.apps.slice(0, 100) : [];
  return {
    provider: b.provider as Provider,
    sentence: b.sentence.slice(0, 300),
    apps: apps.flatMap((a) => {
      const app = (typeof a === "object" && a !== null ? a : {}) as Record<string, unknown>;
      const id = text(app.id, 80);
      return /^[a-z0-9][a-z0-9.-]*$/.test(id) ? [{ id, name: text(app.name, 60) || id, category: text(app.category, 20) || "utility" }] : [];
    }),
  };
}

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export interface ServeOptions {
  route: (request: RouteRequest) => Promise<Routed>;
  log?: (line: string) => void;
  now?: () => number;
}

// The route server, for either service.
export function routeServer(o: ServeOptions): Server {
  const now = o.now ?? Date.now;
  let recent: number[] = [];
  return createServer(async (request, response) => {
    const answer = (status: number, data: object) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (request.method !== "POST" || request.url !== "/route") return answer(404, { ok: false, error: "only POST /route" });
    const asked = routeRequest(await body(request));
    if (typeof asked === "string") return answer(400, { ok: false, error: asked });
    recent = recent.filter((at) => now() - at < 60_000);
    if (recent.length >= PER_MINUTE) return answer(429, { ok: false, error: "too many sentences at once: try again in a minute" });
    recent.push(now());
    const routed = await o.route(asked);
    o.log?.(`${routed.provider} ${routed.via} ${routed.model ?? "its own model"}: ${routed.route.intent}${routed.none ? ` (${routed.none})` : ""} in ${routed.ms} ms${routed.spent !== undefined ? `, $${routed.spent.toFixed(5)}` : ""}${routed.error ? `: ${routed.error}` : ""}`);
    answer(200, { ok: true, routed });
  });
}

// The plan CLIs' way out: their providers' own hosts, on 443.
export function cliPolicy(): Policy {
  const hosts = new Set(CLI_PROVIDERS.flatMap((provider) => PLAN_HOSTS[provider]).map((host) => `${host}:443`));
  return (host, port, scheme) => scheme === "https" && hosts.has(`${host}:${port}`);
}

export function cliNet(log?: (line: string) => void): NetFilter {
  return new NetFilter({ policy: cliPolicy(), log });
}

// The agentv-router group's id, which the sockets are given.
function routerGroup(): number | null {
  for (const line of readFileSync("/etc/group", "utf8").split("\n")) {
    const [name, , gid] = line.split(":");
    if (name === "agentv-router") return Number(gid);
  }
  return null;
}

function listen(server: Server | NetFilter, path: string): Promise<void> {
  rmSync(path, { force: true });
  const done = () => {
    chmodSync(path, 0o660);
    const gid = routerGroup();
    if (gid !== null) chownSync(path, -1, gid);
  };
  if (server instanceof NetFilter) return server.listenPath(path).then(done);
  return new Promise((resolve) => server.listen(path, () => (done(), resolve())));
}

const PROXY_PORT = 8080;

async function main(): Promise<void> {
  const mode = process.argv[2];
  const log = (line: string) => console.log(line);
  if (mode === "api") {
    const run = process.env.RUNTIME_DIRECTORY ?? "/run/agentv-router";
    const credentials = process.env.CREDENTIALS_DIRECTORY;
    // The key, from the credential systemd handed this service as it
    // started. agentv-key.service restarts it after a key is kept or taken
    // off, so it always has the one in /etc/agentv/env.
    const key = (provider: Provider) => (credentials ? keyFrom(readFileSync(join(credentials, "env"), "utf8"), provider) : null);
    const server = routeServer({
      log,
      route: async ({ provider, sentence, apps }) => {
        const found = key(provider);
        // A stand-in for the provider's API, for the image checks, which
        // only a drop-in of root's can set.
        const base = process.env.AGENTV_ROUTER_UPSTREAM || undefined;
        const backend = apiBackend(provider, { key: found ?? "", ...(base ? { base } : {}) });
        if (!found) {
          return { sentence, route: { intent: "none", query: null, kind: null, app: null, season: null, episode: null }, none: "failed", error: "there's no key for this provider on the box", provider, via: "api", model: backend.model, ms: 0 };
        }
        return new Router(backend).route(sentence, apps);
      },
    });
    await listen(server, join(run, "router.sock"));
    await listen(cliNet(log), join(run, "cli-net.sock"));
    log(`agentv router: the provider's API with the household's key, on ${run}`);
  } else if (mode === "cli") {
    const run = process.env.RUNTIME_DIRECTORY ?? "/run/agentv-router-cli";
    const home = process.env.HOME ?? "/var/lib/agentv/builder";
    const net = process.env.AGENTV_ROUTER_NET ?? "/run/agentv-router/cli-net.sock";
    await forward(PROXY_PORT, net);
    const proxy = `http://127.0.0.1:${PROXY_PORT}`;
    const server = routeServer({
      log,
      route: async ({ provider, sentence, apps }) => {
        if (!isCliProvider(provider)) {
          return { sentence, route: { intent: "none", query: null, kind: null, app: null, season: null, episode: null }, none: "failed", error: "that plan can't take requests yet", provider, via: "cli", model: null, ms: 0 };
        }
        return new Router(cliBackend(provider, { home, proxy })).route(sentence, apps);
      },
    });
    await listen(server, join(run, "route.sock"));
    log(`agentv router: a plan's CLI from ${home}, on ${run}`);
  } else {
    console.error("Usage: node router-serve.ts api|cli");
    process.exit(2);
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main();
