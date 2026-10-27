// The sandbox's way out (ADR-045): agentv-build-net.service, outside the
// sandbox, on two socket files the builder's own network-less sandbox can
// reach (builder/sandbox/start.ts forwards to them).
//
// - proxy.sock: the filter. A build reaches the npm registry and OSV.dev,
//   the origins its app declares for its tests, within its recipe's bounds,
//   and, on a plan, the provider the plan signs in to. Nothing else, and
//   never this box.
// - relay.sock: the key relay (relay.ts), with a key.
//
// What the running build is comes from root's ticket, never from the build
// itself; the origins it declared come from its state, read again for each
// request, so one declared mid-build works at once.

import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync } from "node:fs";
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
};

// The plan's sign-in, the first time the builder runs (ADR-040): the same
// hosts, and the pages the CLI's own sign-in goes through.
export const SIGN_IN_HOSTS: Record<Provider, string[]> = {
  claude: [...PLAN_HOSTS.claude, "claude.com", "sso.claude.com"],
  chatgpt: PLAN_HOSTS.chatgpt,
  gemini: [],
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
  for (const name of ["proxy.sock", "relay.sock"]) rmSync(join(run, name), { force: true });
  await filter.listenPath(join(run, "proxy.sock"));
  await relay.listen(join(run, "relay.sock"));
  // The builder reaches them through its group, and nobody else does.
  for (const name of ["proxy.sock", "relay.sock"]) chmodSync(join(run, name), 0o660);
  log(`the builder's way out is ready in ${run}`);
  if (process.env.NOTIFY_SOCKET) execFileSync("systemd-notify", ["--ready"]);
}
