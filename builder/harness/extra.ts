// The tools the harness gets from beyond it (ADR-043, ADR-044, ADR-011):
// npm, the bundle, the test TV's checks and tests, and for a streaming
// service stage A's look at its pages, a sample of an address, and the
// contract tests against the pages it kept. A step that lists one that isn't
// here yet is told it isn't on this box yet.
//
// The harness runs in the builder's sandbox, so what it fetches goes
// through the sandbox's filter, at its fixed address there.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { Build } from "../build.ts";
import { look, saidLook } from "../browse.ts";
import { contractTests } from "../contract-run.ts";
import { fetchVia, osvFor, registryFor } from "../fetch.ts";
import { CHROMIUM, tryBuild } from "../gates/gates.ts";
import { said as report } from "../gates/testtv.ts";
import { PackageError, Packages } from "../packages.ts";
import { writable } from "../recipe.ts";
import { PROXY_PORT } from "../sandbox/ports.ts";
import { ToolError } from "./mcp.ts";
import { findStep } from "./steps.ts";
import { type Extra, inWork } from "./tools.ts";

const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

// A command's exit code, and what it said on both its outputs, within ten
// minutes.
export function run(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    let out = "";
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (chunk: Buffer) => {
      if (out.length < 256 * 1024) out += chunk.toString("utf8");
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: null, out: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

// A package tool's refusal, as the agent reads it.
async function said(work: () => Promise<string>): Promise<string> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof PackageError ? new ToolError(error.message) : error;
  }
}

const SAMPLE_MAX = 20 * 1024;

// An address the build may reach: https, on an origin it declared.
function declaredUrl(build: Build, value: unknown): { url: string; declared: string[] } {
  const declared = build.state().origins.map((o) => o.origin);
  let url: URL;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new ToolError("an address like https://service.example/");
  }
  if (url.protocol !== "https:") throw new ToolError("only https addresses");
  if (!declared.includes(url.origin)) throw new ToolError(`declare ${url.origin} with declare_origin first: the build reaches only the origins it declared`);
  return { url: url.href, declared };
}

// Where a tool keeps what it saves, when it's asked to: a path in the build
// this step writes, checked before the tool does anything.
function saveAt(build: Build, stepId: string, value: unknown): ((data: string) => string) | null {
  if (value === undefined) return null;
  const path = posix.normalize(String(value).replace(/^\.\/+/, ""));
  const file = inWork(build.work, path);
  const writes = findStep(build, stepId)?.writes ?? [];
  if (!writable(path, writes)) throw new ToolError(`this step writes only ${writes.join(", ") || "nothing"}, not ${path}`);
  return (data) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    return path;
  };
}

export async function extraTools(dir: string, stepId: string): Promise<Extra> {
  const build = new Build(dir);
  const request = build.request();
  const osv = osvFor(PROXY);
  const packages = new Packages({
    work: build.work,
    safeguards: request.safeguards,
    home: process.env.HOME ?? "/var/lib/agentv/builder",
    packument: registryFor(PROXY),
    osvBatch: osv.batch,
    osvVuln: osv.vuln,
    run,
    proxy: PROXY,
  });
  // The test TV, with the app as it is now: AgenTV's checks, or the tests.
  const root = process.env.AGENTV_PATH ?? join(import.meta.dirname, "../..");
  const gate = { root, proxy: PROXY };
  return {
    npm_info: (args) => said(() => packages.info(args.name)),
    npm_add: (args) => said(() => packages.add(args.name, args.version)),
    bundle: () => said(() => packages.bundle()),
    try: async () => report(await tryBuild(build, build.recipe(), gate, { checks: true, tests: false })),
    run_tests: async () => report(await tryBuild(build, build.recipe(), gate, { checks: false, tests: true })),
    // Stage A: a fresh browser with no sign-in, through the filter.
    look: async (args) => {
      const { url, declared } = declaredUrl(build, args.url);
      const save = saveAt(build, stepId, args.save);
      const seen = await look(url, { chromium: CHROMIUM, proxy: PROXY }).catch((error: Error) => {
        throw new ToolError(`${url} didn't open: ${error.message}`);
      });
      const saved = save ? `\n\nkept the page, without its scripts, as ${save(seen.html)}` : "";
      return `${saidLook(seen, declared)}${saved}`;
    },
    fetch_sample: async (args) => {
      const { url } = declaredUrl(build, args.url);
      const save = saveAt(build, stepId, args.save);
      const answer = await fetchVia(PROXY, url, { timeout: 20_000 }).catch((error: Error) => {
        throw new ToolError(`${url} didn't answer: ${error.message}`);
      });
      let body: unknown = answer.text;
      try {
        body = JSON.parse(answer.text);
      } catch {}
      const saved = save ? `\n\nkept it as ${save(JSON.stringify({ status: answer.status, body }, null, 2))}` : "";
      const text = answer.text.length > SAMPLE_MAX ? `${answer.text.slice(0, SAMPLE_MAX)}\n... (${answer.text.length} characters; the rest isn't shown)` : answer.text;
      return `${url} answered ${answer.status}${saved}\n\n${text}`;
    },
    contract_tests: async () => {
      const stage = findStep(build, stepId)?.stage;
      return (await contractTests(build, build.recipe(), { chromium: CHROMIUM, stage })).lines.join("\n");
    },
  };
}
