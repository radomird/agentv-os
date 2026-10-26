// TV setup's step (daemon/setup.ts, stage 5): kept in setup.json so setup
// picks up at the same step after a restart, an update or a reboot (S5.6),
// with no step skipped, and what the daemon answers the setup screens and
// the phones with.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Daemon } from "../../../daemon/server.ts";
import { network, Setup, STEPS } from "../../../daemon/setup.ts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-setup-"));
const state = join(scratch, "state");
const root = join(scratch, "root");
let daemon: Daemon;
let url = "";
let lanUrl = "";
let online = true;

const NO_HOTSPOT = { on: false, ssid: null, password: null, joining: null, joined: null, error: null };
const wired = { eth0: [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:01", internal: false, cidr: "192.168.1.20/24" }] };

before(async () => {
  mkdirSync(join(root, "setup"), { recursive: true });
  writeFileSync(join(root, "setup/index.html"), "<!doctype html><title>AgenTV setup</title>");
  writeFileSync(join(root, "settings"), "AGENTV_VERSION=0.2.1\nAGENTV_CHANNEL=stable\n");
  daemon = new Daemon({
    root,
    state,
    port: 0,
    log: () => {},
    builtins: null,
    lanPort: 0,
    lanHost: "127.0.0.1",
    address: () => "127.0.0.1",
    interfaces: () => (online ? wired : {}) as never,
    hotspotRun: join(scratch, "hotspot"),
  });
  url = `http://127.0.0.1:${await daemon.listen()}`;
  lanUrl = `http://127.0.0.1:${daemon.lanPort}`;
});

after(async () => {
  await daemon.close();
  rmSync(scratch, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("S5.6 setup's step is kept in setup.json, and a box from before stage 5 starts on the welcome screen", async () => {
  const path = join(scratch, "old.json");
  writeFileSync(path, JSON.stringify({ done: false }));
  const store = new Setup({ path });
  assert.equal((await store.read()).step, "welcome");
  writeFileSync(path, JSON.stringify({ done: true, at: "2026-10-23T12:00:00+00:00" }));
  assert.deepEqual([(await store.read()).done, (await store.read()).at], [true, "2026-10-23T12:00:00+00:00"]);

  writeFileSync(path, JSON.stringify({ done: false }));
  await store.finish("welcome", { keyboard: true });
  // Another process, as after a restart, reads the same step.
  const again = await new Setup({ path }).read();
  assert.equal(again.step, "ready");
  assert.equal(again.keyboard, true);
  assert.match(again.finished.welcome ?? "", /^\d{4}-\d\d-\d\dT/);
});

test("no step is skipped: forward only as far as the first one that isn't finished, and back always", async () => {
  const store = new Setup({ path: join(scratch, "order.json") });
  assert.match((await store.go("goal")).error ?? "", /welcome isn't finished yet/);
  assert.match((await store.finish("ready")).error ?? "", /welcome isn't finished yet/);
  await store.finish("welcome");
  await store.finish("ready");
  assert.equal((await store.read()).step, "ai");
  assert.match((await store.go("goal")).error ?? "", /ai isn't finished yet/);
  await store.finish("ai");
  assert.equal((await store.read()).step, "people");
  await store.finish("people");
  assert.equal((await store.read()).step, "goal");
  assert.equal((await store.go("welcome")).state?.step, "welcome");
  assert.equal((await store.go("goal")).state?.step, "goal");
  assert.match((await store.finish("goal")).error ?? "", /pick what the tv is for first/);
  assert.match((await store.setGoal("films")).error ?? "", /streaming, music, media, gaming/);
  await store.setGoal("music");
  assert.equal((await store.finish("goal")).state?.goal, "music");
  assert.match((await store.go("nowhere")).error ?? "", /a step/);
  await store.finish("apps");
  assert.equal((await store.read()).step, "theme");
  await store.finish("theme");
  assert.equal((await store.read()).step, "background");
  await store.finish("background");
  assert.equal((await store.read()).step, "background", "the last step finished stays on it, for the page to mark setup done");
  assert.deepEqual(STEPS, ["welcome", "ready", "ai", "people", "goal", "apps", "theme", "background"]);
});

test("getting ready keeps how bringing the box up to date goes, and when the check was asked for", async () => {
  const store = new Setup({ path: join(scratch, "ready.json") });
  const checking = (await store.setReady({ update: "checking", from: "0.2.1-1" })).state!;
  assert.equal(checking.ready.update, "checking");
  assert.match(checking.ready.asked ?? "", /^\d{4}-/);
  const installing = (await store.setReady({ update: "installing", from: "0.2.1-1", to: "0.3.0-1" })).state!;
  assert.deepEqual([installing.ready.from, installing.ready.to, installing.ready.asked], ["0.2.1-1", "0.3.0-1", checking.ready.asked]);
  assert.equal((await store.setReady({ update: "done" })).state?.ready.to, "0.3.0-1");
  assert.match((await store.setReady({ update: "maybe" })).error ?? "", /update is one of/);
  assert.match((await store.setReady({ update: "done", to: "0.3.0; rm -rf /" })).error ?? "", /versions/);
});

test("setup started again forgets its step and choices, and done keeps them", async () => {
  const store = new Setup({ path: join(scratch, "again.json") });
  await store.finish("welcome");
  await store.setGoal("gaming");
  const done = await store.mark(true);
  assert.deepEqual([done.done, done.goal, done.step], [true, "gaming", "ready"]);
  const fresh = await store.mark(false);
  assert.deepEqual([fresh.done, fresh.goal, fresh.step, fresh.finished], [false, null, "welcome", {}]);
});

test("the box is online on a wired or Wi-Fi address that isn't its own setup hotspot's", () => {
  const ip = (address: string) => [{ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/24` }];
  assert.deepEqual(network(NO_HOTSPOT, { lo: [{ ...ip("127.0.0.1")[0], internal: true }] }), { online: false, via: null, name: null });
  assert.deepEqual(network(NO_HOTSPOT, { wlan0: ip("10.42.0.1") }), { online: false, via: null, name: null });
  assert.deepEqual(network(NO_HOTSPOT, { docker0: ip("172.17.0.1") }), { online: false, via: null, name: null });
  assert.deepEqual(network(NO_HOTSPOT, { enp1s0: ip("192.168.1.20") }), { online: true, via: "ethernet", name: null });
  assert.deepEqual(network({ ...NO_HOTSPOT, joined: { ssid: "home wi-fi", address: "192.168.1.30" } }, { wlan0: ip("192.168.1.30") }), {
    online: true,
    via: "wi-fi",
    name: "home wi-fi",
  });
});

test("the setup screens hear where setup is, how the box is online, the hotspot and the phones", async () => {
  const info = await (await fetch(`${url}/api/setup`)).json();
  assert.equal(info.setup.step, "welcome");
  assert.deepEqual(info.steps, ["welcome", "ready", "ai", "people", "goal", "apps", "theme", "background"]);
  assert.equal(info.parts.goal, "4/6 goal");
  assert.equal(info.parts.apps, "5/6 apps");
  assert.equal(info.parts.theme, "6/6 look");
  assert.deepEqual(info.network, { online: true, via: "ethernet", name: null });
  assert.equal(info.hotspot.on, false);
  assert.deepEqual(info.phones, []);
  assert.equal(info.version, "0.2.1");
  assert.equal(info.pin, false);
  online = false;
  assert.equal((await (await fetch(`${url}/api/setup`)).json()).network.online, false);
  online = true;
});

test("S5.6 each step moved on is broadcast, kept, and said in /health, and setup done takes them over", async () => {
  const events = await fetch(`${url}/api/events`);
  const reader = events.body!.getReader();
  assert.equal((await post("/api/setup/finish", { step: "welcome", keyboard: true })).status, 200);
  let seen = "";
  while (!seen.includes('"step":"ready"')) seen += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.equal((await (await fetch(`${url}/health`)).json()).setup_step, "ready");
  assert.equal(JSON.parse(readFileSync(join(state, "setup.json"), "utf8")).step, "ready");

  assert.equal((await post("/api/setup/finish", { step: "goal" })).status, 400, "ready isn't finished yet");
  assert.equal((await post("/api/setup/ready", { update: "none", to: "0.2.1" })).status, 200);
  assert.equal((await post("/api/setup/finish", { step: "ready" })).status, 200);
  assert.equal((await post("/api/setup/finish", { step: "ai" })).status, 200);
  assert.equal((await post("/api/setup/finish", { step: "people" })).status, 200);
  assert.equal((await post("/api/setup/goal", { goal: "streaming" })).status, 200);
  assert.equal((await post("/api/setup/finish", { step: "goal" })).status, 200);
  assert.equal((await post("/api/setup", { done: true })).status, 200);
  assert.equal((await (await fetch(`${url}/health`)).json()).setup_step, null);
  assert.equal((await post("/api/setup/step", { step: "welcome" })).status, 409, "not once setup is done");
  assert.equal((await post("/api/setup", { done: false })).status, 200);
});

test("a paired phone hears setup's step while it's on, and nothing once it's done", async () => {
  const code = (await (await post("/api/phones/pair", {})).json()).pairing.code;
  const paired = await (await fetch(`${lanUrl}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "iphone" }) })).json();
  const phone = async () => (await fetch(`${lanUrl}/api/phone/state`, { headers: { Authorization: `Bearer ${paired.token}` } })).json();
  assert.deepEqual((await phone()).setup, { step: "welcome", part: "1/6 connect" });
  assert.deepEqual((await (await fetch(`${url}/api/setup`)).json()).phones, ["iphone"]);
  await post("/api/setup", { done: true });
  assert.equal((await phone()).setup, null);
  await post("/api/setup", { done: false });
});

test("the keyboard's Wi-Fi at the welcome screen goes the captive page's way, and only while the hotspot is on", async () => {
  const run = join(scratch, "hotspot");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "networks.json"), JSON.stringify([{ ssid: "home wi-fi", signal: 82, secure: true }]));
  assert.match((await (await post("/api/setup/wifi", { ssid: "home wi-fi", password: "correct horse" })).json()).error, /hotspot isn't on/);
  writeFileSync(join(run, "state.json"), JSON.stringify({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n" }));
  assert.deepEqual((await (await fetch(`${url}/api/setup/networks`)).json()).networks, [{ ssid: "home wi-fi", signal: 82, secure: true }]);
  assert.match((await (await post("/api/setup/wifi", { ssid: "home wi-fi", password: "" })).json()).error, /needs its password/);
  assert.equal((await post("/api/setup/wifi", { ssid: "home wi-fi", password: "correct horse" })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "hotspot-drop", "request.json"), "utf8")), { join: { ssid: "home wi-fi", password: "correct horse", hidden: false } });
});

test("with music as the goal, Music is on home from the start", async () => {
  const music = join(scratch, "music");
  mkdirSync(join(music, "root", "setup"), { recursive: true });
  const box = new Daemon({ root: join(music, "root"), state: join(music, "state"), port: 0, log: () => {}, builtins: join(import.meta.dirname, "../../../apps/builtin") });
  const at = `http://127.0.0.1:${await box.listen()}`;
  const send = (path: string, body: unknown) => fetch(`${at}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    await send("/api/setup/finish", { step: "welcome" });
    await send("/api/setup/ready", { update: "none" });
    await send("/api/setup/finish", { step: "ready" });
    await send("/api/setup/finish", { step: "ai" });
    await send("/api/setup/finish", { step: "people" });
    await send("/api/setup/goal", { goal: "music" });
    await send("/api/setup", { done: true });
    const home = await (await fetch(`${at}/api/home`)).json();
    assert.ok(home.layout.some((tile: { id: string }) => tile.id === "agentv.music"), JSON.stringify(home.layout));
  } finally {
    await box.close();
  }
});

test("an app asked for at add your own is kept for later, once, up to five", async () => {
  const store = new Setup({ path: join(scratch, "wishes.json") });
  assert.match((await store.wish("")).error ?? "", /a few words/);
  assert.match((await store.wish("x".repeat(81))).error ?? "", /a few words/);
  assert.match((await store.wish("<script>")).error ?? "", /a few words/);
  assert.deepEqual((await store.wish("  a radio   app ")).state?.wishes, ["a radio app"]);
  assert.deepEqual((await store.wish("A radio app")).state?.wishes, ["a radio app"], "the same words again are kept once");
  for (const app of ["one", "two", "three", "four"]) await store.wish(app);
  assert.match((await store.wish("six")).error ?? "", /5 for later already/);
  assert.equal((await new Setup({ path: join(scratch, "wishes.json") }).read()).wishes.length, 5);
  assert.deepEqual((await store.mark(false)).wishes, [], "setup started again forgets them");
});
