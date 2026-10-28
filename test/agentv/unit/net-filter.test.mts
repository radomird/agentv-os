// The filter home's Chromium and the builder's sandbox go through
// (daemon/net-filter.ts, ADR-043, ADR-045): through to what its policy
// names, never anywhere else, and never to this box whatever a name says.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { after, before, test } from "node:test";
import { forbiddenAddress, NetFilter, target } from "../../../daemon/net-filter.ts";

let site: Server;
let sitePort = 0;
let filter: NetFilter;
let port = 0;
const allowed = new Set(["allowed.example"]);

before(async () => {
  site = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`hello from ${req.headers.host} ${req.url}`);
  });
  sitePort = await new Promise((resolve) => site.listen(0, "127.0.0.1", () => resolve((site.address() as { port: number }).port)));
  // The test's sites are on this box, so here only the box's own name is
  // this box.
  filter = new NetFilter({
    policy: (host) => allowed.has(host),
    resolve: async (host) => (host === "box.example" ? "127.0.0.1" : host.endsWith(".example") ? "127.0.0.1" : Promise.reject(new Error("no such name"))),
    forbid: () => false,
  });
  port = await filter.listen();
});

after(async () => {
  await filter.close();
  site.close();
});

// CONNECT through the filter: what it answered, and what came back through
// the tunnel for a plain request sent down it.
function tunnel(to: string, via = port): Promise<{ status: string; body?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(via, "127.0.0.1", () => socket.write(`CONNECT ${to} HTTP/1.1\r\nHost: ${to}\r\n\r\n`));
    let data = "";
    let sent = false;
    socket.on("data", (chunk) => {
      data += chunk;
      if (!sent && data.includes("\r\n\r\n")) {
        const status = data.split("\r\n")[0];
        if (!status.includes(" 200 ")) {
          socket.destroy();
          resolve({ status });
          return;
        }
        sent = true;
        data = "";
        socket.write(`GET /through HTTP/1.1\r\nHost: ${to}\r\nConnection: close\r\n\r\n`);
      }
    });
    socket.on("end", () => resolve({ status: "HTTP/1.1 200 Connection Established", body: data }));
    socket.on("error", reject);
  });
}

function plain(url: string, via = port): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: via, path: url, headers: { Host: new URL(url).host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a CONNECT target is host:port, with [::1]:443 for IPv6", () => {
  assert.deepEqual(target("api.example.org:443"), { host: "api.example.org", port: 443 });
  assert.deepEqual(target("[::1]:8443"), { host: "::1", port: 8443 });
  for (const bad of ["api.example.org", "api.example.org:0", "api.example.org:70000", "a b:443", "http://x:443"]) assert.equal(target(bad), null, bad);
});

test("the box's own addresses are never reached", () => {
  for (const address of ["127.0.0.1", "127.8.9.10", "0.0.0.0", "::1", "::", "::ffff:127.0.0.1", "169.254.169.254", "fe80::1"]) assert.ok(forbiddenAddress(address), address);
  for (const address of ["192.168.1.20", "10.0.0.5", "93.184.215.14", "2a00:1450::1"]) assert.ok(!forbiddenAddress(address), address);
});

test("ADR-045 a host on the list gets through, by CONNECT and plain http", async () => {
  const through = await tunnel(`allowed.example:${sitePort}`);
  assert.match(through.status, / 200 /);
  assert.match(through.body ?? "", /hello from allowed\.example:\d+ \/through/);
  const direct = await plain(`http://allowed.example:${sitePort}/page?x=1`);
  assert.equal(direct.status, 200);
  assert.match(direct.body, /hello from allowed\.example:\d+ \/page\?x=1/);
});

test("a tunnel the site closes first doesn't stay open in the filter", async () => {
  // An https site that closes once it has answered, and a client that reads
  // the answer and closes a moment later, as a browser does.
  const dir = mkdtempSync(join(tmpdir(), "agentv-net-filter-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=allowed.example", "-addext", "subjectAltName=DNS:allowed.example", "-days", "2", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  const cert = readFileSync(join(dir, "cert.pem"));
  const secureSite = createSecureServer({ key: readFileSync(join(dir, "key.pem")), cert }, (_req, res) => res.end("hello over tls"));
  const securePort = await new Promise<number>((resolve) => secureSite.listen(0, "127.0.0.1", () => resolve((secureSite.address() as { port: number }).port)));
  const leaky = new NetFilter({ policy: () => true, resolve: async () => "127.0.0.1", forbid: () => false });
  const leakyPort = await leaky.listen();
  const sockets = new Set<import("node:net").Socket>();
  leaky.server.on("connection", (socket) => sockets.add(socket));
  try {
    const raw = connect(leakyPort, "127.0.0.1", () => raw.write(`CONNECT allowed.example:${securePort} HTTP/1.1\r\nHost: x\r\n\r\n`));
    await new Promise((resolve) => raw.once("data", resolve));
    const tls = tlsConnect({ socket: raw, servername: "allowed.example", ca: cert });
    tls.write("GET / HTTP/1.1\r\nHost: allowed.example\r\nConnection: close\r\n\r\n");
    let data = "";
    tls.on("data", (chunk) => (data += chunk));
    tls.on("error", () => {});
    await new Promise<void>((resolve) => {
      const wait = setInterval(() => {
        if (data.includes("hello over tls")) {
          clearInterval(wait);
          resolve();
        }
      }, 10);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    tls.destroy();
    raw.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const open = await new Promise<number>((resolve) => leaky.server.getConnections((_e, n) => resolve(n)));
    assert.equal(open, 0, "the filter let go of the client");
  } finally {
    // So a leak fails this test rather than hanging the rest.
    for (const socket of sockets) socket.destroy();
    await leaky.close();
    secureSite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADR-043 S6.8 a host that isn't on the list is refused", async () => {
  assert.match((await tunnel(`elsewhere.example:${sitePort}`)).status, / 403 /);
  assert.equal((await plain(`http://elsewhere.example:${sitePort}/`)).status, 403);
  assert.match((await tunnel(`nonsense`)).status, / 403 /);
  assert.equal((await plain("https://allowed.example/")).status, 400);
});

test("ADR-045 a name that points at this box is refused, even on the list", async () => {
  const strict = new NetFilter({ policy: () => true, resolve: async () => "127.0.0.1" });
  const strictPort = await strict.listen();
  try {
    assert.match((await tunnel(`allowed.example:${sitePort}`, strictPort)).status, / 403 /);
    assert.equal((await plain(`http://allowed.example:${sitePort}/`, strictPort)).status, 403);
    assert.match((await tunnel(`127.0.0.1:${sitePort}`, strictPort)).status, / 403 /);
  } finally {
    await strict.close();
  }
});
