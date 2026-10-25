// The setup hotspot's side in the daemon (daemon/hotspot.ts, stage 4): what
// agentv-hotspot says, read back; the home Wi-Fi handed over in a drop only
// the daemon and root can read; and the captive page, on the hotspot's own
// address only, sending any other name to itself and serving nothing of the
// TV's or the paired phones'.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { HOTSPOT_ADDRESS, Hotspot, validPassword, validSsid, wifiQr } from "../../../daemon/hotspot.ts";
import { Daemon, lanAddress } from "../../../daemon/server.ts";

const ROOT = join(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "agentv-hotspot-"));
const run = join(dir, "run");
const state = join(dir, "state");
const drop = join(state, "hotspot-drop", "request.json");
mkdirSync(run);

const NETWORKS = [
  { ssid: "neighbours", signal: 40, secure: true },
  { ssid: "home wi-fi", signal: 82, secure: true, sae: false },
  { ssid: "cafe", signal: 61, secure: false },
  { ssid: "bad\u0007name", signal: 90, secure: true },
];

function hotspotIs(fields: Record<string, unknown>): void {
  writeFileSync(join(run, "state.json"), JSON.stringify({ on: false, ...fields }));
}

const readDrop = () => JSON.parse(readFileSync(drop, "utf8"));

test("it reads what agentv-hotspot says, and the networks the box saw, strongest first", () => {
  const hotspot = new Hotspot({ state, run });
  rmSync(join(run, "state.json"), { force: true });
  assert.deepEqual(hotspot.status(), { on: false, ssid: null, password: null, joining: null, joined: null, error: null });
  assert.deepEqual(hotspot.networks(), []);
  hotspotIs({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", device: "wlan0", error: "that password didn't work for home wi-fi" });
  writeFileSync(join(run, "networks.json"), JSON.stringify(NETWORKS));
  assert.deepEqual(hotspot.status(), { on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", joining: null, joined: null, error: "that password didn't work for home wi-fi" });
  assert.deepEqual(
    hotspot.networks().map((n) => n.ssid),
    ["home wi-fi", "cafe", "neighbours"],
    "a name with something in it that isn't text is left out",
  );
});

test("a network's name and password are checked before anything is handed over", () => {
  assert.ok(validSsid("home wi-fi") && validSsid("x".repeat(32)) && validSsid("café über"));
  assert.ok(!validSsid("") && !validSsid("x".repeat(33)) && !validSsid("a\nb") && !validSsid(42));
  assert.ok(validPassword("") && validPassword("12345678") && validPassword("a".repeat(63)) && validPassword("ab".repeat(32)));
  assert.ok(!validPassword("1234567") && !validPassword("x".repeat(64)) && !validPassword("pass\nword1") && !validPassword(null));
});

test("joining hands the network and its password to root in a drop only its owner can read", () => {
  const hotspot = new Hotspot({ state, run });
  hotspotIs({ on: false });
  assert.equal(hotspot.join("home wi-fi", "correct horse"), "the setup hotspot isn't on");
  hotspotIs({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n" });
  assert.equal(hotspot.join("", "correct horse"), "that isn't a wi-fi network's name");
  assert.equal(hotspot.join("home wi-fi", "short"), "a wi-fi password is 8 to 63 characters");
  assert.equal(hotspot.join("home wi-fi", ""), "home wi-fi needs its password");
  assert.ok(!existsSync(drop), "nothing is handed over until it's right");

  assert.equal(hotspot.join("home wi-fi", "correct horse"), null);
  assert.deepEqual(readDrop(), { join: { ssid: "home wi-fi", password: "correct horse", hidden: false } });
  assert.equal(statSync(drop).mode & 0o777, 0o600);
  assert.equal(statSync(join(state, "hotspot-drop")).mode & 0o777, 0o700);
  // An open network needs none, and a name it didn't see is a hidden one.
  assert.equal(hotspot.join("cafe", ""), null);
  assert.deepEqual(readDrop(), { join: { ssid: "cafe", password: "", hidden: false } });
  assert.equal(hotspot.join("attic", "upstairs1"), null);
  assert.deepEqual(readDrop(), { join: { ssid: "attic", password: "upstairs1", hidden: true } });
  hotspot.stop();
  assert.deepEqual(readDrop(), { stop: true });
  rmSync(drop);
});

test("the QR code a phone's camera joins with, with its special characters escaped", () => {
  assert.equal(wifiQr("AgenTV-3f9a", "k7m2xpqr4n"), "WIFI:T:WPA;S:AgenTV-3f9a;P:k7m2xpqr4n;;");
  assert.equal(wifiQr('a;b,c:d"e\\f', "p;ss"), 'WIFI:T:WPA;S:a\\;b\\,c\\:d\\"e\\\\f;P:p\\;ss;;');
  assert.equal(wifiQr("open", null), "WIFI:T:nopass;S:open;;");
});

test("the pairing address is never the box's own hotspot address", () => {
  const nic = (address: string) => ({ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/24` });
  assert.equal(lanAddress({ wlan0: [nic(HOTSPOT_ADDRESS)] }), null);
  assert.equal(lanAddress({ wlan0: [nic(HOTSPOT_ADDRESS)], enp1s0: [nic("192.168.1.20")] }), "192.168.1.20");
});

// --- The daemon -------------------------------------------------------------------

let daemon: Daemon;
let tv = "";
let port = 0;
const lines: string[] = [];
const qrArgs = join(dir, "qr-args");

before(async () => {
  const qrencode = join(dir, "qrencode");
  writeFileSync(qrencode, `#!/bin/bash\necho "$*" >"${qrArgs}"\necho '<svg xmlns="http://www.w3.org/2000/svg"></svg>'\n`);
  chmodSync(qrencode, 0o755);
  daemon = new Daemon({
    root: ROOT,
    state,
    builtins: null,
    port: 0,
    log: (line) => lines.push(line),
    running: "0.3.0-1",
    setupPort: 0,
    setupHost: "127.0.0.1",
    hotspotRun: run,
    hotspotAddress: "127.0.0.1",
    lanPort: 0,
    lanHost: "127.0.0.1",
    address: () => "192.168.1.20",
    qrencode,
  });
  tv = `http://127.0.0.1:${await daemon.listen()}`;
  port = daemon.setupPort!;
});

after(async () => {
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

// A request to the captive page with any name, as a phone on the hotspot
// sends it.
function phone(path: string, host: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { Host: host, ...(data ? { "Content-Type": "application/json" } : {}), ...headers } },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

test("a phone asking whether it's online, for any name, is sent to the captive page", async () => {
  hotspotIs({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n" });
  for (const [host, path] of [
    ["captive.apple.com", "/hotspot-detect.html"],
    ["connectivitycheck.gstatic.com", "/generate_204"],
    ["www.msftconnecttest.com", "/connecttest.txt"],
    ["detectportal.firefox.com", "/canonical.html"],
  ]) {
    const answer = await phone(path, host);
    assert.equal(answer.status, 302, `${host}${path}`);
    assert.equal(answer.headers.location, "http://127.0.0.1/");
    assert.equal(answer.headers["cache-control"], "no-store");
  }
});

test("on its own address it serves the captive page and what it needs, and nothing else", async () => {
  const host = `127.0.0.1:${port}`;
  const page = await phone("/", host);
  assert.equal(page.status, 200);
  assert.match(page.body, /companion-web\/setup\.ts/);
  for (const path of ["/companion-web/setup.ts", "/companion-web/lib.ts", "/companion-web/companion.css", "/launcher/glyphs.ts", "/api/theme.css"]) {
    assert.equal((await phone(path, host)).status, 200, path);
  }
  assert.doesNotMatch((await phone("/companion-web/setup.ts", host)).body, /interface Network/, "served as JavaScript");
  for (const path of ["/companion-web/main.ts", "/companion-web/index.html", "/launcher/main.ts", "/api/home", "/api/phone/state", "/api/hotspot", "/health", "/companion-web/../daemon/server.ts"]) {
    assert.equal((await phone(path, host)).status, 404, path);
  }
});

test("it lists the networks, takes the one picked and hands it to root, never logging the password", async () => {
  const host = `127.0.0.1:${port}`;
  const listed = JSON.parse((await phone("/api/setup/networks", host)).body);
  assert.equal(listed.hotspot, "AgenTV-3f9a");
  assert.deepEqual(listed.networks.map((n: { ssid: string }) => n.ssid), ["home wi-fi", "cafe", "neighbours"]);
  assert.equal(listed.password, undefined, "the hotspot's password is the TV's to show");

  const wrong = await phone("/api/setup/wifi", host, "POST", { ssid: "home wi-fi", password: "short" });
  assert.equal(wrong.status, 400);
  assert.equal(JSON.parse(wrong.body).error, "a wi-fi password is 8 to 63 characters");
  const elsewhere = await phone("/api/setup/wifi", host, "POST", { ssid: "home wi-fi", password: "correct horse" }, { Origin: "http://evil.example" });
  assert.equal(elsewhere.status, 403);
  assert.ok(!existsSync(drop));

  const joined = await phone("/api/setup/wifi", host, "POST", { ssid: "home wi-fi", password: "correct horse" }, { Origin: `http://${host}` });
  assert.equal(joined.status, 200);
  assert.deepEqual(JSON.parse(joined.body), { ok: true, joining: "home wi-fi" });
  assert.deepEqual(readDrop(), { join: { ssid: "home wi-fi", password: "correct horse", hidden: false } });
  assert.ok(lines.some((line) => line.includes("asked to join home wi-fi")));
  assert.ok(!lines.some((line) => line.includes("correct horse")), "the password is in no log line");
  rmSync(drop);

  hotspotIs({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", error: "that password didn't work for home wi-fi" });
  assert.deepEqual(JSON.parse((await phone("/api/setup/state", host)).body), { ok: true, on: true, joining: null, joined: null, error: "that password didn't work for home wi-fi" });
});

test("it answers on the hotspot's address and nowhere else", async () => {
  const other = new Daemon({ root: ROOT, state: join(dir, "other"), builtins: null, port: 0, log: () => {}, setupPort: 0, setupHost: "127.0.0.1", hotspotRun: run });
  await other.listen();
  const reached = await fetch(`http://127.0.0.1:${other.setupPort}/`).then(
    () => true,
    () => false,
  );
  await other.close();
  assert.equal(reached, false, "a request to 127.0.0.1 isn't answered when the hotspot's address is 10.42.0.1");
});

test("the TV gets the hotspot's name, password and QR code, and setup ending closes it", async () => {
  hotspotIs({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n" });
  const status = await (await fetch(`${tv}/api/hotspot`)).json();
  assert.deepEqual(status, { ok: true, on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", joining: null, joined: null, error: null });
  const qr = await fetch(`${tv}/api/hotspot/qr`);
  assert.equal(qr.status, 200);
  assert.match(await qr.text(), /<svg/);
  assert.match(readFileSync(qrArgs, "utf8"), /WIFI:T:WPA;S:AgenTV-3f9a;P:k7m2xpqr4n;;/);

  await fetch(`${tv}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: true }) });
  assert.deepEqual(readDrop(), { stop: true });
  rmSync(drop);

  hotspotIs({ on: false, joined: { ssid: "home wi-fi", address: "192.168.1.20" } });
  assert.equal((await fetch(`${tv}/api/hotspot/qr`)).status, 404);
  assert.deepEqual((await (await fetch(`${tv}/api/hotspot`)).json()).joined, { ssid: "home wi-fi", address: "192.168.1.20" });
  await fetch(`${tv}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: true }) });
  assert.ok(!existsSync(drop), "a hotspot that's off isn't asked to close");
});

test("once the hotspot joined the home Wi-Fi, phones pair at the box's address there", async () => {
  const pair = async () => (await (await fetch(`${tv}/api/phones/pair`, { method: "POST" })).json()).pairing.url as string;
  hotspotIs({ on: false });
  assert.match(await pair(), /^http:\/\/192\.168\.1\.20:\d+\/\?code=/, "the home network's address, with no hotspot");
  // 127.0.0.1 stands in for the address the box got on the Wi-Fi it joined.
  hotspotIs({ on: false, joined: { ssid: "home wi-fi", address: "127.0.0.1" } });
  assert.match(await pair(), /^http:\/\/127\.0\.0\.1:\d+\/\?code=/);
  // An address the box doesn't have any more isn't used.
  hotspotIs({ on: false, joined: { ssid: "home wi-fi", address: "10.9.9.9" } });
  assert.match(await pair(), /^http:\/\/192\.168\.1\.20:/);
});
