// Profiles (daemon/profiles.ts, ADR-009, S4.2): the owner first, names,
// avatars and roles, one viewer active for the whole box, and the daemon's
// rules: a child's profile needs the PIN, changing profiles needs it once
// there is one, a child sees only the apps ticked for children, and switching
// from a child to an adult needs the PIN. An adult's profile can ask for the
// PIN to open (ADR-034), and only it is locked after the box starts and
// after the TV has been off.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Ledger } from "../../../daemon/ledger.ts";
import { Profiles } from "../../../daemon/profiles.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "../ui/box.mts";

const dir = mkdtempSync(join(tmpdir(), "agentv-profiles-"));
const passwd = join(dir, "passwd");
writeFileSync(passwd, "root:x:0:0::/root:/bin/bash\nradomir:x:1000:1000::/home/radomir:/bin/bash\n");
let n = 0;

function store() {
  const ledger = new Ledger(":memory:");
  const profiles = new Profiles({ ledger: () => ledger, state: join(dir, `state-${++n}`), passwd });
  return { ledger, profiles };
}

test("S4.2 a box starts with its owner, an adult, watching", async () => {
  const { profiles } = store();
  assert.deepEqual(await profiles.list(), [{ id: "radomir", name: "radomir", role: "adult", avatar: "blue", locked: false }]);
  assert.equal((await profiles.active()).id, "radomir");
  assert.equal(await profiles.children(), false);
});

test("S4.2 profiles have a name, a colour and a role, in the order they came", async () => {
  const { profiles } = store();
  const ana = (await profiles.add({ name: " Ana ", role: "adult" })).profile!;
  assert.deepEqual([ana.name, ana.role, ana.avatar], ["Ana", "adult", "green"], "the next colour no one has");
  assert.match(ana.id, /^v-[0-9a-f]{8}$/);
  const mila = (await profiles.add({ name: "mila", role: "child", avatar: "yellow" })).profile!;
  assert.deepEqual((await profiles.list()).map((p) => p.name), ["radomir", "Ana", "mila"]);
  assert.equal(await profiles.children(), true);
  for (const [input, error] of [
    [{}, "a name of up to 20 characters"],
    [{ name: "  " }, "a name of up to 20 characters"],
    [{ name: "x".repeat(21) }, "a name of up to 20 characters"],
    [{ name: "ANA" }, "someone here has that name already"],
    [{ name: "leo", role: "teen" }, "adult or child"],
    [{ name: "leo", avatar: "pink" }, "a colour: blue, green, magenta, yellow, cyan, orange, red"],
  ] as const) {
    assert.deepEqual(await profiles.add(input), { error }, JSON.stringify(input));
  }
  assert.equal((await profiles.edit(mila.id, { name: "Mila", avatar: "cyan" })).profile!.avatar, "cyan");
  assert.deepEqual(await profiles.edit("v-none", { name: "x" }), { error: "there's no such profile" });
});

test("S4.2 one viewer watches at a time, and the box always keeps an adult", async () => {
  const { profiles, ledger } = store();
  const mila = (await profiles.add({ name: "mila", role: "child" })).profile!;
  assert.equal((await profiles.switchTo(mila.id))!.id, mila.id);
  assert.equal((await profiles.active()).id, mila.id);
  assert.equal(await profiles.switchTo("v-none"), null);
  assert.equal(await profiles.remove("radomir"), "the box needs an adult");
  assert.deepEqual(await profiles.edit("radomir", { role: "child" }), { error: "the box needs an adult" });
  // A profile taken off goes with what it watched, and whoever was watching
  // falls back to the first adult.
  ledger.record(mila.id, "agentv.sample", "film", { title: "Spring", position: 10, duration: 464, playing: true });
  assert.equal(await profiles.remove(mila.id), null);
  assert.deepEqual(ledger.recent(mila.id), []);
  assert.equal((await profiles.active()).id, "radomir");
  assert.equal(await profiles.remove(mila.id), "there's no such profile");
});

test("ADR-034 an adult's profile can ask for the PIN to open, and a child's can't", async () => {
  const { profiles } = store();
  const ana = (await profiles.add({ name: "ana", role: "adult", locked: true })).profile!;
  assert.equal(ana.locked, true);
  assert.equal((await profiles.list()).find((p) => p.id === "radomir")!.locked, false, "the owner doesn't, until they say so");
  assert.equal((await profiles.add({ name: "mila", role: "child", locked: true })).error, "only an adult's profile locks");
  assert.equal((await profiles.edit(ana.id, { locked: "yes" })).error, "locked is true or false");
  assert.equal(await profiles.needPin(), "a locked profile needs the pin. unlock it in settings → profiles first");
  // A profile that becomes a child's stops asking.
  assert.equal((await profiles.edit(ana.id, { role: "child" })).profile!.locked, false);
  assert.equal((await profiles.edit(ana.id, { role: "child", locked: true })).error, "only an adult's profile locks");
  assert.equal((await profiles.edit(ana.id, { role: "adult", locked: true })).profile!.locked, true);
  assert.equal((await profiles.edit("radomir", { locked: true })).profile!.locked, true);
  assert.equal(await profiles.remove(ana.id), null);
  assert.deepEqual((await profiles.list()).map((p) => [p.name, p.locked]), [["radomir", true]], "taken off, with their lock");
  assert.equal((await profiles.edit("radomir", { locked: false })).profile!.locked, false);
  assert.equal(await profiles.needPin(), null);
});

// --- The daemon's requests ---------------------------------------------------

let daemon: Daemon;
let url = "";
const events: string[] = [];

before(async () => {
  process.env.AGENTV_PASSWD = passwd;
  ({ daemon, url } = await startBox());
  const stream = await fetch(`${url}/api/events`);
  const reader = stream.body!.getReader();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      for (const match of new TextDecoder().decode(value).matchAll(/event: (\w+)/g)) events.push(match[1]);
    }
  })().catch(() => {});
});

after(async () => {
  await daemon?.close();
  delete process.env.AGENTV_PASSWD;
  rmSync(dir, { recursive: true, force: true });
});

async function send(method: string, path: string, body?: unknown, grant?: string) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as Record<string, any> };
}

const grant = async () => (await send("POST", "/api/pin/check", { pin: "4826" })).data.grant as string;

test("S4.2 S4.5 a child's profile needs an adult PIN, and changing profiles needs it once there is one", async () => {
  assert.deepEqual((await send("GET", "/api/viewers")).data, { ok: true, viewers: [{ id: "radomir", name: "radomir", role: "adult", avatar: "blue", locked: false }], active: "radomir" });
  const ana = await send("POST", "/api/viewers", { name: "ana", role: "adult" });
  assert.equal(ana.status, 200, "with no pin, an adult's profile is added");
  const child = await send("POST", "/api/viewers", { name: "mila", role: "child" });
  assert.deepEqual(child, { status: 400, data: { ok: false, error: "a child's profile needs an adult pin. set one in settings → adult pin first" } });
  assert.equal((await send("PUT", `/api/viewers/${ana.data.profile.id}`, { role: "child" })).status, 400, "nor can an adult become a child");

  assert.equal((await send("PUT", "/api/pin", { pin: "4826" })).status, 200);
  assert.equal((await send("POST", "/api/viewers", { name: "mila", role: "child" })).status, 403, "now it needs the pin");
  const mila = await send("POST", "/api/viewers", { name: "mila", role: "child", avatar: "yellow" }, await grant());
  assert.equal(mila.status, 200);
  assert.deepEqual(mila.data.viewers.map((v: any) => v.name), ["radomir", "ana", "mila"]);
  // The PIN stays on while there's a child's profile.
  assert.deepEqual((await send("DELETE", "/api/pin", undefined, await grant())).data, { ok: false, error: "a child's profile needs the pin, so it stays" });
  assert.ok(events.includes("viewers"));
});

test("S4.2 a switch to a child shows within a second: their home, only children's apps, and the adult things past the PIN", async () => {
  const mila = (await send("GET", "/api/viewers")).data.viewers.find((v: any) => v.name === "mila");
  const adult = await send("GET", "/api/home");
  assert.ok(adult.data.apps.length > 1);
  const before = events.length;
  const at = Date.now();
  assert.equal((await send("POST", "/api/viewer", { id: mila.id })).status, 200, "switching to a child needs no pin");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(events.slice(before).includes("viewer"), "the TV hears it at once");
  const home = (await send("GET", "/api/home")).data;
  assert.ok(Date.now() - at < 1000);
  assert.deepEqual(home.viewer, mila);
  // No fixture app is child-safe, so a child's home is the all apps tile alone.
  assert.deepEqual(home.apps, []);
  assert.deepEqual(home.layout.map((t: any) => t.id), ["apps"]);
  assert.equal((await send("GET", "/api/apps/agentv.tube/launch")).status, 404, "an app children can't open doesn't open");

  // Settings, home's layout and switching to an adult are past the PIN.
  assert.equal((await send("POST", "/api/settings", { reduceMotion: true })).status, 403);
  assert.equal((await send("POST", "/api/weather", { units: "f" })).status, 403);
  assert.equal((await send("PUT", "/api/layout", { layout: home.layout })).status, 403);
  assert.equal((await send("POST", "/api/viewer", { id: "radomir" })).status, 403);
  assert.equal((await send("POST", "/api/settings", { reduceMotion: true }, await grant())).status, 200);

  // An adult ticks an app for children, and it's on the child's home and opens.
  assert.equal((await send("POST", "/api/apps/agentv.tube/for-children", { allowed: true })).status, 403);
  assert.equal((await send("POST", "/api/apps/agentv.tube/for-children", { allowed: true }, await grant())).status, 200);
  const ticked = (await send("GET", "/api/home")).data;
  assert.deepEqual(ticked.apps.map((a: any) => [a.id, a.forChildren]), [["agentv.tube", true]]);
  assert.deepEqual(ticked.layout.map((t: any) => t.id), ["agentv.tube", "apps"]);
  assert.equal((await send("GET", "/api/apps/agentv.tube/launch")).status, 200);

  assert.equal((await send("POST", "/api/viewer", { id: "radomir" }, await grant())).status, 200);
  assert.equal((await send("GET", "/api/home")).data.viewer.id, "radomir");
});

test("S4.2 each viewer keeps their own layout, and one taken off takes theirs", async () => {
  const ana = (await send("GET", "/api/viewers")).data.viewers.find((v: any) => v.name === "ana");
  const mine = (await send("GET", "/api/home")).data.layout;
  await send("POST", "/api/viewer", { id: ana.id });
  const hers = [{ id: "apps", x: 0, y: 0, size: "s" }];
  assert.equal((await send("PUT", "/api/layout", { layout: hers })).status, 200);
  await send("POST", "/api/viewer", { id: "radomir" });
  assert.deepEqual((await send("GET", "/api/home")).data.layout, mine);
  assert.equal((await send("DELETE", `/api/viewers/${ana.id}`)).status, 403, "with a pin set, it needs it");
  assert.equal((await send("DELETE", `/api/viewers/${ana.id}`, undefined, await grant())).status, 200);
  assert.equal((await send("POST", "/api/viewer", { id: ana.id })).status, 404);
  assert.equal((await send("DELETE", "/api/viewers/radomir", undefined, await grant())).data.error, "the box needs an adult");
});

test("ADR-034 S4.5 only a locked profile asks for the PIN after the box starts, after the TV has been off and to switch to it", async () => {
  const viewers = async () => (await send("GET", "/api/viewers")).data.viewers as any[];
  const pinNow = async () => (await send("GET", "/api/pin")).data.locked as boolean;
  const noor = (await send("POST", "/api/viewers", { name: "noor", role: "adult" }, await grant())).data.profile;
  const mila = (await viewers()).find((v) => v.name === "mila");
  assert.equal((await send("POST", "/api/viewer", { id: "radomir" }, await grant())).status, 200);

  // A locked profile needs a PIN, and locking one needs it.
  assert.equal((await send("PUT", "/api/viewers/radomir", { locked: true })).status, 403);
  assert.deepEqual((await send("PUT", `/api/viewers/${mila.id}`, { locked: true }, await grant())).data, { ok: false, error: "only an adult's profile locks" });
  const locked = await send("PUT", "/api/viewers/radomir", { locked: true }, await grant());
  assert.equal(locked.status, 200);
  assert.deepEqual((await viewers()).map((v) => [v.name, v.locked]), [["radomir", true], ["mila", false], ["noor", false]]);
  assert.equal(await pinNow(), false, "the PIN that locked it unlocked the TV too");

  // After the box starts again, the locked profile on screen is locked.
  daemon.pin.lock(false);
  assert.equal(await pinNow(), true);
  assert.deepEqual((await send("GET", "/api/home")).data.pin, { set: true, locked: true });
  // Someone else watching, from the phone, opens their own profile without it.
  const before = events.length;
  assert.equal((await send("POST", "/api/viewer", { id: noor.id })).status, 200, "noor's profile doesn't ask");
  assert.equal(await pinNow(), false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(events.slice(before).includes("pin"), "the TV hears it's unlocked");
  // Back to the locked one needs the PIN.
  assert.deepEqual((await send("POST", "/api/viewer", { id: "radomir" })).data, { ok: false, error: "that needs the pin", pin: true });
  assert.equal((await send("POST", "/api/viewer", { id: "radomir" }, await grant())).status, 200);
  assert.equal(await pinNow(), false);

  // The TV off for a while locks only a profile that asks.
  assert.equal((await send("POST", "/api/pin/lock", { reason: "tv-off" })).data.locked, true);
  assert.equal((await send("POST", "/api/viewer", { id: mila.id })).status, 200, "to a child needs no PIN");
  assert.equal(await pinNow(), false);
  assert.equal((await send("POST", "/api/pin/lock", { reason: "tv-off" })).data.locked, false);
  // By hand, it locks whoever's watching, until the PIN.
  assert.equal((await send("POST", "/api/pin/lock")).data.locked, true);
  await grant();
  assert.equal(await pinNow(), false);

  // The PIN stays while a profile asks for it, children aside.
  assert.equal((await send("PUT", "/api/viewers/radomir", { locked: false }, await grant())).status, 200);
  assert.deepEqual((await viewers()).map((v) => v.locked), [false, false, false]);
});
