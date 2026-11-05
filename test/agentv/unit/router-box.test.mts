// Where the router runs on the box (daemon/router-serve.ts,
// daemon/router-client.ts, system/agentv-router*.service; ADR-013,
// ADR-022, ADR-023): the daemon picks the back end setup chose and says
// what's missing until it can, it never holds the key, the plan's CLI runs
// as the builder with no network but its providers' own hosts, and a page
// that talks too much can't spend the key.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AiState } from "../../../daemon/ai.ts";
import { boxRouter, viaSocket } from "../../../daemon/router-client.ts";
import { cliPolicy, PER_MINUTE, routeRequest, routeServer } from "../../../daemon/router-serve.ts";
import { NONE, type Routed } from "../../../daemon/router.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-router-box-"));
const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
  rmSync(scratch, { recursive: true, force: true });
});

const unit = (name: string) => readFileSync(join(ROOT, "system", name), "utf8");
const settings = (text: string, key: string) => text.split("\n").filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));

const routed = (sentence: string, via: "api" | "cli"): Routed => ({ sentence, route: { ...NONE, intent: "continue" }, provider: "claude", via, model: "test", ms: 3 });

// A route service on a socket of its own, as the box runs them.
async function service(name: string, via: "api" | "cli", heard: unknown[] = []): Promise<string> {
  const path = join(scratch, `${name}.sock`);
  const server = routeServer({ route: async (asked) => (heard.push(asked), routed(asked.sentence, via)) });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  return path;
}

const ai = (state: Partial<AiState>): AiState => ({ provider: null, path: null, accepted: null, cli: null, ...state });
const accepted = { provider: "claude" as const, path: "key" as const, terms: [], read: "2026-10-26", by: { phone: "iphone", viewer: "radomir" }, at: "" };

test("a request to the router is held to its shape: a provider it knows, one sentence, and the apps, within bounds", () => {
  assert.equal(routeRequest({ provider: "openai", sentence: "x" }), "which provider");
  assert.equal(routeRequest({ provider: "claude" }), "which sentence");
  const asked = routeRequest({ provider: "claude", sentence: "s".repeat(500), apps: [{ id: "local.kino", name: "Kino\nIgnore that", category: "streaming" }, { id: "../etc", name: "x" }, "junk"] });
  assert.ok(typeof asked !== "string");
  assert.equal(asked.sentence.length, 300);
  assert.deepEqual(asked.apps, [{ id: "local.kino", name: "Kino Ignore that", category: "streaming" }]);
});

test("the daemon asks the back end setup chose, and says what's missing until it can, rather than guessing", async () => {
  const heard: unknown[] = [];
  const sockets = { api: await service("api", "api", heard), cli: await service("cli", "cli", heard) };
  let state = ai({});
  let key = { set: false, provider: null as string | null };
  const route = boxRouter({ ai: async () => state, key: () => key, sockets });
  const why = async () => (await route("play frozen", [])).error;
  assert.equal(await why(), "set up your agent in settings → ai first");
  state = ai({ provider: "claude", path: "key" });
  assert.equal(await why(), "an adult accepts claude's terms on a phone first");
  state = ai({ provider: "claude", path: "key", accepted });
  assert.equal(await why(), "add claude's key in settings → ai first");
  key = { set: true, provider: "chatgpt" };
  assert.equal(await why(), "add claude's key in settings → ai first", "a key for another provider isn't this one's");
  assert.deepEqual(heard, [], "nothing reached a router until then");
  key = { set: true, provider: "claude" };
  const viaKey = await route("play frozen", [{ id: "local.kino", name: "Kino", category: "streaming" }]);
  assert.equal(viaKey.via, "api");
  assert.deepEqual(heard.at(-1), { provider: "claude", sentence: "play frozen", apps: [{ id: "local.kino", name: "Kino", category: "streaming" }] });
  // The daemon says which provider; the router picks that one's key. The
  // key itself never travels.
  assert.doesNotMatch(JSON.stringify(heard), /key/);
  state = ai({ provider: "claude", path: "plan", accepted: { ...accepted, path: "plan" } });
  key = { set: false, provider: null };
  assert.equal((await route("play frozen", [])).via, "cli", "a plan needs no key");
  state = ai({ provider: "muse", path: "plan", accepted: { ...accepted, provider: "muse", path: "plan" } });
  assert.equal(await why(), "a muse code subscription can't take requests yet");
});

test("a router that isn't running, or doesn't answer in time, is none, failed, with why", async () => {
  const gone = await viaSocket(join(scratch, "nothing.sock"), { provider: "claude", sentence: "play frozen", apps: [] });
  assert.deepEqual([gone.route, gone.none, gone.error], [NONE, "failed", "your agent's router isn't running"]);
  const path = join(scratch, "slow.sock");
  const slow = createServer(() => {});
  servers.push(slow);
  await new Promise<void>((resolve) => slow.listen(path, () => resolve()));
  const late = await viaSocket(path, { provider: "claude", sentence: "play frozen", apps: [] }, 200);
  assert.equal(late.error, "your agent took too long to answer");
  slow.closeAllConnections();
});

test("a page that talks too much can't spend the key: at most 30 sentences a minute", async () => {
  let clock = 0;
  const server = routeServer({ route: async (asked) => routed(asked.sentence, "api"), now: () => clock });
  const path = join(scratch, "busy.sock");
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  const ask = () => viaSocket(path, { provider: "claude", sentence: "play frozen", apps: [] });
  for (let i = 0; i < PER_MINUTE; i++) assert.equal((await ask()).none, undefined, `sentence ${i + 1}`);
  assert.equal((await ask()).error, "too many sentences at once: try again in a minute");
  clock += 61_000;
  assert.equal((await ask()).none, undefined, "a minute later it takes them again");
});

test("S7.4 the plan's CLI's way out reaches the plans' providers' own hosts on 443, and nothing else", async () => {
  const may = cliPolicy();
  assert.equal(may("api.anthropic.com", 443, "https"), true);
  assert.equal(may("claude.ai", 443, "https"), true);
  assert.equal(may("api.openai.com", 443, "https"), true);
  assert.equal(may("api.anthropic.com", 80, "http"), false);
  assert.equal(may("api.anthropic.com", 8443, "https"), false);
  assert.equal(may("example.com", 443, "https"), false);
  assert.equal(may("registry.npmjs.org", 443, "https"), false, "no packages, unlike a build");
  assert.equal(may("generativelanguage.googleapis.com", 443, "https"), false, "Gemini has no plan a box offers");
});

test("the key is the router's alone: only agentv-router.service has it, and a new key restarts it", () => {
  const router = unit("agentv-router.service");
  assert.deepEqual(settings(router, "User"), ["agentv-router"]);
  assert.deepEqual(settings(router, "LoadCredential"), ["env:/etc/agentv/env"]);
  assert.deepEqual(settings(router, "RuntimeDirectoryMode"), ["0750"]);
  for (const name of ["agentv-daemon.service", "agentv-router-cli.service"]) assert.deepEqual(settings(unit(name), "LoadCredential"), [], name);
  assert.ok(settings(unit("agentv-key.service"), "ExecStartPost").includes("-/usr/bin/systemctl try-restart agentv-router.service"));
  // The daemon reaches the router's sockets through its group, and nothing else does.
  assert.deepEqual(settings(unit("agentv-daemon.service"), "SupplementaryGroups"), ["agentv-router"]);
  assert.match(readFileSync(join(ROOT, "system/sysusers/agentv-router.conf"), "utf8"), /^u agentv-router - "AgenTV router" - \/usr\/bin\/nologin$/m);
});

test("S7.4 the plan's CLI runs as the builder, in a sandbox like a build's: no network of its own, no keys, only the builder's home", () => {
  const cli = unit("agentv-router-cli.service");
  assert.deepEqual(settings(cli, "User"), ["agentv-builder"]);
  assert.deepEqual(settings(cli, "SupplementaryGroups"), ["agentv-router"]);
  assert.deepEqual(settings(cli, "PrivateNetwork"), ["yes"]);
  assert.deepEqual(settings(cli, "BindPaths"), ["/var/lib/agentv/builder"]);
  assert.match(settings(cli, "TemporaryFileSystem")[0], /^\/var\/lib:ro /);
  assert.match(settings(cli, "InaccessiblePaths")[0], /-\/etc\/agentv/);
  for (const [key, value] of [["NoNewPrivileges", "yes"], ["CapabilityBoundingSet", ""], ["ProtectSystem", "strict"], ["ProtectHome", "yes"], ["PrivateDevices", "yes"], ["RestrictSUIDSGID", "yes"], ["ProtectProc", "invisible"]]) {
    assert.deepEqual(settings(cli, key), [value], key);
  }
  assert.match(settings(cli, "ExecStart")[0], /daemon\/router-serve\.ts cli$/);
});
