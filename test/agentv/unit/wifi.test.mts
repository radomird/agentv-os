// Wi-Fi after setup, in the daemon (daemon/network.ts and its routes): how
// the TV is online, the networks nearby with the one it's on marked, a look
// and a join handed to root with the hotspot closed, and who may do which.
// The TV's own page asks on the TV's port, where a child's profile can't
// change the Wi-Fi and a join needs the PIN's grant when a PIN is set. The
// hotspot's page, after setup, asks for the adult PIN itself when one is
// set, with wrong tries counted apart from the TV's pad. The password is in
// the drop and nowhere else. Root is stood in for by what it writes.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hotspot } from "../../../daemon/hotspot.ts";
import { TvNetwork } from "../../../daemon/network.ts";
import { Daemon } from "../../../daemon/server.ts";

const ROOT = join(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "agentv-wifi-"));
const run = join(dir, "run");
const state = join(dir, "state");
const drop = join(state, "hotspot-drop", "request.json");
mkdirSync(run);
mkdirSync(state);

const NETWORKS = [
  { ssid: "neighbours", signal: 40, secure: true },
  { ssid: "Home", signal: 82, secure: true },
  { ssid: "cafe", signal: 61, secure: false },
];
const nic = (address: string) => ({ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/24` });
let interfaces: Record<string, ReturnType<typeof nic>[]> = { wlan0: [nic("192.168.1.20")] };

// Root's side: what agentv-hotspot writes, and the drop it takes.
function rootSays(fields: Record<string, unknown>): void {
  writeFileSync(join(run, "state.json"), JSON.stringify({ on: false, ...fields }));
}
const readDrop = () => JSON.parse(readFileSync(drop, "utf8"));
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("it says how the TV is online, and marks the network it's on", () => {
  writeFileSync(join(run, "networks.json"), JSON.stringify(NETWORKS));
  rootSays({ wifi: "Home", radio: true });
  const network = new TvNetwork({ hotspot: new Hotspot({ state, run }), run, interfaces: () => interfaces });
  assert.deepEqual(network.state(), { online: true, via: "wi-fi", name: "Home", wifi: true, looking: false, joining: null, problem: null, hotspot: null });
  assert.deepEqual(
    network.networks().map((n) => [n.ssid, n.current]),
    [["Home", true], ["cafe", false], ["neighbours", false]],
  );
  interfaces = { enp1s0: [nic("192.168.1.21")] };
  rootSays({ wifi: null, radio: false });
  assert.deepEqual(network.state(), { online: true, via: "cable", name: null, wifi: false, looking: false, joining: null, problem: null, hotspot: null });
  interfaces = {};
  rootSays({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", radio: true, watch: true });
  assert.deepEqual(network.state(), { online: false, via: null, name: null, wifi: true, looking: false, joining: null, problem: null, hotspot: { ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", problem: false } });
  rootSays({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", radio: true, watch: true, error: "that password didn't work for Home", why: "password" });
  assert.equal(network.state().hotspot?.problem, true, "a join from the hotspot's page that didn't work shows on the notice");
  interfaces = { wlan0: [nic("192.168.1.20")] };
});

test("a look and a join go to root with the hotspot closed, and it says how each went", async () => {
  let clock = 1000;
  const heard: unknown[] = [];
  rootSays({ wifi: "Home", radio: true });
  const hotspot = new Hotspot({ state, run });
  // Root's answer counts once state.json is written after the ask.
  const network = new TvNetwork({ hotspot, run, interfaces: () => interfaces, now: () => clock, changed: (now) => heard.push(now) });
  clock = Date.now();
  assert.equal(network.look(), null);
  assert.deepEqual(readDrop(), { scan: true });
  assert.equal(network.state().looking, true);
  assert.equal(network.look(), null, "asked twice, it's one look");
  rmSync(drop);
  assert.equal(network.state().looking, true, "root took it, and hasn't said yet");
  await pause(20);
  rootSays({ wifi: "Home", radio: true, scanned: "now" });
  assert.equal(network.state().looking, false);

  assert.equal(network.join("", "long enough"), "name");
  assert.equal(network.join("Home", "short"), "password");
  assert.equal(network.join("Home", ""), "password", "a network that has a password needs it");
  assert.ok(!existsSync(drop), "nothing is handed over until it's right");
  clock = Date.now();
  assert.equal(network.join("Home", "correct horse"), null);
  assert.deepEqual(readDrop(), { join: { ssid: "Home", password: "correct horse", hidden: false } });
  assert.equal(network.state().joining, "Home");
  assert.equal(network.look(), "busy");
  rmSync(drop);
  await pause(20);
  rootSays({ wifi: "Home", radio: true, joining: "Home" });
  assert.equal(network.state().joining, "Home");
  await pause(20);
  rootSays({ wifi: "cafe", radio: true, joining: null, error: "that password didn't work for Home", why: "password" });
  assert.deepEqual(network.state().problem, { ssid: "Home", why: "password" });
  assert.equal(network.state().joining, null);
  assert.equal(network.state().name, "cafe", "and the TV is back on the network from before");

  // An open one, and one it never saw, which is a hidden one.
  clock = Date.now();
  assert.equal(network.join("attic", "upstairs1"), null);
  assert.deepEqual(readDrop(), { join: { ssid: "attic", password: "upstairs1", hidden: true } });
  assert.equal(network.state().problem, null, "a new try clears the last one's reason");
  rmSync(drop);
  await pause(20);
  rootSays({ wifi: "attic", radio: true, joined: { ssid: "attic", address: "192.168.1.20" } });
  assert.deepEqual([network.state().joining, network.state().problem, network.state().name], [null, null, "attic"]);

  // Root that never answers: the page isn't left waiting for good.
  clock = Date.now();
  assert.equal(network.join("cafe", ""), null);
  clock += 101_000;
  assert.deepEqual(network.state().problem, { ssid: "cafe", why: "failed" });
  rmSync(drop);
  // With the hotspot open the radio can't look.
  rootSays({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", radio: true });
  assert.equal(network.look(), "hotspot");
  assert.ok(!JSON.stringify(heard).includes("correct horse") && !JSON.stringify(heard).includes("upstairs1"), "no password in what the pages hear");
  network.close();
});

// --- The daemon -------------------------------------------------------------------

let daemon: Daemon;
let tv = "";
let captive = "";
let lan = "";
const lines: string[] = [];

async function send(base: string, method: string, path: string, body?: unknown, grant?: string): Promise<{ status: number; data: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

before(async () => {
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true }));
  rootSays({ wifi: "Home", radio: true });
  daemon = new Daemon({
    root: ROOT,
    state,
    builtins: null,
    port: 0,
    log: (line) => lines.push(line),
    setupPort: 0,
    setupHost: "127.0.0.1",
    hotspotRun: run,
    hotspotAddress: "127.0.0.1",
    lanPort: 0,
    lanHost: "127.0.0.1",
    address: () => "192.168.1.20",
    interfaces: () => interfaces,
  });
  tv = `http://127.0.0.1:${await daemon.listen()}`;
  captive = `http://127.0.0.1:${daemon.setupPort}`;
  lan = `http://127.0.0.1:${daemon.lanPort}`;
});

after(async () => {
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the TV's page gets how it's online and the networks, and with no PIN set a join asks for none", async () => {
  rootSays({ wifi: "Home", radio: true });
  const status = await send(tv, "GET", "/api/network");
  assert.deepEqual(status.data, { ok: true, online: true, via: "wi-fi", name: "Home", wifi: true, looking: false, joining: null, problem: null, hotspot: null, change: true });
  const listed = await send(tv, "GET", "/api/network/networks");
  assert.deepEqual(listed.data.networks[0], { ssid: "Home", signal: 82, secure: true, current: true });
  assert.equal((await send(tv, "POST", "/api/network/scan")).status, 200);
  assert.deepEqual(readDrop(), { scan: true });
  rmSync(drop);
  await pause(20);
  rootSays({ wifi: "Home", radio: true });
  assert.equal((await send(tv, "GET", "/api/network")).data.looking, false);

  assert.deepEqual((await send(tv, "POST", "/api/network/join", { ssid: "Home", password: "short" })).data, { ok: false, error: "password" });
  const joined = await send(tv, "POST", "/api/network/join", { ssid: "Home", password: "correct horse" });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.joining, "Home");
  assert.deepEqual(readDrop(), { join: { ssid: "Home", password: "correct horse", hidden: false } });
  assert.ok(lines.some((line) => line.includes("settings asked to join Home")));
  assert.ok(!lines.some((line) => line.includes("correct horse")), "the password is in no log line");
  assert.ok(!JSON.stringify(joined.data).includes("correct horse"), "nor in the answer");
  rmSync(drop);
  await pause(20);
  rootSays({ wifi: "Home", radio: true, joined: { ssid: "Home", address: "192.168.1.20" } });
  assert.equal((await send(tv, "GET", "/api/network")).data.joining, null);
});

test("these are the TV's own: a phone's port and the hotspot's page have none of them", async () => {
  for (const base of [lan, captive]) {
    for (const [method, path] of [["GET", "/api/network"], ["GET", "/api/network/networks"], ["POST", "/api/network/scan"], ["POST", "/api/network/join"]]) {
      const answer = await send(base, method, path, method === "POST" ? { ssid: "cafe", password: "" } : undefined);
      assert.ok(answer.status === 404 || answer.status === 401 || answer.status === 403, `${base === lan ? "phones" : "hotspot"} ${method} ${path}: ${answer.status}`);
    }
  }
  assert.ok(!existsSync(drop), "and nothing was handed to root");
  // Another site's page in the TV's browser can't ask either.
  const elsewhere = await fetch(`${tv}/api/network/join`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body: JSON.stringify({ ssid: "cafe", password: "" }) });
  assert.equal(elsewhere.status, 403);
  assert.ok(!existsSync(drop));
});

test("with a PIN set a join needs its grant, and a child's profile can't look or join even with it", async () => {
  assert.equal((await send(tv, "PUT", "/api/pin", { pin: "4826" })).status, 200);
  const refused = await send(tv, "POST", "/api/network/join", { ssid: "cafe", password: "" });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.pin, true);
  assert.ok(!existsSync(drop));
  assert.equal((await send(tv, "POST", "/api/network/scan")).status, 200, "a look is an adult's with no PIN to type");
  rmSync(drop);
  await pause(20);
  rootSays({ wifi: "Home", radio: true });
  const grant = (await send(tv, "POST", "/api/pin/check", { pin: "4826" })).data.grant as string;
  assert.equal((await send(tv, "POST", "/api/network/join", { ssid: "cafe", password: "" }, grant)).status, 200);
  assert.deepEqual(readDrop(), { join: { ssid: "cafe", password: "", hidden: false } });
  rmSync(drop);
  await pause(20);
  rootSays({ wifi: "cafe", radio: true });
  assert.equal((await send(tv, "GET", "/api/network")).data.joining, null);

  const adult = (await send(tv, "GET", "/api/viewers")).data.active as string;
  const child = (await send(tv, "POST", "/api/viewers", { name: "mila", role: "child" }, grant)).data.profile;
  assert.equal((await send(tv, "POST", "/api/viewer", { id: child.id })).status, 200);
  const seen = await send(tv, "GET", "/api/network");
  assert.equal(seen.data.name, "cafe", "a child's profile sees how the TV is online");
  assert.equal(seen.data.change, false);
  assert.deepEqual((await send(tv, "POST", "/api/network/scan", undefined, grant)).data, { ok: false, error: "child" });
  const join = await send(tv, "POST", "/api/network/join", { ssid: "Home", password: "correct horse" }, grant);
  assert.equal(join.status, 403);
  assert.deepEqual(join.data, { ok: false, error: "child" });
  assert.ok(!existsSync(drop));
  assert.equal((await send(tv, "POST", "/api/viewer", { id: adult }, grant)).status, 200);
});

test("the hotspot's page, after setup, asks for the adult PIN when one is set, and its wrong tries are its own", async () => {
  rootSays({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", radio: true, watch: true });
  const listed = await send(captive, "GET", "/api/setup/networks");
  assert.equal(listed.data.after, true);
  assert.equal(listed.data.pin, true);
  const none = await send(captive, "POST", "/api/setup/wifi", { ssid: "Home", password: "correct horse" });
  assert.equal(none.status, 403);
  assert.equal(none.data.pin, true);
  for (let i = 0; i < 4; i++) assert.equal((await send(captive, "POST", "/api/setup/wifi", { ssid: "Home", password: "correct horse", pin: "0000" })).status, 403);
  const waits = await send(captive, "POST", "/api/setup/wifi", { ssid: "Home", password: "correct horse", pin: "4826" });
  assert.equal(waits.status, 403, "after five wrong tries even the right PIN waits");
  assert.ok(waits.data.wait > 0);
  assert.ok(!existsSync(drop), "and nothing was handed to root");
  assert.equal((await send(tv, "POST", "/api/pin/check", { pin: "4826" })).status, 200, "the TV's pad doesn't wait for the hotspot page's wrong tries");
  assert.ok(!lines.some((line) => /4826|0000/.test(line)), "no PIN in a log line");
});

test("with the right PIN the hotspot's page joins, and with no PIN set it asks for none", async () => {
  // The wait from the test before, taken off, as if it had run out.
  const pinFile = join(state, "pin.json");
  const stored = JSON.parse(readFileSync(pinFile, "utf8"));
  delete stored.phones;
  writeFileSync(pinFile, JSON.stringify(stored));
  const right = await send(captive, "POST", "/api/setup/wifi", { ssid: "Home", password: "correct horse", pin: "4826" });
  assert.equal(right.status, 200);
  assert.deepEqual(readDrop(), { join: { ssid: "Home", password: "correct horse", hidden: false } }, "the PIN goes no further than the daemon's check");
  rmSync(drop);

  const grant = (await send(tv, "POST", "/api/pin/check", { pin: "4826" })).data.grant as string;
  const mila = (await send(tv, "GET", "/api/viewers")).data.viewers.find((v: { name: string }) => v.name === "mila");
  assert.equal((await send(tv, "DELETE", `/api/viewers/${mila.id}`, undefined, grant)).status, 200);
  assert.equal((await send(tv, "DELETE", "/api/pin", undefined, grant)).status, 200);
  const listed = await send(captive, "GET", "/api/setup/networks");
  assert.deepEqual([listed.data.after, listed.data.pin], [true, false]);
  assert.equal((await send(captive, "POST", "/api/setup/wifi", { ssid: "Home", password: "correct horse" })).status, 200);
  rmSync(drop);
});

test("during setup the hotspot's page is as it was: no PIN asked, even with one set", async () => {
  assert.equal((await send(tv, "PUT", "/api/pin", { pin: "4826" })).status, 200);
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false }));
  const listed = await send(captive, "GET", "/api/setup/networks");
  assert.deepEqual([listed.data.after, listed.data.pin], [undefined, undefined]);
  assert.equal((await send(captive, "POST", "/api/setup/wifi", { ssid: "Home", password: "correct horse" })).status, 200);
  assert.deepEqual(readDrop(), { join: { ssid: "Home", password: "correct horse", hidden: false } });
  rmSync(drop);
});
