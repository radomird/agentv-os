// The provider key through the daemon (daemon/key.ts, S4.6): Settings → AI
// hands it over, the move as root (bin/agentv-key-store, run here when the
// drop appears, as agentv-key.path does) puts it in the env file, and the
// key never comes back out of the daemon, its answers or its log.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Daemon } from "../../../daemon/server.ts";

const ROOT = join(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "agentv-key-"));
const state = join(dir, "state");
const etc = join(dir, "etc");
mkdirSync(etc);
const KEY = `sk-ant-api03-${"b".repeat(48)}`;
after(() => rmSync(dir, { recursive: true, force: true }));

// agentv-key.path, as a loop: the move as root whenever the drop is there.
function root(): () => void {
  const drop = join(state, "key-drop", "key.json");
  const timer = setInterval(() => {
    if (!existsSync(drop)) return;
    try {
      execFileSync(join(ROOT, "bin/agentv-key-store"), { env: { ...process.env, AGENTV_ETC: etc, AGENTV_KEY_DROP: drop }, stdio: "ignore" });
    } catch {
      // A key it refused: key.json says why.
    }
  }, 50);
  return () => clearInterval(timer);
}

async function box(waitMs = 5000) {
  const lines: string[] = [];
  const daemon = new Daemon({ root: dir, state, builtins: null, port: 0, log: (line) => lines.push(line), running: "0.3.0-1", keyStatus: join(etc, "key.json"), keyWaitMs: waitMs });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  const send = async (method: string, path: string, body?: unknown, grant?: string) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, data: JSON.parse(text) as Record<string, unknown> };
  };
  return { daemon, lines, send };
}

test("S4.6 a key from Settings → AI ends up root's alone, and never comes back out", async () => {
  const stop = root();
  const { daemon, lines, send } = await box();
  try {
    assert.deepEqual((await send("GET", "/api/key")).data, { ok: true, set: false, provider: null });
    assert.deepEqual((await send("PUT", "/api/key", { provider: "acme", key: KEY })).data, { ok: false, error: "claude, chatgpt or gemini" });
    assert.deepEqual((await send("PUT", "/api/key", { provider: "claude", key: "short" })).data, { ok: false, error: "that doesn't look like a key" });
    assert.deepEqual((await send("PUT", "/api/key", { provider: "claude", key: `${KEY}\nEVIL=1` })).data, { ok: false, error: "that doesn't look like a key" });

    const stored = await send("PUT", "/api/key", { provider: "claude", key: ` ${KEY} ` });
    assert.deepEqual(stored.data, { ok: true, set: true, provider: "claude" });
    assert.equal(readFileSync(join(etc, "env"), "utf8"), `ANTHROPIC_API_KEY=${KEY}\n`);
    assert.equal(statSync(join(etc, "env")).mode & 0o777, 0o600);
    assert.equal(existsSync(join(state, "key-drop", "key.json")), false, "nothing of it stays in the daemon's state");
    const asked = await send("GET", "/api/key");
    assert.deepEqual(asked.data, { ok: true, set: true, provider: "claude" });
    for (const text of [stored.text, asked.text, (await send("GET", "/api/home")).text, lines.join("\n")]) assert.ok(!text.includes(KEY));
    assert.ok(lines.includes("a key for claude is kept, root's alone"));

    // With a PIN set, it's past the PIN.
    assert.equal((await send("PUT", "/api/pin", { pin: "4826" })).status, 200);
    assert.equal((await send("PUT", "/api/key", { provider: "gemini", key: `AIza${"c".repeat(35)}` })).status, 403);
    assert.equal((await send("DELETE", "/api/key")).status, 403);
    const grant = (await send("POST", "/api/pin/check", { pin: "4826" })).data.grant as string;
    assert.deepEqual((await send("DELETE", "/api/key", undefined, grant)).data, { ok: true, set: false, provider: null });
    assert.equal(readFileSync(join(etc, "env"), "utf8"), "");
  } finally {
    stop();
    await daemon.close();
  }
});

test("S4.6 with nothing to move it as root, the key doesn't stay in the daemon's state", async () => {
  const { daemon, send } = await box(300);
  try {
    const reply = await send("PUT", "/api/key", { provider: "chatgpt", key: `sk-proj-${"d".repeat(40)}` }, (await send("POST", "/api/pin/check", { pin: "4826" })).data.grant as string);
    assert.deepEqual(reply, { status: 500, text: reply.text, data: { ok: false, error: "the key couldn't be kept: agentv-key.path isn't running" } });
    assert.equal(existsSync(join(state, "key-drop", "key.json")), false);
  } finally {
    await daemon.close();
  }
});
