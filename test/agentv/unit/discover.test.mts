// Servers and shares on the home network (daemon/discover.ts): each way of
// hearing them, on what real servers answered (fixtures/discover), then a
// look through the daemon against stand-ins on this machine, which shows
// what's found, that Immich is asked only on a machine that announced
// something, and that nothing else is asked.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import { createServer as createTcp, type Server as TcpServer } from "node:net";
import { createSocket, type Socket } from "node:dgram";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  avahiLabel,
  avahiLine,
  gdmAnswer,
  immichPong,
  mdnsFound,
  nfsExports,
  rpcCall,
  rpcResult,
  serverAnswer,
  smbShares,
  wsdComputer,
  wsdGet,
  wsdMatches,
  wsdName,
  wsdProbe,
  wsdResolve,
  type Run,
} from "../../../daemon/discover.ts";
import { kindsOf } from "../../../daemon/routes/discover.ts";
import { Daemon } from "../../../daemon/server.ts";

const FIXTURES = join(import.meta.dirname, "../fixtures/discover");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const hex = (name: string) => Buffer.from(fixture(name).trim(), "hex");

// --- Each protocol, on recorded answers ---

test("T10.1 Jellyfin's and Emby's answers on 7359 give their address and name", () => {
  assert.deepEqual(serverAnswer(fixture("jellyfin-7359.json")), { url: "http://192.168.50.10:8096", name: "living room", id: "a5b0c6d1e2f34a5b8c9d0e1f2a3b4c5d" });
  assert.deepEqual(serverAnswer(fixture("emby-7359.json")), { url: "http://192.168.50.23:8096", name: "office", id: "f00dfeed0123456789abcdef01234567" });
  // A server under a path keeps it, without the slash at the end.
  assert.equal(serverAnswer('{"Address":"https://media.example/jellyfin/","Name":"x"}')?.url, "https://media.example/jellyfin");
  for (const no of ["", "who is JellyfinServer?", "[]", "null", '{"Name":"x"}', '{"Address":"ftp://nas/","Name":"x"}', '{"Address":"http://me:pw@nas:8096","Name":"x"}', '{"Address":"javascript:alert(1)"}']) {
    assert.equal(serverAnswer(no), null, no);
  }
  // A name with control characters in it, and a long one, as the TV shows them.
  assert.equal(serverAnswer(`{"Address":"http://10.0.0.2:8096","Name":"a\\u0007b${"c".repeat(100)}"}`)?.name, `ab${"c".repeat(58)}`);
});

test("T10.1 Plex's GDM answer gives its name and port, at the address it came from", () => {
  assert.deepEqual(gdmAnswer(fixture("plex-gdm.txt"), "192.168.50.30"), { url: "http://192.168.50.30:32400", name: "den", id: "7c3f0b2d6f1e4c8a9b0d1e2f3a4b5c6d7e8f9a0b" });
  // A Plex player answers GDM too, as plex/media-player, and isn't a server.
  assert.equal(gdmAnswer(fixture("plex-gdm.txt").replace("plex/media-server", "plex/media-player"), "192.168.50.30"), null);
  assert.equal(gdmAnswer(fixture("plex-gdm.txt"), "nas.local"), null);
  assert.equal(gdmAnswer(fixture("plex-gdm.txt").replace("Port: 32400", "Port: 99999"), "192.168.50.30"), null);
  assert.equal(gdmAnswer("HTTP/1.0 404 Not Found\r\nContent-Type: plex/media-server\r\n\r\n", "192.168.50.30"), null);
});

test("T10.1 Avahi's lines give the SMB share and the NFS export, with the machine's mDNS name", () => {
  assert.equal(avahiLabel("living\\032room\\032NAS"), "living room NAS");
  assert.equal(avahiLabel("caf\\195\\169\\046\\\\"), "café.\\");
  const [added, smb] = fixture("avahi-smb.txt").trim().split("\n").map(avahiLine);
  assert.deepEqual(added, { event: "+", name: "living room NAS", type: "_smb._tcp", txt: {} });
  assert.equal(mdnsFound(added!), null);
  assert.deepEqual(mdnsFound(smb!), { kind: "smb", name: "living room NAS", url: "smb://nas.local/", host: "nas.local", via: "mdns", address: "192.168.77.10" });
  const nfs = avahiLine(fixture("avahi-nfs.txt").trim().split("\n")[1]);
  assert.deepEqual(nfs?.txt, { path: "/export/music" });
  assert.deepEqual(mdnsFound(nfs!), { kind: "nfs", name: "living room NAS", url: "nfs://nas.local/export/music", host: "nas.local", via: "mdns", address: "192.168.77.10" });
  // IPv6, another kind of service, and lines that aren't avahi-browse's.
  assert.equal(avahiLine("=;stand0;IPv6;nas;_smb._tcp;local;nas.local;fe80::1;445;"), null);
  assert.equal(mdnsFound(avahiLine("=;stand0;IPv4;printer;_ipp._tcp;local;printer.local;192.168.77.20;631;")!), null);
  for (const no of ["", "Failed to create client object", "=;stand0;IPv4;nas;_smb._tcp;local;nas.local;not-an-address;445;", "=;stand0;IPv4;nas;_smb._tcp;local;nas.local;192.168.77.10;0;"]) {
    assert.equal(avahiLine(no), null, no);
  }
});

test("T10.1 WS-Discovery: wsdd answers the Probe, then the Resolve with its address, then its name", () => {
  // What the box sends is what wsdd answered.
  assert.match(wsdProbe("x"), /<wsd:Probe><wsd:Types>wsdp:Device<\/wsd:Types><\/wsd:Probe>/);
  assert.match(wsdResolve("urn:uuid:e5e61fb5-d685-5b50-9ba7-acb6e6962ef3", "x"), /<wsa:Address>urn:uuid:e5e61fb5-d685-5b50-9ba7-acb6e6962ef3<\/wsa:Address>/);
  assert.match(wsdGet("urn:uuid:<x>", "x"), /<wsa:To>urn:uuid:&lt;x&gt;<\/wsa:To>/);

  const [probed] = wsdMatches(fixture("wsdd-probe-match.xml"));
  assert.deepEqual(probed, { endpoint: "urn:uuid:e5e61fb5-d685-5b50-9ba7-acb6e6962ef3", types: ["wsdp:Device", "pub:Computer"], xaddrs: [] });
  assert.ok(wsdComputer(probed));
  const [resolved] = wsdMatches(fixture("wsdd-resolve-match.xml"));
  assert.deepEqual(resolved.xaddrs, ["http://192.168.50.10:5357/e5e61fb5-d685-5b50-9ba7-acb6e6962ef3"]);
  assert.equal(wsdName(fixture("wsdd-get.xml")), "NAS");
  // Windows says its domain instead, and a printer isn't a computer.
  assert.equal(wsdName("<pub:Computer>DESKTOP-7Q2/Domain:home.lan</pub:Computer>"), "DESKTOP-7Q2");
  assert.equal(wsdName("<wsdp:FriendlyName>WSD Device office</wsdp:FriendlyName>"), "WSD Device office");
  assert.equal(wsdComputer({ endpoint: "urn:uuid:1", types: ["wsdp:Device", "wprt:PrintDeviceType"], xaddrs: [] }), false);
  assert.deepEqual(wsdMatches("<not xml"), []);
});

test("T10.1 Immich's ping says pong", () => {
  assert.ok(immichPong(fixture("immich-ping.json")));
  for (const no of ["", "pong", '{"res":"ping"}', "<html>pong</html>"]) assert.equal(immichPong(no), false, no);
});

test("T10.1 smbclient's list gives the folders, without IPC$ and hidden shares", () => {
  assert.deepEqual(smbShares(fixture("smbclient-list.txt")), [{ name: "music", note: "Music library" }, { name: "photos" }, { name: "films" }]);
  assert.deepEqual(smbShares(fixture("smbclient-login.txt")), []);
  assert.deepEqual(smbShares("Printer|laser|\nDisk|a/b|\nDisk||\n"), []);
});

test("T10.1 NFS: rpcbind says where MOUNT is, and MOUNT lists the exports", () => {
  // The calls, as rpcbind and rpc.mountd took them.
  const call = rpcCall(0x1234, 100000, 2, 3, Buffer.from("000186a5000000030000000600000000", "hex"));
  assert.equal(call.readUInt32BE(0), (0x80000000 | (call.length - 4)) >>> 0);
  assert.deepEqual([...Array(6)].map((_, at) => call.readUInt32BE(4 + at * 4)), [0x1234, 0, 2, 100000, 2, 3]);

  const port = rpcResult(hex("rpcbind-getport.hex"), 0x1234);
  assert.equal(port?.readUInt32BE(0), 38321);
  assert.equal(rpcResult(hex("rpcbind-getport.hex"), 0x9999), null);
  const exports = rpcResult(hex("mountd-export.hex"), 0x1235);
  assert.deepEqual(nfsExports(exports!), ["/srv/photos", "/srv/music"]);
  // A reply cut short keeps what came whole.
  assert.deepEqual(nfsExports(exports!.subarray(0, 40)), ["/srv/photos"]);
  assert.deepEqual(nfsExports(Buffer.alloc(4)), []);
});

test("the kinds a list asks for", () => {
  assert.deepEqual(kindsOf(null), ["jellyfin", "emby", "plex", "immich", "smb", "nfs"]);
  assert.deepEqual(kindsOf("jellyfin,emby"), ["jellyfin", "emby"]);
  assert.equal(kindsOf("jellyfin,printers"), null);
  assert.equal(kindsOf(","), null);
});

// --- A look, through the daemon, against stand-ins on this machine ---

const scratch = mkdtempSync(join(tmpdir(), "agentv-discover-"));
let daemon: Daemon;
let url = "";
let lan = "";
const sockets: Socket[] = [];
let http: HttpServer;
let quiet: HttpServer;
let rpc: TcpServer;
// What each stand-in was asked.
const asked: string[] = [];
const quietAsked: string[] = [];
let smbAsked: string[][] = [];
let smbAnswer = { stdout: fixture("smbclient-list.txt"), stderr: "", code: 0 };
let jellyfinQuiet = false;

async function udp(answer: (text: string) => string | null): Promise<number> {
  const socket = createSocket("udp4");
  socket.on("message", (message, from) => {
    const text = message.toString();
    asked.push(`udp ${text.slice(0, 60)}`);
    const reply = answer(text);
    if (reply) socket.send(reply, from.port, from.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  sockets.push(socket);
  return socket.address().port;
}

function listen(server: HttpServer | TcpServer, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve) => server.listen(0, host, () => resolve((server.address() as { port: number }).port)));
}

before(async () => {
  // Immich and the NAS's description, on the machine that announces
  // everything, and an Immich on one that announces nothing.
  http = createHttp((request, response) => {
    asked.push(`http ${request.method} ${request.url}`);
    if (request.url === "/api/server/ping") return void response.end(fixture("immich-ping.json"));
    if (request.url === "/e5e61fb5-d685-5b50-9ba7-acb6e6962ef3") return void response.end(fixture("wsdd-get.xml"));
    response.writeHead(404).end();
  });
  const httpPort = await listen(http);
  quiet = createHttp((request, response) => {
    quietAsked.push(`${request.method} ${request.url}`);
    response.end(fixture("immich-ping.json"));
  });
  await listen(quiet, "127.0.0.2");

  // Jellyfin and Emby share 7359, and each answers its own question.
  const discovery = await udp((text) =>
    text === "who is JellyfinServer?" && !jellyfinQuiet
      ? fixture("jellyfin-7359.json").replace("http://192.168.50.10:8096", "http://127.0.0.1:8096")
      : text === "who is EmbyServer?"
        ? fixture("emby-7359.json").replace("http://192.168.50.23:8096", "http://127.0.0.1:8920")
        : null,
  );
  const gdm = await udp((text) => (text.startsWith("M-SEARCH * HTTP/1.1") ? fixture("plex-gdm.txt") : null));
  // wsdd: its address only when asked to resolve.
  const wsd = await udp((text) =>
    text.includes("/discovery/Probe<")
      ? fixture("wsdd-probe-match.xml")
      : text.includes("/discovery/Resolve<")
        ? fixture("wsdd-resolve-match.xml").replace("http://192.168.50.10:5357/", `http://127.0.0.1:${httpPort}/`)
        : null,
  );

  // rpcbind and rpc.mountd, answering with their recorded replies.
  rpc = createTcp((socket) => {
    socket.on("data", (data) => {
      const xid = data.readUInt32BE(4);
      const program = data.readUInt32BE(16);
      asked.push(`rpc ${program}`);
      const reply = Buffer.from(hex(program === 100000 ? "rpcbind-getport.hex" : "mountd-export.hex"));
      reply.writeUInt32BE(xid, 0);
      if (program === 100000) reply.writeUInt32BE((rpc.address() as { port: number }).port, reply.length - 4);
      const mark = Buffer.alloc(4);
      mark.writeUInt32BE((0x80000000 | reply.length) >>> 0);
      socket.end(Buffer.concat([mark, reply]));
    });
  });
  const rpcPort = await listen(rpc);

  // avahi-browse, as the real one prints, for this machine.
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  for (const type of ["smb", "nfs"]) writeFileSync(join(scratch, `${type}.txt`), fixture(`avahi-${type}.txt`).replaceAll("192.168.77.10", "127.0.0.1"));
  writeFileSync(join(bin, "avahi-browse"), `#!/bin/bash\necho "$*" >>"${scratch}/avahi-args"\ntype=\${!#}\ncat "${scratch}/\${type:1:3}.txt"\nexec sleep 60\n`);
  chmodSync(join(bin, "avahi-browse"), 0o755);
  const run: Run = async (command, args) => {
    smbAsked.push([command, ...args]);
    return smbAnswer;
  };

  daemon = new Daemon({
    root: join(scratch, "root"),
    state: join(scratch, "state"),
    port: 0,
    log: () => {},
    builtins: null,
    lanPort: 0,
    lanHost: "127.0.0.1",
    address: () => "127.0.0.1",
    discover: {
      targets: ["127.0.0.1"],
      ports: { jellyfin: 0, emby: 0, plex: 0, wsd: 0 },
      serverPorts: { discovery, gdm, wsd, immich: httpPort, rpcbind: rpcPort },
      avahi: join(bin, "avahi-browse"),
      run,
      lookMs: 1_500,
      rounds: [50, 400],
    },
  });
  url = `http://127.0.0.1:${await daemon.listen()}`;
  lan = `http://127.0.0.1:${daemon.lanPort}`;
});

after(async () => {
  await daemon?.close();
  for (const socket of sockets) socket.close();
  http?.close();
  quiet?.close();
  rpc?.close();
  rmSync(scratch, { recursive: true, force: true });
});

const discover = async (kinds?: string) => {
  const response = await fetch(`${url}/api/discover${kinds ? `?kinds=${kinds}` : ""}`);
  return { status: response.status, data: await response.json() };
};
const until = async (check: () => Promise<boolean>, ms = 4_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("it didn't happen in time");
};

test("a look finds Jellyfin, Emby, Plex, the NAS and Immich on it, by their own answers, and asks nothing else", async () => {
  const first = await discover("jellyfin,emby,plex,immich,smb,nfs");
  assert.equal(first.status, 200);
  assert.equal(first.data.looking, true);
  await until(async () => (await discover("jellyfin,emby,plex,immich,smb,nfs")).data.found.length === 6 && asked.includes("http POST /e5e61fb5-d685-5b50-9ba7-acb6e6962ef3"));
  const { data } = await discover("jellyfin,emby,plex,immich,smb,nfs");
  assert.deepEqual(
    data.found.map((found: Record<string, string>) => [found.kind, found.name, found.url, found.host, found.via]),
    [
      ["jellyfin", "living room", "http://127.0.0.1:8096", "nas.local", "udp-7359"],
      ["emby", "office", "http://127.0.0.1:8920", "nas.local", "udp-7359"],
      ["plex", "den", "http://127.0.0.1:32400", "nas.local", "gdm"],
      ["immich", "immich", `http://127.0.0.1:${(http.address() as { port: number }).port}`, "nas.local", "immich-ping"],
      ["smb", "living room NAS", "smb://nas.local/", "nas.local", "mdns"],
      ["nfs", "living room NAS", "nfs://nas.local/export/music", "nas.local", "mdns"],
    ],
  );
  // Only the kinds asked for.
  assert.deepEqual((await discover("plex")).data.found.map((found: { kind: string }) => found.kind), ["plex"]);
  // Immich's port only on the machine that announced, once a look, and
  // the NAS's description at the address it gave once it resolved it.
  const http_ = asked.filter((one) => one.startsWith("http "));
  assert.deepEqual([...new Set(http_)].sort(), ["http GET /api/server/ping", "http POST /e5e61fb5-d685-5b50-9ba7-acb6e6962ef3"]);
  assert.equal(http_.filter((one) => one === "http GET /api/server/ping").length, 1);
  assert.deepEqual(quietAsked, []);
  // Every question to UDP is one of the four, and Avahi browses only
  // shares, past what this box announces itself.
  for (const one of asked.filter((line) => line.startsWith("udp "))) assert.match(one, /^udp (who is (Jellyfin|Emby)Server\?|M-SEARCH \* HTTP\/1\.1|<\?xml version="1\.0" encoding="utf-8"\?><soap)/);
  assert.deepEqual(readFileSync(join(scratch, "avahi-args"), "utf8").trim().split("\n").sort(), ["--parsable --resolve --no-db-lookup --ignore-local _nfs._tcp", "--parsable --resolve --no-db-lookup --ignore-local _smb._tcp"]);
  assert.ok(!asked.some((one) => one.startsWith("rpc")), "nothing asks the NAS for its exports until it's picked");
});

test("a NAS's shares: smbclient's list and its NFS exports, only for a machine the box found", async () => {
  const response = await fetch(`${url}/api/discover/shares?host=nas.local`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data, {
    ok: true,
    host: "nas.local",
    shares: [
      { kind: "smb", name: "music", uri: "smb://nas.local/music", note: "Music library" },
      { kind: "smb", name: "photos", uri: "smb://nas.local/photos" },
      { kind: "smb", name: "films", uri: "smb://nas.local/films" },
      { kind: "nfs", name: "music", uri: "nfs://nas.local/export/music" },
      { kind: "nfs", name: "photos", uri: "nfs://nas.local/srv/photos" },
      { kind: "nfs", name: "music", uri: "nfs://nas.local/srv/music" },
    ],
  });
  assert.deepEqual(smbAsked, [["smbclient", "-L", "//nas.local", "-I", "127.0.0.1", "-N", "-g"]]);

  // A NAS that lists its shares only for a user says so, and its NFS
  // exports still come.
  smbAnswer = { stdout: fixture("smbclient-login.txt"), stderr: "", code: 1 };
  const login = await (await fetch(`${url}/api/discover/shares?host=127.0.0.1`)).json();
  assert.equal(login.login, true);
  assert.deepEqual(login.shares.map((share: { kind: string }) => share.kind), ["nfs", "nfs", "nfs"]);

  // Anywhere the box didn't find is never asked.
  smbAsked = [];
  for (const host of ["192.168.1.1", "printer.local", "127.0.0.2"]) {
    const refused = await fetch(`${url}/api/discover/shares?host=${host}`);
    assert.equal(refused.status, 404);
    assert.match((await refused.json()).error, /isn't a nas the tv found/);
  }
  assert.deepEqual(smbAsked, []);
  assert.equal((await fetch(`${url}/api/discover/shares`)).status, 400);
});

test("a paired phone asks the same, and kinds that aren't one are refused", async () => {
  assert.equal((await fetch(`${lan}/api/phone/discover`)).status, 401);
  assert.equal((await discover("jellyfin,printers")).status, 400);
});

test("when the look is over, what didn't answer again goes", async () => {
  await until(async () => !daemon.discover.isLooking, 5_000);
  // Jellyfin goes quiet, and a new look ends without it.
  jellyfinQuiet = true;
  assert.deepEqual((await discover("jellyfin")).data.found.map((found: { name: string }) => found.name), ["living room"]);
  await until(async () => !daemon.discover.isLooking, 5_000);
  const { data } = await discover("jellyfin,emby");
  assert.deepEqual(data.found.map((found: { kind: string }) => found.kind), ["emby"]);
});
