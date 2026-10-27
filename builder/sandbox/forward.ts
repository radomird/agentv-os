// A port on the sandbox's own loopback that passes each connection to a
// socket file of the builder's way out (net.ts): a build's (start.ts) and a
// plan's sign-in (../sign-in.ts) reach the filter and the relay this way.

import { createConnection, createServer, type Server } from "node:net";

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
