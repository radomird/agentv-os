// The provider CLIs, run headless for one step (ADR-011, ADR-022, ADR-047):
// claude as the reference, codex, gemini, grok and muse beside it, each the
// provider's own unmodified CLI from the builder's own home. Each run has no
// built-in tools at all, no shell, no web search and no files of its own:
// only AgenTV's harness, started for this step, with this step's tools.
// Each goes out only through the sandbox's filter, and a key never reaches
// it: the relay outside the sandbox adds it, and stops a build at its cap on
// every CLI, with a budget flag of its own or not (ADR-045). With a plan,
// the CLI uses its own sign-in, in its own files.
//
// A stand-in replays a recorded build instead, for CI, where no repo holds
// a key (builder/stand-in.ts).

import { join } from "node:path";
import type { Provider } from "./build.ts";

export interface StepRun {
  prompt: string;
  brief: string; // AgenTV's brief, given as the system prompt's addition
  harness: { command: string; args: string[] }; // the harness for this step
  cwd: string; // the build's work folder
  turns: number;
  budget?: number; // dollars this build may still spend, with a key
  home: string; // the builder's home: the CLI and its own files
  proxy?: string; // the sandbox's way out, http://127.0.0.1:8080
  relay?: string; // the key relay, http://127.0.0.1:8081, with a key
  path: "plan" | "key";
  standIn?: string; // a recorded build to replay instead of a provider
  step: string;
}

export interface Command {
  command: string;
  args: string[];
  env: Record<string, string>;
  files?: Record<string, string>; // settings the CLI reads, written before it starts
}

export interface Outcome {
  ok: boolean;
  reason?: string; // one line, when not
  spent?: number; // dollars, as the CLI reports them
  turns?: number;
  said?: string; // the agent's last words
}

// The CLI each provider's plan or key goes through, as Omarchy names them.
export const CLIS: Record<Provider, string> = { claude: "claude", chatgpt: "codex", gemini: "gemini", grok: "grok", muse: "muse" };

// grok's own tools, each denied by name: an allowlist that names none of
// them leaves them all on (Grok Build's manual, 1.0.70).
export const GROK_BUILT_INS = [
  "run_terminal_cmd", "bash", "read_file", "grep", "grep_search", "list_dir", "search_replace", "write",
  "web_search", "web_fetch", "task", "spawn_subagent", "get_task_output", "wait_tasks", "kill_task",
  "todo_write", "lsp", "monitor", "enter_plan_mode", "workflow", "execute", "image_gen", "image_edit",
  "CreateGoal", "UpdateGoal",
];

// The model grok builds with, through the relay, with a key.
export const GROK_MODEL = "grok-4.7";

// What a CLI may offer the model besides the harness's own tools: MCP's
// resource readers and grok's two doors to MCP tools, all of which reach
// only the harness.
const BESIDE_HARNESS = new Set(["ListMcpResourcesTool", "ReadMcpResourceTool", "search_tool", "use_tool"]);

// The tools a CLI says it offers, when it says, that aren't the harness's:
// a step that's offered any stops before the agent can use them.
export function ownTools(event: unknown): string[] {
  const e = event as { type?: string; subtype?: string; tools?: unknown };
  if (e?.type !== "system" || e.subtype !== "init" || !Array.isArray(e.tools)) return [];
  return e.tools.filter((tool): tool is string => typeof tool === "string" && !tool.startsWith("mcp__agentv__") && !BESIDE_HARNESS.has(tool));
}

// What every run has: the builder's own home, a plain PATH, and the
// sandbox's filter as the only way out.
function baseEnv(run: StepRun): Record<string, string> {
  const env: Record<string, string> = {
    HOME: run.home,
    PATH: `${join(run.home, ".local/bin")}:/usr/local/bin:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  if (run.proxy) {
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) env[name] = run.proxy;
  }
  return env;
}

// TOML's basic strings take JSON's escapes.
const toml = (value: string) => JSON.stringify(value);

export function command(provider: Provider, run: StepRun): Command {
  if (run.standIn) {
    return {
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "stand-in.ts"), run.standIn, run.step, JSON.stringify(run.harness)],
      env: { ...baseEnv(run), AGENTV_STAND_IN_BUDGET: String(run.budget ?? "") },
    };
  }
  const cli = join(run.home, ".local/bin", CLIS[provider]);
  const env = baseEnv(run);

  if (provider === "claude") {
    const mcp = { mcpServers: { agentv: { type: "stdio", command: run.harness.command, args: run.harness.args } } };
    Object.assign(env, {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_WEB_FETCH: "1",
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    });
    // With a key, the relay outside the sandbox adds it; the CLI holds a
    // stand-in that's no key at all. With a plan, nothing here: an
    // ANTHROPIC_API_KEY would win over the plan's sign-in.
    if (run.path === "key" && run.relay) Object.assign(env, { ANTHROPIC_BASE_URL: run.relay, ANTHROPIC_API_KEY: "agentv-relay" });
    const args = [
      "-p",
      run.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      run.brief,
      "--tools",
      "",
      "--mcp-config",
      JSON.stringify(mcp),
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__agentv",
      "--disallowedTools",
      "Bash",
      "Agent",
      "Monitor",
      "WebFetch",
      "WebSearch",
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "user",
      "--max-turns",
      String(run.turns),
      "--no-session-persistence",
    ];
    if (run.path === "key" && run.budget !== undefined) args.push("--max-budget-usd", run.budget.toFixed(2));
    return { command: cli, args, env };
  }

  if (provider === "chatgpt") {
    const server = `{command=${toml(run.harness.command)},args=[${run.harness.args.map(toml).join(",")}],default_tools_approval_mode="approve",required=true}`;
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "-C",
      run.cwd,
      "-s",
      "read-only",
      "--disable",
      "shell_tool",
      "-c",
      'web_search="disabled"',
      "-c",
      "features.apps=false",
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      `mcp_servers.agentv=${server}`,
    ];
    if (run.path === "key" && run.relay) {
      // A provider of AgenTV's that sends no key: the relay adds it.
      args.push("-c", 'model_provider="agentv"', "-c", `model_providers.agentv={name="AgenTV",base_url=${toml(`${run.relay}/v1`)},wire_api="responses"}`);
    }
    args.push(`${run.brief}\n\n${run.prompt}`);
    return { command: cli, args, env: { ...env, CODEX_HOME: join(run.home, ".codex") } };
  }

  if (provider === "grok") {
    // Grok Build reads its settings from its own home, where a plan's
    // sign-in lives too, and nothing from Claude's or Cursor's.
    const grokHome = join(run.home, ".grok");
    const config = [
      "# AgenTV's builder writes this for each step (builder/providers.ts).",
      "[features]",
      "telemetry = false",
      "write_file = false",
      ...(run.path === "key" ? ["remote_fetch = false"] : []),
      "",
      "[cli]",
      "auto_update = false",
      "",
      "[mcp_servers.agentv]",
      `command = ${toml(run.harness.command)}`,
      `args = [${run.harness.args.map(toml).join(", ")}]`,
    ];
    if (run.path === "key" && run.relay) {
      // A model of AgenTV's that names a key no one has, so grok sends none
      // and the relay adds it.
      config.push("", "[model.agentv]", `model = ${toml(GROK_MODEL)}`, `base_url = ${toml(`${run.relay}/v1`)}`, 'api_backend = "responses"', 'env_key = "AGENTV_NO_KEY"', "context_window = 500000");
      config.push("", "[models]", 'default = "agentv"');
      env.XAI_API_KEY = "agentv-relay";
    }
    Object.assign(env, {
      GROK_HOME: grokHome,
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_DISABLE_EXPERIMENTS: "1",
      GROK_FEEDBACK_ENABLED: "0",
      GROK_SUBAGENTS: "0",
      GROK_MEMORY: "0",
      GROK_WRITE_FILE: "0",
      GROK_WEB_FETCH: "0",
      GROK_GOAL: "0",
      GROK_WORKFLOWS: "0",
      GROK_CLAUDE_MCPS_ENABLED: "0",
      GROK_CURSOR_MCPS_ENABLED: "0",
      GROK_CLAUDE_AGENTS_ENABLED: "0",
      GROK_CLAUDE_RULES_ENABLED: "0",
      GROK_CURSOR_RULES_ENABLED: "0",
      GROK_CURSOR_AGENTS_ENABLED: "0",
    });
    return {
      command: cli,
      args: [
        "-p",
        run.prompt,
        // Claude Code's own stream shape, so its init line says which tools
        // it offers and its result line how the step went.
        "--output-format",
        "streaming-messages-json",
        "--max-turns",
        String(run.turns),
        "--no-auto-update",
        "--no-subagents",
        "--no-memory",
        "--no-plan",
        "--no-ask-user",
        "--disable-web-search",
        "--disallowed-tools",
        GROK_BUILT_INS.join(","),
        "--permission-mode",
        "dontAsk",
        "--allow",
        "MCPTool(agentv__*)",
        "--rules",
        run.brief,
      ],
      env,
      files: { [join(grokHome, "config.toml")]: `${config.join("\n")}\n` },
    };
  }

  if (provider === "muse") {
    // Muse Code: its shell, writes, web tools and observer agents off, no
    // project rules (the work folder isn't a trusted workspace), and the
    // harness its one MCP server. With its shell off, its own sandbox has
    // nothing to hold; AgenTV's holds it either way.
    const config = join(run.home, ".config");
    const settings = { schema_version: 1, mcpServers: { agentv: { type: "stdio", command: run.harness.command, args: run.harness.args, required: true } } };
    Object.assign(env, {
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: join(run.home, ".local", "share"),
      MUSE_NO_AUTO_UPDATE: "1",
      MUSE_SKIP_PROMPT_HISTORY: "1",
      MUSE_CONTRIBUTOR_MODE: "0",
    });
    const args = [
      "exec",
      "--json",
      "--max-model-steps",
      String(run.turns),
      "--disable-shell",
      "--disable-write",
      "--disable-web-tools",
      "--disable-reminders",
      "--disable-request-user-input",
      "--no-foreign-personal-context",
      "--approval-mode",
      "never",
      "--approval-judge",
      "off",
      "--no-session-log",
      "--contributor-mode",
      "off",
    ];
    // Off Meta's own address, muse sends no key; the relay adds it.
    if (run.path === "key" && run.relay) {
      args.push("--base-url", `${run.relay}/v1`);
      env.META_API_KEY = "agentv-relay";
    }
    args.push(`${run.brief}\n\n${run.prompt}`);
    return { command: cli, args, env, files: { [join(config, "muse", "settings.json")]: `${JSON.stringify(settings, null, 2)}\n` } };
  }

  // Gemini CLI: its built-in tools all turned off, and the harness trusted.
  const geminiHome = join(run.home, ".gemini-agentv");
  const settings = {
    tools: { exclude: ["run_shell_command", "web_fetch", "google_web_search", "write_file", "replace", "read_file", "read_many_files", "list_directory", "glob", "search_file_content", "save_memory"] },
    mcpServers: { agentv: { command: run.harness.command, args: run.harness.args, trust: true } },
    privacy: { usageStatisticsEnabled: false },
    general: { enableAutoUpdate: false },
  };
  if (run.path === "key" && run.relay) env.GOOGLE_GEMINI_BASE_URL = run.relay;
  return {
    command: cli,
    args: ["-p", `${run.brief}\n\n${run.prompt}`, "-o", "stream-json", "--approval-mode=yolo", "--skip-trust"],
    env: { ...env, GEMINI_CLI_HOME: geminiHome, GEMINI_CLI_TRUST_WORKSPACE: "true" },
    files: { [join(geminiHome, ".gemini", "settings.json")]: JSON.stringify(settings, null, 2) },
  };
}

// What a run's output says about how the step went. Each CLI writes one
// JSON object a line.
export function outcome(provider: Provider | "stand-in", lines: string[], exitCode: number | null): Outcome {
  const events = lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  if (provider === "claude" || provider === "grok" || provider === "stand-in") {
    const result = events.reverse().find((e) => e.type === "result");
    if (!result) return { ok: false, reason: exitCode === 0 ? "the agent ended without a result" : `the agent stopped (exit ${exitCode})` };
    const reasons: Record<string, string> = {
      error_max_turns: "the step ran out of turns",
      error_max_budget_usd: "the build reached its spend cap",
      error_during_execution: "the agent stopped with an error",
    };
    const ok = result.subtype === "success" && result.is_error !== true;
    return {
      ok,
      reason: ok ? undefined : (reasons[result.subtype] ?? String(result.result ?? "the agent stopped").slice(0, 160)),
      spent: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
      turns: typeof result.num_turns === "number" ? result.num_turns : undefined,
      said: typeof result.result === "string" ? result.result.slice(0, 2000) : undefined,
    };
  }
  if (provider === "chatgpt") {
    const failed = events.find((e) => e.type === "turn.failed" || e.type === "error");
    const said = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message").pop()?.item?.text;
    const turns = events.filter((e) => e.type === "turn.completed").length;
    if (failed || exitCode !== 0) return { ok: false, reason: String(failed?.error?.message ?? failed?.message ?? `the agent stopped (exit ${exitCode})`).slice(0, 160), turns };
    return { ok: true, turns, said };
  }
  if (provider === "muse") {
    // muse exec --json's events aren't documented yet: its exit says how it
    // went, and its last words are the last message with text.
    const said = [...events].reverse().find((e) => typeof e.text === "string" || typeof e.message?.text === "string");
    const error = events.find((e) => typeof e.type === "string" && /error|failed/.test(e.type));
    if (exitCode !== 0 || error) return { ok: false, reason: String(error?.message ?? error?.error?.message ?? (exitCode === 1 ? "the agent stopped, or ran out of steps" : `the agent stopped (exit ${exitCode})`)).slice(0, 160) };
    return { ok: true, said: String(said?.text ?? said?.message?.text ?? "").slice(0, 2000) || undefined };
  }
  const error = events.find((e) => e.type === "error");
  const result = events.reverse().find((e) => e.type === "result");
  if (error || exitCode !== 0 || !result) return { ok: false, reason: String(error?.message ?? `the agent stopped (exit ${exitCode})`).slice(0, 160) };
  return { ok: true, turns: result.stats?.tool_calls, said: typeof result.response === "string" ? result.response.slice(0, 2000) : undefined };
}
