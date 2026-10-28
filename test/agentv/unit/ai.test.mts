// The AI provider and its terms (daemon/ai.ts, ADR-022, ADR-023, ADR-047, S5.5):
// which provider, by plan or key, the terms an adult accepted on a phone
// before anything of it installs, kept with who, on which phone and when,
// and how the first run of its CLI went. And what the phone hears and may
// do in setup's AI step.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Ai, OFFERS, offersOn, TERMS_READ } from "../../../daemon/ai.ts";
import { Daemon } from "../../../daemon/server.ts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-ai-"));
const state = join(scratch, "state");
let daemon: Daemon;
let url = "";
let lan = "";
let token = "";
const keyStatus = join(scratch, "key.json");
// The channel, as agentv channel keeps it: none, so stable, until a test
// puts the box on edge.
const channelFile = join(scratch, "channel");

before(async () => {
  mkdirSync(join(scratch, "root", "setup"), { recursive: true });
  daemon = new Daemon({ root: join(scratch, "root"), state, port: 0, log: () => {}, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1", keyStatus, keyWaitMs: 2000, channelFile });
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

test("ADR-047 Grok's terms are xAI's consumer terms for a plan and its enterprise terms for a key, and Muse's the Meta Model API's, each with its acceptable use policy", () => {
  assert.deepEqual(OFFERS.grok.terms.plan.map((t) => t.url), ["https://x.ai/legal/terms-of-service", "https://x.ai/legal/acceptable-use-policy"]);
  assert.deepEqual(OFFERS.grok.terms.key.map((t) => t.url), ["https://x.ai/legal/terms-of-service-enterprise", "https://x.ai/legal/acceptable-use-policy"]);
  assert.deepEqual(OFFERS.muse.terms.plan.map((t) => t.url), [
    "https://dev.meta.ai/legal/terms-of-service",
    "https://www.facebook.com/legal/meta_subs_terms",
    "https://dev.meta.ai/legal/acceptable-use-policy",
  ]);
  assert.deepEqual(OFFERS.muse.terms.key.map((t) => t.url), ["https://dev.meta.ai/legal/terms-of-service", "https://dev.meta.ai/legal/acceptable-use-policy"]);
  assert.deepEqual([OFFERS.grok.cli, OFFERS.grok.cliName, OFFERS.muse.cli, OFFERS.muse.cliName], ["grok", "grok build", "muse", "muse code"]);
  assert.equal(OFFERS.grok.plan.offered, false, "on stable, a plan waits for a build to run on it headless on the NUC (ADR-053)");
  assert.equal(OFFERS.muse.plan.offered, false);
  assert.match(OFFERS.muse.plan.note ?? "", /meta managed account can only use a key/);
  // xAI's as read in a browser (Q133); the others' readings, and so their
  // acceptances, stand.
  assert.deepEqual([TERMS_READ.grok, TERMS_READ.muse, TERMS_READ.claude], ["2026-10-28", "2026-10-27", "2026-10-26"]);
});

test("a plan is only where it's offered, and none clears the choice", async () => {
  // A box with no channel is on stable.
  const ai = new Ai({ state: join(scratch, "store") });
  assert.match((await ai.choose("chatgpt", "plan")).error ?? "", /coming soon/);
  assert.match((await ai.choose("grok", "plan")).error ?? "", /supergrok or x premium\+ is coming soon/);
  assert.match((await ai.choose("muse", "plan")).error ?? "", /coming soon/);
  assert.match((await ai.choose("copilot", "key")).error ?? "", /claude, chatgpt, gemini, grok or muse/);
  assert.match((await ai.choose("claude", "both")).error ?? "", /a plan or a key/);
  assert.deepEqual((await ai.choose("claude", "plan")).state, { provider: "claude", path: "plan", accepted: null, cli: null });
  assert.deepEqual((await ai.choose(null, undefined)).state, { provider: null, path: null, accepted: null, cli: null });
});

test("ADR-053 on edge, ChatGPT's and grok's plans are offered as best effort; on stable they're coming soon, and Muse's and Google's are on neither", async () => {
  for (const channel of ["stable", "dev", "edge"]) {
    const offers = offersOn(channel);
    const edge = channel === "edge";
    assert.deepEqual([offers.claude.plan.offered, offers.claude.plan.bestEffort], [true, undefined], `claude's plan, on ${channel}`);
    for (const provider of ["chatgpt", "grok"] as const) {
      assert.deepEqual([offers[provider].plan.offered, offers[provider].plan.bestEffort], edge ? [true, true] : [false, undefined], `${provider}'s plan, on ${channel}`);
    }
    for (const provider of ["gemini", "muse"] as const) assert.equal(offers[provider].plan.offered, false, `${provider}'s plan, on ${channel}`);
  }
  assert.equal(OFFERS.chatgpt.plan.offered, false, "the offers themselves stay as stable has them");
  let channel = "edge";
  const ai = new Ai({ state: join(scratch, "edge-store"), channel: async () => channel });
  assert.match((await ai.choose("muse", "plan")).error ?? "", /a muse code subscription is coming soon/);
  assert.match((await ai.choose("gemini", "plan")).error ?? "", /google ai pro or ultra is coming soon/);
  assert.deepEqual((await ai.choose("chatgpt", "plan")).state, { provider: "chatgpt", path: "plan", accepted: null, cli: null });
  assert.deepEqual((await ai.choose("grok", "plan")).state, { provider: "grok", path: "plan", accepted: null, cli: null });
  // Back on stable, the plan picked on edge stays: it's the household's.
  // Stable only keeps it from being picked anew.
  channel = "stable";
  assert.deepEqual([(await ai.read()).provider, (await ai.read()).path], ["grok", "plan"]);
  assert.match((await ai.choose("chatgpt", "plan")).error ?? "", /chatgpt plus or pro is coming soon/);
  assert.deepEqual([(await ai.read()).provider, (await ai.read()).path], ["grok", "plan"], "a refused pick changes nothing");
});

test("ADR-053 the daemon goes by the channel agentv channel keeps, or else the one its package was built for, and says which plans it offers", async () => {
  const ai = async () => (await fetch(`${url}/api/ai`)).json();
  const plans = async () => (await (await fetch(`${url}/api/key`)).json()).plans;
  try {
    let now = await ai();
    assert.equal(now.channel, "stable", "a checkout with no channel is on stable");
    assert.deepEqual([now.offers.chatgpt.plan.offered, now.offers.grok.plan.offered], [false, false]);
    assert.deepEqual(await plans(), [{ provider: "claude", name: "claude pro or max", bestEffort: false }]);
    assert.match((await (await post("/api/ai", { provider: "chatgpt", path: "plan" })).json()).error, /coming soon/);
    writeFileSync(channelFile, "edge\n");
    now = await ai();
    assert.equal(now.channel, "edge");
    assert.deepEqual([now.offers.chatgpt.plan.bestEffort, now.offers.grok.plan.bestEffort, now.offers.muse.plan.offered], [true, true, false]);
    assert.deepEqual(await plans(), [
      { provider: "claude", name: "claude pro or max", bestEffort: false },
      { provider: "chatgpt", name: "chatgpt plus or pro", bestEffort: true },
      { provider: "grok", name: "supergrok or x premium+", bestEffort: true },
    ]);
    // Its package's channel, when agentv channel hasn't set one.
    rmSync(channelFile);
    writeFileSync(join(scratch, "root", "settings"), "AGENTV_VERSION=0.1.3\nAGENTV_CHANNEL=edge\n");
    assert.equal((await ai()).channel, "edge");
    writeFileSync(channelFile, "stable\n");
    assert.equal((await ai()).channel, "stable", "agentv channel's choice comes first");
  } finally {
    rmSync(channelFile, { force: true });
    rmSync(join(scratch, "root", "settings"), { force: true });
  }
});

test("S5.5 an acceptance is for the terms the TV shows, kept with who, on which phone and when, and never taken back", async () => {
  const dir = join(scratch, "kept");
  const ai = new Ai({ state: dir });
  await ai.choose("claude", "key");
  assert.match((await ai.accept("claude", "plan", { phone: "iphone", viewer: "radomir" })).error ?? "", /aren't the terms the tv shows/);
  assert.match((await ai.accept("claude", "key", { phone: "iphone", viewer: "<script>" })).error ?? "", /who accepted/);
  const accepted = (await ai.accept("claude", "key", { phone: "iphone", viewer: "radomir" })).state!.accepted!;
  assert.deepEqual([accepted.provider, accepted.path, accepted.read, accepted.by], ["claude", "key", TERMS_READ.claude, { phone: "iphone", viewer: "radomir" }]);
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

// Root's move of a key, as agentv-key-store does it, while fn runs.
async function withRoot(fn: () => Promise<void>): Promise<void> {
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
    await fn();
  } finally {
    clearInterval(mover);
  }
}

test("Q104 Settings → AI: a key for a provider whose terms nobody here accepted waits for an adult to accept them on a phone; one for a provider accepted just saves", async () => {
  const grant = (await (await phone("/api/phone/pin", { pin: "2468" })).json()).grant;
  await post("/api/setup", { done: true });
  const put = (provider: string, key: string) =>
    fetch(`${url}/api/key`, { method: "PUT", headers: { "Content-Type": "application/json", "X-AgenTV-Grant": grant }, body: JSON.stringify({ provider, key }) });
  const kept = () => JSON.parse(readFileSync(join(state, "terms.json"), "utf8"));

  // Claude's terms for a key were accepted in setup: a new key just saves.
  await withRoot(async () => assert.equal((await put("claude", `sk-ant-${"m".repeat(40)}`)).status, 200));
  assert.equal((await phoneState()).ai, null);

  // ChatGPT's never were. A key that won't do says so first; one that will
  // waits, and the phone shows ChatGPT's terms for a key.
  assert.equal((await put("chatgpt", "short")).status, 400);
  const waiting = await put("chatgpt", `sk-proj-${"n".repeat(40)}`);
  assert.equal(waiting.status, 409);
  const said = await waiting.json();
  assert.equal(said.error, "chatgpt's terms come first");
  assert.deepEqual(said.terms.terms, OFFERS.chatgpt.terms.key);
  const asked = (await phoneState()).ai;
  assert.deepEqual([asked.ask, asked.provider, asked.path, asked.terms[0].name], ["terms", "chatgpt", "key", "openai's services agreement"]);
  assert.equal(kept().length, 2, "nothing is recorded before an adult accepts");

  // Past the PIN, and only the terms it asks for.
  assert.equal((await phone("/api/phone/terms", { provider: "chatgpt", path: "key" })).status, 403);
  assert.equal((await phone("/api/phone/terms", { provider: "gemini", path: "key" }, grant)).status, 400);
  assert.equal((await phone("/api/phone/terms", { provider: "chatgpt", path: "key" }, grant)).status, 200);
  const record = kept().at(-1);
  assert.deepEqual([record.provider, record.path, record.read, record.by.phone, record.terms[0].id], ["chatgpt", "key", TERMS_READ.chatgpt, "iphone", "openai-services-agreement"]);
  assert.equal((await phoneState()).ai, null);
  await withRoot(async () => assert.equal((await put("chatgpt", `sk-proj-${"n".repeat(40)}`)).status, 200));
  assert.doesNotMatch(JSON.stringify(kept()), /sk-proj/, "no key in the record");

  // Gemini, then Settings stops waiting: the phone stops asking.
  assert.equal((await put("gemini", `AIza${"p".repeat(35)}`)).status, 409);
  assert.equal((await phoneState()).ai.provider, "gemini");
  assert.equal((await fetch(`${url}/api/key/terms`, { method: "DELETE" })).status, 200);
  assert.equal((await phoneState()).ai, null);
  assert.equal((await phone("/api/phone/terms", { provider: "gemini", path: "key" }, grant)).status, 400, "nothing to accept now");
  assert.equal(kept().length, 3);
});

test("ADR-047 Q104 Grok and Muse in Settings → AI: each waits for its own terms for a key, accepted on a phone, then its key is kept, and a second one just saves", async () => {
  const grant = (await (await phone("/api/phone/pin", { pin: "2468" })).json()).grant;
  const put = (provider: string, key: string) =>
    fetch(`${url}/api/key`, { method: "PUT", headers: { "Content-Type": "application/json", "X-AgenTV-Grant": grant }, body: JSON.stringify({ provider, key }) });
  const kept = () => JSON.parse(readFileSync(join(state, "terms.json"), "utf8"));
  for (const [provider, key, first] of [
    ["grok", `xai-${"g".repeat(40)}`, "xai-enterprise-terms"],
    ["muse", `LLM_${"u".repeat(40)}`, "meta-model-api-terms"],
  ]) {
    const before = kept().length;
    const waiting = await put(provider, key);
    assert.equal(waiting.status, 409, `${provider}'s key waits`);
    assert.equal((await waiting.json()).terms.terms[0].id, first);
    const asked = (await phoneState()).ai;
    assert.deepEqual([asked.ask, asked.provider, asked.path, asked.terms[0].id], ["terms", provider, "key", first]);
    assert.equal(kept().length, before, "nothing is recorded before an adult accepts");
    assert.equal((await phone("/api/phone/terms", { provider, path: "key" }, grant)).status, 200);
    const record = kept().at(-1);
    assert.deepEqual([record.provider, record.path, record.read, record.by.phone], [provider, "key", TERMS_READ[provider as "grok" | "muse"], "iphone"]);
    await withRoot(async () => assert.equal((await put(provider, key)).status, 200, `${provider}'s key is kept`));
    await withRoot(async () => assert.equal((await put(provider, `${key}2`)).status, 200, `a second ${provider} key just saves`));
    assert.equal(kept().length, before + 1, "with no new acceptance");
  }
  assert.doesNotMatch(JSON.stringify(kept()), /xai-g|LLM_u/, "no key in the record");
});

test("Q143 Settings → AI: an adult picks the household's plan past the PIN, its terms accepted on a phone first, and a key kept there after is what builds use", async () => {
  const grant = (await (await phone("/api/phone/pin", { pin: "2468" })).json()).grant;
  const usePlan = (provider: string, withGrant = true) =>
    fetch(`${url}/api/ai/plan`, { method: "PUT", headers: { "Content-Type": "application/json", ...(withGrant ? { "X-AgenTV-Grant": grant } : {}) }, body: JSON.stringify({ provider }) });
  const using = async () => (await (await fetch(`${url}/api/key`)).json()).ai;
  const kept = () => JSON.parse(readFileSync(join(state, "terms.json"), "utf8"));
  try {
    assert.equal((await usePlan("claude", false)).status, 403, "past the PIN");
    assert.match((await (await usePlan("copilot")).json()).error, /claude, chatgpt, gemini, grok or muse/);
    // On stable, Claude's is the only plan.
    assert.match((await (await usePlan("chatgpt")).json()).error, /chatgpt plus or pro is coming soon/);
    assert.match((await (await usePlan("muse")).json()).error, /a muse code subscription is coming soon/);

    // Claude's terms for a plan were accepted in setup: it's used at once.
    const claude = await usePlan("claude");
    assert.equal(claude.status, 200);
    assert.deepEqual(await using(), { provider: "claude", path: "plan", accepted: true });

    // On edge, grok's plan, whose terms nobody here has accepted, waits for
    // them: the phone shows xAI's consumer terms, and builds keep Claude's
    // plan until an adult accepts.
    writeFileSync(channelFile, "edge\n");
    const before = kept().length;
    const waiting = await usePlan("grok");
    assert.equal(waiting.status, 409);
    const said = await waiting.json();
    assert.equal(said.error, "grok's terms come first");
    assert.deepEqual(said.terms.terms, OFFERS.grok.terms.plan);
    const asked = (await phoneState()).ai;
    assert.deepEqual([asked.ask, asked.provider, asked.path, asked.terms[0].id], ["terms", "grok", "plan", "xai-consumer-terms"]);
    assert.deepEqual(await using(), { provider: "claude", path: "plan", accepted: true });
    assert.equal((await phone("/api/phone/terms", { provider: "grok", path: "plan" })).status, 403, "past the PIN on the phone too");
    assert.equal((await phone("/api/phone/terms", { provider: "grok", path: "plan" }, grant)).status, 200);
    const record = kept().at(-1);
    assert.deepEqual([kept().length, record.provider, record.path, record.read, record.terms[0].id], [before + 1, "grok", "plan", TERMS_READ.grok, "xai-consumer-terms"]);
    assert.equal((await phoneState()).ai, null);
    assert.equal((await usePlan("grok")).status, 200, "the TV asks again, and now it's used");
    assert.deepEqual(await using(), { provider: "grok", path: "plan", accepted: true });

    // ChatGPT's, then Settings stops waiting: the phone stops asking.
    assert.equal((await usePlan("chatgpt")).status, 409);
    assert.deepEqual([(await phoneState()).ai.provider, (await phoneState()).ai.path], ["chatgpt", "plan"]);
    assert.equal((await fetch(`${url}/api/ai/plan/terms`, { method: "DELETE" })).status, 200);
    assert.equal((await phoneState()).ai, null);
    assert.deepEqual(await using(), { provider: "grok", path: "plan", accepted: true }, "the plan in use stays");

    // A key kept from Settings → AI is what builds use after.
    await withRoot(async () => {
      const put = await fetch(`${url}/api/key`, { method: "PUT", headers: { "Content-Type": "application/json", "X-AgenTV-Grant": grant }, body: JSON.stringify({ provider: "claude", key: `sk-ant-${"q".repeat(40)}` }) });
      assert.equal(put.status, 200);
      assert.deepEqual((await put.json()).ai, { provider: "claude", path: "key", accepted: true });
    });
    assert.deepEqual(await using(), { provider: "claude", path: "key", accepted: true });
  } finally {
    rmSync(channelFile, { force: true });
  }
});

test("a child's profile can't accept the terms or give the key from a phone", async () => {
  const grant = (await (await phone("/api/phone/pin", { pin: "2468" })).json()).grant;
  const child = (await (await post("/api/viewers", { name: "mia", role: "child" }, grant)).json()).profile;
  await post("/api/viewer", { id: child.id }, grant);
  assert.equal((await phone("/api/phone/terms", { provider: "claude", path: "key" }, grant)).status, 403);
  assert.equal((await phone("/api/phone/key", { key: `sk-ant-${"k".repeat(40)}` }, grant)).status, 403);
  assert.equal((await post("/api/ai", { provider: "gemini", path: "key" })).status, 403, "nor pick the provider without the PIN");
});
