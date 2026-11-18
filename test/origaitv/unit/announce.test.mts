// The TV found and woken (PHASE-2-PLAN.md track 25, T25.1's unit half),
// behind the announce switch: the box id is made once and kept, the daemon
// hands root what Avahi publishes, and a paired phone learns the id and what
// it needs to wake the TV. With the switch off there's no id, nothing is
// handed over and every answer is as it was. What root does with the drop
// is bin/origaitv-announce-set's, which the last test here runs for real, and
// announce-test.sh checks on its own.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Announce, boxId, SERVICE_TYPE } from "../../../daemon/announce.ts";
import { Box, broadcastAddress, wake } from "../../../daemon/box.ts";
import { FEATURES } from "../../../daemon/features.ts";
import { HOTSPOT_ADDRESS } from "../../../daemon/hotspot.ts";
import { b64u, hmac, INFO, x25519Pair } from "../../../daemon/phone-channel.ts";
import { Daemon } from "../../../daemon/server.ts";
import { pairPhone } from "./phone-client.mts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "origaitv-announce-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;
const fresh = (name: string): string => {
  const dir = join(scratch, `${name}-${count++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// A port's addresses, as Node lists them.
const port = (address: string, mac: string, netmask = "255.255.255.0") => [
  { address, netmask, family: "IPv4" as const, mac, internal: false, cidr: `${address}/24` },
  { address: "fe80::96c6:91ff:fe1a:2b3c", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6" as const, mac, internal: false, cidr: "fe80::96c6:91ff:fe1a:2b3c/64", scopeid: 2 },
];
const WIRED = { enp0s31f6: port("192.168.50.20", "94:C6:91:1A:2B:3C") };
const WIFI = { wlan0: port("192.168.50.191", "a0:51:0b:00:00:02") };

test("T25.1 the announce switch is there, and off until it's been checked", () => {
  assert.equal(FEATURES.announce, false);
  assert.equal(SERVICE_TYPE, "_origaitv._tcp");
});

test("T25.1 the box id is made once, at random, and is the same after a restart", () => {
  const state = fresh("id");
  const id = boxId(state);
  assert.match(id, /^[0-9a-f]{32}$/, "16 random bytes, in hex");
  assert.equal(boxId(state), id, "asked again, it's the one that was made");
  assert.equal(new Announce({ state }).id(), id, "and after a restart");
  assert.equal(readFileSync(join(state, "box-id"), "utf8"), `${id}\n`, "kept in the daemon's state");
  assert.equal(statSync(join(state, "box-id")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(state), ["box-id"], "and nothing else is left beside it");

  // It comes from the system's random bytes and nothing else: two boxes
  // differ, and the bytes it's handed are the id.
  assert.notEqual(boxId(fresh("id")), id);
  assert.equal(boxId(fresh("id"), (length) => Buffer.alloc(length, 0xab)), "ab".repeat(16));

  // A file someone broke isn't an id: a new one is made, once.
  writeFileSync(join(state, "box-id"), "not an id\n");
  const again = boxId(state);
  assert.match(again, /^[0-9a-f]{32}$/);
  assert.notEqual(again, id);
  assert.equal(boxId(state), again);
});

test("T25.1 what wakes the box: the wired port's hardware address and its network's broadcast address", () => {
  assert.deepEqual(wake(WIRED), { mac: "94:c6:91:1a:2b:3c", broadcast: "192.168.50.255" }, "in lower case");
  assert.deepEqual(wake({ ...WIFI, ...WIRED }), { mac: "94:c6:91:1a:2b:3c", broadcast: "192.168.50.255" }, "the wire's, with Wi-Fi on too");
  assert.equal(wake(WIFI), null, "nothing on Wi-Fi alone: the box only listens for the packet on a cable");
  assert.equal(wake({}), null);
  assert.equal(wake({ lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }] }), null);
  assert.equal(wake({ docker0: port("172.17.0.1", "02:42:ac:11:00:01"), veth1: port("10.9.0.1", "02:42:ac:11:00:02") }), null, "a container's bridge isn't the wired port");
  assert.equal(wake({ eth0: port(HOTSPOT_ADDRESS, "94:c6:91:1a:2b:3c") }), null, "nor is the box's own setup hotspot a home network");
  assert.equal(wake({ eth0: port("192.168.1.9", "00:00:00:00:00:00") }), null, "a port with no hardware address can't be woken");
  assert.equal(wake({ eth0: [{ address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "94:c6:91:1a:2b:3c", internal: false, cidr: "fe80::1/64", scopeid: 2 }] }), null, "a cable with no IPv4 network has nowhere to send the packet");
  assert.deepEqual(wake({ enp3s0: port("10.0.2.15", "52:54:00:12:34:56"), enp2s0: port("192.168.1.9", "94:c6:91:1a:2b:3c") }), { mac: "94:c6:91:1a:2b:3c", broadcast: "192.168.1.255" }, "with two, the first by name, every time");

  assert.equal(broadcastAddress("192.168.1.20", "255.255.255.0"), "192.168.1.255");
  assert.equal(broadcastAddress("10.0.2.15", "255.255.254.0"), "10.0.3.255");
  assert.equal(broadcastAddress("172.16.5.9", "255.255.0.0"), "172.16.255.255");
  assert.equal(broadcastAddress("10.1.2.3", "255.0.0.0"), "10.255.255.255");
  assert.equal(broadcastAddress("192.168.1.20", "255.255.255.255"), null, "a network of one has none");
  assert.equal(broadcastAddress("192.168.1.20", "255.255.255.254"), null);
  assert.equal(broadcastAddress("192.168.1", "255.255.255.0"), null);
  assert.equal(broadcastAddress("192.168.1.300", "255.255.255.0"), null);
  assert.equal(broadcastAddress("fe80::1", "ffff::"), null);

  // The box reads its ports each time, since a cable can go in or come out.
  let now: ReturnType<typeof port> | undefined;
  const box = new Box({ state: fresh("box"), interfaces: () => (now ? { enp0s31f6: now } : {}) });
  assert.equal(box.wake(), null);
  now = port("192.168.50.20", "94:c6:91:1a:2b:3c");
  assert.deepEqual(box.wake(), { mac: "94:c6:91:1a:2b:3c", broadcast: "192.168.50.255" });
});

test("T25.1 the hand-over: the id and the phones' port when it's on, and nothing at all while it's off", () => {
  const state = fresh("hand");
  const file = join(fresh("avahi"), "origaitv.service");
  const announce = new Announce({ state, file });
  const drop = () => JSON.parse(readFileSync(announce.drop, "utf8"));

  assert.equal(announce.sync(false, 3001), null, "off, with nothing published: nothing to do");
  assert.deepEqual(readdirSync(state), [], "so no id is made and no drop is left");

  const on = announce.sync(true, 3001);
  const id = boxId(state);
  assert.deepEqual(on, { on: true, id, port: 3001 });
  assert.deepEqual(drop(), { on: true, id, port: 3001 }, "the drop says the same, and nothing more");
  assert.equal(announce.drop, join(state, "announce-drop", "announce.json"), "where origaitv-announce.path looks");

  // Off again, with root's file there from when it was on: root is told
  // to take it away.
  rmSync(announce.drop);
  writeFileSync(file, "<service-group/>\n");
  assert.deepEqual(announce.sync(false, 3001), { on: false });
  assert.deepEqual(drop(), { on: false });

  // With no port for phones there's nothing to announce, which is off.
  assert.deepEqual(announce.sync(true, null), { on: false });
  rmSync(file);
  rmSync(announce.drop);
  assert.equal(announce.sync(true, null), null);
  assert.equal(existsSync(announce.drop), false);
});

// A daemon on a box that's on edge, where a switch can be turned on, with a
// wired port and a folder standing in for Avahi's.
function tv(state: string, file: string, channel = "edge"): { daemon: Daemon; start: () => Promise<{ url: string; lan: string }> } {
  const channelFile = join(state, "..", `channel-${count++}`);
  writeFileSync(channelFile, `${channel}\n`);
  const root = fresh("root");
  writeFileSync(join(root, "settings"), "ORIGAITV_VERSION=1.0.0.r7.gabc1234\nORIGAITV_CHANNEL=edge\n");
  const daemon = new Daemon({ root, state, port: 0, log: () => {}, channelFile, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1", announceFile: file, box: { root: fresh("machine"), exec: async () => null, interfaces: () => ({ ...WIFI, ...WIRED }), disk: scratch } });
  return { daemon, start: async () => ({ url: `http://127.0.0.1:${await daemon.listen()}`, lan: `http://127.0.0.1:${daemon.lanPort}` }) };
}

// What the TV answers a phone that pairs with the code on show, as it is on
// the wire.
async function pairAnswer(daemon: Daemon, lan: string): Promise<Record<string, unknown>> {
  const { code } = daemon.phones.code();
  const mine = x25519Pair();
  const response = await fetch(`${lan}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: b64u(mine.public), name: "a check", proof: b64u(hmac(Buffer.from(code), INFO.pair, mine.public)) }) });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

const put = (url: string, body: unknown) => fetch(`${url}/api/features`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Until the daemon has left a drop, which it does just after it answers.
async function dropped(path: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return JSON.parse(readFileSync(path, "utf8"));
}

test("T25.1 with announce off, the TV says nothing new: no id, no hand-over, and the same answers as before", async () => {
  const state = fresh("off");
  const { daemon, start } = tv(state, join(fresh("avahi"), "origaitv.service"));
  const { url, lan } = await start();
  try {
    assert.equal((await (await fetch(`${url}/api/features`)).json()).announce, false);
    assert.deepEqual(Object.keys(await pairAnswer(daemon, lan)), ["ok", "id", "key", "confirm", "phone"], "pairing answers as the phone API has it");
    const phone = await pairPhone(lan, daemon.phones.code().code, "iphone");
    assert.equal("boxId" in (await phone.json("GET", "/api/phone/state")), false);
    assert.deepEqual(Object.keys(await phone.json("GET", "/api/phone/box")), ["ok", "line", "box"]);
    assert.equal(existsSync(join(state, "box-id")), false, "no id is made");
    assert.equal(existsSync(join(state, "announce-drop")), false, "and nothing is handed to root");
  } finally {
    await daemon.close();
  }
});

test("T25.1 with announce on, a paired phone learns the id and what wakes the TV, an unpaired one is refused, and the id is the same after a restart", async () => {
  const state = fresh("on");
  const file = join(fresh("avahi"), "origaitv.service");
  let { daemon, start } = tv(state, file);
  let { url, lan } = await start();
  let id = "";
  try {
    const phone = await pairPhone(lan, daemon.phones.code().code, "iphone");
    assert.equal((await put(url, { announce: true })).status, 200);

    // What root is handed: the id and the port phones reach the TV on.
    const drop = await dropped(join(state, "announce-drop", "announce.json"));
    id = boxId(state);
    assert.deepEqual(drop, { on: true, id, port: daemon.lanPort });

    // The phone that was paired already learns the id from the state, and
    // one that pairs now learns it as it pairs.
    assert.equal((await phone.json("GET", "/api/phone/state")).boxId, id);
    const paired = await pairAnswer(daemon, lan);
    assert.deepEqual(Object.keys(paired), ["ok", "id", "key", "confirm", "phone", "boxId"]);
    assert.equal(paired.boxId, id);

    // What wakes the TV goes to a paired phone, sealed.
    const answer = await phone.call("GET", "/api/phone/box");
    assert.equal(answer.sealed, true);
    assert.deepEqual(Object.keys(answer.data), ["ok", "line", "box", "wake"]);
    assert.deepEqual(answer.data.wake, { mac: "94:c6:91:1a:2b:3c", broadcast: "192.168.50.255" });

    // Not to anyone else on the network: with no session there's a plain
    // 401 and nothing of the box in it.
    for (const path of ["/api/phone/box", "/api/phone/state"]) {
      const refused = await fetch(`${lan}${path}`);
      assert.equal(refused.status, 401, path);
      const text = await refused.text();
      assert.deepEqual(JSON.parse(text), { ok: false, error: "This phone isn't paired. Pair it from your TV.", pair: true }, path);
      assert.ok(!text.includes(id) && !text.includes("94:c6"), path);
    }
    // And the TV's own pages get the box as before, with no hardware
    // address in it.
    const own = await (await fetch(`${url}/api/box`)).text();
    assert.ok(!own.includes("wake") && !own.toLowerCase().includes("94:c6"));
  } finally {
    await daemon.close();
  }

  // The daemon again, on the same state: the same id, handed over as it
  // starts with no one asking.
  rmSync(join(state, "announce-drop"), { recursive: true });
  ({ daemon, start } = tv(state, file));
  ({ url, lan } = await start());
  try {
    assert.deepEqual(await dropped(join(state, "announce-drop", "announce.json")), { on: true, id, port: daemon.lanPort }, "T25.1 the id is the same after a restart");
    const phone = await pairPhone(lan, daemon.phones.code().code, "ipad");
    assert.equal((await phone.json("GET", "/api/phone/state")).boxId, id);
  } finally {
    await daemon.close();
  }

  // On stable, a switch that was turned on is off again: the TV says nothing
  // and its answers are as before, though the id is kept for when it's on.
  ({ daemon, start } = tv(state, file, "stable"));
  ({ url, lan } = await start());
  try {
    const phone = await pairPhone(lan, daemon.phones.code().code, "ipad");
    assert.equal("boxId" in (await phone.json("GET", "/api/phone/state")), false);
    assert.equal("wake" in (await phone.json("GET", "/api/phone/box")), false);
  } finally {
    await daemon.close();
  }
});

test("T25.1 from the switch to Avahi's file: root writes the type, the port, the id and the version, and takes it away when the switch goes off", async () => {
  const state = fresh("file");
  const file = join(fresh("avahi"), "origaitv.service");
  const { daemon, start } = tv(state, file);
  const { url } = await start();
  const drop = join(state, "announce-drop", "announce.json");
  // What origaitv-announce.path does when the drop appears.
  const root = () => execFileSync("bash", [join(ROOT, "bin/origaitv-announce-set")], { env: { ...process.env, ORIGAITV_ANNOUNCE_DROP: drop, ORIGAITV_ANNOUNCE_FILE: file, ORIGAITV_PATH: join(scratch, "package") }, encoding: "utf8" });
  mkdirSync(join(scratch, "package"), { recursive: true });
  writeFileSync(join(scratch, "package", "settings"), "ORIGAITV_VERSION=1.0.0.r7.gabc1234\nORIGAITV_CHANNEL=edge\n");
  try {
    assert.equal((await put(url, { announce: true })).status, 200);
    await dropped(drop);
    assert.match(root(), /the TV is announced on the home network/);
    const written = readFileSync(file, "utf8");
    const id = boxId(state);
    assert.ok(written.includes("<type>_origaitv._tcp</type>"));
    assert.ok(written.includes(`<port>${daemon.lanPort}</port>`));
    assert.ok(written.includes(`<txt-record>id=${id}</txt-record>`));
    assert.ok(written.includes("<txt-record>version=1.0.0.r7.gabc1234</txt-record>"));
    assert.ok(written.includes('<name replace-wildcards="yes">%h</name>'), "the name is the box's own, which Avahi fills in");
    assert.equal(written.match(/<txt-record>/g)?.length, 2, "the id and the version, and nothing else");
    assert.ok(!written.toLowerCase().includes("94:c6"), "the hardware address isn't announced");
    assert.equal(existsSync(drop), false, "the drop is taken");

    assert.equal((await put(url, { announce: false })).status, 200);
    assert.deepEqual(await dropped(drop), { on: false });
    assert.match(root(), /isn't announced on the home network any more/);
    assert.equal(existsSync(file), false, "T25.1 with it off, nothing is published");

    // Off already, and nothing published: turning another switch leaves no
    // drop behind.
    assert.equal((await put(url, { discover: false })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(drop), false);
  } finally {
    await daemon.close();
  }
});
