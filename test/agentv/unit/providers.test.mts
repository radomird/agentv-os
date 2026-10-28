// The provider CLIs, as the builder starts them for a step (builder/
// providers.ts, ADR-011, ADR-045, ADR-047): each with no tools of its own,
// only AgenTV's harness, no key on a key's path (the relay adds it), and a
// stop at its turns. claude, codex and gemini, and grok and muse beside
// them. The CLIs themselves run on the NUC; here it's what they're given.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Provider } from "../../../builder/build.ts";
import { CLIS, command, GROK_BUILT_INS, outcome, ownTools, type StepRun } from "../../../builder/providers.ts";

const harness = { command: "/usr/bin/node", args: ["/usr/share/agentv/builder/harness/server.ts", "/var/lib/agentv/build/local.blocks/1.0.0", "design"] };

const step = (change: Partial<StepRun> = {}): StepRun => ({
  prompt: "The request: a game like tetris",
  brief: "AgenTV's brief",
  harness,
  cwd: "/var/lib/agentv/build/local.blocks/1.0.0/work",
  turns: 30,
  budget: 4.5,
  home: "/var/lib/agentv/builder",
  proxy: "http://127.0.0.1:8080",
  relay: "http://127.0.0.1:8081",
  path: "key",
  step: "design",
  ...change,
});

const PROVIDERS: Provider[] = ["claude", "chatgpt", "gemini", "grok", "muse"];
const KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "META_API_KEY"];

test("ADR-047 each provider runs its own CLI from the builder's home, through the sandbox's filter", () => {
  for (const provider of PROVIDERS) {
    const run = command(provider, step());
    assert.equal(run.command, `/var/lib/agentv/builder/.local/bin/${CLIS[provider]}`, provider);
    assert.equal(run.env.HTTPS_PROXY, "http://127.0.0.1:8080", provider);
    assert.equal(run.env.HOME, "/var/lib/agentv/builder", provider);
  }
});

test("ADR-045 no CLI is given a key: on a key's path each holds a stand-in, and the relay adds the key", () => {
  for (const provider of PROVIDERS) {
    for (const path of ["key", "plan"] as const) {
      const run = command(provider, step({ path }));
      for (const name of KEY_NAMES) {
        if (run.env[name] !== undefined) assert.equal(run.env[name], "agentv-relay", `${provider} ${path} ${name}`);
      }
      if (path === "plan") assert.ok(!KEY_NAMES.some((name) => run.env[name]), `${provider}: a plan uses the CLI's own sign-in, which a key would win over`);
      const all = JSON.stringify(run);
      assert.ok(!/sk-ant-|sk-proj-|LLM_[A-Za-z0-9]/.test(all), provider);
    }
  }
});

test("claude: no tools of its own, only the harness, and its own budget stop with a key", () => {
  const run = command("claude", step());
  const at = (flag: string) => run.args[run.args.indexOf(flag) + 1];
  assert.equal(at("--tools"), "");
  assert.ok(run.args.includes("--strict-mcp-config"));
  assert.deepEqual(Object.keys(JSON.parse(at("--mcp-config")).mcpServers), ["agentv"]);
  assert.equal(at("--allowedTools"), "mcp__agentv");
  assert.equal(at("--permission-mode"), "dontAsk");
  assert.equal(at("--max-turns"), "30");
  assert.equal(at("--max-budget-usd"), "4.50");
  assert.equal(run.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8081");
  assert.ok(!command("claude", step({ path: "plan" })).args.includes("--max-budget-usd"), "a plan has its own limits (ADR-045)");
});

test("codex and gemini: their shells and web tools off, and the harness approved", () => {
  const codex = command("chatgpt", step());
  assert.ok(codex.args.includes("shell_tool") && codex.args.includes('web_search="disabled"'));
  assert.ok(codex.args.some((a) => a.startsWith("mcp_servers.agentv=") && a.includes('default_tools_approval_mode="approve"')));
  assert.ok(codex.args.some((a) => a.includes('base_url="http://127.0.0.1:8081/v1"')));
  const gemini = command("gemini", step());
  const settings = JSON.parse(Object.values(gemini.files!)[0]);
  assert.ok(settings.tools.exclude.includes("run_shell_command") && settings.tools.exclude.includes("web_fetch"));
  assert.deepEqual(Object.keys(settings.mcpServers), ["agentv"]);
  assert.equal(gemini.env.GOOGLE_GEMINI_BASE_URL, "http://127.0.0.1:8081");
});

test("ADR-047 grok: every tool of its own denied by name, the harness its only MCP server, and a stop at its turns", () => {
  const run = command("grok", step());
  const at = (flag: string) => run.args[run.args.indexOf(flag) + 1];
  assert.equal(at("--output-format"), "streaming-messages-json", "Claude Code's stream shape: its init line lists the tools");
  assert.deepEqual(at("--disallowed-tools").split(","), GROK_BUILT_INS);
  for (const tool of ["run_terminal_cmd", "read_file", "write", "search_replace", "web_search", "web_fetch", "task"]) assert.ok(GROK_BUILT_INS.includes(tool), tool);
  for (const flag of ["--no-subagents", "--no-memory", "--disable-web-search", "--no-auto-update", "--no-ask-user"]) assert.ok(run.args.includes(flag), flag);
  assert.equal(at("--permission-mode"), "dontAsk", "not Omarchy's bypassPermissions");
  assert.equal(at("--allow"), "MCPTool(agentv__*)");
  assert.equal(at("--max-turns"), "30");
  assert.ok(!run.args.includes("--trust") && !run.args.includes("--always-approve") && !run.args.includes("--yolo"));
  assert.equal(run.env.GROK_CLAUDE_MCPS_ENABLED, "0");
  assert.equal(run.env.GROK_HOME, "/var/lib/agentv/builder/.grok");
  const config = run.files!["/var/lib/agentv/builder/.grok/config.toml"];
  assert.match(config, /\[mcp_servers\.agentv\]\ncommand = "\/usr\/bin\/node"/);
  assert.equal((config.match(/\[mcp_servers\./g) ?? []).length, 1);
  assert.match(config, /\[model\.agentv\][^[]*base_url = "http:\/\/127\.0\.0\.1:8081\/v1"[^[]*env_key = "AGENTV_NO_KEY"/, "with a key, the relay is the model's address");
  assert.match(config, /\[models\]\ndefault = "agentv"/);
  const plan = command("grok", step({ path: "plan" })).files!["/var/lib/agentv/builder/.grok/config.toml"];
  assert.ok(!plan.includes("[model.agentv]"), "a plan goes to xAI with its own sign-in");
});

test("ADR-047 muse: its shell, writes and web tools off, never asking, the harness its only MCP server", () => {
  const run = command("muse", step());
  const at = (flag: string) => run.args[run.args.indexOf(flag) + 1];
  assert.equal(run.args[0], "exec");
  for (const flag of ["--json", "--disable-shell", "--disable-write", "--disable-web-tools", "--disable-reminders", "--disable-request-user-input", "--no-foreign-personal-context", "--no-session-log"]) assert.ok(run.args.includes(flag), flag);
  assert.equal(at("--approval-mode"), "never");
  assert.equal(at("--approval-judge"), "off");
  assert.equal(at("--max-model-steps"), "30");
  assert.equal(at("--contributor-mode"), "off", "the household's work isn't Meta's training data");
  assert.equal(at("--base-url"), "http://127.0.0.1:8081/v1");
  assert.ok(!run.args.includes("--yolo") && !run.args.includes("--trust-workspace") && !run.args.includes("--disable-sandbox"));
  assert.equal(run.env.MUSE_NO_AUTO_UPDATE, "1");
  const settings = JSON.parse(run.files!["/var/lib/agentv/builder/.config/muse/settings.json"]);
  assert.equal(settings.schema_version, 1);
  assert.deepEqual(Object.keys(settings.mcpServers), ["agentv"]);
  assert.equal(settings.mcpServers.agentv.command, "/usr/bin/node");
  assert.ok(!command("muse", step({ path: "plan" })).args.includes("--base-url"));
});

test("a CLI that offers tools of its own beside the harness's is caught from its first line", () => {
  assert.deepEqual(ownTools({ type: "system", subtype: "init", tools: ["mcp__agentv__write", "ListMcpResourcesTool", "search_tool", "use_tool"] }), []);
  assert.deepEqual(ownTools({ type: "system", subtype: "init", tools: ["mcp__agentv__write", "Bash", "WebSearch"] }), ["Bash", "WebSearch"]);
  assert.deepEqual(ownTools({ type: "system", subtype: "init", tools: ["mcp__other__run"] }), ["mcp__other__run"], "another MCP server's tool too");
  assert.deepEqual(ownTools({ type: "assistant" }), []);
});

test("how a step went, from each CLI's own output", () => {
  const result = (subtype: string, extra = {}) => [JSON.stringify({ type: "result", subtype, is_error: subtype !== "success", num_turns: 7, total_cost_usd: 0.42, result: "done", ...extra })];
  assert.deepEqual(outcome("grok", result("success"), 0), { ok: true, reason: undefined, spent: 0.42, turns: 7, said: "done" });
  assert.equal(outcome("grok", result("error_max_turns"), 1).reason, "the step ran out of turns");
  assert.equal(outcome("claude", result("error_max_budget_usd"), 1).reason, "the build reached its spend cap");
  assert.deepEqual(outcome("muse", [JSON.stringify({ type: "message", text: "the step is done" })], 0), { ok: true, said: "the step is done" });
  assert.equal(outcome("muse", [], 1).reason, "the agent stopped, or ran out of steps");
  assert.equal(outcome("muse", [JSON.stringify({ type: "run.error", message: "no credential" })], 1).reason, "no credential");
});
