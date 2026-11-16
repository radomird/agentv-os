// How much of a plan is used, in % (ADR-103, Q313, T19.1): Omarchy's own
// usage check, as the plan router's service runs it as the builder
// (daemon/plan-usage.ts, daemon/router-serve.ts), hands back only the
// windows: the 5 hours, the week and, for a plan that counts by the month,
// the month. The daemon asks for them now and then and keeps the answer a
// little while. A build on a plan carries no dollar amount to any screen.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PlanUsages, usageCommand, usageWindows, type UsageWindow } from "../../../daemon/plan-usage.ts";
import { usageViaSocket } from "../../../daemon/router-client.ts";
import { routeServer, USAGE_PER_MINUTE } from "../../../daemon/router-serve.ts";
import { Builds } from "../../../daemon/builds.ts";

const scratch = mkdtempSync(join(tmpdir(), "origaitv-plan-usage-"));
const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
  rmSync(scratch, { recursive: true, force: true });
});

// What omarchy-agent-usage-claude prints, as its panel reads it: the plan's
// two windows, a model's own allowance, and much more besides.
const CLAUDE = JSON.stringify({
  id: "claude",
  name: "Claude Code",
  tierLabel: "Max",
  accountEmail: "someone@example.com",
  totalPrompts: 4321,
  modelUsage: { "claude-opus-5-5": { inputTokens: 99 } },
  limits: [
    { label: "Session (5-hour)", percent: 0.234, resetsAt: "2026-11-16T17:00:00+00:00" },
    { label: "Weekly (7-day)", percent: 0.41, resetsAt: "2026-11-20T09:00:00+00:00" },
    { label: "Fable Weekly", title: "Fable Weekly", percent: 0.9, resetsAt: "2026-11-20T09:00:00+00:00" },
  ],
});

test("T19.1 only the windows leave the check: the 5 hours and the week, in whole %, with when each starts over, and nothing else it says", () => {
  const windows = usageWindows(CLAUDE)!;
  assert.deepEqual(windows, [
    { window: "hours", hours: 5, percent: 23, resets: "2026-11-16T17:00:00.000Z" },
    { window: "week", percent: 41, resets: "2026-11-20T09:00:00.000Z" },
  ]);
  for (const kept of ["someone@example.com", "Max", "4321", "opus", "Fable"]) assert.ok(!JSON.stringify(windows).includes(kept), kept);
  // Codex's: a 5-hour window by its minutes, and the week; a spend cap isn't a window.
  assert.deepEqual(usageWindows(JSON.stringify({ limits: [{ label: "Weekly (7-day)", percent: 1.4, resetsAt: "" }, { label: "5h window", percent: 0.05, resetsAt: "2026-11-16T17:00:00+00:00" }, { label: "Spend limit", title: "Spend limit", percent: 0.5 }] })), [
    { window: "hours", hours: 5, percent: 5, resets: "2026-11-16T17:00:00.000Z" },
    { window: "week", percent: 100 },
  ]);
  // Grok's: a week of credits, and the month's quota.
  assert.deepEqual(usageWindows(JSON.stringify({ limits: [{ label: "Weekly", percent: 0.5, resetsAt: "2026-11-20T00:00:00+00:00" }, { label: "Monthly", percent: 0.1, resetsAt: "2026-12-01T00:00:00+00:00" }] }))!.map((w) => [w.window, w.percent]), [
    ["week", 50],
    ["month", 10],
  ]);
  // Nothing to say: signed out, a garbled line, or no limits at all.
  assert.equal(usageWindows(JSON.stringify({ limits: [], usageStatusText: "Waiting for auth" })), null);
  assert.equal(usageWindows("Traceback (most recent call last):"), null);
  assert.equal(usageWindows(JSON.stringify({ limits: [{ label: "Session (5-hour)", percent: "lots" }] })), null);
});

test("T19.1 the check runs from the builder's home, with the CLI's own folders in it and the service's one way out", () => {
  const home = "/var/lib/origaitv/builder";
  const claude = usageCommand("claude", { home, proxy: "http://127.0.0.1:8080" });
  assert.equal(claude.command, "/usr/share/omarchy/bin/omarchy-agent-usage-claude");
  assert.deepEqual(claude.args, ["--limits-only"]);
  assert.equal(claude.env.HOME, home);
  assert.equal(claude.env.CLAUDE_CONFIG_DIR, `${home}/.claude`);
  assert.equal(claude.env.OMARCHY_PATH, "/usr/share/omarchy");
  assert.equal(claude.env.HTTPS_PROXY, "http://127.0.0.1:8080");
  assert.equal(usageCommand("chatgpt", { home }).command, "/usr/share/omarchy/bin/omarchy-agent-usage-codex");
  assert.equal(usageCommand("chatgpt", { home }).env.CODEX_HOME, `${home}/.codex`);
  assert.equal(usageCommand("grok", { home }).env.GROK_HOME, `${home}/.grok`);
  assert.ok(!Object.keys(claude.env).some((name) => /API_KEY|TOKEN/.test(name)), "no key of any kind");
});

test("T19.1 the plan's service answers POST /usage with the windows, for a plan it knows, at most ten a minute; the key's service has no such route", async () => {
  const asked: string[] = [];
  const windows: UsageWindow[] = [{ window: "hours", hours: 5, percent: 23 }];
  const path = join(scratch, "cli.sock");
  const server = routeServer({ path: "plan", route: async () => { throw new Error("not asked"); }, usage: async (provider) => (asked.push(provider), provider === "grok" ? null : windows) });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  assert.deepEqual(await usageViaSocket(path, "claude"), windows);
  assert.equal(await usageViaSocket(path, "grok"), null, "a check with nothing to say");
  assert.equal(await usageViaSocket(path, "gemini" as "claude"), null, "Google's plan isn't offered");
  assert.deepEqual(asked, ["claude", "grok"]);
  for (let i = asked.length; i < USAGE_PER_MINUTE + 2; i++) await usageViaSocket(path, "claude");
  assert.equal(asked.length, USAGE_PER_MINUTE, "a stuck page can't run the check over and over");
  const api = join(scratch, "api.sock");
  const apiServer = routeServer({ route: async () => { throw new Error("not asked"); } });
  servers.push(apiServer);
  await new Promise<void>((resolve) => apiServer.listen(api, () => resolve()));
  assert.equal(await usageViaSocket(api, "claude"), null);
  assert.equal(await usageViaSocket(join(scratch, "nothing.sock"), "claude"), null, "no service: nothing to say");
});

test("T19.1 the daemon keeps an answer two minutes and a missing one half a minute, asks once for many, and asks again when told to", async () => {
  let now = 0;
  let asks = 0;
  let answer: UsageWindow[] | null = [{ window: "week", percent: 41 }];
  const usages = new PlanUsages({ ask: async () => (asks++, answer), now: () => now });
  assert.equal(await usages.get("gemini"), null, "no check for Google");
  assert.equal(await usages.get(null), null);
  const [one, two] = await Promise.all([usages.get("claude"), usages.get("claude")]);
  assert.deepEqual(one?.windows, [{ window: "week", percent: 41 }]);
  assert.equal(one, two);
  assert.equal(asks, 1);
  now = 119_000;
  await usages.get("claude");
  assert.equal(asks, 1);
  now = 121_000;
  answer = null;
  assert.equal(await usages.get("claude"), null);
  assert.equal(asks, 2);
  now = 140_000;
  await usages.get("claude");
  assert.equal(asks, 2, "a missing one is kept too, a little");
  answer = [{ window: "week", percent: 42 }];
  assert.equal((await usages.get("claude", true))?.windows[0].percent, 42);
  assert.equal(asks, 3);
});

test("T19.1 a build on a plan carries no dollar amount, though the CLI wrote its own estimate", async () => {
  const base = join(scratch, "box");
  const o = { state: join(base, "daemon"), drop: join(base, "daemon", "build-drop"), builds: join(base, "build"), run: join(base, "run"), spend: join(base, "spend.json"), warnings: join(base, "warnings.json") };
  mkdirSync(o.builds, { recursive: true });
  const builds = new Builds(o);
  const plan = await builds.ask("a game like tetris", { provider: "claude", path: "plan" });
  mkdirSync(join(o.builds, plan.build!.id, "1.0.0"), { recursive: true });
  writeFileSync(join(o.builds, plan.build!.id, "1.0.0", "status.json"), JSON.stringify({ build: plan.build!.build, id: plan.build!.id, version: "1.0.0", phase: "build", state: "running", steps: [], spent: 0.73, started: "", at: "" }));
  const view = (await builds.list())[0];
  assert.equal(view.spent, undefined);
  assert.ok(!JSON.stringify(view).includes("0.73"));
});
