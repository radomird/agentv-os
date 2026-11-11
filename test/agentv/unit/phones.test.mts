// Paired phones (daemon/phones.ts, stage 4) and the daemon's phone listener:
// a one-time code that pairs one phone, a key of the phone's own that never
// crosses the network, only the phone companion's page and requests on the
// home network, and the phone's keys and text reaching the screen daemon's
// stream, never its log. The signing and sealing themselves are in
// phone-channel.test.mts.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { x25519Pair } from "../../../daemon/phone-channel.ts";
import { CODE_MS, Phones } from "../../../daemon/phones.ts";
import { Daemon } from "../../../daemon/server.ts";
import { pairPhone, type TestPhone } from "./phone-client.mts";

const ROOT = join(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "agentv-phones-"));
let n = 0;

// What a phone sends to pair: a public key, and proof of the secret or the
// code, worked out here as the page does.
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
function asking(k: string | Buffer, name = "x", key: Uint8Array = x25519Pair().public) {
  return { key: b64u(key), name, proof: b64u(createHmac("sha256", k).update("agentv pair v1").update(key).digest()) };
}

test("a code is six letters and digits that don't look alike, and it pairs one phone", () => {
  const clock = { now: 1_800_000_000_000 };
  const phones = new Phones({ path: join(dir, `phones-${++n}.json`), now: () => clock.now });
  assert.deepEqual(phones.pair(asking("ABCDEF")), { error: "that code has run out: pair again from the tv" });
  assert.equal(phones.secret(), null);
  const { code, until } = phones.code();
  assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(Date.parse(until) - clock.now, CODE_MS);
  assert.deepEqual(phones.showing(), { code, until }, "the secret isn't shown with the code");
  assert.equal(Buffer.from(phones.secret()!, "base64url").length, 16, "a 128-bit secret for the QR code");
  const paired = phones.pair(asking(code, " Ana's iPhone "));
  assert.ok("id" in paired);
  assert.equal(paired.phone.name, "Ana's iPhone");
  assert.equal(phones.showing(), null, "the code is used up");
  assert.equal(phones.secret(), null);
  assert.deepEqual(phones.pair(asking(code, "again")), { error: "that code has run out: pair again from the tv" });
  // The phone's key is kept, in a file only the daemon reads.
  const path = join(dir, `phones-${n}.json`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const stored = JSON.parse(readFileSync(path, "utf8")).phones[0];
  assert.equal(Buffer.from(stored.key, "base64").length, 32);
  assert.equal(stored.token, undefined);
  assert.deepEqual(phones.key(paired.id)?.phone.id, paired.phone.id);
  assert.equal(phones.key("p-00000000"), null);
  assert.ok(!JSON.stringify(phones.list()).includes(stored.key), "the list has no keys");
  assert.equal(phones.forget(paired.phone.id), true);
  assert.equal(phones.key(paired.id), null);
});

test("F1 the QR code's secret pairs a phone too, and the code itself is no proof", () => {
  const phones = new Phones({ path: join(dir, `phones-${++n}.json`) });
  const { code } = phones.code();
  const secret = Buffer.from(phones.secret()!, "base64url");
  // Sending the code as the old page did is a wrong try, not a pairing.
  assert.deepEqual(phones.pair({ code, name: "x" } as any), { error: "that isn't the code on the tv" });
  assert.deepEqual(phones.pair({ ...asking(code), proof: b64u(Buffer.from(code)) }), { error: "that isn't the code on the tv" });
  // A proof made for another key doesn't carry over.
  assert.deepEqual(phones.pair({ ...asking(secret), key: b64u(x25519Pair().public) }), { error: "that isn't the code on the tv" });
  const paired = phones.pair(asking(secret, "by qr"));
  assert.ok("id" in paired, JSON.stringify(paired));
  assert.equal(Buffer.from(paired.key, "base64url").length, 32);
});

test("F1 a public key that shares nothing is refused, and counts as a try", () => {
  const phones = new Phones({ path: join(dir, `phones-${++n}.json`) });
  const { code } = phones.code();
  for (const key of [new Uint8Array(32), Uint8Array.from([1, ...new Uint8Array(31)])]) {
    assert.deepEqual(phones.pair(asking(code, "x", key)), { error: "that isn't the code on the tv" });
  }
  assert.deepEqual(phones.pair(asking(code, "x", randomBytes(31))), { error: "that isn't the code on the tv" });
  assert.equal(phones.list().length, 0);
  // Three tries are gone: two more end the code.
  phones.pair(asking("ZZZZZZ"));
  phones.pair(asking("ZZZZZZ"));
  assert.deepEqual(phones.pair(asking(code)), { error: "that code has run out: pair again from the tv" });
});

test("H7 a phone's name is one line: control characters are left out", () => {
  const phones = new Phones({ path: join(dir, `phones-${++n}.json`) });
  const named = phones.pair(asking(phones.code().code, "ana\n\u001b[2K is paired\u007f\u0000"));
  assert.ok("id" in named);
  assert.equal(named.phone.name, "ana[2K is paired");
  const blank = phones.pair(asking(phones.code().code, "\n\t "));
  assert.ok("id" in blank);
  assert.equal(blank.phone.name, "a phone");
});

test("five wrong proofs end the code, and so do 10 minutes", () => {
  const clock = { now: 1_800_000_000_000 };
  const phones = new Phones({ path: join(dir, `phones-${++n}.json`), now: () => clock.now });
  const { code } = phones.code();
  const secret = Buffer.from(phones.secret()!, "base64url");
  for (let i = 0; i < 5; i++) assert.deepEqual(phones.pair(asking(i % 2 ? "ZZZZZZ" : randomBytes(16))), { error: "that isn't the code on the tv" });
  assert.deepEqual(phones.pair(asking(code)), { error: "that code has run out: pair again from the tv" });
  assert.deepEqual(phones.pair(asking(secret)), { error: "that code has run out: pair again from the tv" });
  const next = phones.code().code;
  clock.now += CODE_MS;
  assert.deepEqual(phones.pair(asking(next)), { error: "that code has run out: pair again from the tv" });
});

test("F1 a phone stored without a key (paired before phones had keys) is gone from the file once it's read", () => {
  const path = join(dir, `phones-${++n}.json`);
  const old = { id: "p-0badc0de", name: "old phone", pairedAt: "2026-10-01T00:00:00.000Z", token: "ab".repeat(32) };
  writeFileSync(path, JSON.stringify({ phones: [old] }));
  const phones = new Phones({ path });
  assert.equal(phones.key(old.id), null);
  assert.deepEqual(phones.list(), []);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { phones: [] });
  // One with a key stays when another goes.
  const paired = phones.pair(asking(phones.code().code, "new phone"));
  assert.ok("id" in paired);
  const kept = JSON.parse(readFileSync(path, "utf8")).phones;
  writeFileSync(path, JSON.stringify({ phones: [old, ...kept, { ...old, id: "p-0badc0df", key: "c2hvcnQ=" }] }));
  assert.deepEqual(phones.list().map((phone) => phone.name), ["new phone"]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).phones, kept);
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
  // These are the phase 1 remote's, arranging phase 1's home, so the new
  // remote and the looks are turned off. Those have their own tests
  // (remote2.test.mts, typing.test.mts, looks.test.mts).
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "state", "features.json"), JSON.stringify({ remote2: false, looks: false }));
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
  // The daemon's first look at the builds tells the phones something
  // changed, two seconds in. It's had here, so it can't land in a test that
  // counts the changes.
  await (daemon as unknown as { watchBuilds(): Promise<void> }).watchBuilds();
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

// A request to the TV's own port or the phone port. With `token`, it's the
// paired phone's: signed and sealed, and its answer opened.
async function send(base: string, method: string, path: string, options: { body?: unknown; token?: TestPhone; grant?: string; origin?: string } = {}) {
  const init = {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.grant ? { "X-AgenTV-Grant": options.grant } : {}),
      ...(options.origin ? { Origin: options.origin } : {}),
    } as Record<string, string>,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };
  const response = options.token ? await options.token.fetch(path, init) : await fetch(`${base}${path}`, init);
  const text = await response.text();
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(text);
  } catch {
    // A page or a script.
  }
  return { status: response.status, type: response.headers.get("content-type") ?? "", text, data };
}

let token: TestPhone;

test("F6 with no PIN set, pairing a phone and forgetting one ask for nothing", async () => {
  assert.equal((await send(tv, "POST", "/api/setup", { body: { done: true } })).status, 200);
  const made = await send(tv, "POST", "/api/phones/pair");
  assert.equal(made.status, 200);
  const paired = await pairPhone(phone, made.data.pairing.code, "a guest's");
  const forgot = await send(tv, "DELETE", `/api/phones/${paired.kept.id}`);
  assert.equal(forgot.status, 200);
  assert.deepEqual(forgot.data, { ok: true, phones: [] });
  assert.ok(!lines.join("\n").includes("needs the pin"));
  lines.length = 0;
  events.length = 0;
});

test("pairing: the TV shows a code and a QR code with the phone companion's address, and a phone sends the code back", async () => {
  assert.deepEqual((await send(tv, "GET", "/api/phones")).data, { ok: true, phones: [], pairing: null });
  assert.equal((await send(tv, "GET", "/api/phones/qr")).status, 404, "no code on show, no qr code");
  const { pairing } = (await send(tv, "POST", "/api/phones/pair")).data;
  // The address the TV shows as text has neither the code nor the secret.
  assert.equal(pairing.url, `http://192.168.1.20:${daemon.lanPort}/`);
  assert.deepEqual(Object.keys(pairing).sort(), ["code", "until", "url"]);
  const qr = await send(tv, "GET", "/api/phones/qr");
  assert.equal(qr.type, "image/svg+xml");
  assert.match(qr.text, /^<svg/);
  // The QR code has the secret after the #, and not the code.
  const secret = daemon.phones.secret()!;
  assert.match(secret, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(readFileSync(qrArgs, "utf8").trim(), `-t SVG -m 1 -o - -- ${pairing.url}#pair=${secret}`, "H8: the text can't be read as an option");

  assert.equal((await send(phone, "POST", "/api/phone/pair", { body: asking("ZZZZZZ") })).status, 403);
  // The code itself, sent as the page once did, pairs nothing.
  assert.equal((await send(phone, "POST", "/api/phone/pair", { body: { code: pairing.code, name: "x" } })).status, 403);
  token = await pairPhone(phone, { secret }, "android phone");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(events.includes('phones {"paired":"android phone"}'), "the TV hears it at once");
  const listed = (await send(tv, "GET", "/api/phones")).data;
  assert.deepEqual(listed.phones.map((p: any) => p.name), ["android phone"]);
  assert.equal(listed.pairing, null);
  assert.ok(!lines.join("\n").includes(secret) && !lines.join("\n").includes(pairing.code), "neither is logged");
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
    assert.ok([401, 404].includes((await send(phone, "GET", path, { token })).status), path);
  }
  assert.equal((await send(phone, "GET", "/api/phone/state")).status, 401, "a phone that isn't paired");
  const state = await send(phone, "GET", "/api/phone/state", { token });
  assert.equal(state.data.phone.name, "android phone");
  assert.equal(state.data.viewer.role, "adult");
  // The box says no before it reads the signature, so that answer isn't
  // sealed, and the phone's own client wouldn't take it.
  const signed = token.sign("POST", "/api/phone/remote", { key: "up" });
  const elsewhere = await fetch(`${phone}/api/phone/remote`, { method: "POST", headers: { ...signed.headers, Origin: "https://evil.example" }, body: new Uint8Array(signed.body!) });
  assert.equal(elsewhere.status, 403, "not from another site");
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
  const onTv = (await send(tv, "POST", "/api/pin/check", { body: { pin: "4826" } })).data.grant;
  const child = (await send(tv, "POST", "/api/viewers", { body: { name: "mila", role: "child" }, grant: onTv })).data.profile;
  assert.equal((await send(phone, "POST", "/api/phone/viewer", { token, body: { id: child.id } })).status, 200);
  assert.equal((await send(phone, "GET", "/api/phone/state", { token })).data.viewer.id, child.id);
  const owner = (await send(phone, "GET", "/api/phone/state", { token })).data.viewers.find((v: any) => v.role === "adult");
  assert.equal((await send(phone, "POST", "/api/phone/viewer", { token, body: { id: owner.id } })).status, 403);
  assert.equal((await send(phone, "POST", "/api/phone/viewer", { token, body: { id: owner.id }, grant })).status, 200);
  assert.ok(lines.some((line) => line.endsWith("from android phone")));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("F9 a phone's wrong PINs make only that phone wait, not the TV or another phone", async () => {
  const grant = (await send(tv, "POST", "/api/pin/check", { body: { pin: "4826" } })).data.grant;
  const code = (await send(tv, "POST", "/api/phones/pair", { grant })).data.pairing.code;
  const other = await pairPhone(phone, code, "second phone");
  for (let i = 0; i < 5; i++) assert.equal((await send(phone, "POST", "/api/phone/pin", { token: other, body: { pin: "0000" } })).status, 403);
  const waiting = await send(phone, "POST", "/api/phone/pin", { token: other, body: { pin: "4826" } });
  assert.equal(waiting.status, 403, "that phone waits, even with the right one");
  assert.match(waiting.data.error, /^too many tries/);
  assert.equal((await send(tv, "POST", "/api/pin/check", { body: { pin: "4826" } })).status, 200, "the tv's pad doesn't");
  assert.equal((await send(phone, "POST", "/api/phone/pin", { token, body: { pin: "4826" } })).status, 200, "and neither does another phone");
  assert.equal((await send(tv, "DELETE", `/api/phones/${other.kept.id}`, { grant })).status, 200);
});

test("a PIN's grant is for whoever entered it: another phone can't use it, a phone can't use the TV's, and the TV can't use a phone's", async () => {
  const mine = (await send(phone, "POST", "/api/phone/pin", { token, body: { pin: "4826" } })).data.grant;
  const onTv = (await send(tv, "POST", "/api/pin/check", { body: { pin: "4826" } })).data.grant;
  const code = (await send(tv, "POST", "/api/phones/pair", { grant: onTv })).data.pairing.code;
  const other = await pairPhone(phone, code, "second phone");
  const state = (await send(phone, "GET", "/api/phone/state", { token })).data;
  const child = state.viewers.find((v: any) => v.role === "child");
  const adult = state.viewers.find((v: any) => v.role === "adult");
  const toChild = async () => assert.equal((await send(phone, "POST", "/api/phone/viewer", { token, body: { id: child.id } })).status, 200);
  const needsPin = (answer: { status: number; data: Record<string, any> }, what: string) => assert.deepEqual([answer.status, answer.data.error, answer.data.pin], [403, "that needs the pin", true], what);

  // Back to the adult takes the PIN, on the phone and on the TV.
  await toChild();
  needsPin(await send(phone, "POST", "/api/phone/viewer", { token: other, body: { id: adult.id }, grant: mine }), "another phone, with the first one's grant");
  needsPin(await send(phone, "POST", "/api/phone/viewer", { token: other, body: { id: adult.id }, grant: onTv }), "a phone, with the TV's grant");
  needsPin(await send(phone, "POST", "/api/phone/viewer", { token, body: { id: adult.id }, grant: onTv }), "the first phone, with the TV's grant");
  needsPin(await send(tv, "POST", "/api/viewer", { body: { id: adult.id }, grant: mine }), "the TV, with a phone's grant");
  assert.equal((await send(tv, "POST", "/api/pin/allows", { body: { grant: mine } })).status, 403, "nor for the TV's own checks");
  assert.equal((await send(phone, "GET", "/api/phone/state", { token })).data.viewer.id, child.id, "nothing changed");

  assert.equal((await send(phone, "POST", "/api/phone/viewer", { token, body: { id: adult.id }, grant: mine })).status, 200, "the phone that entered it");
  await toChild();
  const theirs = (await send(phone, "POST", "/api/phone/pin", { token: other, body: { pin: "4826" } })).data.grant;
  assert.equal((await send(phone, "POST", "/api/phone/viewer", { token: other, body: { id: adult.id }, grant: theirs })).status, 200, "the other phone, with its own");
  await toChild();
  assert.equal((await send(tv, "POST", "/api/viewer", { body: { id: adult.id }, grant: onTv })).status, 200, "the TV's pages, with the TV's");
  assert.equal((await send(tv, "POST", "/api/pin/allows", { body: { grant: onTv } })).status, 200);
  assert.equal((await send(tv, "DELETE", `/api/phones/${other.kept.id}`, { grant: onTv })).status, 200);
});

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

test("ADR-037 a change while the phone's state is read leaves it a count behind, so its next ask answers at once", async () => {
  // Who's watching is read first; the TV changes before the rest is.
  const active = daemon.profiles.active.bind(daemon.profiles);
  let changed = false;
  daemon.profiles.active = async () => {
    const viewer = await active();
    if (!changed) {
      changed = true;
      await send(tv, "POST", "/api/tv/context", { body: { playing: true } });
    }
    return viewer;
  };
  try {
    const read = (await send(phone, "GET", "/api/phone/state", { token })).data;
    assert.ok(changed);
    const at = Date.now();
    const next = (await send(phone, "GET", `/api/phone/state?since=${read.version}`, { token })).data;
    assert.ok(Date.now() - at < 300, `it waited ${Date.now() - at} ms`);
    assert.ok(next.version > read.version);
  } finally {
    daemon.profiles.active = active;
    await send(tv, "POST", "/api/tv/context", { body: { playing: false } });
  }
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
  // F6: a PIN is set by now, so pairing and forgetting need its grant.
  const refused = await send(tv, "DELETE", `/api/phones/${id}`);
  assert.equal(refused.status, 403);
  assert.equal(refused.data.pin, true);
  assert.equal((await send(tv, "POST", "/api/phones/pair")).status, 403);
  assert.equal((await send(tv, "GET", "/api/phones")).data.pairing, null, "and no code came on show");
  // Setup shows a code on its own screens, so until it's done a code comes
  // without the PIN. Forgetting isn't part of setup. And starting setup
  // again needs the PIN itself, or it would be a way round it.
  assert.equal((await send(tv, "POST", "/api/setup", { body: { done: false } })).status, 403);
  assert.equal((await send(tv, "POST", "/api/phones/pair")).status, 403, "so still no code without the PIN");
  const grant = (await send(tv, "POST", "/api/pin/check", { body: { pin: "4826" } })).data.grant;
  assert.equal((await send(tv, "POST", "/api/setup", { body: { done: false }, grant })).status, 200);
  assert.equal((await send(tv, "POST", "/api/phones/pair")).status, 200);
  assert.equal((await send(tv, "DELETE", `/api/phones/${id}`)).status, 403);
  assert.equal((await send(tv, "POST", "/api/setup", { body: { done: true } })).status, 200);
  assert.equal((await send(tv, "POST", "/api/phones/pair", { grant })).status, 200);
  assert.equal((await send(tv, "DELETE", `/api/phones/${id}`, { grant })).status, 200);
  assert.equal((await send(phone, "GET", "/api/phone/state", { token })).status, 401);
  assert.equal((await send(phone, "POST", "/api/phone/remote", { token, body: { key: "up" } })).status, 401);
  assert.equal((await token.hello()), false, "nor open a session");
});
