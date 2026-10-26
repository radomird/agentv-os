// The AI provider and its terms (daemon/ai.ts, ADR-022, ADR-023, S5.5):
// which provider, by plan or key, the terms an adult accepted on a phone
// before anything of it installs, kept with who, on which phone and when,
// and how the first run of its CLI went. And what the phone hears and may
// do in setup's AI step.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Ai, OFFERS, TERMS_READ } from "../../../daemon/ai.ts";
import { Daemon } from "../../../daemon/server.ts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-ai-"));
const state = join(scratch, "state");
let daemon: Daemon;
let url = "";
let lan = "";
let token = "";
const keyStatus = join(scratch, "key.json");

before(async () => {
  mkdirSync(join(scratch, "root", "setup"), { recursive: true });
  daemon = new Daemon({ root: join(scratch, "root"), state, port: 0, log: () => {}, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1", keyStatus, keyWaitMs: 2000 });
  url = `http://127.0.0.1:${await daemon.listen()}`;
  lan = `http://127.0.0.1:${daemon.lanPort}`;
  const code = (await (await post("/api/phones/pair", {})).json()).pairing.code;
  token = (await (await fetch(`${lan}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "iphone" }) })).json()).token;
});

after(async () => {
  await daemon.close();
  rmSync(scratch, { recursive: true, force: true });
});

const post = (path: string, body: unknown, grant?: string) =>
  fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: JSON.stringify(body) });
const phone = (path: string, body?: unknown, grant?: string) =>
  fetch(`${lan}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const phoneState = async () => (await phone("/api/phone/state")).json();

test("S5.5 Claude's terms are Anthropic's consumer terms for a plan and its commercial terms for a key, with its usage policy and Claude Code's legal notes", () => {
  assert.deepEqual(OFFERS.claude.terms.plan.map((t) => t.url), [
    "https://www.anthropic.com/legal/consumer-terms",
    "https://www.anthropic.com/legal/aup",
    "https://code.claude.com/docs/en/legal-and-compliance",
  ]);
  assert.deepEqual(OFFERS.claude.terms.key.map((t) => t.url), [
    "https://www.anthropic.com/legal/commercial-terms",
    "https://www.anthropic.com/legal/aup",
    "https://code.claude.com/docs/en/legal-and-compliance",
  ]);
  assert.equal(OFFERS.claude.cli, "claude");
  assert.equal(OFFERS.claude.plan.offered, true);
  assert.equal(OFFERS.chatgpt.plan.offered, false, "ChatGPT's plan waits for stage 6 to show a build runs on it");
  assert.equal(OFFERS.gemini.plan.offered, false, "Google's plan waits for its new CLI to run headless");
  for (const offer of Object.values(OFFERS)) for (const terms of Object.values(offer.terms)) for (const t of terms) assert.match(t.url, /^https:\/\//);
});

test("a plan is only where it's offered, and none clears the choice", async () => {
  const ai = new Ai({ state: join(scratch, "store") });
  assert.match((await ai.choose("chatgpt", "plan")).error ?? "", /coming soon/);
  assert.match((await ai.choose("copilot", "key")).error ?? "", /claude, chatgpt or gemini/);
  assert.match((await ai.choose("claude", "both")).error ?? "", /a plan or a key/);
  assert.deepEqual((await ai.choose("claude", "plan")).state, { provider: "claude", path: "plan", accepted: null, cli: null });
  assert.deepEqual((await ai.choose(null, undefined)).state, { provider: null, path: null, accepted: null, cli: null });
});

test("S5.5 an acceptance is for the terms the TV shows, kept with who, on which phone and when, and never taken back", async () => {
  const dir = join(scratch, "kept");
  const ai = new Ai({ state: dir });
  await ai.choose("claude", "key");
  assert.match((await ai.accept("claude", "plan", { phone: "iphone", viewer: "radomir" })).error ?? "", /aren't the terms the tv shows/);
  assert.match((await ai.accept("claude", "key", { phone: "iphone", viewer: "<script>" })).error ?? "", /who accepted/);
  const accepted = (await ai.accept("claude", "key", { phone: "iphone", viewer: "radomir" })).state!.accepted!;
  assert.deepEqual([accepted.provider, accepted.path, accepted.read, accepted.by], ["claude", "key", TERMS_READ, { phone: "iphone", viewer: "radomir" }]);
  assert.equal(accepted.terms[0].id, "anthropic-commercial-terms");
  assert.match(accepted.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
  // Picking a plan needs its own terms; back to the key, they're still accepted.
  assert.equal((await ai.choose("claude", "plan")).state!.accepted, null);
  assert.ok((await ai.choose("claude", "key")).state!.accepted);
  await ai.choose(null, undefined);
  assert.equal(JSON.parse(readFileSync(join(dir, "terms.json"), "utf8")).length, 1, "clearing the choice keeps the record");
});

test("S5.5 the CLI's first run is only heard about once its terms are accepted", async () => {
  const ai = new Ai({ state: join(scratch, "cli") });
  await ai.choose("gemini", "key");
  assert.match((await ai.setCli({ state: "installing" })).error ?? "", /aren't accepted yet/);
  await ai.accept("gemini", "key", { phone: "pixel", viewer: "ana" });
  assert.match((await ai.setCli({ state: "done" })).error ?? "", /installing, ready or failed/);
  const ready = (await ai.setCli({ state: "ready", version: "0.12.0\u0007" })).state!.cli!;
  assert.deepEqual([ready.state, ready.cli, ready.version], ["ready", "gemini", "0.12.0 "]);
});

test("S5.5 setup's AI step: the phone hears the terms to accept, an adult accepts them past the PIN, and the box records it", async () => {
  await post("/api/setup/finish", { step: "welcome" });
  await post("/api/setup/ready", { update: "none" });
  await post("/api/setup/finish", { step: "ready" });
  assert.equal((await phoneState()).ai, null, "nothing to ask until the TV picks a provider");
  assert.equal((await post("/api/ai", { provider: "claude", path: "plan" })).status, 200);
  const asked = (await phoneState()).ai;
  assert.deepEqual([asked.ask, asked.provider, asked.path, asked.name], ["terms", "claude", "plan", "claude"]);
  assert.equal(asked.terms[0].name, "anthropic's consumer terms");
  assert.match(asked.summary, /consumer terms/);

  // The key comes after the terms.
  assert.equal((await phone("/api/phone/key", { key: `sk-ant-${"k".repeat(40)}` })).status, 409);
  assert.equal((await phone("/api/phone/terms", { provider: "claude", path: "key" })).status, 400, "not the terms the TV shows");

  // With an adult PIN set, accepting needs it.
  assert.equal((await fetch(`${url}/api/pin`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "2468" }) })).status, 200);
  assert.equal((await phone("/api/phone/terms", { provider: "claude", path: "plan" })).status, 403);
  const grant = (await (await phone("/api/phone/pin", { pin: "2468" })).json()).grant;
  const accepted = await phone("/api/phone/terms", { provider: "claude", path: "plan" }, grant);
  assert.equal(accepted.status, 200);
  const record = (await (await fetch(`${url}/api/ai`)).json()).accepted;
  assert.equal(record.by.phone, "iphone");
  assert.equal(record.path, "plan");
  assert.equal((await phoneState()).ai, null, "a plan has no key to ask for");

  // A key, then: its own terms first, then the key, root's alone.
  await post("/api/ai", { provider: "claude", path: "key" }, grant);
  assert.equal((await phoneState()).ai.ask, "terms");
  await phone("/api/phone/terms", { provider: "claude", path: "key" }, grant);
  assert.equal((await phoneState()).ai.ask, "key");
  // Root's move, as agentv-key-store does it.
  const mover = setInterval(() => {
    try {
      const drop = JSON.parse(readFileSync(join(state, "key-drop", "key.json"), "utf8"));
      rmSync(join(state, "key-drop", "key.json"));
      writeFileSync(keyStatus, JSON.stringify({ set: true, provider: drop.provider, at: new Date().toISOString() }));
    } catch {
      // nothing dropped yet
    }
  }, 20);
  try {
    assert.equal((await phone("/api/phone/key", { key: `sk-ant-${"k".repeat(40)}` }, grant)).status, 200);
  } finally {
    clearInterval(mover);
  }
  assert.equal((await phoneState()).ai, null);
  assert.equal(JSON.parse(readFileSync(join(state, "terms.json"), "utf8")).length, 2);
  const history = JSON.stringify(JSON.parse(readFileSync(join(state, "terms.json"), "utf8")));
  assert.doesNotMatch(history, /sk-ant/, "no key in the record");
});

test("a child's profile can't accept the terms or give the key from a phone", async () => {
  const grant = (await (await phone("/api/phone/pin", { pin: "2468" })).json()).grant;
  const child = (await (await post("/api/viewers", { name: "mia", role: "child" }, grant)).json()).profile;
  await post("/api/viewer", { id: child.id }, grant);
  assert.equal((await phone("/api/phone/terms", { provider: "claude", path: "key" }, grant)).status, 403);
  assert.equal((await phone("/api/phone/key", { key: `sk-ant-${"k".repeat(40)}` }, grant)).status, 403);
  assert.equal((await post("/api/ai", { provider: "gemini", path: "key" })).status, 403, "nor pick the provider without the PIN");
});
