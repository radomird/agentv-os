// The daemon's way to the router (daemon/router-serve.ts): the provider
// setup chose, through its API with the key, or through its plan's CLI.
// The daemon never holds the key; it only says which provider, and the
// router service picks up that provider's key. Until the AI is set up, its
// terms accepted and its key kept, every sentence comes back as none, with
// what's missing, so the TV says why rather than guessing.

import { request } from "node:http";
import { OFFERS, type AiState, type Provider } from "./ai.ts";
import { AI_NAMES } from "../builder/reasons.ts";
import { isCliProvider } from "./providers/cli.ts";
import { CANT_ANSWER, TOOK_TOO_LONG } from "./providers/no-answer.ts";
import { NONE, type Routed, type RouterApp } from "./router.ts";

export const ROUTER_SOCKETS = { api: "/run/agentv-router/router.sock", cli: "/run/agentv-router-cli/route.sock" };

// A route of none, and why, for a sentence the router never got.
export function unrouted(sentence: string, provider: Provider, via: "api" | "cli", error: string, setup?: Routed["setup"]): Routed {
  return { sentence, route: { ...NONE }, none: "failed", error, provider, via, model: null, ms: 0, ...(setup ? { setup } : {}) };
}

// One sentence to a route service, over its socket.
export function viaSocket(path: string, body: { provider: Provider; sentence: string; apps: RouterApp[] }, timeoutMs = 45_000): Promise<Routed> {
  const via = path.includes("router-cli") ? "cli" : "api";
  return new Promise((resolve) => {
    const failed = (error: string) => resolve(unrouted(body.sentence, body.provider, via, error));
    const asked = request({ socketPath: path, path: "/route", method: "POST", headers: { "Content-Type": "application/json" }, timeout: timeoutMs }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => {
        try {
          const answer = JSON.parse(text);
          if (answer.ok && answer.routed) resolve(answer.routed as Routed);
          else failed(String(answer.error ?? "the router didn't answer").slice(0, 160));
        } catch {
          failed("the router didn't answer");
        }
      });
    });
    asked.on("timeout", () => {
      asked.destroy();
      failed(TOOK_TOO_LONG);
    });
    asked.on("error", (error: NodeJS.ErrnoException) => failed(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? CANT_ANSWER : error.message));
    asked.end(JSON.stringify(body));
  });
}

export interface BoxRouterOptions {
  ai: () => Promise<AiState>;
  key: () => { set: boolean; provider: string | null };
  sockets?: { api: string; cli: string };
}

// The router the box's own setup chose.
export function boxRouter(o: BoxRouterOptions): (sentence: string, apps: RouterApp[]) => Promise<Routed> {
  const sockets = o.sockets ?? ROUTER_SOCKETS;
  return async (sentence, apps) => {
    const ai = await o.ai();
    const provider = ai.provider ?? "claude";
    const via = ai.path === "plan" ? "cli" : "api";
    if (!ai.provider || !ai.path) return unrouted(sentence, provider, via, "Set up AI in Settings first", "ai");
    const offer = OFFERS[ai.provider];
    const name = AI_NAMES[ai.provider];
    if (!ai.accepted) return unrouted(sentence, provider, via, `Accept ${name}'s terms first`, "terms");
    if (ai.path === "key") {
      const key = o.key();
      if (!key.set || key.provider !== ai.provider) return unrouted(sentence, provider, via, `Add your ${name} key in Settings first`, "key");
      return viaSocket(sockets.api, { provider, sentence, apps });
    }
    if (!isCliProvider(ai.provider)) return unrouted(sentence, provider, via, `${offer.plan.name} can't do this yet`, "plan");
    return viaSocket(sockets.cli, { provider, sentence, apps });
  };
}
