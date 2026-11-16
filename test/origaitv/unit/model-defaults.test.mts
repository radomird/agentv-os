// The household's two models (ADR-103, Q312, T19.1): one for asking and one
// for building, kept with the AI in ai.json (daemon/ai.ts), each from the
// provider's list for the way in it uses, and the asking one sent to both
// router services, which take it only from that list (daemon/router-client.ts,
// daemon/router-serve.ts). Each provider keeps its own two.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { defaultModel, modelsFor } from "../../../builder/models.ts";
import { Ai, type AiState } from "../../../daemon/ai.ts";
import { cliCommand } from "../../../daemon/providers/cli.ts";
import { ROUTER_MODELS } from "../../../daemon/providers/index.ts";
import { boxRouter } from "../../../daemon/router-client.ts";
import { routeRequest, routeServer } from "../../../daemon/router-serve.ts";
import { NONE, type Ask } from "../../../daemon/router.ts";

const scratch = mkdtempSync(join(tmpdir(), "origaitv-model-defaults-"));
const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
  rmSync(scratch, { recursive: true, force: true });
});
let count = 0;

async function household(provider: "claude" | "chatgpt", path: "plan" | "key"): Promise<Ai> {
  const ai = new Ai({ state: join(scratch, `ai${++count}`) });
  assert.ok((await ai.choose(provider, path)).state);
  return ai;
}

test("T19.1 asking starts on Haiku 5.5 and building on Sonnet 5.5 for Claude, and each changes to another on Claude's list only", async () => {
  const ai = await household("claude", "plan");
  const first = (await ai.read()).models!;
  assert.deepEqual([first.ask, first.build], ["claude-haiku-5-5", "claude-sonnet-5-5"]);
  assert.deepEqual(first.list.map((m) => m.name), ["Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"], "strongest first");
  assert.deepEqual((await ai.setModel("ask", "claude-sonnet-5-5")).state!.models!.ask, "claude-sonnet-5-5");
  assert.deepEqual((await ai.setModel("build", "claude-opus-5-5")).state!.models!.build, "claude-opus-5-5");
  assert.equal((await ai.setModel("build", "gpt-6-astra")).error, "Pick a model from the list");
  assert.equal((await ai.setModel("build", "claude-opus-9")).error, "Pick a model from the list");
  assert.equal((await ai.setModel("spend", "claude-opus-5-5")).error, "for asking or for building");
  const kept = (await ai.read()).models!;
  assert.deepEqual([kept.ask, kept.build], ["claude-sonnet-5-5", "claude-opus-5-5"], "kept, and nothing refused changed it");
});

test("T19.1 each provider keeps its own two, and one the new way in doesn't offer goes back to where the provider starts", async () => {
  const ai = await household("claude", "plan");
  await ai.setModel("build", "claude-fable-5-2");
  await ai.choose("chatgpt", "plan");
  const chatgpt = (await ai.read()).models!;
  assert.deepEqual([chatgpt.ask, chatgpt.build], [defaultModel("chatgpt", "plan", "ask"), defaultModel("chatgpt", "plan", "build")]);
  await ai.choose("claude", "plan");
  assert.equal((await ai.read()).models!.build, "claude-fable-5-2", "Claude's own pick is there again");
  // With a key, Fable 5.2 isn't priced, so it can't be picked, and the pick
  // made on the plan doesn't carry over.
  await ai.choose("claude", "key");
  const key = (await ai.read()).models!;
  assert.equal(key.build, "claude-sonnet-5-5");
  assert.ok(!key.list.some((m) => m.id === "claude-fable-5-2"));
  assert.equal((await ai.setModel("build", "claude-fable-5-2")).error, "Pick a model from the list");
  // None picked, none to show.
  await ai.choose(null, undefined);
  assert.equal((await ai.read()).models, null);
});

test("T19.1 the router services take a model only from the provider's list for their own way in", () => {
  const asked = routeRequest({ provider: "claude", sentence: "play frozen", model: "claude-sonnet-5-5" }, "key");
  assert.ok(typeof asked !== "string");
  assert.equal(asked.model, "claude-sonnet-5-5");
  assert.equal(routeRequest({ provider: "claude", sentence: "play frozen", model: "claude-opus-9" }, "key"), "a model on the provider's list");
  assert.equal(routeRequest({ provider: "claude", sentence: "play frozen", model: "--help" }, "key"), "a model on the provider's list");
  assert.equal(routeRequest({ provider: "chatgpt", sentence: "play frozen", model: "gpt-6-luna" }, "key"), "a model on the provider's list", "a plan's model, at the key's service");
  assert.ok(typeof routeRequest({ provider: "chatgpt", sentence: "play frozen", model: "gpt-6-luna" }, "plan") !== "string");
  const none = routeRequest({ provider: "claude", sentence: "play frozen" });
  assert.ok(typeof none !== "string" && none.model === undefined, "none: the service's own");
  assert.deepEqual(ROUTER_MODELS, { claude: "claude-haiku-5-5", chatgpt: "gpt-5.6-luna", gemini: "gemini-3.8-flash", grok: "grok-4.7", muse: "muse-spark-1.3" }, "by key, the router starts where its evals ran");
});

test("T19.1 the daemon sends the household's asking model to the key's service and to the plan's", async () => {
  const heard: { via: string; model?: string }[] = [];
  const service = async (name: string, path: "plan" | "key") => {
    const socket = join(scratch, `${name}.sock`);
    const server = routeServer({ path, route: async (asked) => (heard.push({ via: name, model: asked.model }), { sentence: asked.sentence, route: { ...NONE }, provider: asked.provider, via: name as "api" | "cli", model: asked.model ?? null, ms: 1 }) });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
    return socket;
  };
  const sockets = { api: await service("api", "key"), cli: await service("cli", "plan") };
  const accepted = { provider: "claude" as const, path: "key" as const, terms: [], read: "2026-10-26", by: { phone: "iphone", viewer: "radomir" }, at: "" };
  const models = (path: "plan" | "key", ask: string) => ({ ask, build: defaultModel("claude", path, "build"), list: modelsFor("claude", path) });
  let state: AiState = { provider: "claude", path: "key", accepted, cli: null, models: models("key", "claude-sonnet-5-5") };
  const route = boxRouter({ ai: async () => state, key: () => ({ set: true, provider: "claude" }), sockets });
  await route("play frozen", []);
  state = { ...state, path: "plan", accepted: { ...accepted, path: "plan" }, models: models("plan", "claude-fable-5-2") };
  await route("play frozen", []);
  assert.deepEqual(heard, [
    { via: "api", model: "claude-sonnet-5-5" },
    { via: "cli", model: "claude-fable-5-2" },
  ]);
});

test("T19.1 a plan's CLI asks on the household's model: Claude Code's --model, Codex's -m and Grok Build's --model", () => {
  const ask: Ask = { system: "the brief", user: "play frozen", schema: { type: "object" } } as unknown as Ask;
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  assert.equal(flag(cliCommand("claude", ask, { home: "/var/lib/origaitv/builder", work: "/tmp/route", model: "claude-sonnet-5-5" }).args, "--model"), "claude-sonnet-5-5");
  assert.equal(flag(cliCommand("chatgpt", ask, { home: "/var/lib/origaitv/builder", work: "/tmp/route", model: "gpt-6-luna" }).args, "-m"), "gpt-6-luna");
  assert.equal(flag(cliCommand("grok", ask, { home: "/var/lib/origaitv/builder", work: "/tmp/route", model: "grok-4.3" }).args, "--model"), "grok-4.3");
});
