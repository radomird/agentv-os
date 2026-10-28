// The tools the harness gets from beyond it (ADR-043, ADR-044): npm and
// the bundle here, and the gates and the browsers as they come. A step that
// lists one that isn't here yet is told it isn't on this box yet.
//
// The harness runs in the builder's sandbox, so what it fetches goes
// through the sandbox's filter, at its fixed address there.

import { spawn } from "node:child_process";
import { Build } from "../build.ts";
import { osvFor, registryFor } from "../fetch.ts";
import { PackageError, Packages } from "../packages.ts";
import { PROXY_PORT } from "../sandbox/ports.ts";
import { ToolError } from "./mcp.ts";
import type { Extra } from "./tools.ts";

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

export async function extraTools(dir: string, _step: string): Promise<Extra> {
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
  return {
    npm_info: (args) => said(() => packages.info(args.name)),
    npm_add: (args) => said(() => packages.add(args.name, args.version)),
    bundle: () => said(() => packages.bundle()),
  };
}
