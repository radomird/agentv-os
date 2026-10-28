// One build in the agentv-builder sandbox (agentv-builder@.service). The
// sandbox has no network of its own: its loopback is its own, and its only
// way out is agentv-build-net's two socket files. This forwards a port on
// that loopback to each, since the provider CLIs take a proxy and a base URL
// as addresses, and then runs the build.
//
// - 127.0.0.1:8080: the filter, as HTTPS_PROXY;
// - 127.0.0.1:8081: the key relay, as the provider's address, with a key.
//
// Usage: node start.ts <build-dir>

import { join, resolve } from "node:path";
import { Build } from "../build.ts";
import { gates } from "../gates/gates.ts";
import { Runner } from "../run.ts";
import { forward } from "./forward.ts";
import { PROXY_PORT, RELAY_PORT } from "./ports.ts";

export { forward, PROXY_PORT, RELAY_PORT };

// A build stopped while it was going, as the TV and the phone show it.
export function stopped(build: Build): void {
  const now = build.status();
  if (!now || now.state !== "running") return;
  const steps = now.steps.map((step) => (step.state === "running" ? { ...step, state: "failed" as const } : step));
  build.setStatus({ ...now, state: "failed", steps, reason: "you stopped it", at: new Date().toISOString() });
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.removeAllListeners("warning");
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node start.ts <build-dir>");
    process.exit(2);
  }
  const net = process.env.AGENTV_BUILD_NET ?? "/run/agentv-build-net";
  const servers = [await forward(PROXY_PORT, join(net, "proxy.sock")), await forward(RELAY_PORT, join(net, "relay.sock"))];
  // A stop from the TV: the build says it was stopped, rather than still
  // going, and keeps what it had.
  process.once("SIGTERM", () => {
    stopped(new Build(dir));
    process.exit(1);
  });
  const root = process.env.AGENTV_PATH ?? "/usr/share/agentv";
  const proxy = `http://127.0.0.1:${PROXY_PORT}`;
  const status = await new Runner(dir, {
    root,
    home: process.env.HOME,
    proxy,
    relay: `http://127.0.0.1:${RELAY_PORT}`,
    standIn: process.env.AGENTV_BUILD_STAND_IN,
    gates: (build, recipe) => gates(build, recipe, { root, proxy }),
  }).run();
  for (const server of servers) server.close();
  process.exit(status.state === "failed" ? 1 : 0);
}
