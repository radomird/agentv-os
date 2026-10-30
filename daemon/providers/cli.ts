// A plan's back end (ADR-022, ADR-023, ADR-053): the provider's own CLI,
// unmodified, run once per sentence as the builder, which signed in to the
// plan through the CLI's own login. AgenTV never sees the plan's tokens:
// the CLI reads them from its own files in the builder's home.
//
// Each run is the router's brief and nothing else: no tools, no MCP
// servers, no hooks, no skills, no project files, no session kept, and the
// answer as one JSON object. Claude Code is the reference; Codex and Grok
// Build are best effort, as their plans are.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Provider } from "../ai.ts";
import { GROK_BUILT_INS } from "../../builder/providers.ts";
import type { Answer, Ask, Backend } from "../router.ts";
import { ProviderError } from "./http.ts";
import { ROUTER_MODELS } from "./index.ts";

// The plans whose CLI can route: the ones a box offers (daemon/ai.ts).
export const CLI_PROVIDERS = ["claude", "chatgpt", "grok"] as const satisfies readonly Provider[];
export type CliProvider = (typeof CLI_PROVIDERS)[number];
export const isCliProvider = (provider: Provider): provider is CliProvider => (CLI_PROVIDERS as readonly string[]).includes(provider);

const CLIS: Record<CliProvider, string> = { claude: "claude", chatgpt: "codex", grok: "grok" };

export interface CliRun {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  files?: Record<string, string>; // written before it starts
}

export interface CliOptions {
  home: string; // the builder's home, where the CLI and its sign-in live
  work?: string; // an empty folder of the run's own
  model?: string | null; // null: the CLI's own default for the plan
  proxy?: string; // the only way out, http://127.0.0.1:8080, on the box
}

// The brief, with the schema in words, for a CLI that can't be given one.
export function withSchema(ask: Ask): string {
  return `${ask.system}\n\nAnswer with one JSON object and nothing else, in this JSON schema:\n${JSON.stringify(ask.schema)}`;
}

// What every run has: the builder's home, a plain PATH, and nothing from
// the service that starts it. No ANTHROPIC_API_KEY, which would win over
// the plan's sign-in.
function baseEnv(home: string): Record<string, string> {
  return { HOME: home, PATH: `${join(home, ".local/bin")}:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
}

export function cliCommand(provider: CliProvider, ask: Ask, options: CliOptions): CliRun {
  const cli = join(options.home, ".local/bin", CLIS[provider]);
  const work = options.work ?? tmpdir();
  const env = baseEnv(options.home);
  if (options.proxy) {
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) env[name] = options.proxy;
    Object.assign(env, { NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" });
  }
  const model = options.model === undefined ? (provider === "claude" ? ROUTER_MODELS.claude : null) : options.model;

  if (provider === "claude") {
    Object.assign(env, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1", CLAUDE_CODE_DISABLE_WEB_FETCH: "1" });
    const args = [
      "-p",
      ask.user,
      // The brief in place of Claude Code's own, so the model reads only it.
      "--system-prompt",
      withSchema(ask),
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(ask.schema),
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--setting-sources",
      "user",
      "--settings",
      JSON.stringify({ disableAllHooks: true }),
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--max-turns",
      "3",
      "--effort",
      "low",
    ];
    if (model) args.push("--model", model);
    return { command: cli, args, env, cwd: work };
  }

  if (provider === "chatgpt") {
    const schema = join(work, "route.schema.json");
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "-C",
      work,
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
      'model_reasoning_effort="low"',
      "--output-schema",
      schema,
    ];
    if (model) args.push("-m", model);
    args.push(`${withSchema(ask)}\n\n${ask.user}`);
    return { command: cli, args, env: { ...env, CODEX_HOME: join(options.home, ".codex") }, cwd: work, files: { [schema]: JSON.stringify(ask.schema) } };
  }

  // Grok Build: every one of its own tools denied by name, and its other
  // agents, memory and web off, as the builder runs it.
  Object.assign(env, {
    GROK_HOME: join(options.home, ".grok"),
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_DISABLE_EXPERIMENTS: "1",
    GROK_FEEDBACK_ENABLED: "0",
    GROK_SUBAGENTS: "0",
    GROK_MEMORY: "0",
    GROK_WRITE_FILE: "0",
    GROK_WEB_FETCH: "0",
    GROK_CLAUDE_MCPS_ENABLED: "0",
    GROK_CURSOR_MCPS_ENABLED: "0",
    GROK_CLAUDE_RULES_ENABLED: "0",
    GROK_CURSOR_RULES_ENABLED: "0",
  });
  const args = [
    "-p",
    ask.user,
    "--output-format",
    "streaming-messages-json",
    "--max-turns",
    "1",
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
    "--rules",
    withSchema(ask),
  ];
  if (model) args.push("--model", model);
  return { command: cli, args, env, cwd: work };
}

const lines = (out: string) =>
  out.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

// The first line of what a CLI said on its way out, for its error.
const said = (stderr: string) => {
  const line = stderr.split("\n").find((l) => l.trim())?.trim();
  return line ? `: ${line.slice(0, 160)}` : "";
};

// A plan signs in the first time the builder runs (ADR-040), so a CLI that
// says it isn't signed in yet means that.
export const NOT_SIGNED_IN = "the plan isn't signed in yet: it signs in the first time your agent builds something";
const signedOut = (text: string) => /\/login|not logged in|log ?in again|not signed in|unauthori[sz]ed/i.test(text);

// The answer in what the CLI printed, or why there isn't one.
export function cliAnswer(provider: CliProvider, stdout: string, code: number | null, stderr = ""): Answer {
  try {
    return readAnswer(provider, stdout, code, stderr);
  } catch (error) {
    if (signedOut(`${(error as Error).message}\n${stderr}`)) throw new ProviderError(NOT_SIGNED_IN);
    throw error;
  }
}

function readAnswer(provider: CliProvider, stdout: string, code: number | null, stderr: string): Answer {
  if (provider === "chatgpt") {
    const events = lines(stdout);
    const failed = events.find((e) => e.type === "turn.failed" || e.type === "error");
    if (failed) throw new ProviderError(`codex stopped: ${String(failed.error?.message ?? failed.message ?? "an error").slice(0, 160)}`);
    const text = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message").pop()?.item?.text;
    if (typeof text !== "string") throw new ProviderError(code === 0 ? "codex gave no answer" : `codex stopped (exit ${code})${said(stderr)}`);
    return { value: text };
  }
  // Claude Code's one result, and Grok Build's last line, the same shape.
  let whole: unknown;
  try {
    whole = JSON.parse(stdout.trim());
  } catch {}
  const result = (whole && typeof whole === "object" ? [whole as Record<string, any>] : lines(stdout).reverse()).find((e) => e?.type === "result");
  if (!result) throw new ProviderError(code === 0 ? `${CLIS[provider]} gave no answer` : `${CLIS[provider]} stopped (exit ${code})${said(stderr)}`);
  if (result.is_error === true || (result.subtype && result.subtype !== "success")) {
    throw new ProviderError(`${CLIS[provider]} stopped: ${String(result.result ?? result.subtype ?? "an error").slice(0, 160)}`);
  }
  const models = result.modelUsage && typeof result.modelUsage === "object" ? Object.keys(result.modelUsage) : [];
  return { value: result.structured_output ?? result.result, ...(models.length === 1 ? { model: models[0] } : {}) };
}

export type CliRunner = (run: CliRun, timeoutMs: number) => Promise<{ stdout: string; stderr: string; code: number | null }>;

// Runs a CLI with only its own environment, and stops it at its time.
export const runCli: CliRunner = (run, timeoutMs) =>
  new Promise((resolve, reject) => {
    for (const [path, content] of Object.entries(run.files ?? {})) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { mode: 0o600 });
    }
    const child = spawn(run.command, run.args, { cwd: run.cwd, env: run.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ProviderError(`${run.command.split("/").pop()} didn't answer in time`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new ProviderError(error.code === "ENOENT" ? `${run.command.split("/").pop()} isn't on the box yet: it comes with your agent's first build` : error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });

export interface CliBackendOptions extends CliOptions {
  run?: CliRunner;
  timeoutMs?: number;
}

export function cliBackend(provider: CliProvider, options: CliBackendOptions): Backend {
  const model = options.model === undefined ? (provider === "claude" ? ROUTER_MODELS.claude : null) : options.model;
  const run = options.run ?? runCli;
  return {
    provider,
    via: "cli",
    model,
    ask: async (ask) => {
      const { stdout, stderr, code } = await run(cliCommand(provider, ask, { ...options, model }), options.timeoutMs ?? 30_000);
      return cliAnswer(provider, stdout, code, stderr);
    },
  };
}
