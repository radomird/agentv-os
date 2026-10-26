// Paired phones (daemon/phones.ts, stage 4) and the daemon's phone listener:
// a one-time code that pairs one phone, a token kept only as a hash, only the
// phone companion's page and requests on the home network, and the phone's
// keys and text reaching the screen daemon's stream, never its log.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CODE_MS, Phones } from "../../../daemon/phones.ts";
import { Daemon } from "../../../daemon/server.ts";

const ROOT = join(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "agentv-phones-"));
let n = 0;

test("a code is six letters and digits that don't look alike, and it pairs one phone", () => {
  const clock = { now: 1_800_000_000_000 };
  const phones = new Phones({ path: join(dir, `phones-${++n}.json`), now: () => clock.now });
  assert.deepEqual(phones.pair("ABCDEF", "x"), { error: "that code has run out: pair again from the tv" });
  const { code, until } = phones.code();
  assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(Date.parse(until) - clock.now, CODE_MS);
  assert.deepEqual(phones.showing(), { code, until });
  const paired = phones.pair(`${code.slice(0, 3).toLowerCase()}-${code.slice(3)}`, " Ana's iPhone ");
  assert.ok("token" in paired);
  assert.equal(paired.phone.name, "Ana's iPhone");
  assert.equal(phones.showing(), null, "the code is used up");
  assert.deepEqual(phones.pair(code, "again"), { error: "that code has run out: pair again from the tv" });
  // Only the token's hash is kept.
  const file = readFileSync(join(dir, `phones-${n}.json`), "utf8");
  assert.ok(!file.includes(paired.token));
  assert.deepEqual(phones.who(paired.token)?.id, paired.phone.id);
  assert.equal(phones.who("x".repeat(43)), null);
  assert.equal(phones.forget(paired.phone.id), true);
  assert.equal(phones.who(paired.token), null);
});

test("five wrong codes end the code, and so do 10 minutes", () => {
  const clock = { now: 1_800_000_000_000 };
  const phones = new Phones({ path: join(dir, `phones-${++n}.json`), now: () => clock.now });
  const { code } = phones.code();
  for (let i = 0; i < 5; i++) assert.deepEqual(phones.pair("ZZZZZZ", "x"), { error: "that isn't the code on the tv" });
  assert.deepEqual(phones.pair(code, "x"), { error: "that code has run out: pair again from the tv" });
  const next = phones.code().code;
  clock.now += CODE_MS;
  assert.deepEqual(phones.pair(next, "x"), { error: "that code has run out: pair again from the tv" });
});

// --- The daemon -------------------------------------------------------------------

let daemon: Daemon;
let tv = "";
let phone = "";
const lines: string[] = [];
const events: string[] = [];
const qrArgs = join(dir, "qr-args");

before(async () => {
  const qrencode = join(dir, "qrencode");
  writeFileSync(qrencode, `#!/bin/bash\necho "$*" >"${qrArgs}"\necho '<svg xmlns="http://www.w3.org/2000/svg"></svg>'\n`);
  chmodSync(qrencode, 0o755);
  daemon = new Daemon({
    root: ROOT,
    state: join(dir, "state"),
    builtins: null,
    port: 0,
    log: (line) => lines.push(line),
    running: "0.3.0-1",
    lanPort: 0,
    lanHost: "127.0.0.1",
    address: () => "192.168.1.20",
    qrencode,
    phoneWaitMs: 400,
  });
  tv = `http://127.0.0.1:${await daemon.listen()}`;
  phone = `http://127.0.0.1:${daemon.lanPort}`;
  const stream = await fetch(`${tv}/api/events`);
  const reader = stream.body!.getReader();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      for (const match of new TextDecoder().decode(value).matchAll(/event: (\w+)\ndata: (.*)/g)) events.push(`${match[1]} ${match[2]}`);
    }
  })().catch(() => {});
});

after(async () => {
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function send(base: string, method: string, path: string, options: { body?: unknown; token?: string; grant?: string; origin?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.grant ? { "X-AgenTV-Grant": options.grant } : {}),
      ...(options.origin ? { Origin: options.origin } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(text);
  } catch {
    // A page or a script.
  }
  return { status: response.status, type: response.headers.get("content-type") ?? "", text, data };
}

let token = "";

test("pairing: the TV shows a code and a QR code with the phone companion's address, and a phone sends the code back", async () => {
  assert.deepEqual((await send(tv, "GET", "/api/phones")).data, { ok: true, phones: [], pairing: null });
  assert.equal((await send(tv, "GET", "/api/phones/qr")).status, 404, "no code on show, no qr code");
  const { pairing } = (await send(tv, "POST", "/api/phones/pair")).data;
  assert.equal(pairing.url, `http://192.168.1.20:${daemon.lanPort}/?code=${pairing.code}`);
  const qr = await send(tv, "GET", "/api/phones/qr");
  assert.equal(qr.type, "image/svg+xml");
  assert.match(qr.text, /^<svg/);
  assert.equal(readFileSync(qrArgs, "utf8").trim(), `-t SVG -m 1 -o - ${pairing.url}`);

  assert.equal((await send(phone, "POST", "/api/phone/pair", { body: { code: "ZZZZZZ", name: "x" } })).status, 403);
  const paired = await send(phone, "POST", "/api/phone/pair", { body: { code: pairing.code, name: "android phone" } });
  assert.equal(paired.status, 200);
  token = paired.data.token;
  assert.equal(paired.data.phone.name, "android phone");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(events.includes('phones {"paired":"android phone"}'), "the TV hears it at once");
  const listed = (await send(tv, "GET", "/api/phones")).data;
  assert.deepEqual(listed.phones.map((p: any) => p.name), ["android phone"]);
  assert.equal(listed.pairing, null);
  assert.ok(!lines.join("\n").includes(token));
});

test("the home network gets only the phone companion: its page, its requests, and nothing of the TV's own", async () => {
  const page = await send(phone, "GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.text, /companion-web\/main\.ts/);
  const script = await send(phone, "GET", "/companion-web/main.ts");
  assert.equal(script.type, "text/javascript; charset=utf-8");
  assert.doesNotMatch(script.text, /: Promise<boolean>/, "served with its types stripped");
  assert.match((await send(phone, "GET", "/api/theme.css")).type, /text\/css/);
  // The TV's own requests and pages aren't served, paired or not.
  for (const path of ["/api/home", "/api/pin", "/api/key", "/api/remote", "/launcher/main.ts", "/companion-web/../daemon/pin.ts", "/health"]) {
    assert.ok([401, 404].includes((await send(phone, "GET", path)).status), path);
    assert.equal((await send(phone, "GET", path, { token: "x".repeat(43) })).status, 401, path);
  }
  assert.equal((await send(phone, "GET", "/api/phone/state")).status, 401, "a phone that isn't paired");
  const state = await send(phone, "GET", "/api/phone/state", { token });
  assert.equal(state.data.phone.name, "android phone");
  assert.equal(state.data.viewer.role, "adult");
  assert.equal((await send(phone, "POST", "/api/phone/remote", { token, body: { key: "up" }, origin: "https://evil.example" })).status, 403, "not from another site");
});

test("the phone's keys and text reach the screen daemon's stream, and what's typed is never logged", async () => {
  assert.deepEqual((await send(phone, "POST", "/api/phone/remote", { token, body: { key: "down" } })).data, { ok: false, error: "the tv session isn't on" });
  assert.equal((await send(tv, "GET", "/api/remote")).status, 403, "a page can't take the phone's keys");
  const controller = new AbortController();
  const stream = await fetch(`${tv}/api/remote`, { headers: { "X-AgenTV-Screen": "1" }, signal: controller.signal });
  const got: string[] = [];
  void (async () => {
    for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
      for (const match of new TextDecoder().decode(chunk).matchAll(/data: (.*)/g)) got.push(match[1]);
    }
  })().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const body of [{ key: "down" }, { key: "home-key" }, { hold: "back", ms: 99_999 }, { text: "hunter2 secret" }]) {
    assert.deepEqual((await send(phone, "POST", "/api/phone/remote", { token, body })).data, { ok: true }, JSON.stringify(body));
  }
  for (const body of [{ key: "Down; rm" }, { text: "" }, { text: "x".repeat(501) }, {}]) {
    assert.equal((await send(phone, "POST", "/api/phone/remote", { token, body })).status, 400, JSON.stringify(body));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(got, ['{"key":"down"}', '{"key":"home-key"}', '{"hold":"back","ms":3000}', '{"text":"hunter2 secret"}']);
  assert.ok(!lines.join("\n").includes("hunter2"));
  controller.abort();
});

test("the PIN on the phone gives a grant, which switching from a child to an adult needs", async () => {
  assert.equal((await send(tv, "PUT", "/api/pin", { body: { pin: "4826" } })).status, 200);
  const wrong = await send(phone, "POST", "/api/phone/pin", { token, body: { pin: "0000" } });
  assert.equal(wrong.status, 403);
  const grant = (await send(phone, "POST", "/api/phone/pin", { token, body: { pin: "4826" } })).data.grant;
  const child = (await send(tv, "POST", "/api/viewers", { body: { name: "mila", role: "child" }, grant })).data.profile;
  assert.equal((await send(phone, "POST", "/api/phone/viewer", { token, body: { id: child.id } })).status, 200);
  assert.equal((await send(phone, "GET", "/api/phone/state", { token })).data.viewer.id, child.id);
  const owner = (await send(phone, "GET", "/api/phone/state", { token })).data.viewers.find((v: any) => v.role === "adult");
  assert.equal((await send(phone, "POST", "/api/phone/viewer", { token, body: { id: owner.id } })).status, 403);
  assert.equal((await send(phone, "POST", "/api/phone/viewer", { token, body: { id: owner.id }, grant })).status, 200);
  assert.ok(lines.some((line) => line.endsWith("from android phone")));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("ADR-037 S4.10 the phone hears what's on the TV within a second: its ask waits for a change, and the remote's view follows", async () => {
  const first = (await send(phone, "GET", "/api/phone/state", { token })).data;
  assert.equal(first.tv.view, "remote");
  // An ask with the count it has waits, until the TV asks for the PIN.
  const started = Date.now();
  const waiting = send(phone, "GET", `/api/phone/state?since=${first.version}`, { token });
  await sleep(100);
  const pin = { title: "enter the adult pin", for: "for omarchy's desktop.", digits: 0, error: null };
  assert.equal((await send(tv, "POST", "/api/tv/context", { body: { pin } })).status, 200);
  const woke = (await waiting).data;
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
  assert.deepEqual([woke.tv.view, woke.tv.pin, woke.version > first.version], ["pin", pin, true]);
  // A text field, something playing (the screen daemon's word), and back.
  for (const [body, view] of [
    [{ pin: { ...pin, digits: 2 } }, "pin"],
    [{ pin: null, field: { kind: "number" } }, "keyboard"],
    [{ field: null, front: "app", playing: true }, "playback"],
    [{ front: "home", playing: false }, "remote"],
  ] as const) {
    await send(tv, "POST", "/api/tv/context", { body });
    assert.equal((await send(phone, "GET", "/api/phone/state", { token })).data.tv.view, view, JSON.stringify(body));
  }
  // What doesn't fit is left out, and no PIN is in it.
  await send(tv, "POST", "/api/tv/context", { body: { field: { kind: "<script>" }, screen: "nowhere", playing: "yes", pin: { for: 4 } } });
  const tidy = (await send(phone, "GET", "/api/phone/state", { token })).data.tv;
  assert.deepEqual([tidy.field, tidy.screen, tidy.playing, tidy.pin], [{ kind: "text" }, "home", false, null]);
  // An ask with an old count answers at once; one with nothing to wait for
  // answers after its wait.
  const now = (await send(phone, "GET", "/api/phone/state", { token })).data;
  let at = Date.now();
  await send(phone, "GET", `/api/phone/state?since=${now.version - 1}`, { token });
  assert.ok(Date.now() - at < 300);
  at = Date.now();
  assert.equal((await send(phone, "GET", `/api/phone/state?since=${now.version}`, { token })).data.version, now.version);
  assert.ok(Date.now() - at >= 350, "it waited");
  assert.equal((await send(tv, "POST", "/api/tv/context", { body: { playing: true }, origin: "https://evil.example" })).status, 403, "not from another site");
  assert.equal((await send(phone, "POST", "/api/tv/context", { token, body: { playing: true } })).status, 404, "nor from a phone");
  await send(tv, "POST", "/api/tv/context", { body: { field: null } });
});

test("ADR-037 the trackpad's moves, clicks and scrolls reach the stream, Omarchy's desktop's relay makes it the trackpad, and Settings opens on the TV for an adult", async () => {
  const controller = new AbortController();
  const stream = await fetch(`${tv}/api/remote`, { headers: { "X-AgenTV-Screen": "desktop" }, signal: controller.signal });
  const got: string[] = [];
  void (async () => {
    for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
      for (const match of new TextDecoder().decode(chunk).matchAll(/data: (.*)/g)) got.push(match[1]);
    }
  })().catch(() => {});
  await sleep(30);
  assert.deepEqual([(await send(phone, "GET", "/api/phone/state", { token })).data.tv.view, (await send(phone, "GET", "/api/phone/state", { token })).data.tv.desktop], ["trackpad", true]);
  for (const body of [{ move: [12, -7] }, { click: "left" }, { click: "right" }, { scroll: -3 }]) {
    assert.deepEqual((await send(phone, "POST", "/api/phone/remote", { token, body })).data, { ok: true }, JSON.stringify(body));
  }
  for (const body of [{ move: [1] }, { move: [1, "2"] }, { move: [99_999, 0] }, { click: "double" }, { scroll: 0 }, { scroll: 1.5 }]) {
    assert.equal((await send(phone, "POST", "/api/phone/remote", { token, body })).status, 400, JSON.stringify(body));
  }
  await sleep(30);
  assert.deepEqual(got, ['{"move":[12,-7]}', '{"click":"left"}', '{"click":"right"}', '{"scroll":-3}']);
  controller.abort();
  await sleep(50);
  assert.equal((await send(phone, "GET", "/api/phone/state", { token })).data.tv.view, "remote", "the desktop's gone");

  events.length = 0;
  assert.deepEqual((await send(phone, "POST", "/api/phone/settings", { token })).data, { ok: true });
  await sleep(30);
  assert.ok(events.includes('page {"route":"settings"}'), events.join("\n"));
  // A child's profile has no Settings.
  const state = (await send(phone, "GET", "/api/phone/state", { token })).data;
  const child = state.viewers.find((v: any) => v.role === "child");
  const adult = state.viewer;
  assert.equal((await send(phone, "POST", "/api/phone/viewer", { token, body: { id: child.id } })).status, 200);
  assert.equal((await send(phone, "POST", "/api/phone/settings", { token })).status, 403);
  const grant = (await send(phone, "POST", "/api/phone/pin", { token, body: { pin: "4826" } })).data.grant;
  assert.equal((await send(phone, "POST", "/api/phone/viewer", { token, body: { id: adult.id }, grant })).status, 200);
});

test("S4.7 S4.8 S4.9 the phone arranges home, hears about an update, and signs in on the TV's sign-in screen", async () => {
  // Back to an adult, so arranging home needs no PIN.
  const grant = (await send(phone, "POST", "/api/phone/pin", { token, body: { pin: "4826" } })).data.grant;
  const owner = (await send(phone, "GET", "/api/phone/state", { token })).data.viewers.find((v: any) => v.role === "adult");
  await send(phone, "POST", "/api/phone/viewer", { token, body: { id: owner.id }, grant });
  const home = (await send(phone, "GET", "/api/phone/home", { token })).data;
  assert.equal(home.appsTile, "apps");
  assert.deepEqual(home.layout, [{ id: "apps", x: 0, y: 0, size: "s" }]);
  const before = events.length;
  const moved = await send(phone, "PUT", "/api/phone/layout", { token, body: { layout: [{ id: "apps", x: 3, y: 2, size: "s" }] } });
  assert.deepEqual(moved.data.layout, [{ id: "apps", x: 3, y: 2, size: "s" }]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(events.slice(before).some((e) => e.startsWith("layout ")), "the TV hears it at once");
  assert.equal((await send(phone, "PUT", "/api/phone/layout", { token, body: { layout: [{ id: "apps", x: 9, y: 9, size: "s" }] } })).status, 400);

  // No update, no notice.
  assert.equal((await send(phone, "GET", "/api/phone/state", { token })).data.update, null);
  assert.equal((await send(phone, "POST", "/api/phone/updates/later", { token })).status, 404);

  // Nothing signing in on the TV: the phone's fields aren't offered.
  assert.equal((await send(phone, "GET", "/api/phone/state", { token })).data.signIn, null);
  assert.equal((await send(phone, "POST", "/api/phone/sign-in", { token, body: { username: "a@b.c", password: "pw" } })).status, 409);
  assert.equal((await send(tv, "POST", "/api/sign-in-screen", { body: { app: "agentv.tube", name: "Tube" } })).status, 200);
  assert.deepEqual((await send(phone, "GET", "/api/phone/state", { token })).data.signIn, { name: "Tube" });
  const controller = new AbortController();
  const stream = await fetch(`${tv}/api/remote`, { headers: { "X-AgenTV-Screen": "1" }, signal: controller.signal });
  const got: string[] = [];
  void (async () => {
    for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
      for (const match of new TextDecoder().decode(chunk).matchAll(/data: (.*)/g)) got.push(match[1]);
    }
  })().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await send(phone, "POST", "/api/phone/sign-in", { token, body: { username: "ana@example.org", password: "" } })).status, 400);
  assert.deepEqual((await send(phone, "POST", "/api/phone/sign-in", { token, body: { username: "ana@example.org", password: "correct horse" } })).data, { ok: true });
  // Install now from the phone goes to the TV session, past the PIN.
  assert.equal((await send(phone, "POST", "/api/phone/updates/install", { token })).status, 403);
  assert.equal((await send(phone, "POST", "/api/phone/updates/install", { token, grant })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(got, ['{"text":"ana@example.org"}', '{"key":"tab"}', '{"text":"correct horse"}', '{"key":"enter"}', '{"cmd":"update-install"}']);
  assert.ok(!lines.join("\n").includes("correct horse") && !lines.join("\n").includes("ana@example.org"));
  await send(tv, "POST", "/api/sign-in-screen", { body: { app: null } });
  assert.equal((await send(phone, "GET", "/api/phone/state", { token })).data.signIn, null);
  controller.abort();
});

test("a phone Settings forgets can't do anything any more", async () => {
  const id = (await send(tv, "GET", "/api/phones")).data.phones[0].id;
  assert.equal((await send(tv, "DELETE", `/api/phones/${id}`)).status, 200);
  assert.equal((await send(phone, "GET", "/api/phone/state", { token })).status, 401);
  assert.equal((await send(phone, "POST", "/api/phone/remote", { token, body: { key: "up" } })).status, 401);
});
