// A model for each build (ADR-103, Q311, T19.1): the provider's short list
// (builder/models.ts), the model kept with the build from "Make X?" to
// start.json, root's check of it (builder/sandbox/hand-over.ts), and the
// flag each CLI is given for it (builder/providers.ts). A retry, a change
// and a rebuild keep it. The CLIs themselves run on the NUC and in the
// image layer's stand-in; here it's what they're given.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Provider } from "../../../builder/build.ts";
import { DEFAULT_MODELS, defaultModel, MODELS, modelsFor, offered } from "../../../builder/models.ts";
import { command, type StepRun } from "../../../builder/providers.ts";
import { rateFor } from "../../../builder/sandbox/prices.ts";
import { checkRequest } from "../../../builder/sandbox/hand-over.ts";
import { Builds, type BuildsOptions } from "../../../daemon/builds.ts";

const PROVIDERS: Provider[] = ["claude", "chatgpt", "gemini", "grok", "muse"];
const scratch = mkdtempSync(join(tmpdir(), "origaitv-build-model-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

function box(extra: Pick<BuildsOptions, "buildModel"> = {}) {
  const base = join(scratch, `box${++count}`);
  const o = { state: join(base, "daemon"), drop: join(base, "daemon", "build-drop"), builds: join(base, "build"), run: join(base, "run"), spend: join(base, "spend.json"), warnings: join(base, "warnings.json") };
  mkdirSync(o.builds, { recursive: true });
  let clock = Date.parse("2026-11-16T18:00:00Z");
  const builds = new Builds({ ...o, ...extra, now: () => new Date((clock += 1000)) });
  const drop = (name: string) => {
    const path = join(o.drop, `${name}.json`);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    rmSync(path);
    return data;
  };
  const status = (id: string, version: string, change: Record<string, unknown>) => {
    mkdirSync(join(o.builds, id, version), { recursive: true });
    writeFileSync(join(o.builds, id, version, "status.json"), JSON.stringify({ id, version, phase: "build", steps: [], started: "", at: "", ...change }));
  };
  return { builds, drop, status };
}

const PLAN = { provider: "claude" as const, path: "plan" as const, model: "claude-sonnet-5-5" };

test("T19.1 each provider's list is short and strongest first, with its two defaults on it, and a key offers only what the relay prices", () => {
  for (const provider of PROVIDERS) {
    assert.equal(new Set(MODELS[provider].map((m) => m.id)).size, MODELS[provider].length, `${provider}: no model twice`);
    for (const model of MODELS[provider]) assert.ok(model.name && !/^[a-z]/.test(model.name), `${provider}: ${model.id} has the provider's own name`);
    for (const path of ["plan", "key"] as const) {
      const ids = modelsFor(provider, path).map((m) => m.id);
      assert.ok(ids.length >= 2 && ids.length <= 4, `${provider} by ${path}: a short list`);
      const { ask, build } = DEFAULT_MODELS[provider][path];
      assert.ok(ids.includes(ask), `${provider} by ${path}: asking starts on its list`);
      assert.ok(ids.includes(build), `${provider} by ${path}: building starts on its list`);
      assert.ok(ids.indexOf(build) <= ids.indexOf(ask), `${provider} by ${path}: building's never weaker than asking's`);
      assert.equal(defaultModel(provider, path, "build"), build);
      for (const model of [ask, build]) assert.ok(!MODELS[provider].find((m) => m.id === model)?.costsExtra, `${provider} by ${path}: one that can cost extra is never a default (Q324)`);
      if (path === "key") assert.ok(modelsFor(provider, path).every((m) => !m.costsExtra), `${provider}: nothing costs extra on a plan with a key`);
    }
    for (const model of modelsFor(provider, "key")) assert.ok(rateFor(provider, model.id), `${provider}: ${model.id} is priced`);
  }
  for (const path of ["plan", "key"] as const) assert.deepEqual(DEFAULT_MODELS.claude[path], { ask: "claude-haiku-5-5", build: "claude-sonnet-5-5" }, "Q312: Haiku 5.5 for asking, Sonnet 5.5 for building");
  assert.deepEqual(modelsFor("claude", "key").map((m) => m.name), ["Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"], "Fable 5.2 is priced for a key");
  assert.deepEqual(modelsFor("chatgpt", "key").map((m) => m.id), ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-luna"], "the GPT-6 line, and the model the router's evals ran on");
  assert.deepEqual(modelsFor("muse", "key").map((m) => m.id), ["muse-wonder-1.0", "muse-spark-1.3", "muse-ember-1.0"]);
  assert.deepEqual(modelsFor("claude", "plan").map((m) => m.name), ["Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
  assert.deepEqual(modelsFor("claude", "plan")[0], { id: "claude-fable-5-2", name: "Fable 5.2", costsExtra: "plan" }, "Q324: on a plan, Fable says it can cost extra");
});

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

test("T19.1 root takes a build's model only from its provider's list, and with a key only one the relay prices", () => {
  assert.equal(checkRequest(asked()).request!.model, undefined, "no model: the CLI's own");
  assert.equal(checkRequest(asked({ model: "claude-sonnet-5-5" })).request!.model, "claude-sonnet-5-5");
  assert.equal(checkRequest(asked({ model: "claude-haiku-5-5", path: "plan", cap: undefined })).request!.model, "claude-haiku-5-5");
  assert.match(checkRequest(asked({ model: "claude-opus-9" })).error!, /model on the provider's list/);
  assert.match(checkRequest(asked({ provider: "chatgpt", model: "gpt-5.5" })).error!, /relay prices/, "one the relay prices that isn't on the list");
  assert.match(checkRequest(asked({ provider: "chatgpt", path: "plan", cap: undefined, model: "gpt-5.6-luna" })).error!, /model on the provider's list/, "a key's own model, on a plan");
  assert.match(checkRequest(asked({ model: "gpt-5.6-sol" })).error!, /model on the provider's list/, "another provider's model");
  assert.match(checkRequest(asked({ model: "--dangerously-skip-permissions" })).error!, /model/, "nothing that reads as a flag");
  assert.match(checkRequest(asked({ model: 5 })).error!, /model/);
  // A model on a list the relay can't price is a plan's only.
  for (const provider of PROVIDERS) {
    for (const model of MODELS[provider].filter((m) => !rateFor(provider, m.id))) {
      assert.match(checkRequest(asked({ provider, model: model.id })).error!, /relay prices/, `${provider}: ${model.id} with a key`);
      if (provider !== "gemini" && model.only !== "key") assert.equal(checkRequest(asked({ provider, model: model.id, path: "plan", cap: undefined })).request!.model, model.id);
    }
  }
});

const step = (change: Partial<StepRun> = {}): StepRun => ({
  prompt: "The request: a game like tetris",
  brief: "OrigaiTV's brief",
  harness: { command: "/usr/bin/node", args: ["/usr/share/origaitv/builder/harness/server.ts", "/var/lib/origaitv/build/local.blocks/1.0.0", "design"] },
  cwd: "/var/lib/origaitv/build/local.blocks/1.0.0/work",
  turns: 30,
  budget: 4.5,
  home: "/var/lib/origaitv/builder",
  proxy: "http://127.0.0.1:8080",
  relay: "http://127.0.0.1:8081",
  path: "key",
  step: "design",
  ...change,
});

test("T19.1 each CLI is given the build's model on its command line, and none without one", () => {
  const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  for (const path of ["key", "plan"] as const) {
    assert.equal(flag(command("claude", step({ path, model: "claude-haiku-5-5" })).args, "--model"), "claude-haiku-5-5", path);
    assert.equal(flag(command("chatgpt", step({ path, model: "gpt-5.6-luna" })).args, "-m"), "gpt-5.6-luna", path);
    assert.equal(flag(command("gemini", step({ path, model: "gemini-3.8-flash" })).args, "-m"), "gemini-3.8-flash", path);
    assert.equal(flag(command("muse", step({ path, model: "muse-spark-1.3" })).args, "--model"), "muse-spark-1.3", path);
  }
  // Grok with a key reaches the relay through a model of OrigaiTV's, which
  // names the build's; with a plan, the flag.
  const grokKey = command("grok", step({ model: "grok-build-0.1" }));
  assert.match(grokKey.files!["/var/lib/origaitv/builder/.grok/config.toml"], /\[model\.origaitv\]\nmodel = "grok-build-0\.1"/);
  assert.ok(!grokKey.args.includes("--model"), "with a key, the relay's model stands");
  assert.equal(flag(command("grok", step({ path: "plan", model: "grok-4.7" })).args, "--model"), "grok-4.7");
  // No model: as before, each CLI's own.
  for (const provider of PROVIDERS) {
    const run = command(provider, step());
    assert.ok(!run.args.includes("--model") && !run.args.includes("-m"), provider);
  }
  assert.match(command("grok", step()).files!["/var/lib/origaitv/builder/.grok/config.toml"], /model = "grok-4\.7"/);
  // The stand-in hears it too, as the image layer's build does.
  assert.equal(command("claude", step({ standIn: "/tmp/recording.json", model: "claude-haiku-5-5" })).env.ORIGAITV_STAND_IN_MODEL, "claude-haiku-5-5");
});

test("T19.1 a build is understood on the household's model, made on the one picked at Make X?, and a retry, a change and a rebuild keep it", async () => {
  const { builds, drop, status } = box();
  const { build } = await builds.ask("a game like tetris", PLAN);
  assert.equal(build!.model, "claude-sonnet-5-5");
  assert.equal(drop("start").model, "claude-sonnet-5-5", "understanding runs on the household's model");
  status(build!.id, "1.0.0", { build: build!.build, phase: "understand", state: "confirm", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" } });
  const waiting = (await builds.list())[0];
  assert.deepEqual(waiting.models, modelsFor("claude", "plan"), "Make X? offers the list");
  assert.equal((await builds.confirm(build!.build, "claude-opus-9")).error, "Pick a model from the list");
  assert.equal(drop("start"), null, "nothing starts on a model that isn't offered");
  await builds.confirm(build!.build, "claude-haiku-5-5");
  const made = drop("start");
  assert.deepEqual([made.phase, made.model], ["build", "claude-haiku-5-5"]);
  status(build!.id, "1.0.0", { build: build!.build, phase: "build", state: "running", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" } });
  assert.equal((await builds.list())[0].models, undefined, "the list goes once it's confirmed");

  // It failed: the retry is on the same model.
  status(build!.id, "1.0.0", { build: build!.build, phase: "build", state: "failed", reason: "design: it didn't finish", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" } });
  await builds.retry(build!.build);
  assert.equal(drop("start").model, "claude-haiku-5-5");

  // Installed: a change and a rebuild keep the model it was made on.
  status(build!.id, "1.0.0", { build: build!.build, phase: "build", state: "installed", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" } });
  const changed = await builds.next(build!.id, "make it blue", PLAN);
  assert.equal(changed.build!.model, "claude-haiku-5-5");
  assert.equal(drop("start").model, "claude-haiku-5-5");
  status(build!.id, "1.1.0", { build: changed.build!.build, phase: "build", state: "installed", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" } });
  status(build!.id, "1.0.0", { build: build!.build, phase: "build", state: "kept", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" } });
  const again = await builds.next(build!.id, undefined, PLAN);
  assert.equal(drop("start").model, "claude-haiku-5-5", `a rebuild of ${again.build!.version} too`);

  // Another provider since: its own default, not a model it doesn't have.
  status(build!.id, "1.2.0", { build: again.build!.build, phase: "build", state: "installed", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" } });
  status(build!.id, "1.1.0", { build: changed.build!.build, phase: "build", state: "kept", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" } });
  await builds.next(build!.id, "make it red", { provider: "chatgpt", path: "plan", model: DEFAULT_MODELS.chatgpt.plan.build });
  assert.equal(drop("start").model, DEFAULT_MODELS.chatgpt.plan.build);
});

test("T19.1 a build with no model of its own shows the household's for building at Make X?, and is made on it when none is picked", async () => {
  const { builds, drop, status } = box({ buildModel: async (provider, path) => (provider === "claude" && path === "plan" ? "claude-sonnet-5-5" : undefined) });
  // As from before models were kept: the build has none.
  const { build } = await builds.ask("a game like tetris", { provider: "claude", path: "plan" });
  assert.equal(drop("start").model, undefined);
  status(build!.id, "1.0.0", { build: build!.build, phase: "understand", state: "confirm", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" } });
  assert.equal((await builds.list())[0].model, "claude-sonnet-5-5", "the TV and the phone both show the household's");
  await builds.confirm(build!.build);
  assert.equal(drop("start").model, "claude-sonnet-5-5", "and it's made on it");
});

test("T19.1 with a key, a model the relay can't price isn't kept, and the CLI's own is used", async () => {
  const unpriced = PROVIDERS.flatMap((provider) => MODELS[provider].filter((m) => !rateFor(provider, m.id)).map((m) => ({ provider, model: m.id })))[0];
  const { builds, drop } = box();
  if (unpriced) {
    await builds.ask("a game like tetris", { provider: unpriced.provider, path: "key", model: unpriced.model });
    assert.equal(drop("start").model, undefined);
  }
  const listed = box();
  await listed.builds.ask("a game like tetris", { provider: "claude", path: "key", model: "claude-opus-9" });
  assert.equal(listed.drop("start").model, undefined, "nor one that isn't on the list");
});
