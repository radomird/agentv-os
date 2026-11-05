// The switches for what's still being built (daemon/features.ts): every one
// off by default, GET /api/features lists them, and only an edge box turns
// one on, through the daemon or `agentv feature`.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { DEFAULTS, FEATURES, Features } from "../../../daemon/features.ts";
import { Daemon } from "../../../daemon/server.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-features-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const run = promisify(execFile);

async function daemon(channel: string): Promise<{ url: string; port: number; state: string; channelFile: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(scratch, "daemon-"));
  mkdirSync(join(dir, "root", "setup"), { recursive: true });
  const channelFile = join(dir, "channel");
  writeFileSync(channelFile, `${channel}\n`);
  const state = join(dir, "state");
  const d = new Daemon({ root: join(dir, "root"), state, port: 0, log: () => {}, builtins: null, channelFile });
  const port = await d.listen();
  return { url: `http://127.0.0.1:${port}`, port, state, channelFile, close: () => d.close() };
}

// agentv feature, against that daemon: what it printed, and how it exited.
async function feature(port: number, ...args: string[]): Promise<{ out: string; err: string; code: number }> {
  try {
    const { stdout, stderr } = await run(join(ROOT, "bin/agentv-feature"), args, { env: { ...process.env, AGENTV_PORT: String(port) } });
    return { out: stdout, err: stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout: string; stderr: string; code: number };
    return { out: failed.stdout, err: failed.stderr, code: failed.code };
  }
}

test("every track's switch is there, and off until its design is signed off", () => {
  assert.deepEqual([...FEATURES], ["boxcheck", "sizes", "looks", "dynamicbg", "setup2", "remote2", "starter", "discover", "askbuilds"]);
  assert.ok(Object.values(DEFAULTS).every((on) => on === false));
});

test("GET /api/features lists every switch, off on a fresh box", async () => {
  const d = await daemon("stable");
  try {
    assert.deepEqual(await (await fetch(`${d.url}/api/features`)).json(), DEFAULTS);
  } finally {
    await d.close();
  }
});

test("a switch changes on edge only, lasts, and the pages hear it", async () => {
  const d = await daemon("stable");
  try {
    const put = (body: unknown) => fetch(`${d.url}/api/features`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const refused = await put({ name: "dynamicbg", on: true });
    assert.equal(refused.status, 403, "stable keeps every default");
    assert.match((await refused.json()).error, /edge only/);

    writeFileSync(d.channelFile, "edge\n");
    const events = new AbortController();
    const stream = await fetch(`${d.url}/api/events`, { signal: events.signal });
    const heard = (async () => {
      const reader = stream.body!.getReader();
      let text = "";
      while (!text.includes("event: features")) text += new TextDecoder().decode((await reader.read()).value);
      return text;
    })();
    const on = await put({ name: "dynamicbg", on: true });
    assert.equal(on.status, 200);
    assert.equal((await on.json()).dynamicbg, true);
    assert.match(await heard, /"dynamicbg":true/);
    events.abort();
    assert.equal((await (await fetch(`${d.url}/api/features`)).json()).dynamicbg, true);
    assert.deepEqual(JSON.parse(readFileSync(join(d.state, "features.json"), "utf8")), { dynamicbg: true }, "only what differs from the defaults is kept");

    assert.equal((await put({ name: "nothing", on: true })).status, 400, "only the switches there are");
    assert.equal((await put({ name: "looks", on: "yes" })).status, 400, "on or off");
  } finally {
    await d.close();
  }
});

test("a kept switch that's gone, or isn't true or false, is left out", async () => {
  const state = mkdtempSync(join(scratch, "state-"));
  writeFileSync(join(state, "features.json"), JSON.stringify({ dynamicbg: true, gone: true, looks: "on" }));
  const switches = await new Features({ state, channel: async () => "stable" }).read();
  assert.deepEqual(switches, { ...DEFAULTS, dynamicbg: true });
  writeFileSync(join(state, "features.json"), "not json");
  assert.deepEqual(await new Features({ state, channel: async () => "stable" }).read(), DEFAULTS);
});

test("agentv feature lists the switches, and turns one on and off on edge only", async () => {
  const d = await daemon("stable");
  try {
    const list = await feature(d.port, "list");
    assert.equal(list.code, 0);
    assert.equal(list.out, `${FEATURES.map((name) => `${name}\toff`).join("\n")}\n`);

    const refused = await feature(d.port, "on", "dynamicbg");
    assert.equal(refused.code, 1);
    assert.match(refused.err, /edge only/);

    writeFileSync(d.channelFile, "edge\n");
    assert.deepEqual(await feature(d.port, "on", "dynamicbg"), { out: "dynamicbg is on.\n", err: "", code: 0 });
    assert.match((await feature(d.port)).out, /^dynamicbg\ton$/m, "list is what it does with nothing else");
    assert.deepEqual(await feature(d.port, "off", "dynamicbg"), { out: "dynamicbg is off.\n", err: "", code: 0 });
    assert.match((await feature(d.port, "list")).out, /^dynamicbg\toff$/m);

    assert.equal((await feature(d.port, "on")).code, 2, "on which");
    assert.equal((await feature(d.port, "on", "../x")).code, 2);
    const unknown = await feature(d.port, "on", "nothing");
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /a switch: boxcheck/);
  } finally {
    await d.close();
  }
  const gone = await feature(d.port, "list");
  assert.equal(gone.code, 1);
  assert.match(gone.err, /isn't answering/);
});
