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

import { createConnection, createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { Runner } from "../run.ts";

export const PROXY_PORT = 8080;
export const RELAY_PORT = 8081;

// A port on this loopback that passes each connection to a socket file.
export function forward(port: number, path: string): Promise<Server> {
  // Half-open both ways, so a side that's done sending still gets its answer.
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = createConnection({ path, allowHalfOpen: true });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done(server));
  });
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
  const status = await new Runner(dir, {
    root: process.env.AGENTV_PATH,
    home: process.env.HOME,
    proxy: `http://127.0.0.1:${PROXY_PORT}`,
    relay: `http://127.0.0.1:${RELAY_PORT}`,
    standIn: process.env.AGENTV_BUILD_STAND_IN,
  }).run();
  for (const server of servers) server.close();
  process.exit(status.state === "failed" ? 1 : 0);
}
