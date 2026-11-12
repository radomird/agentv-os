// Setup's AI step (ADR-069, ADR-070): each provider's own icon, fetched on
// the box from its site the first time it's asked for and kept, or none,
// and a plan's sign-in started from setup without a build, handed to root
// through the builder's drop, with its status read back.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AiIcons, PROVIDER_SITES } from "../../../daemon/ai-icons.ts";
import { PlanSignIn } from "../../../daemon/plan-sign-in.ts";
import { Daemon } from "../../../daemon/server.ts";

const ROOT = join(import.meta.dirname, "../../..");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAKAgCAn8bSAgAAAAASUVORK5CYII=", "base64");
const scratch = mkdtempSync(join(tmpdir(), "agentv-ai-step-"));
let sites: Server;
let at = "";
const asked: string[] = [];

before(async () => {
  sites = createServer((request, response) => {
    asked.push(request.url ?? "");
    if (request.url === "/claude/") response.writeHead(200, { "Content-Type": "text/html" }).end('<link rel="apple-touch-icon" href="/claude/touch.png">');
    else if (request.url === "/claude/touch.png") response.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => sites.listen(0, "127.0.0.1", () => resolve()));
  at = `http://127.0.0.1:${(sites.address() as { port: number }).port}`;
});

after(() => {
  sites.close();
  rmSync(scratch, { recursive: true, force: true });
});

test("ADR-069 each provider's icon comes from its own site", () => {
  assert.deepEqual(PROVIDER_SITES, { claude: "https://claude.ai/", chatgpt: "https://chatgpt.com/", gemini: "https://gemini.google.com/", grok: "https://grok.com/", muse: "https://www.meta.ai/" });
});

test("T7.2 a provider's icon is fetched from its site once and kept, and a site with none isn't asked again at once", async () => {
  const state = join(scratch, "icons");
  const icons = new AiIcons({ state, userAgent: "AgenTV test", sites: { claude: `${at}/claude/`, chatgpt: `${at}/chatgpt/` } });
  const claude = await icons.icon("claude");
  assert.equal(claude?.type, "image/png");
  assert.deepEqual(claude?.body, PNG);
  assert.deepEqual(readFileSync(join(state, "ai-icons", "claude")), PNG);
  const before = asked.length;
  assert.deepEqual((await new AiIcons({ state, userAgent: "AgenTV test", sites: { claude: `${at}/claude/` } }).icon("claude"))?.body, PNG, "kept, even after a restart");
  assert.equal(asked.length, before, "the site isn't asked again");

  assert.equal(await icons.icon("chatgpt"), null, "no icon: the name alone");
  const missed = asked.length;
  assert.equal(await icons.icon("chatgpt"), null);
  assert.equal(asked.length, missed, "a site with no icon is left alone for a while");
  // Two screens asking at once share one fetch.
  const together = new AiIcons({ state: join(scratch, "together"), userAgent: "AgenTV test", sites: { claude: `${at}/claude/` } });
  const first = asked.length;
  await Promise.all([together.icon("claude"), together.icon("claude")]);
  assert.equal(asked.slice(first).filter((u) => u === "/claude/").length, 1);
});

test("ADR-070 a plan's sign-in from setup goes to root without a build, and its status comes back", async () => {
  const state = join(scratch, "sign-in");
  const drop = join(state, "build-drop");
  const run = join(scratch, "run");
  const signIn = new PlanSignIn({ state, drop, run });
  assert.equal(await signIn.state(), null, "none started");
  await signIn.start("claude");
  assert.deepEqual(JSON.parse(readFileSync(join(drop, "sign-in.json"), "utf8")), { build: null, provider: "claude" });
  assert.deepEqual(await signIn.state(), { provider: "claude", signedIn: false, now: { state: "starting" } });
  assert.match((await signIn.code("abc")).error ?? "", /Nothing is waiting/);

  const later = () => new Date(Date.now() + 1000).toISOString();
  mkdirSync(join(run, "sign-in"), { recursive: true });
  // An older status, from a build's sign-in before, doesn't count.
  writeFileSync(join(run, "sign-in", "status.json"), JSON.stringify({ provider: "claude", state: "failed", reason: "old", at: "2026-01-01T00:00:00Z" }));
  assert.equal((await signIn.state())?.now?.state, "starting");
  writeFileSync(join(run, "sign-in", "status.json"), JSON.stringify({ provider: "claude", state: "waiting", url: "https://claude.ai/oauth/authorize?x=1", pastes: true, at: later() }));
  assert.deepEqual((await signIn.state())?.now, { state: "waiting", url: "https://claude.ai/oauth/authorize?x=1", pastes: true });
  assert.match((await signIn.code("bad code with spaces")).error ?? "", /Paste the code/);
  assert.deepEqual(await signIn.code(" good-code#s7Q "), {});
  assert.deepEqual(JSON.parse(readFileSync(join(drop, "sign-in-code.json"), "utf8")), { code: "good-code#s7Q" });

  writeFileSync(join(run, "sign-in", "status.json"), JSON.stringify({ provider: "claude", state: "done", at: later() }));
  assert.deepEqual(await signIn.state(), { provider: "claude", signedIn: true });
  rmSync(join(run, "sign-in"), { recursive: true });
  assert.deepEqual(await new PlanSignIn({ state, drop, run }).state(), { provider: "claude", signedIn: true }, "kept after /run is gone, as after a reboot");
});

test("ADR-070 root refusing the sign-in says why", async () => {
  const state = join(scratch, "refused");
  const run = join(scratch, "run-refused");
  const signIn = new PlanSignIn({ state, drop: join(state, "build-drop"), run });
  await signIn.start("claude");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "answer.json"), JSON.stringify({ action: "sign-in", build: null, started: false, reason: "another build is running; one runs at a time", at: new Date(Date.now() + 1000).toISOString() }));
  assert.deepEqual((await signIn.state())?.now, { state: "failed", reason: "another build is running; one runs at a time" });
});

test("the AI step's routes: icons, and the sign-in only for a plan whose terms an adult accepted", async () => {
  const state = join(scratch, "daemon");
  const run = join(scratch, "daemon-run");
  const daemon = new Daemon({ root: ROOT, state, port: 0, log: () => {}, builtins: null, buildRun: run, aiSites: { claude: `${at}/claude/`, chatgpt: `${at}/chatgpt/` } });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  const post = (path: string, body: unknown = {}) => fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const icon = await fetch(`${url}/api/ai/icon/claude`);
    assert.deepEqual([icon.status, icon.headers.get("content-type")], [200, "image/png"]);
    assert.equal((await fetch(`${url}/api/ai/icon/chatgpt`)).status, 404);
    assert.equal((await fetch(`${url}/api/ai/icon/toString`)).status, 404);
    assert.equal((await (await fetch(`${url}/api/ai/sign-in`)).json()).signIn, null);
    assert.equal((await post("/api/ai/sign-in")).status, 409, "no plan picked");
    assert.equal((await post("/api/ai", { provider: "claude", path: "plan" })).status, 200);
    assert.match((await (await post("/api/ai/sign-in")).json()).error, /Accept Claude's terms first/);
    await daemon.ai.accept("claude", "plan", { phone: "pixel", viewer: "radomir" });
    const started = await (await post("/api/ai/sign-in")).json();
    assert.deepEqual(started.signIn, { provider: "claude", signedIn: false, now: { state: "starting" } });
    assert.ok(existsSync(join(state, "build-drop", "sign-in.json")));
    assert.equal((await fetch(`${url}/api/ai/sign-in/qr`)).status, 404, "no link yet");
    assert.equal((await post("/api/ai/sign-in/code", { code: "abc" })).status, 400);
    // A key picked instead: the plan's sign-in isn't this provider's way in.
    assert.equal((await post("/api/ai", { provider: "claude", path: "key" })).status, 200);
    assert.equal((await (await fetch(`${url}/api/ai/sign-in`)).json()).signIn, null);
  } finally {
    await daemon.close();
  }
});
