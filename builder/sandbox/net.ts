// The sandbox's way out (ADR-045): agentv-build-net.service, outside the
// sandbox, on two socket files the builder's own network-less sandbox can
// reach (builder/sandbox/start.ts forwards to them).
//
// - proxy.sock: the filter. A build reaches the npm registry and OSV.dev,
//   the origins its app declares for its tests, within its recipe's bounds,
//   and, on a plan, the provider the plan signs in to. Nothing else, and
//   never this box.
// - relay.sock: the key relay (relay.ts), with a key.
// - page.sock: in a streaming service's stage B, a page of the service as
//   the household's signed-in browser shows it (ADR-011): its structure and
//   a copy without its scripts, on the build's declared origins only, which
//   the daemon asks the screen daemon for. Never the browser itself.
//
// What the running build is comes from root's ticket, never from the build
// itself; the origins it declared come from its state, read again for each
// request, so one declared mid-build works at once.

import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { NetFilter, type Policy } from "../../daemon/net-filter.ts";
import type { Provider } from "../build.ts";
import { KINDS, loadRecipes, type Kind } from "../recipe.ts";
import { keyFrom, Relay, type Ticket } from "./relay.ts";

// npm's registry and OSV.dev, for the guarded packages (ADR-044).
export const ALWAYS = ["registry.npmjs.org", "api.osv.dev"];

// The hosts a provider's CLI reaches on a plan: its model calls and the
// sign-in it refreshes. With a key the CLI reaches the relay, not these.
export const PLAN_HOSTS: Record<Provider, string[]> = {
  claude: ["api.anthropic.com", "platform.claude.com", "claude.ai", "console.anthropic.com"],
  chatgpt: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
  gemini: [],
  grok: ["cli-chat-proxy.grok.com", "auth.x.ai"],
  muse: ["api.meta.ai", "auth.meta.com"],
};

// The plan's sign-in, the first time the builder runs (ADR-040): the same
// hosts, and the pages the CLI's own sign-in goes through.
export const SIGN_IN_HOSTS: Record<Provider, string[]> = {
  claude: [...PLAN_HOSTS.claude, "claude.com", "sso.claude.com"],
  chatgpt: PLAN_HOSTS.chatgpt,
  gemini: [],
  grok: PLAN_HOSTS.grok,
  muse: PLAN_HOSTS.muse,
};

export interface Declared {
  origins: string[];
  originsAllowed: boolean; // the recipe's bounds
}

// host:port the build may reach, from its ticket and what it declared.
export function allowed(ticket: Ticket | null, declared: Declared, signIn = false): Set<string> {
  const hosts = new Set<string>();
  if (!ticket) return hosts;
  for (const host of ALWAYS) hosts.add(`${host}:443`);
  if (ticket.path === "plan") for (const host of (signIn ? SIGN_IN_HOSTS : PLAN_HOSTS)[ticket.provider]) hosts.add(`${host}:443`);
  const origins = ticket.recipe === null ? (ticket.origins ?? []) : declared.originsAllowed ? declared.origins : [];
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password) continue;
      hosts.add(`${url.hostname.toLowerCase()}:${url.port || 443}`);
    } catch {}
  }
  return hosts;
}

export interface PageOptions {
  ticket: () => Ticket | null;
  declared: (ticket: Ticket) => string[]; // its origins
  ask: (url: string) => Promise<object>; // the daemon's answer
  log: (line: string) => void;
}

// Stage B's look at the signed-in pages: one ask at a time, an address on
// the running build's declared origins, while it's in stage B.
export function pageServer(o: PageOptions): Server {
  let busy = false;
  return createServer(async (request, response) => {
    const answer = (status: number, body: object) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || request.url !== "/snapshot") return answer(404, { ok: false, error: "only POST /snapshot" });
    let text = "";
    for await (const chunk of request) {
      text += chunk;
      if (text.length > 4096) return answer(413, { ok: false, error: "an address, and nothing more" });
    }
    let url: URL;
    try {
      url = new URL(String(JSON.parse(text).url));
    } catch {
      return answer(400, { ok: false, error: "an address like https://service.example/" });
    }
    const ticket = o.ticket();
    if (!ticket || ticket.phase !== "stage-b") return answer(403, { ok: false, error: "the service's signed-in pages are for stage B, after the household signed in" });
    if (url.protocol !== "https:" || !o.declared(ticket).includes(url.origin)) return answer(403, { ok: false, error: `${url.origin} isn't one of the build's declared origins` });
    if (busy) return answer(429, { ok: false, error: "one page at a time" });
    busy = true;
    try {
      o.log(`stage B: ${ticket.id} looks at ${url.origin}`);
      answer(200, await o.ask(url.href));
    } catch (error) {
      answer(502, { ok: false, error: `the TV couldn't show it: ${(error as Error).message}` });
    } finally {
      busy = false;
    }
  });
}

// Only https, and only what's on the list.
export function policy(list: () => Set<string>): Policy {
  return (host, port, scheme) => scheme === "https" && list().has(`${host.toLowerCase()}:${port}`);
}

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

// What the running build declared: the origins in its state, and whether its
// recipe lets an app have any, from AgenTV's own recipes, not the build's.
export function declaredBy(ticket: Ticket | null, recipesRoot: string): Declared {
  if (!ticket || ticket.recipe === null) return { origins: [], originsAllowed: false };
  if (!KINDS.includes(ticket.recipe as Kind)) return { origins: [], originsAllowed: false };
  let originsAllowed = false;
  try {
    originsAllowed = loadRecipes(recipesRoot).get(ticket.recipe as Kind)?.bounds.origins ?? false;
  } catch {}
  const state = readJson<{ origins?: { origin?: unknown }[] }>(join(ticket.dir, "state.json"));
  const origins = (state?.origins ?? []).map((o) => o?.origin).filter((o): o is string => typeof o === "string");
  return { origins, originsAllowed };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.removeAllListeners("warning");
  const root = process.env.AGENTV_PATH ?? "/usr/share/agentv";
  const run = process.env.RUNTIME_DIRECTORY ?? "/run/agentv-build-net";
  const ticketPath = process.env.AGENTV_BUILD_TICKET ?? "/run/agentv-build/ticket.json";
  // A plan's first sign-in will leave its own ticket here (ADR-040).
  const signInPath = process.env.AGENTV_BUILD_SIGN_IN ?? "/run/agentv-build/sign-in.json";
  const keyPath = process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, "env") : null;
  const ticket = () => readJson<Ticket>(ticketPath);
  const log = (line: string) => console.log(line);

  const filter = new NetFilter({
    policy: policy(() => {
      const build = ticket();
      if (build) return allowed(build, declaredBy(build, join(root, "builder/recipes")));
      return allowed(readJson<Ticket>(signInPath), { origins: [], originsAllowed: false }, true);
    }),
    log,
  });
  const relay = new Relay({
    ticket,
    // The key as systemd handed it over when this started: root restarts
    // this for each build, so a new key in Settings → AI counts from the
    // next one. It never leaves this process but to its provider.
    key: (provider) => {
      if (!keyPath) return null;
      try {
        return keyFrom(readFileSync(keyPath, "utf8"), provider);
      } catch {
        return null;
      }
    },
    spendPath: process.env.AGENTV_SPEND ?? "/var/lib/agentv/spend/spend.json",
    log,
  });
  // The daemon, on the box's own address, takes stage B's asks to the
  // screen daemon, which holds the signed-in browser.
  const daemon = process.env.AGENTV_DAEMON ?? "http://127.0.0.1:3000";
  const page = pageServer({
    ticket,
    declared: (build) => {
      const said = declaredBy(build, join(root, "builder/recipes"));
      return said.originsAllowed ? said.origins : [];
    },
    ask: async (url) => {
      const response = await fetch(`${daemon}/api/builder/page`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(120_000) });
      return (await response.json()) as object;
    },
    log,
  });
  for (const name of ["proxy.sock", "relay.sock", "page.sock"]) rmSync(join(run, name), { force: true });
  await filter.listenPath(join(run, "proxy.sock"));
  await relay.listen(join(run, "relay.sock"));
  await new Promise<void>((done) => page.listen(join(run, "page.sock"), done));
  // The builder reaches them through its group, and nobody else does.
  for (const name of ["proxy.sock", "relay.sock", "page.sock"]) chmodSync(join(run, name), 0o660);
  log(`the builder's way out is ready in ${run}`);
  if (process.env.NOTIFY_SOCKET) execFileSync("systemd-notify", ["--ready"]);
}
