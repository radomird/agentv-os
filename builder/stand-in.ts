// A stand-in for a provider's CLI, for CI, where no repo holds a key: it
// replays a recorded build through the real harness. The builder starts it
// the way it starts claude, for one step, with that step's harness; it calls
// the tools the recording has for the step, in order, as an agent would,
// and ends the way claude -p does, with a result line.
//
// A recording is JSON: { "steps": { "<step>": { "calls": [{ "tool": "write",
// "args": { "path": "app/main.js", "file": "blocks/main.js" } }], "said":
// "...", "spent": 0.12, "fail": "why" } } }. An argument "file" names a file
// beside the recording whose text is the "content". A recording can call a
// tool its step doesn't have, as a misled agent would, to show it's refused.
//
// Usage: node stand-in.ts <recording.json> <step> '<harness as JSON>'

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { client } from "./harness/mcp.ts";

interface Call {
  tool: string;
  args?: Record<string, unknown>;
}

interface Recorded {
  calls?: Call[];
  said?: string;
  spent?: number;
  fail?: string;
}

const [recordingPath, step, harnessJson] = process.argv.slice(2);
const out = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);

const recording = JSON.parse(readFileSync(recordingPath, "utf8")) as { steps: Record<string, Recorded> };
const recorded: Recorded = recording.steps[step] ?? { said: `nothing was recorded for ${step}` };
const harness = JSON.parse(harnessJson) as { command: string; args: string[] };
const child = spawn(harness.command, harness.args, { stdio: ["pipe", "pipe", "inherit"] });
const mcp = client(child.stdout, child.stdin, () => child.stdin.end());

const listed = (await mcp.list()).map((tool) => tool.name);
out({ type: "system", subtype: "init", tools: listed.map((name) => `mcp__agentv__${name}`) });
let turns = 0;
for (const call of recorded.calls ?? []) {
  const args = { ...(call.args ?? {}) };
  if (typeof args.file === "string") {
    args.content = readFileSync(join(dirname(recordingPath), args.file), "utf8");
    delete args.file;
  }
  const answer = await mcp.call(call.tool, args);
  turns++;
  out({ type: "tool", tool: call.tool, ok: !answer.error, answer: answer.text.slice(0, 2000) });
}
mcp.close();

const budget = Number(process.env.AGENTV_STAND_IN_BUDGET);
const spent = recorded.spent ?? 0;
if (process.env.AGENTV_STAND_IN_BUDGET && Number.isFinite(budget) && spent > budget) {
  out({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: budget, num_turns: turns });
} else if (recorded.fail) {
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: recorded.fail, total_cost_usd: spent, num_turns: turns });
} else {
  out({ type: "result", subtype: "success", is_error: false, result: recorded.said ?? "done", total_cost_usd: spent, num_turns: turns });
}
