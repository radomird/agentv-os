// How much of a plan is used, in % (ADR-103, Q313, T19.1): Omarchy's own
// usage check, as the plan router's service runs it as the builder
// (daemon/plan-usage.ts, daemon/router-serve.ts), hands back only the
// windows: the 5 hours, the week and, for a plan that counts by the month,
// the month, measured just now, or kept while the limits are paused, with
// when they were read. Other old numbers aren't shown, and a sign-in that
// ran out says so. The
// daemon asks for them now and then and keeps the answer a little while. A
// build on a plan carries no dollar amount to any screen.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { PlanUsages, usageAnswer, usageCommand, usageWindows, type UsageReply, type UsageWindow } from "../../../daemon/plan-usage.ts";
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

// Omarchy's own checks, as the plan's service runs them (usageCommand), on
// homes made here: what they print is what the box gets.
const OMARCHY = fileURLToPath(new URL("../../..", import.meta.url));
function realCheck(provider: "claude" | "chatgpt", home: string): string {
  const run = usageCommand(provider, { home, omarchy: OMARCHY });
  return execFileSync(run.command, run.args, { env: run.env, cwd: home, encoding: "utf8", timeout: 60_000 });
}
function claudeHome(name: string, o: { access?: number; refresh?: number; keptAgo?: number }): string {
  const home = join(scratch, name);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  const now = Date.now();
  if (o.access !== undefined) {
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-stand-in", expiresAt: now + o.access, refreshTokenExpiresAt: now + (o.refresh ?? 86_400_000), subscriptionType: "max" } }));
  }
  if (o.keptAgo !== undefined) {
    mkdirSync(join(home, ".cache", "omarchy", "agent-usage"), { recursive: true });
    const limits = [
      { label: "Session (5-hour)", percent: 0.23, resetsAt: "2030-01-01T10:00:00+00:00" },
      { label: "Weekly (7-day)", percent: 0.41, resetsAt: "2030-01-04T10:00:00+00:00" },
    ];
    writeFileSync(join(home, ".cache", "omarchy", "agent-usage", "claude-limits.json"), JSON.stringify({ fetchedAtMs: now - o.keptAgo, limits }));
  }
  return home;
}

test("T19.1 Omarchy's own check: numbers measured just now are shown, and kept ones while the limits are paused with when they were read; other old ones aren't, and a sign-in that ran out or was never done says so", () => {
  // Measured a moment ago, with a sign-in that's good: the check reuses
  // them rather than ask again, and they're today's.
  const fresh = realCheck("claude", claudeHome("fresh", { access: 3_600_000, keptAgo: 5_000 }));
  assert.equal(JSON.parse(fresh).limitsStale, false);
  assert.deepEqual(usageAnswer(fresh).reply, { windows: [{ window: "hours", hours: 5, percent: 23, resets: "2030-01-01T10:00:00.000Z" }, { window: "week", percent: 41, resets: "2030-01-04T10:00:00.000Z" }] });
  // The token lapsed, the sign-in itself still good: the check prints the
  // numbers it kept, marked stale, and "Limits paused". They're shown, with
  // when they were read (Q341).
  const paused = realCheck("claude", claudeHome("paused", { access: -3_600_000, keptAgo: 7_200_000 }));
  const record = JSON.parse(paused);
  assert.equal(record.usageStatusText, "Limits paused");
  assert.equal(record.limitsStale, true);
  assert.deepEqual(usageAnswer(paused), {
    reply: { windows: [{ window: "hours", hours: 5, percent: 23, resets: "2030-01-01T10:00:00.000Z" }, { window: "week", percent: 41, resets: "2030-01-04T10:00:00.000Z" }], asOf: new Date(record.limitsFetchedAt).toISOString() },
    said: "kept numbers, limits paused",
  });
  assert.ok(Math.abs(Date.parse((usageAnswer(paused).reply as { asOf: string }).asOf) - (Date.now() - 7_200_000)) < 60_000, "read two hours ago");
  // Old numbers for any other reason aren't shown.
  assert.deepEqual(usageAnswer(JSON.stringify({ ...record, usageStatusText: "" })), { reply: null, said: "old numbers" });
  // The sign-in ran out: the same old numbers, and the TV asks to sign in again.
  const expired = realCheck("claude", claudeHome("expired", { access: -3_600_000, refresh: -60_000, keptAgo: 7_200_000 }));
  assert.equal(JSON.parse(expired).limits.length, 2);
  assert.deepEqual(usageAnswer(expired), { reply: { signIn: "expired" }, said: "sign-in expired" });
  // Claude Code is set up, never signed in.
  assert.deepEqual(usageAnswer(realCheck("claude", claudeHome("never", {}))), { reply: { signIn: "none" }, said: "not signed in" });
  // A home that never ran it, and Codex with no sign-in and no Codex.
  const empty = join(scratch, "empty");
  mkdirSync(empty, { recursive: true });
  assert.equal(usageAnswer(realCheck("claude", empty)).reply, null);
  const codex = join(scratch, "codex");
  mkdirSync(join(codex, ".codex"), { recursive: true });
  assert.equal(usageAnswer(realCheck("chatgpt", codex)).reply, null);
  assert.equal(usageAnswer(realCheck("chatgpt", empty)).reply, null);
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
  const server = routeServer({
    path: "plan",
    route: async () => { throw new Error("not asked"); },
    usage: async (provider) => (asked.push(provider), provider === "grok" ? { reply: null, said: "old numbers" } : provider === "chatgpt" ? { reply: { signIn: "expired" }, said: "sign-in expired" } : { reply: { windows }, said: "1 window" }),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  assert.deepEqual(await usageViaSocket(path, "claude"), { windows });
  assert.equal(await usageViaSocket(path, "grok"), null, "a check with nothing to say");
  assert.deepEqual(await usageViaSocket(path, "chatgpt"), { signIn: "expired" }, "a sign-in that ran out");
  assert.equal(await usageViaSocket(path, "gemini" as "claude"), null, "Google's plan isn't offered");
  assert.deepEqual(asked, ["claude", "grok", "chatgpt"]);
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
  let answer: UsageReply | null = { windows: [{ window: "week", percent: 41 }] };
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
  answer = { windows: [{ window: "week", percent: 42 }] };
  assert.equal((await usages.get("claude", true))?.windows[0].percent, 42);
  assert.equal(asks, 3);
  // A sign-in that ran out: no windows, and asked again as soon as no answer.
  answer = { signIn: "expired" };
  assert.deepEqual(await usages.get("claude", true).then((u) => u && { windows: u.windows, signIn: u.signIn }), { windows: [], signIn: "expired" });
  now = 171_000;
  answer = { windows: [{ window: "week", percent: 43 }] };
  assert.equal((await usages.get("claude"))?.windows[0].percent, 43, "a sign-in just done shows its numbers soon");
  assert.equal(asks, 5);
  // Kept numbers, while the limits are paused: shown with when they were
  // read, and asked again as soon as no answer, for fresh ones.
  answer = { windows: [{ window: "week", percent: 41 }], asOf: "2026-11-16T01:00:00.000Z" };
  assert.equal((await usages.get("claude", true))?.asOf, "2026-11-16T01:00:00.000Z");
  now = 202_000;
  answer = { windows: [{ window: "week", percent: 44 }] };
  assert.deepEqual(await usages.get("claude").then((u) => [u?.windows[0].percent, u?.asOf]), [44, undefined]);
  assert.equal(asks, 7);
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
