// The parent PIN (daemon/pin.ts, ADR-009, S4.5): only a hash kept, a wait
// after too many wrong tries, grants that run out, the TV locked after
// another boot and after it's been off, and the daemon refusing a guarded
// request without a grant.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { GRANT_MS, Pin } from "../../../daemon/pin.ts";
import { Daemon } from "../../../daemon/server.ts";

const dir = mkdtempSync(join(tmpdir(), "agentv-pin-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

// A PIN in its own file, on a clock and a boot the test moves on.
function box(needed: () => string | null = () => null) {
  const path = join(dir, `pin-${++n}.json`);
  const clock = { now: 1_800_000_000_000, boot: "boot-1" };
  const make = () => new Pin({ path, now: () => clock.now, bootId: () => clock.boot, needed });
  return { path, clock, pin: make(), make };
}

const granted = (checked: ReturnType<Pin["check"]>): string => {
  assert.equal(checked.ok, true, JSON.stringify(checked));
  return (checked as { grant: string }).grant;
};

test("S4.5 with no PIN set, nothing is guarded or locked", () => {
  const { pin } = box();
  assert.deepEqual(pin.status(), { set: false, locked: false, wait: 0 });
  assert.equal(pin.allows(undefined), true);
  assert.deepEqual(pin.check("1234"), { ok: false, error: "there's no pin yet" });
  assert.equal(pin.lock(), false);
  assert.equal(pin.remove(undefined), "there's no pin to remove");
});

test("S4.5 a PIN is 4 digits, kept only as a hash the user account can't read", () => {
  const { pin, path } = box();
  for (const bad of ["123", "12345", "abcd", 1234, null]) assert.equal(pin.set(bad, undefined), "a pin is 4 digits");
  assert.equal(pin.set("4826", undefined), null);
  // Set from the TV, so it isn't locked in this boot.
  assert.deepEqual(pin.status(), { set: true, locked: false, wait: 0 });
  const text = readFileSync(path, "utf8");
  assert.match(JSON.parse(text).hash, /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.doesNotMatch(text, /"4826"/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("S4.5 a guarded action needs a grant, which the right PIN gives and which runs out", () => {
  const { pin, clock } = box();
  pin.set("4826", undefined);
  assert.equal(pin.allows(undefined), false);
  assert.equal(pin.allows("made-up"), false);
  const grant = granted(pin.check("4826"));
  assert.equal(pin.allows(grant), true);
  clock.now += GRANT_MS - 1000;
  assert.equal(pin.allows(grant), true);
  clock.now += 2000;
  assert.equal(pin.allows(grant), false, "a grant lasts a few minutes");
});

test("S4.5 changing or taking off the PIN needs a grant, and a kid's profile keeps it on", () => {
  let kids = false;
  const { pin } = box(() => (kids ? "a kid's profile needs the pin, so it stays" : null));
  pin.set("4826", undefined);
  assert.equal(pin.set("1111", undefined), "that needs the pin");
  assert.equal(pin.remove("made-up"), "that needs the pin");
  const grant = granted(pin.check("4826"));
  assert.equal(pin.set("1111", grant), null);
  assert.equal(pin.check("4826").ok, false, "the old one is gone");
  kids = true;
  assert.equal(pin.remove(grant), "a kid's profile needs the pin, so it stays");
  kids = false;
  assert.equal(pin.remove(grant), null);
  assert.equal(pin.status().set, false);
  assert.equal(pin.allows(undefined), true);
});

test("S4.5 five wrong tries make it wait 30 s, each one after doubles it, and a restart doesn't reset it", () => {
  const { pin, clock, make } = box();
  pin.set("4826", undefined);
  const errors = ["0000", "0001", "0002", "0003"].map((wrong) => (pin.check(wrong) as { error: string }).error);
  assert.deepEqual(errors, ["that's not the pin", "that's not the pin", "that's not the pin. 2 more tries before a wait", "that's not the pin. 1 more try before a wait"]);
  assert.deepEqual(pin.check("0004"), { ok: false, error: "that's not the pin. try again in 30 s", wait: 30 });
  // Waiting, even the right one is refused, by a new daemon too.
  const again = make();
  assert.deepEqual(again.check("4826"), { ok: false, error: "too many tries. try again in 30 s", wait: 30 });
  assert.equal(again.status().wait, 30);
  clock.now += 30_000;
  assert.deepEqual(again.check("0005"), { ok: false, error: "that's not the pin. try again in 60 s", wait: 60 });
  clock.now += 60_000;
  granted(again.check("4826"));
  assert.deepEqual(again.check("0006"), { ok: false, error: "that's not the pin" }, "the right one starts the count again");
});

test("S4.5 the TV is locked after another boot, and after it's been off, until the PIN", () => {
  const { pin, clock, make } = box();
  pin.set("4826", undefined);
  const grant = granted(pin.check("4826"));
  // An update restarts the daemon in the same boot: still unlocked.
  assert.equal(make().status().locked, false);
  clock.boot = "boot-2";
  const booted = make();
  assert.equal(booted.status().locked, true);
  granted(booted.check("4826"));
  assert.equal(booted.status().locked, false);
  // The TV off for a while locks it, and ends every grant.
  assert.equal(pin.lock(), true);
  assert.equal(pin.status().locked, true);
  assert.equal(pin.allows(grant), false);
});

// --- The daemon's requests ---------------------------------------------------

test("S4.5 the daemon refuses a guarded request without the PIN's grant, and never logs the PIN", async () => {
  const lines: string[] = [];
  const clock = { boot: "boot-1" };
  const state = join(dir, "daemon");
  const daemon = new Daemon({ root: dir, state, builtins: null, port: 0, log: (line) => lines.push(line), running: "0.3.0-1", bootId: () => clock.boot });
  const port = await daemon.listen();
  const url = `http://127.0.0.1:${port}`;
  const send = async (method: string, path: string, body?: unknown, grant?: string) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
  };
  try {
    // What the TV hears: a pin event for each change.
    const events: string[] = [];
    const stream = await fetch(`${url}/api/events`);
    const reader = stream.body!.getReader();
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        for (const match of new TextDecoder().decode(value).matchAll(/event: (\w+)/g)) events.push(match[1]);
      }
    })().catch(() => {});

    // With no PIN, the guarded requests go ahead.
    assert.equal((await send("POST", "/api/updates/tonight", { version: "0.3.0" })).status, 200);
    assert.deepEqual((await send("GET", "/api/pin")).data, { ok: true, set: false, locked: false, wait: 0 });

    assert.equal((await send("PUT", "/api/pin", { pin: "48" })).status, 400);
    assert.deepEqual((await send("PUT", "/api/pin", { pin: "4826" })).data, { ok: true, set: true, locked: false, wait: 0 });
    assert.equal((await send("PUT", "/api/pin", { pin: "1111" })).status, 403, "another pin needs this one");

    // Installing tonight, and updating overnight, need it now.
    const refused = await send("POST", "/api/updates/tonight", { version: "0.3.1" });
    assert.deepEqual(refused, { status: 403, data: { ok: false, error: "that needs the pin", pin: true } });
    assert.equal((await send("POST", "/api/updates/tonight", { version: null })).status, 200, "clearing it after the night's install doesn't");
    assert.equal((await send("POST", "/api/settings", { updateOvernight: true })).status, 403);
    assert.equal((await send("POST", "/api/settings", { updateOvernight: false, reduceMotion: true })).status, 200, "a setting that isn't guarded doesn't");

    const wrong = await send("POST", "/api/pin/check", { pin: "0000" });
    assert.deepEqual(wrong, { status: 403, data: { ok: false, error: "that's not the pin" } });
    const right = await send("POST", "/api/pin/check", { pin: "4826" });
    assert.equal(right.status, 200);
    const grant = right.data.grant as string;
    assert.equal((await send("POST", "/api/updates/tonight", { version: "0.3.1" }, grant)).status, 200);
    assert.equal((await send("POST", "/api/settings", { updateOvernight: true }, grant)).status, 200);
    assert.equal((await send("POST", "/api/pin/allows", { grant })).status, 200);
    assert.equal((await send("POST", "/api/pin/allows", { grant: "made-up" })).status, 403);

    // Home says whether there's a PIN and whether the TV is locked.
    assert.deepEqual((await send("GET", "/api/home")).data.pin, { set: true, locked: false });
    assert.deepEqual((await send("POST", "/api/pin/lock")).data, { ok: true, set: true, locked: true, wait: 0 });
    assert.deepEqual((await send("GET", "/api/home")).data.pin, { set: true, locked: true });
    assert.equal((await send("POST", "/api/pin/allows", { grant })).status, 403, "locking ends the grant");
    const unlock = await send("POST", "/api/pin/check", { pin: "4826" });
    assert.equal((await send("GET", "/api/pin")).data.locked, false);
    assert.equal((await send("DELETE", "/api/pin", undefined, "made-up")).status, 403);
    assert.deepEqual((await send("DELETE", "/api/pin", undefined, unlock.data.grant as string)).data, { ok: true, set: false, locked: false, wait: 0 });

    // A page elsewhere can't try PINs.
    const elsewhere = await fetch(`${url}/api/pin/check`, { method: "POST", headers: { Origin: "https://example.org", "Content-Type": "application/json" }, body: '{"pin":"4826"}' });
    assert.equal(elsewhere.status, 403);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      events.filter((e) => e === "pin"),
      ["pin", "pin", "pin", "pin"],
      "set, locked, unlocked, taken off",
    );
    assert.ok(!lines.join("\n").includes("4826"), lines.join("\n"));
    assert.ok(lines.includes("a wrong pin"));
    assert.ok(lines.includes("refused install tonight: it needs the pin"));
    await reader.cancel();
  } finally {
    await daemon.close();
  }
});
