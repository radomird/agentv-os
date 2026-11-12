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
import { createSocket as createUdp } from "node:dgram";
import { after, before, test } from "node:test";
import {
  Discover,
  avahiLabel,
  avahiLine,
  gdmAnswer,
  immichPong,
  mdnsFound,
  nfsExports,
  rpcCall,
  rpcResult,
  senderUrl,
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
import { kindsOf, listOf, loginOf } from "../../../daemon/routes/discover.ts";
import { ServerPicks, type PickHome } from "../../../daemon/server-picks.ts";
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

test("F7 a Jellyfin's or an Emby's address is the one its answer came from", async () => {
  const names: Record<string, string[]> = { "media.home": ["192.168.50.10", "192.168.50.11"], "elsewhere.example": ["203.0.113.7"] };
  const asked: string[] = [];
  const resolve = async (name: string) => {
    asked.push(name);
    if (!names[name]) throw new Error("ENOTFOUND");
    return names[name];
  };
  const at = (answer: string) => senderUrl(answer, "192.168.50.10", resolve);
  // Its own address, or a name of its own that leads to it, stays as it is.
  assert.equal(await at("http://192.168.50.10:8096"), "http://192.168.50.10:8096");
  assert.equal(await at("https://192.168.50.10:8920/jellyfin"), "https://192.168.50.10:8920/jellyfin");
  assert.equal(await at("https://media.home/jellyfin"), "https://media.home/jellyfin");
  // Another machine's address, one off the home network, a name that leads
  // somewhere else and one that leads nowhere all become the sender's.
  assert.equal(await at("http://192.168.50.66:8096"), "http://192.168.50.10:8096");
  assert.equal(await at("http://192.168.50.66:8097/media"), "http://192.168.50.10:8097/media");
  assert.equal(await at("http://203.0.113.7"), "http://192.168.50.10");
  assert.equal(await at("https://203.0.113.7"), "http://192.168.50.10:8096");
  assert.equal(await at("http://[fd00::66]:8096"), "http://192.168.50.10:8096");
  assert.equal(await at("https://elsewhere.example/jellyfin"), "http://192.168.50.10:8096/jellyfin");
  assert.equal(await at("http://nowhere.example:8096"), "http://192.168.50.10:8096");
  assert.deepEqual(asked, ["media.home", "elsewhere.example", "nowhere.example"], "only a name is looked up");
  assert.equal(await senderUrl("http://192.168.50.10:8096", "fe80::1", resolve), null);
});

test("F7 an answer with another machine's address, or with a server's id from somewhere else, never takes that server's row", async () => {
  // The real server, on 127.0.0.1, and a device on 127.0.0.2 that answers
  // too, with the real one's id and name.
  const real = fixture("jellyfin-7359.json").replace("192.168.50.10", "127.0.0.1");
  let box = 0;
  const server = createUdp("udp4");
  server.on("message", (message, from) => {
    if (message.toString() !== "who is JellyfinServer?") return;
    box = from.port;
    server.send(real, from.port, from.address);
  });
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
  const forger = createUdp("udp4");
  await new Promise<void>((resolve) => forger.bind(0, "127.0.0.2", resolve));
  const discover = new Discover({ targets: ["127.0.0.1"], ports: { jellyfin: 0, emby: 0, plex: 0, wsd: 0 }, serverPorts: { discovery: server.address().port, gdm: 9, wsd: 9 }, avahi: null, log: () => {}, lookMs: 3_000, rounds: [20], lookup: async () => [] });
  const rows = () => discover.found(["jellyfin"]).map((found) => `${found.name} ${found.url}`);
  const until = async (count: number) => {
    for (let i = 0; i < 60 && rows().length !== count; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  };
  try {
    discover.look(["jellyfin"]);
    await until(1);
    assert.deepEqual(rows(), ["living room http://127.0.0.1:8096"]);
    // The same id and name, sending the real server's address, its own,
    // and one off the home network.
    for (const address of ["http://127.0.0.1:8096", "http://127.0.0.2:8096", "http://203.0.113.7:8096"]) {
      await new Promise<void>((resolve) => forger.send(real.replace("http://127.0.0.1:8096", address), box, "127.0.0.1", () => resolve()));
    }
    await until(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(rows(), ["living room http://127.0.0.1:8096", "living room http://127.0.0.2:8096"], "the real one keeps its row, and the other one only ever has its own address");
    // And the real one answering again doesn't change that.
    await new Promise<void>((resolve) => server.send(real, box, "127.0.0.1", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(rows().length, 2);
  } finally {
    discover.close();
    server.close();
    forger.close();
  }
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

test("a NAS's user name and password, as smbclient takes them", () => {
  assert.deepEqual(loginOf({ host: "nas.local", user: "radomir", password: "a b,c=d" }), { host: "nas.local", user: "radomir", password: "a b,c=d" });
  for (const no of [null, {}, { host: "nas.local", user: "", password: "x" }, { host: "nas.local", user: "my name", password: "x" }, { host: "nas.local", user: "a:b", password: "x" }, { host: "nas.local", user: "r", password: "line\nbreak" }, { host: "", user: "r", password: "x" }, { host: "nas.local", user: "r", password: 5 }]) {
    assert.equal(typeof loginOf(no), "string", JSON.stringify(no));
  }
});

test("the kinds a list asks for", () => {
  assert.deepEqual(kindsOf(null), ["jellyfin", "emby", "plex", "immich", "smb", "nfs"]);
  assert.deepEqual(kindsOf("jellyfin,emby"), ["jellyfin", "emby"]);
  assert.equal(kindsOf("jellyfin,printers"), null);
  assert.equal(kindsOf(","), null);
});

test("the list on the TV, as its page says it", () => {
  assert.deepEqual(listOf({ kinds: "jellyfin", machines: false }), { kinds: ["jellyfin"], machines: false });
  assert.deepEqual(listOf({ kinds: "smb,nfs", machines: true }), { kinds: ["smb", "nfs"], machines: true });
  assert.deepEqual(listOf({ host: "nas.local" }), { host: "nas.local" });
  assert.equal(listOf({}), null);
  for (const no of [null, [], "jellyfin", { kinds: "printers" }, { kinds: "jellyfin", machines: "yes" }, { host: "" }, { host: "nas.local", kinds: "smb" }, { host: 5 }]) {
    assert.equal(listOf(no), undefined, JSON.stringify(no));
  }
});

test("the phones hear when the TV's list changes, and a pick goes to the TV's page only while it shows one", () => {
  let told = 0;
  const picked: string[] = [];
  const box = new Discover({ screen: () => told++, picked: (key) => picked.push(key) });
  assert.equal(box.onScreen(), null);
  assert.equal(box.pick("nas nas.local"), false);
  box.showing({ kinds: ["smb", "nfs"], machines: true });
  box.showing({ kinds: ["smb", "nfs"], machines: true });
  assert.equal(told, 1, "the same list again says nothing new");
  assert.equal(box.pick("nas nas.local"), true);
  box.showing({ host: "nas.local" });
  assert.deepEqual(box.onScreen(), { host: "nas.local" });
  box.showing(null);
  assert.equal(told, 3);
  assert.equal(box.pick("smb://nas.local/music"), false);
  assert.deepEqual(picked, ["nas nas.local"]);
});

test("a server picked in setup waits for its app to install, then fills in its address", async () => {
  const state = mkdtempSync(join(tmpdir(), "agentv-picks-"));
  const installed = new Set<string>();
  const saved: Record<string, Record<string, unknown>> = {};
  const home: PickHome = {
    appSetup: async (id) => (installed.has(id) ? { fields: id === "agentv.steam" ? [] : [{ key: "serverUrl", address: true }] } : null),
    saveAppSetup: async (id, change) => {
      if (!/^https?:\/\/\S+$/.test(String((change as Record<string, unknown>).serverUrl))) return "server address is an address like http://192.168.1.20:8096";
      saved[id] = change as Record<string, unknown>;
      return null;
    },
  };
  const landed: string[] = [];
  const picks = new ServerPicks({ state, home, saved: (app) => landed.push(app), log: () => {} });
  try {
    // Jellyfin is still installing: the pick waits.
    assert.deepEqual(await picks.pick("agentv.jellyfin", "http://192.168.50.10:8096"), { ok: true, saved: false });
    assert.deepEqual(await picks.waiting(), ["agentv.jellyfin"]);
    await picks.settle();
    assert.deepEqual(saved, {}, "nothing to fill in before it lands");
    // It lands, and its address goes in.
    installed.add("agentv.jellyfin");
    await picks.settle();
    assert.deepEqual(saved["agentv.jellyfin"], { serverUrl: "http://192.168.50.10:8096" });
    assert.deepEqual(landed, ["agentv.jellyfin"]);
    assert.deepEqual(await picks.waiting(), []);
    // An app that's here already takes it at once.
    assert.deepEqual(await picks.pick("agentv.jellyfin", "http://192.168.50.11:8096"), { ok: true, saved: true });
    // Immich never lands: its pick goes, and its tile says "set up".
    await picks.pick("agentv.immich", "http://192.168.50.10:2283");
    await picks.settle(["agentv.immich"]);
    assert.deepEqual(await picks.waiting(), []);
    assert.equal(saved["agentv.immich"], undefined);
    // What isn't a pick is refused.
    installed.add("agentv.steam");
    assert.deepEqual(await picks.pick("agentv.steam", "http://192.168.50.10:1"), { ok: false, status: 400, error: "That app doesn't need a server" });
    for (const [app, url] of [["", "http://a"], ["Jellyfin!", "http://a"], ["agentv.jellyfin", "ftp://nas"], ["agentv.jellyfin", 5], ["agentv.jellyfin", `http://${"a".repeat(500)}`]]) {
      assert.equal((await picks.pick(app, url)).ok, false, JSON.stringify([app, url]));
    }
    // F2: a server is never this box itself.
    const mine = new ServerPicks({ state, home, log: () => {}, own: () => ["192.168.50.2"] });
    for (const url of ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::ffff:7f00:1]:3000", "http://192.168.50.2:3001"]) {
      assert.deepEqual(await mine.pick("agentv.jellyfin", url), { ok: false, status: 400, error: "Type an address like http://192.168.1.20:8096" }, url);
    }
    assert.equal((await mine.pick("agentv.jellyfin", "http://192.168.50.11:8096")).ok, true);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
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
let smbEnv: (Record<string, string> | undefined)[] = [];
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
  const run: Run = async (command, args, _timeoutMs, env) => {
    smbAsked.push([command, ...args]);
    smbEnv.push(env);
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

  // Then with the user name and password typed on the phone: the password
  // goes in smbclient's environment, never its command line, and each
  // share's address has the user name, ready for Music's sources.
  smbAnswer = { stdout: fixture("smbclient-list.txt"), stderr: "", code: 0 };
  smbAsked = [];
  smbEnv = [];
  const signedIn = await fetch(`${url}/api/discover/shares`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host: "nas.local", user: "radomir", password: "tunes, at 9 = fine" }) });
  assert.equal(signedIn.status, 200);
  const listed = await signedIn.json();
  assert.equal(listed.login, undefined);
  assert.deepEqual(listed.shares.filter((share: { kind: string }) => share.kind === "smb").map((share: { uri: string }) => share.uri), ["smb://radomir@nas.local/music", "smb://radomir@nas.local/photos", "smb://radomir@nas.local/films"]);
  assert.deepEqual(smbAsked, [["smbclient", "-L", "//nas.local", "-I", "127.0.0.1", "-U", "radomir", "-g"]]);
  assert.deepEqual(smbEnv, [{ PASSWD: "tunes, at 9 = fine" }]);
  assert.ok(!smbAsked.flat().some((arg) => arg.includes("tunes")));
  // A user name or password smbclient would read wrongly is refused.
  const refusedLogin = await fetch(`${url}/api/discover/shares`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host: "nas.local", user: "me@home", password: "x" }) });
  assert.equal(refusedLogin.status, 400);

  // Anywhere the box didn't find is never asked.
  smbAsked = [];
  for (const host of ["192.168.1.1", "printer.local", "127.0.0.2"]) {
    const refused = await fetch(`${url}/api/discover/shares?host=${host}`);
    assert.equal(refused.status, 404);
    assert.equal((await refused.json()).error, `Couldn't find ${host}`);
  }
  assert.deepEqual(smbAsked, []);
  assert.equal((await fetch(`${url}/api/discover/shares`)).status, 400);
});

test("the TV's page says which list it shows, and a phone's pick needs pairing", async () => {
  const say = (body: unknown) => fetch(`${url}/api/discover/screen`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await say({ kinds: "jellyfin", machines: false })).status, 200);
  assert.deepEqual(daemon.discover.onScreen(), { kinds: ["jellyfin"], machines: false });
  assert.equal((await say({ kinds: "printers" })).status, 400);
  assert.equal((await say({})).status, 200);
  assert.equal(daemon.discover.onScreen(), null);
  // Only the TV's page says it, and only a paired phone picks.
  assert.equal((await fetch(`${lan}/api/phone/discover/screen`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(`${lan}/api/phone/discover/pick`, { method: "POST", body: JSON.stringify({ key: "typed" }) })).status, 401);
  assert.equal((await fetch(`${url}/api/discover/pick`, { method: "POST", body: JSON.stringify({ app: "agentv.jellyfin", url: "http://192.168.50.10:8096" }) })).status, 200);
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
