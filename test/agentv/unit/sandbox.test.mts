// The builder's sandbox (builder/sandbox/, ADR-011, ADR-045): what models
// cost, the key relay that adds the key outside the sandbox and keeps
// builds inside their caps, the filter's list, the forwarders inside the
// sandbox, root's hand-over, and the units' sandbox, kept as it is.

import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NetFilter } from "../../../daemon/net-filter.ts";
import { Build } from "../../../builder/build.ts";
import { checkRequest, escapePath, HandOver } from "../../../builder/sandbox/hand-over.ts";
import { allowed, declaredBy, policy } from "../../../builder/sandbox/net.ts";
import { buildForbidden } from "../../../builder/origins.ts";
import { cost, NO_USAGE, rateFor } from "../../../builder/sandbox/prices.ts";
import { keyFrom, Meter, Relay, serverTools, type Ticket } from "../../../builder/sandbox/relay.ts";
import { forward } from "../../../builder/sandbox/start.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-sandbox-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// --- Prices --------------------------------------------------------------

test("each model's price is its own, and a model the table doesn't have isn't priced", () => {
  assert.equal(rateFor("claude", "claude-opus-5-5")?.in, 4);
  assert.equal(rateFor("claude", "claude-opus-5")?.in, 5, "claude-opus-5 isn't read as claude-opus-5-5");
  assert.equal(rateFor("claude", "claude-haiku-4-5-20251001")?.in, 1, "a dated id is its model");
  assert.equal(rateFor("chatgpt", "gpt-5.4-mini")?.in, 0.75, "the longest name that fits wins");
  assert.equal(rateFor("chatgpt", "gpt-5.5-pro"), null, "a -pro costs far more, so it isn't read as gpt-5.5");
  assert.equal(rateFor("gemini", "models/gemini-3.1-pro-preview")?.out, 12);
  assert.equal(rateFor("claude", "claude-something-new"), null);
});

test("a request costs its input, cache writes and reads, and output, each at its rate", () => {
  const opus = rateFor("claude", "claude-opus-5-5")!;
  // 1M input at $4, 1M 5-minute writes at $5, 1M 1-hour at $8, 1M reads at
  // $0.20, 1M output at $20.
  assert.equal(cost(opus, { input: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6, output: 1e6 }), 4 + 5 + 8 + 0.2 + 20);
  assert.equal(cost(opus, { ...NO_USAGE, output: 1e6 }, true), 40, "fast mode is twice the price");
  const haiku = rateFor("claude", "claude-haiku-5-5")!;
  assert.equal(cost(haiku, { ...NO_USAGE, input: 50_000, output: 1e6 }), 0.005 + 0.5);
  assert.equal(cost(haiku, { ...NO_USAGE, input: 200_000, output: 1e6 }), 0.1 + 2.5, "a prompt over 100K takes the long rate");
  assert.equal(cost(rateFor("chatgpt", "gpt-5.5")!, { ...NO_USAGE, input: 300_000 }), null, "a prompt over 272K on gpt-5.5 has no published price");
});

// --- The key relay -------------------------------------------------------

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

// A stand-in for the providers' APIs: it says what it was sent, and answers
// what each test sets.
const seen: Seen[] = [];
let answer: { type: string; body: string } = { type: "application/json", body: "{}" };
const provider: Server = createHttpServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    res.writeHead(200, { "Content-Type": answer.type });
    res.end(answer.body);
  });
});
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", () => done()));
const upstreamUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;

const KEY = "sk-ant-api03-relaytest0000000000000000";
let ticket: Ticket | null = null;
const spendPath = join(scratch, "spend", "spend.json");
const relay = new Relay({
  ticket: () => ticket,
  key: (p) => ({ claude: KEY, chatgpt: "sk-openai-relaytest", gemini: "gemini-relaytest", grok: "xai-relaytest", muse: "LLM_relaytest" })[p],
  spendPath,
  upstream: { claude: upstreamUrl, chatgpt: upstreamUrl, gemini: upstreamUrl, grok: upstreamUrl, muse: upstreamUrl },
});
const relayPort = (await relay.listen(0)) as number;
after(() => {
  provider.closeAllConnections();
  provider.close();
  relay.server.closeAllConnections();
  void relay.close();
});

const keyTicket = (change: Partial<Ticket> = {}): Ticket => ({
  build: "b1",
  id: "local.blocks",
  version: "1.0.0",
  dir: join(scratch, "nowhere"),
  provider: "claude",
  path: "key",
  recipe: "game",
  cap: { build: 5, month: 20 },
  ...change,
});

function ask(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port: relayPort, method, path, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => done({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", fail);
    req.end(data);
  });
}

const sse = (events: object[]) => events.map((e) => `event: ${(e as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const spent = () => JSON.parse(readFileSync(spendPath, "utf8"));

test("the relay refuses everything when no build with a key is running", async () => {
  ticket = null;
  assert.equal((await ask("POST", "/v1/messages", { model: "claude-opus-5-5" })).status, 403);
  ticket = keyTicket({ path: "plan" });
  const plan = await ask("POST", "/v1/messages", { model: "claude-opus-5-5" });
  assert.equal(plan.status, 403, "a plan's build goes to its provider through the filter, not here");
  assert.equal(seen.length, 0);
});

test("the relay swaps the CLI's stand-in for the household's key, passes the answer on as it is, and counts what it cost", async () => {
  rmSync(spendPath, { force: true });
  ticket = keyTicket();
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0, output_tokens: 1 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    { type: "message_delta", usage: { output_tokens: 50_000 } },
    { type: "message_stop" },
  ];
  answer = { type: "text/event-stream", body: sse(events) };
  seen.length = 0;
  const reply = await ask("POST", "/v1/messages", { model: "claude-opus-5-5", stream: true, tools: [{ name: "mcp__agentv__write", input_schema: {} }] }, { "x-api-key": "agentv-relay" });
  assert.equal(reply.status, 200);
  assert.equal(reply.text, sse(events), "the stream reaches the CLI unchanged");
  assert.equal(seen[0].headers["x-api-key"], KEY, "the provider gets the household's key");
  assert.ok(!JSON.stringify(seen[0].headers).includes("agentv-relay"), "and not the CLI's stand-in");
  // 100K input at $4, 1M reads at $0.20, 50K output at $20: $0.4 + $0.2 + $1.
  assert.equal(Math.round(spent().builds.b1 * 1e6) / 1e6, 1.6);
  assert.equal(Math.round(spent().spent * 1e6) / 1e6, 1.6);
});

test("the relay passes on only a model's calls, a model it can price, and no tool the provider runs itself", async () => {
  ticket = keyTicket();
  seen.length = 0;
  assert.equal((await ask("POST", "/v1/files", {})).status, 403, "the Files API isn't a call the builder makes");
  assert.equal((await ask("POST", "/v1/messages", { model: "claude-new-thing" })).status, 400, "a model with no price");
  const search = await ask("POST", "/v1/messages", { model: "claude-opus-5-5", tools: [{ type: "web_search_20260209", name: "web_search" }] });
  assert.equal(search.status, 400);
  assert.match(search.text, /web_search_20260209/);
  assert.equal(seen.length, 0, "none of them reached the provider");
  assert.equal(serverTools("responses", { tools: [{ type: "function", name: "write" }, { type: "web_search" }] }), "web_search");
  assert.equal(serverTools("chat", { tools: [{ type: "function", function: { name: "write" } }, { type: "x_search" }] }), "x_search");
  assert.equal(serverTools("gemini", { tools: [{ functionDeclarations: [] }, { googleSearch: {} }] }), "googleSearch");
  assert.equal(serverTools("messages", { tools: [{ name: "write", input_schema: {} }] }), null);
});

test("a build stops within one request of its cap, and the month's cap holds across builds", async () => {
  rmSync(spendPath, { force: true });
  ticket = keyTicket({ cap: { build: 1, month: 1.5 } });
  // Each answer costs $1.20: 60K output at $20.
  answer = { type: "application/json", body: JSON.stringify({ type: "message", usage: { input_tokens: 0, output_tokens: 60_000 } }) };
  assert.equal((await ask("POST", "/v1/messages", { model: "claude-opus-5-5" })).status, 200);
  const capped = await ask("POST", "/v1/messages", { model: "claude-opus-5-5" });
  assert.equal(capped.status, 403);
  assert.match(capped.text, /spend cap/);
  ticket = keyTicket({ build: "b2", cap: { build: 5, month: 1.5 } });
  assert.equal((await ask("POST", "/v1/messages", { model: "claude-opus-5-5" })).status, 200, "a new build starts under the month's cap");
  const month = await ask("POST", "/v1/messages", { model: "claude-opus-5-5" });
  assert.equal(month.status, 403);
  assert.match(month.text, /this month/);
  ticket = keyTicket({ build: "b3" });
  assert.equal((await ask("POST", "/v1/messages/count_tokens", { model: "claude-opus-5-5" })).status, 200, "counting tokens costs nothing");
});

test("a new month starts from nothing", async () => {
  writeFileSync(spendPath, JSON.stringify({ month: "2020-01", spent: 99, builds: { b1: 99 } }));
  ticket = keyTicket();
  answer = { type: "application/json", body: JSON.stringify({ type: "message", usage: { input_tokens: 0, output_tokens: 0 } }) };
  assert.equal((await ask("POST", "/v1/messages", { model: "claude-opus-5-5" })).status, 200);
  assert.equal(relay.spend().spent, 0);
});

test("codex's and gemini's answers are counted too, though their CLIs report no cost", async () => {
  rmSync(spendPath, { force: true });
  ticket = keyTicket({ provider: "chatgpt" });
  seen.length = 0;
  answer = { type: "application/json", body: JSON.stringify({ object: "response", usage: { input_tokens: 200_000, input_tokens_details: { cached_tokens: 100_000 }, output_tokens: 100_000 } }) };
  assert.equal((await ask("POST", "/v1/responses", { model: "gpt-5.5" }, { authorization: "Bearer nothing" })).status, 200);
  assert.equal(seen[0].headers.authorization, "Bearer sk-openai-relaytest");
  // 100K input at $5, 100K cached at $0.50, 100K output at $30.
  assert.equal(Math.round(spent().builds.b1 * 1e6) / 1e6, 0.5 + 0.05 + 3);
  // A prompt longer than gpt-5.5's published price uses up the cap.
  answer = { type: "application/json", body: JSON.stringify({ object: "response", usage: { input_tokens: 300_000, output_tokens: 10 } }) };
  assert.equal((await ask("POST", "/v1/responses", { model: "gpt-5.5" })).status, 200);
  assert.equal(spent().builds.b1, 5, "a prompt too long to price counts as the build's whole cap");
  assert.equal((await ask("POST", "/v1/responses", { model: "gpt-5.5" })).status, 403);

  rmSync(spendPath, { force: true });
  ticket = keyTicket({ provider: "gemini" });
  seen.length = 0;
  const chunks = [{ usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 10 } }, { usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 100_000, thoughtsTokenCount: 100_000 } }];
  answer = { type: "text/event-stream", body: chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("") };
  assert.equal((await ask("POST", "/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse", {})).status, 200);
  assert.equal(seen[0].headers["x-goog-api-key"], "gemini-relaytest");
  // 1M input at $0.50, 200K output with thinking at $3.
  assert.equal(Math.round(spent().builds.b1 * 1e6) / 1e6, 0.5 + 0.6);
});

test("ADR-047 grok's and muse's answers are counted: xAI's at the cost it says, Meta's from its usage", async () => {
  rmSync(spendPath, { force: true });
  ticket = keyTicket({ provider: "grok" });
  seen.length = 0;
  const done = { type: "response.completed", response: { usage: { input_tokens: 100_000, output_tokens: 10_000, cost_in_usd_ticks: 1_234_500_000 } } };
  answer = { type: "text/event-stream", body: `data: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n` };
  assert.equal((await ask("POST", "/v1/responses", { model: "grok-4.7", stream: true }, { authorization: "Bearer agentv-relay" })).status, 200);
  assert.equal(seen[0].headers.authorization, "Bearer xai-relaytest");
  assert.equal(spent().builds.b1, 0.12345, "1,234,500,000 ticks are $0.12345");
  assert.equal((await ask("POST", "/v1/responses", { model: "grok-4.7", tools: [{ type: "x_search" }] })).status, 400, "xAI's own search would go round the filter");

  rmSync(spendPath, { force: true });
  ticket = keyTicket({ provider: "muse" });
  seen.length = 0;
  answer = { type: "application/json", body: JSON.stringify({ object: "chat.completion", usage: { prompt_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 200_000 }, completion_tokens: 100_000 } }) };
  assert.equal((await ask("POST", "/v1/chat/completions", { model: "muse-spark-1.2" })).status, 200);
  assert.equal(seen[0].headers.authorization, "Bearer LLM_relaytest");
  // 800K input at $1.25, 200K cached at $0.15, 100K output at $4.25.
  assert.equal(Math.round(spent().builds.b1 * 1e6) / 1e6, 1 + 0.03 + 0.425);
  assert.equal((await ask("POST", "/v1/chat/completions", { model: "muse-unknown-9" })).status, 400);
});

test("Claude's cache writes are counted at their own rates", () => {
  const meter = new Meter("messages");
  meter.read({ type: "message_start", message: { usage: { input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 }, cache_read_input_tokens: 40, output_tokens: 1 } } });
  meter.read({ type: "message_delta", usage: { output_tokens: 99 } });
  assert.deepEqual(meter.usage, { input: 10, cacheWrite5m: 20, cacheWrite1h: 30, cacheRead: 40, output: 99 });
});

test("the relay takes the provider's key from /etc/agentv/env's line, and no other", () => {
  const env = "TMDB_API_KEY=tmdb\nANTHROPIC_API_KEY=sk-ant-1\nOPENAI_API_KEY=\nXAI_API_KEY=xai-1\nMETA_API_KEY=LLM_1\n";
  assert.equal(keyFrom(env, "claude"), "sk-ant-1");
  assert.equal(keyFrom(env, "grok"), "xai-1");
  assert.equal(keyFrom(env, "muse"), "LLM_1");
  assert.equal(keyFrom(env, "chatgpt"), null);
  assert.equal(keyFrom(env, "gemini"), null);
});

// --- The filter's list ---------------------------------------------------

test("a build reaches npm and OSV, its provider only on a plan, and the origins its recipe allows", () => {
  const plan = allowed(keyTicket({ path: "plan" }), { origins: [], originsAllowed: false });
  assert.ok(plan.has("registry.npmjs.org:443") && plan.has("api.osv.dev:443"));
  assert.ok(plan.has("api.anthropic.com:443"), "a plan's CLI reaches its provider");
  assert.ok(!plan.has("claude.com:443"), "its sign-in pages only while it signs in");
  assert.ok(allowed(keyTicket({ path: "plan" }), { origins: [], originsAllowed: false }, true).has("claude.com:443"));
  const key = allowed(keyTicket(), { origins: [], originsAllowed: false });
  assert.ok(!key.has("api.anthropic.com:443"), "with a key, the CLI reaches the relay, not the provider");
  assert.ok(!key.has("github.com:443"), "and never GitHub");

  const api = allowed(keyTicket({ recipe: "api" }), { origins: ["https://api.met.no", "http://plain.example", "https://x.example/path", "https://user:pw@y.example"], originsAllowed: true });
  assert.ok(api.has("api.met.no:443"));
  assert.ok(!api.has("plain.example:80") && !api.has("x.example:443") && !api.has("y.example:443"), "only https origins, nothing more");
  // L2: only port 443, whatever port an origin names.
  const ported = allowed(keyTicket({ recipe: "api" }), { origins: ["https://api.met.no:8443", "https://nas.example:22"], originsAllowed: true });
  assert.deepEqual([...ported].filter((host) => !host.endsWith(":443")), []);
  assert.ok(!ported.has("api.met.no:443") && !ported.has("api.met.no:8443") && !ported.has("nas.example:22"));
  assert.ok(![...allowed(keyTicket({ recipe: null, origins: ["https://api.example.org:8443"] }), { origins: [], originsAllowed: true })].some((host) => host.startsWith("api.example.org")), "a plan's too");
  const game = allowed(keyTicket({ recipe: "game" }), { origins: ["https://api.met.no"], originsAllowed: false });
  assert.ok(!game.has("api.met.no:443"), "a game's recipe reaches no origin, whatever it declared");
  const approved = allowed(keyTicket({ recipe: null, origins: ["https://api.example.org"] }), { origins: ["https://other.example"], originsAllowed: true });
  assert.ok(approved.has("api.example.org:443") && !approved.has("other.example:443"), "a plan's build reaches what the adult approved");
  assert.equal(allowed(null, { origins: [], originsAllowed: true }).size, 0, "no build, no way out");

  const p = policy(() => api);
  assert.equal(p("API.MET.NO", 443, "https"), true);
  assert.equal(p("api.met.no", 443, "http"), false, "plain http never");
});

test("what a build declared comes from its state, within AgenTV's own recipe for it", () => {
  const dir = join(scratch, "declared");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ origins: [{ origin: "https://api.met.no", why: "the forecast" }] }));
  const recipes = join(ROOT, "builder/recipes");
  assert.deepEqual(declaredBy(keyTicket({ dir, recipe: "api" }), recipes), { origins: ["https://api.met.no"], originsAllowed: true });
  assert.equal(declaredBy(keyTicket({ dir, recipe: "photos" }), recipes).originsAllowed, false, "S6.7: the photo browser reaches no internet origin");
  assert.equal(declaredBy(keyTicket({ dir, recipe: "nonsense" }), recipes).originsAllowed, false);
});

test("the filter listens on a socket file, and refuses what isn't on the list", async () => {
  const path = join(scratch, "proxy.sock");
  const filter = new NetFilter({ policy: policy(() => new Set(["registry.npmjs.org:443"])) });
  await filter.listenPath(path);
  const reply = await new Promise<string>((done) => {
    const socket = connect(path, () => socket.write("CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n"));
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => done(text));
  });
  assert.match(reply, /^HTTP\/1\.1 403/, "S6.8: the builder can't reach GitHub");
  await filter.close();
});

// --- Inside the sandbox --------------------------------------------------

test("a port inside the sandbox passes each connection on to its socket file", async () => {
  const path = join(scratch, "echo.sock");
  const echo = createNetServer({ allowHalfOpen: true }, (socket) => socket.pipe(socket));
  await new Promise<void>((done) => echo.listen(path, () => done()));
  const server = await forward(0, path);
  const port = (server.address() as { port: number }).port;
  const back = await new Promise<string>((done) => {
    const socket = connect(port, "127.0.0.1", () => socket.end("through"));
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => done(text));
  });
  assert.equal(back, "through");
  server.close();
  echo.close();
});

test("L2 the build's filter refuses a name that points into the home network, and a port that isn't 443", async () => {
  const path = join(scratch, "strict.sock");
  const names: Record<string, string> = { "api.example.org": "192.168.1.20", "tail.example.org": "100.64.0.3", "six.example.org": "fd00::20" };
  const log: string[] = [];
  // As net.ts builds it, with made-up name resolution.
  const filter = new NetFilter({ policy: policy(() => allowed(keyTicket({ recipe: "api" }), { origins: Object.keys(names).map((name) => `https://${name}`), originsAllowed: true })), forbid: (address) => buildForbidden(address, () => new Set()), resolve: async (host) => names[host], log: (line) => log.push(line) });
  await filter.listenPath(path);
  const ask = (target: string) =>
    new Promise<string>((done) => {
      const socket = connect(path, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let text = "";
      socket.on("data", (chunk) => (text += chunk));
      socket.on("end", () => done(text));
    });
  for (const name of Object.keys(names)) assert.match(await ask(`${name}:443`), /^HTTP\/1\.1 403/, name);
  assert.match(await ask("api.example.org:8443"), /^HTTP\/1\.1 403/);
  assert.match(await ask("192.168.1.20:443"), /^HTTP\/1\.1 403/);
  assert.equal(log.filter((line) => /is this box \((192\.168\.1\.20|100\.64\.0\.3|fd00::20)\)/.test(line)).length, 3, log.join("\n"));
  await filter.close();
  // And the unit's own code passes that rule to its filter.
  assert.match(readFileSync(join(ROOT, "builder/sandbox/net.ts"), "utf8"), /forbid: \(address\) => forbiddenAddress\(address\) \|\| buildForbidden\(address\)/);
});

// --- Root's hand-over ----------------------------------------------------

const asked = (change: Record<string, unknown> = {}) => ({
  build: "b1730000000",
  id: "local.blocks",
  version: "1.0.0",
  sentence: "a game like tetris",
  phase: "build",
  recipe: "game",
  name: "Blocks",
  provider: "claude",
  path: "key",
  safeguards: true,
  cap: { build: 5, month: 20 },
  ...change,
});

test("root checks what the daemon asked before anything starts", async () => {
  assert.ok(checkRequest(asked()).request);
  assert.match(checkRequest(asked({ id: "agentv.music" })).error!, /local\./);
  assert.match(checkRequest(asked({ id: "local.blocks/../../etc" })).error!, /local\./);
  assert.match(checkRequest(asked({ version: "../1" })).error!, /version/);
  assert.match(checkRequest(asked({ recipe: "anything" })).error!, /recipe/);
  assert.match(checkRequest(asked({ recipe: null })).error!, /no recipe fits/, "no recipe and no approved plan builds nothing");
  assert.match(checkRequest(asked({ provider: "gemini", path: "plan" })).error!, /google/);
  assert.match(checkRequest(asked({ cap: { build: 1e9, month: 20 } })).error!, /cap/);
  assert.match(checkRequest(asked({ from: "../../x" })).error!, /another version/);
  assert.equal(checkRequest(asked({ sentence: "a game\u0000 like tetris" })).request!.sentence, "a game  like tetris");
});

test("a build's unit is named the way systemd-escape --path names it", () => {
  assert.equal(escapePath("local.blocks/1.0.0"), "local.blocks-1.0.0");
  assert.equal(escapePath("local.my-app/1.2.3"), "local.my\\x2dapp-1.2.3");
});

function handOver(name: string, running = false) {
  const base = join(scratch, name);
  const o = {
    drop: join(base, "drop"),
    builds: join(base, "build"),
    apps: join(base, "apps"),
    home: join(base, "home"),
    run: join(base, "run"),
    spend: join(base, "spend.json"),
    builder: { uid: process.getuid!(), gid: process.getgid!() },
    rootUid: process.getuid!(),
    calls: [] as string[][],
  };
  mkdirSync(o.drop, { recursive: true });
  mkdirSync(join(o.home, ".local/bin"), { recursive: true });
  const h = new HandOver({
    ...o,
    systemctl: (args) => {
      o.calls.push(args);
      return args.includes("is-active") ? running : true;
    },
  });
  return { o, h };
}

test("root makes the build's folder, its request and the ticket, fetches the CLI the first time, and starts the sandbox", async () => {
  const { o, h } = handOver("start");
  writeFileSync(join(o.drop, "start.json"), JSON.stringify(asked()));
  writeFileSync(o.spend, JSON.stringify({ month: new Date().toISOString().slice(0, 7), spent: 3, builds: {} }));
  const done = await h.handle();
  assert.deepEqual(done, { started: true, reason: undefined });
  assert.ok(!existsSync(join(o.drop, "start.json")), "the drop is taken");
  const dir = join(o.builds, "local.blocks", "1.0.0");
  const saved = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
  assert.equal(saved.id, "local.blocks");
  assert.deepEqual(saved.budget, { build: 5, month: 20, spentMonth: 3 });
  const ticket = JSON.parse(readFileSync(join(o.run, "ticket.json"), "utf8"));
  assert.equal(ticket.dir, dir);
  assert.equal(ticket.phase, "build", "the way out knows the phase: only stage B sees signed-in pages");
  assert.deepEqual(ticket.cap, { build: 5, month: 20 });
  assert.deepEqual(o.calls.slice(1), [
    ["start", "agentv-builder-cli@claude.service"],
    ["restart", "agentv-build-net.service"],
    ["start", "--no-block", "agentv-builder@local.blocks-1.0.0.service"],
  ]);
  assert.equal(JSON.parse(readFileSync(join(o.run, "answer.json"), "utf8")).started, true);
});

test("H2 stage B's ticket carries the origins approved with the app, from root's copy of it, not from the build's state", async () => {
  const { o, h } = handOver("stage-b");
  writeFileSync(join(o.home, ".local/bin/claude"), "");
  const dir = join(o.builds, "local.stand-in", "1.0.0");
  mkdirSync(dir, { recursive: true });
  // The build's own folder says more than was approved.
  writeFileSync(join(dir, "state.json"), JSON.stringify({ origins: [{ origin: "https://stand-in.test", why: "its pages" }, { origin: "https://late.example", why: "after approval" }] }));
  const stageB = asked({ id: "local.stand-in", phase: "stage-b", recipe: "streaming", name: "Stand-in" });

  // Not on home: nothing to go on with.
  writeFileSync(join(o.drop, "start.json"), JSON.stringify(stageB));
  assert.match((await h.handle())!.reason!, /isn't on home at this version/);
  assert.ok(!existsSync(join(o.run, "ticket.json")));

  // On home, as root installed it after an adult's yes.
  mkdirSync(join(o.apps, "local.stand-in"), { recursive: true });
  writeFileSync(join(o.apps, "installed.json"), JSON.stringify({ "local.stand-in": { id: "local.stand-in", name: "Stand-in", version: "1.0.0", tier: "local", installedAt: "" } }));
  writeFileSync(join(o.apps, "local.stand-in", "manifest.json"), JSON.stringify({ id: "local.stand-in", version: "1.0.0", tv: { origins: ["https://stand-in.test"] } }));
  writeFileSync(join(o.drop, "start.json"), JSON.stringify(stageB));
  assert.equal((await h.handle())!.started, true);
  const ticket = JSON.parse(readFileSync(join(o.run, "ticket.json"), "utf8"));
  assert.deepEqual([ticket.phase, ticket.origins], ["stage-b", ["https://stand-in.test"]]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "request.json"), "utf8")).origins, ["https://stand-in.test"]);
  // The way out goes by that ticket alone.
  assert.ok(!allowed(ticket, declaredBy(ticket, join(ROOT, "builder/recipes"))).has("late.example:443"));

  // Another version on home isn't this build's approval.
  writeFileSync(join(o.apps, "local.stand-in", "manifest.json"), JSON.stringify({ id: "local.stand-in", version: "1.1.0", tv: { origins: ["https://stand-in.test"] } }));
  assert.equal(h.approvedOrigins("local.stand-in", "1.0.0"), null);
  // A stage A build's ticket has no such list: what it declares is live at once.
  const { o: a, h: first } = handOver("stage-a");
  writeFileSync(join(a.drop, "start.json"), JSON.stringify(asked({ id: "local.stand-in", recipe: "streaming" })));
  assert.equal((await first.handle())!.started, true);
  assert.equal(JSON.parse(readFileSync(join(a.run, "ticket.json"), "utf8")).origins, undefined);
});

test("a new build starts from an empty folder, whatever an earlier try left there", async () => {
  const { o, h } = handOver("again");
  const dir = join(o.builds, "local.blocks", "1.0.0");
  mkdirSync(join(o.builds, "local.blocks"), { recursive: true });
  mkdirSync(dir);
  writeFileSync(join(dir, "state.json"), JSON.stringify({ understood: { name: "Old", recipe: "game", says: "an earlier try" } }));
  writeFileSync(join(o.home, ".local/bin/claude"), "");
  writeFileSync(join(o.drop, "start.json"), JSON.stringify(asked({ phase: "understand" })));
  assert.equal((await h.handle())!.started, true);
  assert.ok(!existsSync(join(dir, "state.json")));
  assert.ok(existsSync(join(dir, "request.json")));
});

test("root starts one build at a time, and stops the running one when asked", async () => {
  const { o, h } = handOver("busy", true);
  writeFileSync(join(o.drop, "start.json"), JSON.stringify(asked()));
  assert.match((await h.handle())!.reason!, /one runs at a time/);
  assert.ok(!o.calls.some((call) => call.includes("agentv-builder@local.blocks-1.0.0.service")));
  writeFileSync(join(o.drop, "stop.json"), "{}");
  await h.handle();
  assert.deepEqual(o.calls.at(-1), ["stop", "--no-block", "agentv-builder@*.service", "agentv-builder-sign-in@*.service"]);
});

test("a change starts from a copy of the version it changes, in the build's own folder", async () => {
  const { o, h } = handOver("change");
  mkdirSync(join(o.builds, "local.blocks", "1.0.0", "work", "app"), { recursive: true });
  writeFileSync(join(o.builds, "local.blocks", "1.0.0", "work", "app", "main.js"), "// 1.0.0");
  writeFileSync(join(o.home, ".local/bin/claude"), "");
  writeFileSync(join(o.drop, "start.json"), JSON.stringify(asked({ version: "1.0.1", from: "1.0.0", change: "make it faster" })));
  assert.equal((await h.handle())!.started, true);
  const dir = join(o.builds, "local.blocks", "1.0.1");
  assert.equal(readFileSync(join(dir, "from", "work", "app", "main.js"), "utf8"), "// 1.0.0");
  assert.equal(JSON.parse(readFileSync(join(dir, "request.json"), "utf8")).from, join(dir, "from"));
  assert.ok(!o.calls.some((call) => call[1]?.startsWith("agentv-builder-cli@")), "the CLI is there already");
});

test("root won't follow what a build left behind: a swapped app folder or a pointed drop", async () => {
  const { o, h } = handOver("swapped");
  mkdirSync(o.builds, { recursive: true });
  mkdirSync(join(scratch, "elsewhere"), { recursive: true });
  symlinkSync(join(scratch, "elsewhere"), join(o.builds, "local.blocks"));
  writeFileSync(join(o.drop, "start.json"), JSON.stringify(asked()));
  assert.match((await h.handle())!.reason!, /root's/);
  assert.ok(!existsSync(join(scratch, "elsewhere", "1.0.0")));

  const pointed = handOver("pointed");
  writeFileSync(join(scratch, "a-request.json"), JSON.stringify(asked()));
  symlinkSync(join(scratch, "a-request.json"), join(pointed.o.drop, "start.json"));
  assert.equal((await pointed.h.handle())!.started, false);
  assert.ok(!lstatSync(join(scratch, "a-request.json")).isSymbolicLink());
});

test("a refused request says why in its build's status", async () => {
  const { o, h } = handOver("refused");
  // The CLI can't be fetched.
  const failing = new HandOver({ ...o, systemctl: (args) => !args[1]?.startsWith("agentv-builder-cli@") && !args.includes("is-active") });
  writeFileSync(join(o.drop, "start.json"), JSON.stringify(asked()));
  assert.match((await failing.handle())!.reason!, /couldn't fetch claude/);
  const status = JSON.parse(readFileSync(join(o.builds, "local.blocks", "1.0.0", "status.json"), "utf8"));
  assert.equal(status.state, "failed");
  assert.ok(!existsSync(join(o.run, "ticket.json")), "no ticket stays behind");
  void h;
});

// --- The units' sandbox ----------------------------------------------------

// A unit's settings, as systemd reads them.
function unit(name: string): Map<string, string[]> {
  const settings = new Map<string, string[]>();
  for (const line of readFileSync(join(ROOT, "system", name), "utf8").split("\n")) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (match) settings.set(match[1], [...(settings.get(match[1]) ?? []), match[2]]);
  }
  return settings;
}

// Whether every path a unit lists is inside the builder's own home: the
// writable folders it keeps there, between the read-only ones (H3).
const insideHome = (lines: string[] | undefined) => (lines ?? []).join(" ").split(" ").filter(Boolean).every((path) => path.startsWith("-/var/lib/agentv/builder/"));

test("S6.3 the builder's sandbox stays as tight as it is: no sudo, no key, no network of its own, no other service's state", () => {
  const u = unit("agentv-builder@.service");
  const one = (key: string) => u.get(key)?.join(" ");
  assert.equal(one("User"), "agentv-builder");
  for (const [key, value] of Object.entries({
    NoNewPrivileges: "yes",
    PrivateNetwork: "yes",
    ProtectSystem: "strict",
    ProtectHome: "yes",
    PrivateDevices: "yes",
    TemporaryFileSystem: "/var/lib:ro /tmp:nosuid,nodev,mode=1777 /var/tmp:nosuid,nodev,mode=1777",
    CapabilityBoundingSet: "",
  })) {
    assert.equal(one(key), value, `${key}=${value}`);
  }
  assert.equal(one("BindPaths"), "/var/lib/agentv/build/%I /var/lib/agentv/builder", "it writes its build and its own home, nothing else");
  assert.ok(one("InaccessiblePaths")!.split(" ").includes("-/etc/agentv"), "the keys are out of its sight");
  assert.ok(insideHome(u.get("ReadWritePaths")) && !u.has("LoadCredential") && !u.has("EnvironmentFile"), "it's given nothing more to write than its home, and no credential");

  // A plan's sign-in runs in the same sandbox, and writes only its own folder.
  const signIn = unit("agentv-builder-sign-in@.service");
  for (const key of ["User", "NoNewPrivileges", "PrivateNetwork", "ProtectSystem", "ProtectHome", "PrivateDevices", "TemporaryFileSystem", "CapabilityBoundingSet", "InaccessiblePaths", "ProtectProc"]) {
    assert.deepEqual(signIn.get(key), u.get(key), `the sign-in's ${key} is the build's`);
  }
  // It runs no bubblewrap, so it keeps RestrictSUIDSGID= too (ADR-052), and
  // the builder's home it writes is the nosuid mount.
  assert.equal(signIn.get("RestrictSUIDSGID")?.[0], "yes");
  assert.ok(!signIn.has("PrivateTmp"));
  assert.deepEqual(signIn.get("RequiresMountsFor"), ["/var/lib/agentv/builder"]);
  assert.equal(signIn.get("BindPaths")?.join(" "), "/var/lib/agentv/builder /run/agentv-build/sign-in");
  assert.ok(!signIn.has("ReadWritePaths") && !signIn.has("LoadCredential") && !signIn.has("EnvironmentFile"));

  const net = unit("agentv-build-net.service");
  assert.equal(net.get("User")?.[0], "agentv-build-net", "the key goes to the relay's own user");
  assert.deepEqual(net.get("LoadCredential"), ["env:/etc/agentv/env"]);

  const users = readFileSync(join(ROOT, "system/sysusers/agentv-builder.conf"), "utf8");
  assert.ok(!/wheel|sudo|adm\b/.test(users.replace(/^#.*$/gm, "")), "the builder's in no admin group");
});

test("S6.10 everything the builder can write is mounted nosuid and nodev: its build, its home, its /tmp and its /var/tmp", () => {
  const u = unit("agentv-builder@.service");
  const binds = u.get("BindPaths")!.join(" ").split(" ");
  assert.deepEqual(u.get("RequiresMountsFor")?.join(" ").split(" "), binds, "a build waits for the mounts its folders come from");
  // Each folder it binds comes from a mount of its own for the whole box,
  // on itself, nosuid and nodev, there from boot. A bind keeps the flags of
  // the mount it comes from.
  for (const path of ["/var/lib/agentv/build", "/var/lib/agentv/builder"]) {
    assert.ok(binds.some((bind) => bind === path || bind.startsWith(`${path}/`)), `it binds ${path} or a folder in it`);
    const name = `${path.slice(1).replaceAll("/", "-")}.mount`;
    const mount = unit(name);
    assert.equal(mount.get("What")?.[0], path, `${name} mounts ${path}`);
    assert.equal(mount.get("Where")?.[0], path, `${name} mounts it on itself`);
    assert.deepEqual(mount.get("Options")?.[0]?.split(",").sort(), ["bind", "nodev", "nosuid"], `${name} is nosuid and nodev`);
    assert.equal(mount.get("WantedBy")?.[0], "local-fs.target", `${name} is there from boot`);
  }
  // Its /tmp and /var/tmp are its own, nosuid and nodev. PrivateTmp= would
  // keep its /var/tmp on the box's /var, where set-user-ID bits count.
  const tmp = u.get("TemporaryFileSystem")!.join(" ").split(" ");
  for (const path of ["/tmp", "/var/tmp"]) {
    const options = tmp.find((entry) => entry.startsWith(`${path}:`))?.split(":")[1]?.split(",") ?? [];
    assert.ok(options.includes("nosuid") && options.includes("nodev"), `its ${path} is nosuid and nodev`);
  }
  assert.ok(!u.has("PrivateTmp"));
  // RestrictSUIDSGID= filters out openat2(), which bubblewrap needs, and the
  // mounts above do its work instead (ADR-052).
  assert.ok(!u.has("RestrictSUIDSGID"), "bubblewrap can open what it binds");
  assert.ok(insideHome(u.get("ReadWritePaths")) && !u.has("StateDirectory") && !u.has("CacheDirectory") && !u.has("RuntimeDirectory"), "it's given nothing else to write");
});

test("M5 a build's folder and what's saved in it aren't for every user on the box: the builder and its group, which the readers are in", async () => {
  // The build writes its files closed to others.
  assert.deepEqual(unit("agentv-builder@.service").get("UMask"), ["0027"]);
  // Root makes a version's folder 0750, and closes one made before.
  const { o, h } = handOver("modes");
  writeFileSync(join(o.home, ".local/bin/claude"), "");
  writeFileSync(join(o.drop, "start.json"), JSON.stringify(asked()));
  assert.equal((await h.handle())!.started, true);
  const dir = join(o.builds, "local.blocks", "1.0.0");
  assert.equal(lstatSync(dir).mode & 0o777, 0o750);
  chmodSync(dir, 0o755);
  writeFileSync(join(o.drop, "start.json"), JSON.stringify(asked()));
  assert.equal((await h.handle())!.started, true);
  assert.equal(lstatSync(dir).mode & 0o777, 0o750, "one from before is closed at its next start");
  // And the builder's own files in it, whatever the umask.
  const build = new Build(dir);
  build.setState({ origins: [] });
  build.setStatus({ build: "b1", id: "local.blocks", version: "1.0.0", phase: "build", state: "running", steps: [], started: "", at: "" });
  for (const name of ["state.json", "status.json"]) assert.equal(lstatSync(join(dir, name)).mode & 0o007, 0, `${name} isn't for others`);

  // Who reads builds: the daemon and the builder's way out (its filter and
  // the nightly package check), through the builder's group.
  assert.ok(unit("agentv-daemon.service").get("SupplementaryGroups")![0].split(" ").includes("agentv-builder"), "the daemon reads a build's status and screenshot");
  const users = readFileSync(join(ROOT, "system/sysusers/agentv-builder.conf"), "utf8").split("\n");
  assert.ok(users.includes("m agentv-build-net agentv-builder"), "the way out reads a build's state and lockfile");
  for (const name of ["agentv-build-net.service", "agentv-npm-check.service"]) assert.deepEqual(unit(name).get("User"), ["agentv-build-net"], name);
  // The group opens nothing else: the builder's home stays its own.
  const folders = readFileSync(join(ROOT, "system/tmpfiles/agentv-builder.conf"), "utf8").split("\n");
  assert.ok(folders.includes("d /var/lib/agentv/builder 0700 agentv-builder agentv-builder -"));
  assert.ok(folders.includes("f /etc/agentv/env 0600 root root -"));

  // Boxes installed before close the folders they have.
  const migrations = join(ROOT, "migrations/agentv");
  const closes = readdirSync(migrations).filter((name) => /find \/var\/lib\/agentv\/build -mindepth 2 -maxdepth 2 -type d -exec chmod 0750/.test(readFileSync(join(migrations, name), "utf8")));
  assert.equal(closes.length, 1, "a migration closes the builds a box already has");
});

test("H3 a build can't change the CLI, mise's tree or the CLI's own settings in the builder's home, and nor can the voice router's run", () => {
  const home = "/var/lib/agentv/builder";
  const made = readFileSync(join(ROOT, "system/tmpfiles/agentv-builder.conf"), "utf8").split("\n");
  for (const name of ["agentv-builder@.service", "agentv-router-cli.service"]) {
    const u = unit(name);
    const list = (key: string) => (u.get(key) ?? []).join(" ").split(" ").filter(Boolean);
    const readOnly = list("ReadOnlyPaths");
    const writable = list("ReadWritePaths");
    // The CLI's binaries and mise's tree, and no way to move a folder on
    // the way aside: ~/.local and ~/.config are read-only as a whole.
    for (const path of [".local", ".config", ".local/share/mise", ".local/state/mise", ".claude/settings.json"]) assert.ok(readOnly.includes(`-${home}/${path}`), `${name}: ~/${path} is read-only`);
    // Only what a CLI writes as it runs is writable again, each a mount of
    // its own, so it can't be renamed either.
    assert.deepEqual(writable.sort(), [".claude", ".config/muse", ".local/share", ".local/state"].map((path) => `-${home}/${path}`).sort(), name);
    assert.ok(!writable.some((path) => /\/\.local\/bin|mise|settings\.json/.test(path)), `${name}: never the CLI, mise or the settings`);
    assert.ok(u.get("BindPaths")!.join(" ").split(" ").includes(home), `${name}: its home is still the one it runs in`);
    // Each of those is there before any build is, so no line is skipped.
    for (const path of [...readOnly, ...writable].map((entry) => entry.slice(1))) {
      const line = made.find((entry) => entry.split(/\s+/)[1] === path);
      assert.ok(line, `tmpfiles makes ${path}`);
      assert.equal(line!.split(/\s+/).slice(3, 5).join(":"), "agentv-builder:agentv-builder", path);
    }
  }
  assert.ok(made.includes("f /var/lib/agentv/builder/.claude/settings.json 0600 agentv-builder agentv-builder - {}"), "the CLI's settings start empty");

  // A sign-in writes the plan's sign-in and the fetch writes the CLI, so
  // those two keep the home as it was. Neither runs anything of a build's.
  for (const name of ["agentv-builder-sign-in@.service", "agentv-builder-cli@.service"]) assert.ok(!unit(name).has("ReadOnlyPaths"), name);
  // The fetch starts mise from /, so it reads no config a build left in the home.
  const fetch = readFileSync(join(ROOT, "builder/sandbox/fetch-cli.sh"), "utf8");
  assert.ok(fetch.indexOf("\ncd /\n") > 0 && fetch.indexOf("\ncd /\n") < fetch.indexOf("mise use"), "fetch-cli.sh leaves the home before it runs mise");
  // Boxes installed before get the folders too.
  const migrations = join(ROOT, "migrations/agentv");
  assert.ok(readdirSync(migrations).some((name) => readFileSync(join(migrations, name), "utf8").includes("systemd-tmpfiles --create agentv-builder.conf")));
});
