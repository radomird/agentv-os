// How an app's request goes out (daemon/apps/reach.ts): never to this box,
// whatever a name resolves to, to the very address that was checked, and
// without the headers only the loader may say.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import { boxAddress, boxHost, linkLocalElsewhere } from "../../../apps/contract/address.ts";
import { appHeaders, checked, reach } from "../../../daemon/apps/reach.ts";

let server: Server;
let port = 0;
const seen: IncomingMessage[] = [];

before(async () => {
  server = createServer((request, response) => {
    seen.push(request);
    if (request.url === "/packed") {
      response.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
      response.end(gzipSync("packed on the way"));
    } else if (request.url === "/moved") {
      response.writeHead(302, { Location: "http://127.0.0.1:3000/api/home" });
      response.end();
    } else if (request.url === "/big") {
      response.end(Buffer.alloc(4096, 1));
    } else if (request.url === "/echo") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => response.end(`${request.method} ${body}`));
    } else {
      response.setHeader("Set-Cookie", ["a=1", "b=2"]);
      response.end("from the app's own server");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

after(() => server.close());

// The stand-in server is on this machine, so here nothing counts as the box
// unless a test says so.
const open = { forbid: () => false };

test("F2 a request to this box is refused, however its address is written", async () => {
  const out = reach();
  for (const address of [`http://127.0.0.1:${port}/`, `http://[::1]:${port}/`, `http://[::ffff:7f00:1]:${port}/`, `http://2130706433:${port}/`, `http://0.0.0.0:${port}/`, "http://169.254.169.254/"]) {
    await assert.rejects(out(address), /is this tv itself/, address);
  }
  assert.equal(seen.length, 0);
});

test("F2 a name that resolves to this box is refused, by loopback and by the box's own address on the network", async () => {
  const asked: string[] = [];
  const resolve = async (host: string) => {
    asked.push(host);
    return host === "tv.example" ? ["192.168.1.50"] : host === "both.example" ? ["93.184.215.14", "127.0.0.1"] : ["127.0.0.1"];
  };
  const out = reach({ resolve, forbid: (address) => boxAddress(address, ["192.168.1.50"]) });
  for (const host of ["daemon.example", "tv.example", "both.example"]) await assert.rejects(out(`http://${host}:${port}/`), /is this tv itself/, host);
  assert.deepEqual(asked, ["daemon.example", "tv.example", "both.example"]);
  assert.equal(seen.length, 0);
  await assert.rejects(reach({ resolve: async () => [], ...open })(`http://nowhere.example:${port}/`), /doesn't resolve/);
});

test("F2 the connection goes to the address that was checked, and the name is looked up once", async () => {
  // media.example is no name anywhere: only the checked address gets it there.
  let lookups = 0;
  const out = reach({
    resolve: async () => {
      lookups++;
      return ["127.0.0.1"];
    },
    ...open,
  });
  const response = await out(`http://media.example:${port}/`);
  assert.equal(await response.text(), "from the app's own server");
  assert.equal(lookups, 1);
  assert.equal(seen.at(-1)!.headers.host, `media.example:${port}`);
  assert.deepEqual(response.headers.getSetCookie(), ["a=1", "b=2"]);
});

// The box here has 192.168.1.50 and fe80::50 on its network. The stand-in
// server is on 127.0.0.1, which plays the server's address on the home
// network, so it alone isn't the box in these.
const box = ["192.168.1.50", "fe80::50%eth0"];
const home = { own: () => box, forbid: (address: string) => address !== "127.0.0.1" && boxAddress(address, box) };

test("a server that also answers by a link-local address is reached, by its other address only", async () => {
  const before = seen.length;
  for (const beside of ["fe80::1234", "fe80::1234%eth0", "169.254.7.7", "::ffff:169.254.7.7"]) {
    const options = { ...home, resolve: async () => [beside, "127.0.0.1"] };
    assert.deepEqual(await checked("nas.local", options), [{ address: "127.0.0.1", family: 4 }], beside);
    const response = await reach(options)(`http://nas.local:${port}/`);
    assert.equal(await response.text(), "from the app's own server", beside);
  }
  assert.equal(seen.length, before + 4);
});

test("a name with only link-local addresses is refused, since nothing is left to go to", async () => {
  const before = seen.length;
  for (const only of [["fe80::1234"], ["169.254.7.7", "fe80::1234"]]) {
    await assert.rejects(reach({ ...home, resolve: async () => only })(`http://nas.local:${port}/`), /is this tv itself/, only.join(" "));
  }
  assert.equal(seen.length, before);
});

test("F2 a name that points at this box by any address stays refused, with a server's address beside it or not", async () => {
  const before = seen.length;
  // The box's own link-local address, with and without its zone and written
  // out in full, then loopback, the box's address on the network and nowhere.
  for (const mine of ["fe80::50", "fe80::50%wlan0", "fe80:0:0:0:0:0:0:50", "127.0.0.1", "::1", "192.168.1.50", "::ffff:192.168.1.50", "0.0.0.0"]) {
    for (const addresses of [["192.168.1.20", mine], [mine, "192.168.1.20"], ["fe80::1234", mine, "192.168.1.20"]]) {
      const options = { own: () => box, resolve: async () => addresses };
      await assert.rejects(reach(options)(`http://nas.local:${port}/`), /is this tv itself/, addresses.join(" "));
      await assert.rejects(checked("nas.local", options), /is this tv itself/, addresses.join(" "));
    }
  }
  // A link-local address typed as the host is refused as before, a
  // neighbour's too.
  for (const typed of ["http://[fe80::1234]/", "http://169.254.7.7/", "http://[fe80::50]/"]) await assert.rejects(reach({ own: () => box })(typed), /is this tv itself/, typed);
  assert.equal(seen.length, before);
});

test("a link-local address is someone else's only when the box doesn't have it", () => {
  for (const address of ["fe80::1234", "fe80::1234%eth0", "[fe80::1234]", "febf::1", "169.254.7.7", "::ffff:169.254.7.7"]) assert.ok(linkLocalElsewhere(address, box), address);
  for (const address of ["fe80::50", "fe80::50%wlan0", "fe80:0000::0050", "127.0.0.1", "::1", "::", "0.0.0.0", "192.168.1.20", "192.168.1.50", "2001:db8::20", "fec0::1", "nas.local", ""]) assert.ok(!linkLocalElsewhere(address, box), address);
  assert.ok(!linkLocalElsewhere("169.254.7.7", ["169.254.7.7"]));
  assert.ok(!linkLocalElsewhere("::ffff:169.254.7.7", ["169.254.7.7"]));
  // boxAddress means what it did: link-local is the box, whoever has it.
  for (const address of ["fe80::1234", "169.254.7.7", "fe80::50"]) assert.ok(boxAddress(address, box), address);
});

test("F2 an app's headers go along, but never the box's own or the connection's", async () => {
  const headers = appHeaders([
    ["Accept", "application/json"],
    ["X-AgenTV-Screen", "1"],
    ["x-agentv-anything", "1"],
    ["Host", "127.0.0.1:3000"],
    ["Connection", "upgrade"],
    ["Transfer-Encoding", "chunked"],
    ["Authorization", "Bearer app-token"],
  ]);
  assert.deepEqual([...headers.keys()].sort(), ["accept", "authorization"]);
  await reach(open)(`http://127.0.0.1:${port}/`, { headers });
  const got = seen.at(-1)!.headers;
  assert.equal(got.host, `127.0.0.1:${port}`);
  assert.equal(got["x-agentv-screen"], undefined);
  assert.equal(got.authorization, "Bearer app-token");
});

test("an answer comes back as fetch gives it: unpacked, a redirect as it is, a body sent, and not too big", async () => {
  const out = reach({ ...open, maxBytes: 1024 });
  const packed = await out(`http://127.0.0.1:${port}/packed`);
  assert.equal(await packed.text(), "packed on the way");
  assert.equal(packed.headers.get("content-encoding"), null);
  const moved = await out(`http://127.0.0.1:${port}/moved`);
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get("location"), "http://127.0.0.1:3000/api/home");
  const echoed = await out(`http://127.0.0.1:${port}/echo`, { method: "POST", body: new TextEncoder().encode("hello") });
  assert.equal(await echoed.text(), "POST hello");
  await assert.rejects(out(`http://127.0.0.1:${port}/big`), /too big/);
  await assert.rejects(out("ftp://media.example/"), /isn't http or https/);
});

test("F2 this box by how a host is written, and the home network isn't it", () => {
  for (const host of ["localhost", "LOCALHOST", "localhost.", "tv.localhost", "127.0.0.1", "127.1.2.3", "0.0.0.0", "[::1]", "[::]", "[::ffff:7f00:1]", "[::ffff:127.0.0.1]", "169.254.1.1", "[fe80::1]"]) {
    assert.ok(boxHost(host), host);
  }
  for (const host of ["192.168.1.20", "10.0.0.5", "nas.local", "jellyfin.home.arpa", "example.org", "[2001:db8::20]", "localhost.example.org"]) assert.ok(!boxHost(host), host);
  assert.ok(boxHost("192.168.1.50", ["192.168.1.50"]));
  assert.ok(!boxHost("192.168.1.20", ["192.168.1.50"]));
});
