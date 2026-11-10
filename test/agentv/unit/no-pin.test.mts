// No PIN, no PIN asked (ADR-087): with no adult PIN chosen, or with it taken
// off, the daemon lets every guarded and adult-only request through, and
// nothing it answers asks for a PIN or names one. The list of requests is
// the daemon's own guards (guarded() and adult() in daemon/server.ts and its
// routes), on the TV's port and the phone's. Each is shown to be guarded
// first, by sending it with a PIN set and no grant.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Ledger } from "../../../daemon/ledger.ts";
import { Profiles } from "../../../daemon/profiles.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "../ui/box.mts";

const dir = mkdtempSync(join(tmpdir(), "agentv-no-pin-"));
const passwd = join(dir, "passwd");
writeFileSync(passwd, "root:x:0:0::/root:/bin/bash\nradomir:x:1000:1000::/home/radomir:/bin/bash\n");
const PIN = "4826";

let daemon: Daemon;
let url = "";
let lan = "";
let state = "";
let token = "";

type Reply = { status: number; data: Record<string, any> };

async function send(method: string, path: string, body?: unknown, options: { grant?: string; phone?: boolean } = {}): Promise<Reply> {
  const response = await fetch(`${options.phone ? lan : url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.grant ? { "X-AgenTV-Grant": options.grant } : {}),
      ...(options.phone ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json().catch(() => ({}))) as Record<string, any> };
}

const grant = async () => (await send("POST", "/api/pin/check", { pin: PIN })).data.grant as string;

before(async () => {
  process.env.AGENTV_PASSWD = passwd;
  ({ daemon, url, state } = await startBox());
  lan = `http://127.0.0.1:${daemon.lanPort}`;
  const code = (await send("POST", "/api/phones/pair", {})).data.pairing.code;
  token = (await send("POST", "/api/phone/pair", { code, name: "iphone" }, { phone: true })).data.token;
  assert.ok(token, "a phone is paired");
});

after(async () => {
  await daemon?.close();
  delete process.env.AGENTV_PASSWD;
  rmSync(dir, { recursive: true, force: true });
});

// Every request the daemon guards with the PIN (guarded()), or keeps for an
// adult past the PIN on a child's profile (adult()). What each sends only
// has to reach the guard: with no PIN it may still be refused for what it
// asks, as long as that's not for a PIN.
// A few need something real before their guard is reached (setup still
// running, a share, a password the TV manages): those are marked, sent all
// the same, and their own tests show them refused with a PIN set.
type Ask = { method: string; path: string; body?: unknown; phone?: boolean; needsMore?: true };
function asks(spare: string, adult: string): Ask[] {
  const tv: Ask[] = [
    // Profiles: adding, changing and taking off. The switch to an adult is
    // last, since it leaves the child's profile.
    { method: "POST", path: "/api/viewers", body: { name: `n${Math.random().toString(36).slice(2, 8)}`, role: "adult" } },
    { method: "PUT", path: `/api/viewers/${spare}`, body: { avatar: "cyan" } },
    // The key, the plan and the provider.
    { method: "PUT", path: "/api/key", body: { key: "sk-test-0000000000000000000000000000", provider: "claude" } },
    { method: "DELETE", path: "/api/key" },
    { method: "PUT", path: "/api/tmdb-key", body: { key: "0123456789abcdef".repeat(2) } },
    { method: "DELETE", path: "/api/tmdb-key" },
    { method: "PUT", path: "/api/ai/plan", body: { provider: "claude" } },
    { method: "POST", path: "/api/ai", body: { provider: "claude", path: "key" } },
    { method: "POST", path: "/api/ai/sign-in", body: {} },
    // Where the TV is, and the desktop's password.
    { method: "PUT", path: "/api/country", body: { country: "NL" } },
    { method: "PUT", path: "/api/setup/location", body: { country: "NL" } },
    { method: "PUT", path: "/api/desktop/password", body: { password: "a long enough password" }, needsMore: true },
    // Apps: adding, setting up, for children, the profile for children.
    { method: "POST", path: "/api/apps/add", body: { id: "agentv.steam" } },
    { method: "POST", path: "/api/setup/apps", body: { install: [] }, needsMore: true },
    { method: "POST", path: "/api/apps/agentv.sample/for-children", body: { on: true } },
    { method: "POST", path: "/api/apps/agentv.sample/setup", body: { settings: {} } },
    { method: "PUT", path: "/api/apps/agentv.sample/child-profile", body: { profile: "x" } },
    { method: "POST", path: "/api/apps/local.mytv/export", body: {} },
    { method: "POST", path: "/api/discover/pick", body: { id: "x" } },
    // Updates, sleep and the builder.
    { method: "POST", path: "/api/updates/tonight", body: { version: "9.9.9" } },
    { method: "POST", path: "/api/settings", body: { updateOvernight: true } },
    { method: "POST", path: "/api/settings", body: { sleepWhenOff: true } },
    { method: "POST", path: "/api/settings", body: { sounds: false } },
    { method: "PUT", path: "/api/builds/settings", body: { perBuild: 4 } },
    { method: "POST", path: "/api/builds/apps/local.mytv/rollback", body: {} },
    { method: "POST", path: "/api/builds/apps/local.mytv/remove", body: {} },
    // Home, the look and the backgrounds.
    { method: "PUT", path: "/api/layout", body: { layout: [] } },
    { method: "PUT", path: "/api/look", body: { look: "cinema" } },
    { method: "PUT", path: "/api/display", body: { size: "m" } },
    { method: "POST", path: "/api/weather", body: { name: "x" } },
    { method: "POST", path: "/api/backgrounds/art", body: {} },
    { method: "POST", path: "/api/backgrounds/folder", body: {} },
    { method: "POST", path: "/api/backgrounds/immich", body: {} },
    { method: "DELETE", path: "/api/backgrounds/0123456789abcdef" },
    { method: "POST", path: "/api/shared/none/background", body: {}, needsMore: true },
    { method: "DELETE", path: "/api/shared/none", needsMore: true },
    { method: "DELETE", path: `/api/viewers/${spare}` },
  ];
  const phone: Ask[] = [
    { method: "PUT", path: "/api/phone/layout", body: { layout: [] } },
    { method: "POST", path: "/api/phone/terms", body: { provider: "claude", path: "key" } },
    { method: "POST", path: "/api/phone/key", body: { key: "sk-test-0000000000000000000000000000" } },
    { method: "POST", path: "/api/phone/ai/sign-in/code", body: { code: "x" } },
    { method: "PUT", path: "/api/phone/location", body: { country: "NL" } },
    { method: "POST", path: "/api/phone/builds/b-none/approve", body: {} },
    { method: "POST", path: "/api/phone/builds/b-none/plan", body: {} },
    { method: "POST", path: "/api/phone/builds/b-none/code", body: { code: "x" } },
    { method: "POST", path: "/api/phone/apps/local.mytv/push", body: { repo: "someone/mytv" } },
    { method: "POST", path: "/api/phone/updates/tonight", body: { version: "9.9.9" } },
    { method: "POST", path: "/api/phone/updates/install", body: {} },
    { method: "POST", path: "/api/phone/viewer", body: { id: adult } },
  ].map((ask) => ({ ...ask, phone: true }));
  return [...tv, ...phone, { method: "POST", path: "/api/viewer", body: { id: adult } }];
}

const key = (ask: Ask) => `${ask.phone ? "phone " : ""}${ask.method} ${ask.path}${ask.body && Object.keys(ask.body as object).length === 1 && ask.path === "/api/settings" ? ` ${Object.keys(ask.body as object)[0]}` : ""}`.replace(/v-[0-9a-f]{8}/, "<id>");
const asksPin = (reply: Reply) => reply.data.pin === true || /\bpin\b/i.test(JSON.stringify(reply.data));

// The same list on an adult's profile and on a child's: which of them the
// answer to names a PIN.
type Found = Map<string, { pin: boolean; needsMore: boolean; replies: Reply[] }>;
async function walk(child: string, adult: string): Promise<Found> {
  const found: Found = new Map();
  for (const watching of [adult, child]) {
    const set = daemon.pin.status().set;
    assert.equal((await send("POST", "/api/viewer", { id: watching }, { grant: set ? await grant() : undefined })).status, 200);
    const spare = (await send("POST", "/api/viewers", { name: `spare ${watching === adult ? "a" : "b"}`, role: "adult" }, { grant: set ? await grant() : undefined })).data.profile.id as string;
    for (const ask of asks(spare, adult)) {
      const reply = await send(ask.method, ask.path, ask.body, { phone: ask.phone });
      const entry = found.get(key(ask)) ?? { pin: false, needsMore: ask.needsMore === true, replies: [] };
      entry.pin ||= asksPin(reply);
      entry.replies.push(reply);
      found.set(key(ask), entry);
    }
    // The spare is still there with a PIN set, where nothing took it off.
    await send("DELETE", `/api/viewers/${spare}`, undefined, { grant: set ? await grant() : undefined });
  }
  return found;
}

// No PIN, however the test before left it.
function noPin(): void {
  if (!daemon.pin.status().set) return;
  const checked = daemon.pin.check(PIN);
  assert.ok(checked.ok);
  assert.equal(daemon.pin.remove(checked.grant), null);
}

test("ADR-087 with no PIN, no guarded or adult-only request asks for one or names one, on the TV's port or the phone's, even on a child's profile", async () => {
  // A PIN and a child's profile first, to show each request is guarded.
  assert.equal((await send("PUT", "/api/pin", { pin: PIN })).status, 200);
  const mila = (await send("POST", "/api/viewers", { name: "mila", role: "child" }, { grant: await grant() })).data.profile.id as string;
  const guarded = await walk(mila, "radomir");
  const open = [...guarded].filter(([, entry]) => !entry.pin && !entry.needsMore).map(([name]) => name);
  assert.deepEqual(open, [], "with a PIN set, each of these is refused without it");

  // The PIN gone with the child's profile still there, as on a box whose
  // PIN file was lost: Settings won't take it off while a child's profile
  // needs it.
  const checked = daemon.pin.check(PIN);
  assert.ok(checked.ok);
  assert.equal(daemon.pin.remove(checked.grant), null);
  assert.deepEqual((await send("GET", "/api/pin")).data, { ok: true, set: false, locked: false, wait: 0 });

  const now = await walk(mila, "radomir");
  assert.equal(now.size, guarded.size);
  const asking = [...now].filter(([, entry]) => entry.pin).map(([name, entry]) => `${name}: ${JSON.stringify(entry.replies.map((r) => r.data))}`);
  assert.deepEqual(asking, [], "with no PIN, none of them asks for one or names one");

  // From a child's profile to an adult's, on the TV and on the phone:
  // nothing can stop it with no PIN, so nothing asks.
  for (const phone of [false, true]) {
    assert.equal((await send("POST", "/api/viewer", { id: mila })).status, 200);
    const back = await send("POST", phone ? "/api/phone/viewer" : "/api/viewer", { id: "radomir" }, { phone });
    assert.equal(back.status, 200, JSON.stringify(back.data));
    assert.equal((await send("GET", "/api/viewer")).data.viewer.id, "radomir");
  }
  // What the screens draw by says there's none, and a grant check passes.
  assert.deepEqual((await send("GET", "/api/home")).data.pin, { set: false, locked: false });
  assert.deepEqual((await send("GET", "/api/phone/state", undefined, { phone: true })).data.pin, { set: false, locked: false });
  assert.equal((await send("GET", "/api/setup")).data.pin, false);
  assert.deepEqual((await send("POST", "/api/pin/allows", {})).data, { ok: true });
  // Locking the TV does nothing, and the TV takes what's said to it.
  assert.equal((await send("POST", "/api/pin/lock")).data.locked, false);
  assert.equal((await send("POST", "/api/pin/lock", { reason: "tv-off" })).data.locked, false);
});

test("ADR-087 a PIN taken off in Settings leaves no lock behind: a locked profile is unlocked first, and then nothing asks", async () => {
  noPin();
  for (const viewer of (await send("GET", "/api/viewers")).data.viewers) if (viewer.id !== "radomir") await send("DELETE", `/api/viewers/${viewer.id}`);
  assert.equal((await send("PUT", "/api/pin", { pin: PIN })).status, 200);
  const ana = (await send("POST", "/api/viewers", { name: "ana", role: "adult", locked: true }, { grant: await grant() })).data.profile.id as string;
  assert.equal((await send("POST", "/api/viewer", { id: ana })).data.pin, true, "locked, it asks");
  // Settings says why the PIN stays, with the PIN still set.
  assert.deepEqual((await send("DELETE", "/api/pin", undefined, { grant: await grant() })).data, { ok: false, error: "a locked profile needs the pin. unlock it in settings → profiles first" });
  assert.equal((await send("PUT", `/api/viewers/${ana}`, { locked: false }, { grant: await grant() })).status, 200);
  assert.equal((await send("DELETE", "/api/pin", undefined, { grant: await grant() })).status, 200);
  assert.deepEqual((await send("GET", "/api/viewers")).data.viewers.map((v: any) => v.locked), [false, false]);
  assert.equal((await send("POST", "/api/viewer", { id: ana })).status, 200);
  assert.deepEqual((await send("GET", "/api/pin")).data, { ok: true, set: false, locked: false, wait: 0 });
  assert.equal((await send("POST", "/api/viewer", { id: "radomir" })).status, 200);
});

test("ADR-087 a lock left from a PIN that's gone doesn't show: no profile says it's locked, saving it works, and the next PIN doesn't bring the lock back", async () => {
  noPin();
  assert.equal((await send("PUT", "/api/pin", { pin: PIN })).status, 200);
  assert.equal((await send("PUT", "/api/viewers/radomir", { locked: true }, { grant: await grant() })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "viewer.json"), "utf8")).locked, ["radomir"]);
  // The PIN's file lost, with the lock still in the daemon's state.
  rmSync(join(state, "pin.json"));
  const viewers = (await send("GET", "/api/viewers")).data.viewers as any[];
  assert.deepEqual(viewers.map((v) => v.locked), viewers.map(() => false));
  assert.equal((await send("GET", "/api/home")).data.viewer.locked, false);
  assert.equal((await send("GET", "/api/phone/state", undefined, { phone: true })).data.viewers.some((v: any) => v.locked), false);
  // Its page saves as it is, with nothing about a PIN.
  assert.equal((await send("PUT", "/api/viewers/radomir", { name: "radomir", role: "adult", avatar: "blue" })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "viewer.json"), "utf8")).locked, ["radomir"], "kept, but not shown");
  // The next PIN starts with nothing locked.
  assert.equal((await send("PUT", "/api/pin", { pin: PIN })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "viewer.json"), "utf8")).locked, []);
  daemon.pin.lock(false);
  assert.deepEqual((await send("GET", "/api/pin")).data, { ok: true, set: true, locked: false, wait: 0 });
  const taken = daemon.pin.check(PIN);
  assert.ok(taken.ok);
  assert.equal(daemon.pin.remove(taken.grant), null);
});

test("ADR-087 profiles on their own: with no PIN none is locked, and with one a lock shows as before", async () => {
  let set = true;
  const ledger = new Ledger(":memory:");
  const profiles = new Profiles({ ledger: () => ledger, state: join(dir, "state-own"), passwd, pinSet: () => set });
  assert.equal((await profiles.edit("radomir", { locked: true })).profile!.locked, true);
  assert.equal((await profiles.list())[0].locked, true);
  assert.equal(await profiles.needPin(), "a locked profile needs the pin. unlock it in settings → profiles first");
  set = false;
  assert.equal((await profiles.list())[0].locked, false);
  assert.equal((await profiles.active()).locked, false);
  assert.equal(await profiles.needPin(), null);
  await profiles.unlockAll();
  set = true;
  assert.equal((await profiles.list())[0].locked, false, "a new PIN starts with nothing locked");
});
