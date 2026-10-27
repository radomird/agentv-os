// A plan's sign-in, the first time the builder runs on it (ADR-040, S6.5):
// the provider's own CLI signs in (builder/sign-in.ts), with stand-ins for
// Claude Code's paste-back login and Codex's device code; the runner waits
// for it; root starts it and hands over the phone's code
// (builder/sandbox/hand-over.ts); and the daemon asks for it and starts the
// build again once it's in (daemon/builds.ts). The plan's tokens stay in the
// CLI's own files.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Build, type BuildRequest } from "../../../builder/build.ts";
import { Runner } from "../../../builder/run.ts";
import { HandOver } from "../../../builder/sandbox/hand-over.ts";
import { signedIn, signIn, type SignInStatus } from "../../../builder/sign-in.ts";
import { Builds } from "../../../daemon/builds.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-plan-sign-in-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

// What the stand-in CLIs keep as the plan's tokens, to look for everywhere else.
const TOKEN = "sk-ant-oat01-STAND-IN-PLAN-TOKEN";

// Claude Code's login as it goes: a link to open, then a prompt for the code
// the page gives. Its status says how it's signed in.
const CLAUDE = `#!/bin/bash
creds="$HOME/.claude/.credentials.json"
if [[ $1 == auth && $2 == status ]]; then
  if [[ -f $creds ]]; then echo '{"loggedIn": true, "authMethod": "claude.ai"}'; exit 0; fi
  echo '{"loggedIn": false, "authMethod": "none"}'; exit 1
fi
[[ $1 == auth && $2 == login && $3 == --claudeai ]] || exit 2
[[ -z \${ANTHROPIC_API_KEY:-} && -z \${CLAUDE_CODE_OAUTH_TOKEN:-} ]] || { echo "a key would win over the plan"; exit 3; }
printf '\\e[1mBrowser didn'"'"'t open? Use the url below to sign in:\\e[0m\\n\\nhttps://claude.ai/oauth/authorize?code=true&client_id=stand-in&state=s7Q\\n\\n'
printf 'Paste code here if prompted > '
read -r code
if [[ $code == "good-code#s7Q" ]]; then
  mkdir -p "$HOME/.claude"
  printf '{"claudeAiOauth": {"accessToken": "${TOKEN}"}}' >"$creds"
  echo "Login successful."
  exit 0
fi
echo "OAuth error: invalid code"
exit 1
`;

// Codex's device sign-in: a link and a code to enter there, then it waits
// until the person has.
const CODEX = `#!/bin/bash
auth="$CODEX_HOME/auth.json"
if [[ $1 == login && $2 == status ]]; then
  if [[ -f $auth ]]; then echo "Logged in using ChatGPT"; exit 0; fi
  echo "Not logged in"; exit 1
fi
[[ $1 == login && $2 == --device-auth ]] || exit 2
echo "Follow these steps to sign in with ChatGPT using device code authorization:"
echo "1. Open this link in your browser and sign in to your account"
echo "   https://auth.openai.com/codex/device"
echo "2. Enter this one-time code (expires in 15 minutes)"
echo "   QX7P-4KD2M"
for _ in $(seq 1 100); do
  if [[ -f $HOME/entered ]]; then
    mkdir -p "$CODEX_HOME"
    echo '{"tokens": {"access_token": "${TOKEN}"}}' >"$auth"
    echo "Successfully logged in"
    exit 0
  fi
  sleep 0.1
done
exit 1
`;

function home(cli: string, script: string): string {
  const dir = join(scratch, `home${++count}`);
  mkdirSync(join(dir, ".local/bin"), { recursive: true });
  writeFileSync(join(dir, ".local/bin", cli), script);
  chmodSync(join(dir, ".local/bin", cli), 0o755);
  return dir;
}

async function until(what: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("it didn't happen in time");
    await new Promise((done) => setTimeout(done, 50));
  }
}

const read = (folder: string): SignInStatus | null => {
  try {
    return JSON.parse(readFileSync(join(folder, "status.json"), "utf8"));
  } catch {
    return null;
  }
};

// Every file under dir whose text has the plan's token, but the CLI's own.
function copies(dir: string, own: string[]): string[] {
  const found: string[] = [];
  const walk = (path: string) => {
    if (statSync(path).isDirectory()) return readdirSync(path).forEach((name) => walk(join(path, name)));
    if (!own.includes(path) && readFileSync(path, "utf8").includes(TOKEN)) found.push(path);
  };
  walk(dir);
  return found;
}

test("S6.5 a Claude plan signs in through Claude Code's own login: its link shows, the phone's code goes to its prompt, and its tokens stay in its own files", async () => {
  const h = home("claude", CLAUDE);
  const folder = join(scratch, `sign-in${count}`);
  mkdirSync(folder);
  assert.equal(await signedIn("claude", { home: h }), false);
  const lines: string[] = [];
  const going = signIn("claude", { home: h, folder, minutes: 1, log: (line) => lines.push(line) });
  await until(() => read(folder)?.state === "waiting");
  const waiting = read(folder)!;
  assert.equal(waiting.url, "https://claude.ai/oauth/authorize?code=true&client_id=stand-in&state=s7Q", "the link, whole, without the terminal's colours");
  assert.equal(waiting.pastes, true);
  assert.equal(waiting.code, undefined, "Claude's page gives a code to paste, not one to enter");

  writeFileSync(join(folder, "input"), "good-code#s7Q\n");
  const done = await going;
  assert.equal(done.state, "done");
  assert.ok(!existsSync(join(folder, "input")), "the code is gone once it's typed");
  assert.equal(read(folder)!.url, undefined, "the link goes once it's used");
  assert.equal(await signedIn("claude", { home: h }), true);
  // The stand-in CLI stands for the provider's side too, so it has the token.
  assert.deepEqual(copies(scratch, [join(h, ".claude/.credentials.json"), join(h, ".local/bin/claude")]), [], "no copy of the plan's tokens outside the CLI's own files");
  assert.ok(!lines.join("\n").includes("good-code"), "the code isn't logged");
});

test("a wrong code, a stop and a sign-in that runs out each say it didn't finish", async () => {
  const h = home("claude", CLAUDE);
  const folder = join(scratch, `wrong${count}`);
  mkdirSync(folder);
  const wrong = signIn("claude", { home: h, folder, minutes: 1, log: () => {} });
  await until(() => read(folder)?.state === "waiting");
  writeFileSync(join(folder, "input"), "not-it");
  assert.equal((await wrong).state, "failed");
  assert.equal(await signedIn("claude", { home: h }), false);

  const stop = new AbortController();
  const stopped = signIn("claude", { home: h, folder, minutes: 1, stop: stop.signal, log: () => {} });
  await until(() => read(folder)?.state === "waiting");
  stop.abort();
  assert.deepEqual([(await stopped).state, read(folder)!.reason], ["failed", "it was stopped"]);

  const slow = signIn("claude", { home: h, folder, minutes: 0.01, log: () => {} });
  assert.match((await slow).reason!, /took longer than/);
});

test("ADR-040 Codex's device sign-in shows its link and the code to enter there, and goes on by itself", async () => {
  const h = home("codex", CODEX);
  const folder = join(scratch, `device${count}`);
  mkdirSync(folder);
  const going = signIn("chatgpt", { home: h, folder, minutes: 1, log: () => {} });
  await until(() => read(folder)?.state === "waiting");
  assert.deepEqual([read(folder)!.url, read(folder)!.code, read(folder)!.pastes], ["https://auth.openai.com/codex/device", "QX7P-4KD2M", false]);
  writeFileSync(join(h, "entered"), "");
  assert.equal((await going).state, "done");
  assert.ok(existsSync(join(h, ".codex/auth.json")), "in Codex's own folder in the builder's home");
});

test("a plan without its CLI, or with no sign-in yet, says so", async () => {
  const folder = join(scratch, `none${++count}`);
  mkdirSync(folder);
  const empty = join(scratch, `empty${count}`);
  mkdirSync(empty);
  assert.match((await signIn("claude", { home: empty, folder, log: () => {} })).reason!, /claude isn't on the box yet/);
  assert.match((await signIn("grok", { home: empty, folder, log: () => {} })).reason!, /coming soon/);
  assert.equal(await signedIn("grok", { home: empty }), null);
});

// --- The runner waits for it ---------------------------------------------------

function build(change: Partial<BuildRequest> = {}): Build {
  const dir = join(scratch, `b${++count}`, "1.0.0");
  mkdirSync(dir, { recursive: true });
  const request: BuildRequest = { build: `b${count}`, id: "local.blocks", version: "1.0.0", sentence: "a game like tetris", phase: "understand", recipe: null, provider: "claude", path: "plan", safeguards: true, at: "2026-10-27T15:00:00Z", ...change };
  writeFileSync(join(dir, "request.json"), JSON.stringify(request));
  return new Build(dir);
}

test("ADR-040 a build on a plan that isn't signed in waits for the sign-in, once; a plan with none yet is a key's for now", async () => {
  const empty = join(scratch, `nobody${++count}`);
  mkdirSync(empty);
  const run = (b: Build) => new Runner(b.dir, { root: ROOT, home: empty, log: () => {} }).run();
  const waits = await run(build());
  assert.deepEqual([waits.state, waits.reason], ["plan-sign-in", "sign in to your claude plan first"]);
  assert.match((await run(build({ signedIn: true }))).reason!, /sign-in didn't take/, "not asked for again and again");
  assert.match((await run(build({ provider: "grok" }))).reason!, /grok's plan is coming soon: use a key/);
});

// --- Root starts it, and hands over the code --------------------------------

function handOver(running = false) {
  const base = join(scratch, `root${++count}`);
  const o = {
    drop: join(base, "drop"),
    builds: join(base, "build"),
    apps: join(base, "apps"),
    home: join(base, "home"),
    run: join(base, "run"),
    spend: join(base, "spend.json"),
    builder: { uid: process.getuid!(), gid: process.getgid!() },
    rootUid: process.getuid!(),
    calls: [] as string[][],
  };
  mkdirSync(o.drop, { recursive: true });
  mkdirSync(join(o.home, ".local/bin"), { recursive: true });
  const h = new HandOver({ ...o, systemctl: (args) => (o.calls.push(args), args.includes("is-active") ? running : true) });
  return { o, h };
}

test("ADR-040 root starts the sign-in in the builder's sandbox with a ticket of its own, and hands the phone's code to it alone", async () => {
  const { o, h } = handOver();
  mkdirSync(join(o.run, "sign-in"), { recursive: true });
  writeFileSync(join(o.run, "sign-in", "status.json"), "{}");
  writeFileSync(join(o.drop, "sign-in.json"), JSON.stringify({ build: "b1", provider: "claude" }));
  assert.equal((await h.handle())!.started, true);
  assert.deepEqual(readdirSync(join(o.run, "sign-in")), [], "a fresh folder for each sign-in");
  assert.deepEqual(JSON.parse(readFileSync(join(o.run, "sign-in.json"), "utf8")), { provider: "claude", path: "plan", recipe: null });
  assert.deepEqual(o.calls.slice(1), [
    ["stop", "agentv-builder-sign-in@*.service"],
    ["start", "agentv-builder-cli@claude.service"],
    ["restart", "agentv-build-net.service"],
    ["start", "--no-block", "agentv-builder-sign-in@claude.service"],
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(o.run, "answer.json"), "utf8")).action, "sign-in");

  writeFileSync(join(o.drop, "sign-in-code.json"), JSON.stringify({ code: "good-code#s7Q" }));
  assert.equal((await h.handle())!.started, true);
  const input = join(o.run, "sign-in", "input");
  assert.equal(readFileSync(input, "utf8"), "good-code#s7Q");
  assert.equal(statSync(input).mode & 0o777, 0o600, "only the builder reads it");

  writeFileSync(join(o.drop, "sign-in-code.json"), JSON.stringify({ code: "two words" }));
  assert.match((await h.handle())!.reason!, /isn't a sign-in code/);

  // A stop ends it, and a sign-in not begun yet with it.
  writeFileSync(join(o.drop, "sign-in.json"), JSON.stringify({ build: "b1", provider: "claude" }));
  writeFileSync(join(o.drop, "stop.json"), "{}");
  await h.handle();
  assert.ok(!existsSync(join(o.drop, "sign-in.json")));
  assert.deepEqual(o.calls.at(-1), ["stop", "--no-block", "agentv-builder@*.service", "agentv-builder-sign-in@*.service"]);
});

test("root won't start a sign-in for a plan with none, or while a build runs, or hand a code to nobody", async () => {
  const { o, h } = handOver();
  writeFileSync(join(o.drop, "sign-in.json"), JSON.stringify({ build: "b1", provider: "grok" }));
  assert.match((await h.handle())!.reason!, /no sign-in yet/);
  writeFileSync(join(o.drop, "sign-in-code.json"), JSON.stringify({ code: "good-code" }));
  assert.match((await h.handle())!.reason!, /nothing is signing in/);
  const busy = handOver(true);
  writeFileSync(join(busy.o.drop, "sign-in.json"), JSON.stringify({ build: "b1", provider: "claude" }));
  assert.match((await busy.h.handle())!.reason!, /one runs at a time/);
  assert.ok(!existsSync(join(busy.o.run, "sign-in.json")));
});

// --- The daemon asks for it, and goes on after it ---------------------------

function box() {
  const base = join(scratch, `box${++count}`);
  const o = { state: join(base, "daemon"), drop: join(base, "daemon", "build-drop"), builds: join(base, "build"), run: join(base, "run"), spend: join(base, "spend.json") };
  mkdirSync(o.builds, { recursive: true });
  mkdirSync(join(o.run, "sign-in"), { recursive: true });
  let clock = Date.parse("2026-10-27T18:00:00Z");
  const builds = new Builds({ ...o, now: () => new Date((clock += 1000)) });
  const take = (name: string) => {
    const path = join(o.drop, `${name}.json`);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    rmSync(path);
    return data;
  };
  const status = (id: string, change: Record<string, unknown>) => {
    mkdirSync(join(o.builds, id, "1.0.0"), { recursive: true });
    writeFileSync(join(o.builds, id, "1.0.0", "status.json"), JSON.stringify({ id, version: "1.0.0", phase: "understand", steps: [], started: "", ...change }));
  };
  const said = (change: Record<string, unknown>) => writeFileSync(join(o.run, "sign-in", "status.json"), JSON.stringify({ provider: "claude", pastes: true, ...change }));
  return { o, builds, take, status, said };
}

test("ADR-040 the daemon asks for the sign-in once, shows its link, hands over the code, and starts the build again once it's in", async () => {
  const { builds, take, status, said } = box();
  const made = (await builds.ask("a game like tetris", { provider: "claude", path: "plan" })).build!;
  take("start");
  status(made.id, { build: made.build, state: "plan-sign-in", reason: "sign in to your claude plan first", at: "2026-10-27T18:01:00Z" });
  assert.equal((await builds.find(made.build))!.state, "plan-sign-in");
  assert.ok(await builds.running(), "one build at a time, sign-in and all");

  assert.equal(await builds.tend(), true);
  assert.deepEqual(take("sign-in"), { build: made.build, provider: "claude" });
  writeFileSync(join(builds["o"].drop, "sign-in.json"), "{}");
  assert.equal(await builds.tend(), false, "asked once");
  assert.deepEqual((await builds.find(made.build))!.signIn, { state: "starting" });
  take("sign-in");

  // An old sign-in's word is no word on this one.
  said({ state: "waiting", url: "https://claude.ai/old", at: "2026-10-27T17:00:00Z" });
  assert.equal(await builds.tend(), true);
  take("sign-in");
  said({ state: "waiting", url: "https://claude.ai/oauth/authorize?state=s7Q", at: "2026-10-27T18:02:00Z" });
  assert.deepEqual((await builds.find(made.build))!.signIn, { state: "waiting", url: "https://claude.ai/oauth/authorize?state=s7Q", pastes: true });
  assert.match((await builds.signInCode(made.build, "two words")).error!, /paste the code/);
  assert.deepEqual(await builds.signInCode(made.build, " good-code#s7Q "), {});
  assert.deepEqual(take("sign-in-code"), { code: "good-code#s7Q" });

  said({ state: "done", at: "2026-10-27T18:03:00Z" });
  assert.equal(await builds.tend(), true);
  assert.equal((await builds.find(made.build))!.state, "starting");
  const again = take("start");
  assert.deepEqual([again.build, again.phase, again.signedIn], [made.build, "understand", true]);
});

test("a sign-in that didn't finish, or a stop, fails the build, which tries again from its sign-in", async () => {
  const { o, builds, take, status, said } = box();
  const made = (await builds.ask("a game like tetris", { provider: "claude", path: "plan" })).build!;
  take("start");
  status(made.id, { build: made.build, state: "plan-sign-in", at: "2026-10-27T18:01:00Z" });
  said({ state: "failed", reason: "it took longer than 15 minutes", at: "2026-10-27T18:20:00Z" });
  const failed = (await builds.find(made.build))!;
  assert.deepEqual([failed.state, failed.reason, failed.signIn], ["failed", "couldn't sign in to the plan: it took longer than 15 minutes", undefined]);
  assert.equal(await builds.tend(), false, "not asked for again by itself");
  assert.equal((await builds.retry(made.build)).error, undefined);
  assert.equal(take("start").phase, "understand");

  status(made.id, { build: made.build, state: "plan-sign-in", at: "2026-10-27T18:21:00Z" });
  said({ state: "waiting", url: "https://claude.ai/x", at: "2026-10-27T18:22:00Z" });
  writeFileSync(join(o.run, "answer.json"), JSON.stringify({ action: "stop", build: null, started: false, reason: "stopped", at: "2026-10-27T18:23:00Z" }));
  assert.deepEqual([(await builds.find(made.build))!.state, (await builds.find(made.build))!.reason], ["failed", "couldn't sign in to the plan: you stopped it"]);
});
