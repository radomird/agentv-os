// Settings → Omarchy desktop's password, with setup's own switch on. The
// daemon checks it and hands it to root on a socket, and root
// (bin/agentv-password-set) checks the PIN again, feeds it to chpasswd on
// stdin, marks the account note and lets SSH take passwords again. Here the
// socket is the test's, starting the real command for each connection, with
// stand-ins for id, chpasswd and systemctl, which only the VM has for real.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { passwordProblem } from "../../../daemon/desktop-password.ts";
import { KNOWN } from "../../../daemon/routes/desktop-password.ts";
import { Daemon } from "../../../daemon/server.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-password-"));
const state = join(scratch, "state");
const tools = join(scratch, "tools");
const marker = join(scratch, "account.json");
const dropIn = join(scratch, "05-agentv-no-password.conf");
const socket = join(scratch, "password.sock");
const typed = join(scratch, "chpasswd.in");
const reloads = join(scratch, "systemctl.log");
// A throwaway password, made up here.
const PASSWORD = `test ${process.pid} ${Date.now()}`;

let daemon: Daemon;
let url = "";
let rootSide: Server;
const logged: string[] = [];
let rootLog = "";

before(async () => {
  mkdirSync(state, { recursive: true });
  mkdirSync(tools);
  writeFileSync(join(tools, "id"), `#!/bin/bash\n[[ $1 == -u && $2 == agentv ]] && echo 1000 && exit 0\nexit 1\n`);
  writeFileSync(join(tools, "chpasswd"), `#!/bin/bash\ncat >${JSON.stringify(typed)}\n`);
  writeFileSync(join(tools, "systemctl"), `#!/bin/bash\necho "$*" >>${JSON.stringify(reloads)}\n`);
  for (const tool of ["id", "chpasswd", "systemctl"]) chmodSync(join(tools, tool), 0o755);
  writeFileSync(join(scratch, "channel"), "edge\n");
  daemon = new Daemon({ root: ROOT, state, port: 0, log: (line) => logged.push(line), builtins: null, channelFile: join(scratch, "channel"), accountMarker: marker, passwordSocket: socket });
  const port = await daemon.listen();
  url = `http://127.0.0.1:${port}`;
  // As agentv-password.socket does: each connection is the command's stdin
  // and stdout.
  rootSide = createServer((connection) => {
    const command = spawn("bash", [join(ROOT, "bin/agentv-password-set")], {
      env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, AGENTV_ACCOUNT_MARKER: marker, AGENTV_SSHD_NO_PASSWORD: dropIn, AGENTV_PORT: String(port) },
    });
    connection.pipe(command.stdin);
    command.stdout.pipe(connection);
    command.stderr.on("data", (chunk) => (rootLog += chunk));
    command.on("close", () => connection.end());
    connection.on("error", () => {});
    command.stdin.on("error", () => {});
  });
  await new Promise<void>((done) => rootSide.listen(socket, done));
});

after(async () => {
  rootSide?.close();
  await daemon?.close();
  rmSync(scratch, { recursive: true, force: true });
});

const switchOn = (on: boolean) => writeFileSync(join(state, "features.json"), JSON.stringify({ setup2: on }));
const unknown = () => writeFileSync(marker, JSON.stringify({ name: "agentv", passwordKnown: false }) + "\n", { mode: 0o644 });
const keysOnly = () => writeFileSync(dropIn, "PasswordAuthentication no\nKbdInteractiveAuthentication no\n");

async function call(method: string, body?: unknown, grant?: string): Promise<{ status: number; data: { ok?: boolean; error?: string; password?: { managed: boolean; name: string | null; known: boolean } } }> {
  const response = await fetch(`${url}/api/desktop/password`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

// What root answers a line sent straight to its socket.
function straight(line: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((done, fail) => {
    let answer = "";
    const connection = createConnection(socket, () => connection.write(`${line}\n`));
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => (answer += chunk));
    connection.on("end", () => done(JSON.parse(answer)));
    connection.on("error", fail);
  });
}

test("a password the daemon or root refuses, before anything reaches chpasswd", () => {
  assert.equal(passwordProblem(""), "type a password first");
  assert.equal(passwordProblem("short"), "the password needs 8 characters or more");
  assert.equal(passwordProblem("x".repeat(129)), "the password can be 128 characters at most");
  assert.equal(passwordProblem("two\nlines!"), "the password can't have a line break in it");
  assert.equal(passwordProblem(42), "type a password first");
  assert.equal(passwordProblem("eight ch"), null);
  assert.equal(passwordProblem("ü".repeat(8)), null, "eight letters, whatever their bytes");
});

test("with setup's own switch off, there's no desktop password here", async () => {
  switchOn(false);
  unknown();
  assert.equal((await call("GET")).status, 404);
  assert.equal((await call("PUT", { password: PASSWORD })).status, 404);
});

test("a box installed through Omarchy's own installer keeps the password typed there", async () => {
  switchOn(true);
  rmSync(marker, { force: true });
  assert.deepEqual((await call("GET")).data.password, { managed: false, name: null, known: true });
  const put = await call("PUT", { password: PASSWORD });
  assert.deepEqual([put.status, put.data.error], [409, "this box's password is the one typed when it was installed"]);
  assert.equal(existsSync(typed), false);
});

test("Q225 the desktop's first password, past the PIN, reaches chpasswd on stdin, SSH takes passwords again, and the TV sets no other", async () => {
  switchOn(true);
  unknown();
  keysOnly();
  assert.deepEqual((await call("GET")).data.password, { managed: true, name: "agentv", known: false });

  const short = await call("PUT", { password: "short" });
  assert.deepEqual([short.status, short.data.error], [400, "the password needs 8 characters or more"]);

  // With a PIN, the daemon wants its grant, and root asks it again.
  assert.equal((await fetch(`${url}/api/pin`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "4826" }) })).status, 200);
  const refused = await call("PUT", { password: PASSWORD });
  assert.deepEqual([refused.status, refused.data.error], [403, "that needs the pin"]);
  assert.deepEqual(await straight(JSON.stringify({ password: PASSWORD, grant: "made-up" })), { ok: false, error: "that needs the pin" }, "root checks the grant itself");
  assert.equal(existsSync(typed), false, "nothing reached chpasswd");

  const grant = ((await (await fetch(`${url}/api/pin/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "4826" }) })).json()) as { grant: string }).grant;
  assert.deepEqual(await straight(JSON.stringify({ password: "two\nlines!", grant })), { ok: false, error: "the password can't have a line break in it" }, "root checks the password itself");

  const set = await call("PUT", { password: PASSWORD }, grant);
  assert.deepEqual([set.status, set.data.password], [200, { managed: true, name: "agentv", known: true }]);
  assert.equal(readFileSync(typed, "utf8"), `agentv:${PASSWORD}\n`, "chpasswd got name:password on stdin");
  assert.equal(JSON.parse(readFileSync(marker, "utf8")).passwordKnown, true);
  assert.equal(statSync(marker).mode & 0o777, 0o644, "the note stays readable");
  assert.equal(existsSync(dropIn), false, "SSH's keys-only drop-in is gone");
  assert.equal(readFileSync(reloads, "utf8"), "try-reload-or-restart sshd.service\n");

  // Only the first one comes from the TV. After that it changes on the
  // desktop, where passwd asks for the one before, so the daemon and root
  // both refuse another, even past the PIN.
  rmSync(typed);
  const again = await call("PUT", { password: `${PASSWORD} again` }, grant);
  assert.deepEqual([again.status, again.data.error], [409, KNOWN]);
  assert.deepEqual(await straight(JSON.stringify({ password: `${PASSWORD} again`, grant })), { ok: false, error: KNOWN }, "root refuses it itself");
  assert.equal(existsSync(typed), false, "nothing reached chpasswd");

  assert.ok(logged.includes("the desktop's password was set"));
  for (const where of [logged.join("\n"), rootLog]) assert.ok(!where.includes(PASSWORD), "the password is in no log");
});

test("with root's side down, Settings says so", async () => {
  switchOn(true);
  unknown();
  const grant = ((await (await fetch(`${url}/api/pin/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "4826" }) })).json()) as { grant: string }).grant;
  await new Promise((done) => rootSide.close(done));
  const put = await call("PUT", { password: PASSWORD }, grant);
  assert.deepEqual([put.status, put.data.error], [500, "the box can't set passwords: is agentv-password.socket on?"]);
});
