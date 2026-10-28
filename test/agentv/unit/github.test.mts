// Export's push to a repo of the person's own (daemon/github.ts, ADR-045):
// AgenTV's own repos refused, the person's GitHub sign-in found with gh or
// an SSH key, the app pushed with real git to a bare repo standing in for
// GitHub, as a commit of theirs in a folder of its own and never forced,
// and the daemon's side: offered only when the box is signed in, asked on
// an adult's phone behind the PIN, and handed to the screen daemon.

import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { installLocal } from "../../../daemon/apps/install.ts";
import { AskWatch } from "../../../daemon/asks.ts";
import { type GitHubAnswer, type GitHubAsk, NOT_SIGNED_IN, parseRepo, pushApp, type PushAsk, repoRefusal, run, type Run, signedIn } from "../../../daemon/github.ts";
import { agentvOwner } from "../../../daemon/identity.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-github-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Stand-ins for gh and ssh on PATH, which say what they were asked. gh's
// repos are bare ones in BARE, which git pushes to as it would to GitHub.
const bin = join(scratch, "bin");
const bare = join(scratch, "github");
const said = join(scratch, "said.log");
mkdirSync(bin);
mkdirSync(bare);
writeFileSync(
  join(bin, "gh"),
  `#!/bin/bash
echo "gh $*" >>"$STANDIN_SAID"
case "$1 $2" in
  "api user") [ -n "$STANDIN_LOGIN" ] && { echo "$STANDIN_LOGIN"; exit 0; }; echo "You are not logged into any GitHub hosts." >&2; exit 4 ;;
  "repo view") [ -d "$STANDIN_BARE/$3.git" ] && { echo '{"name":"x"}'; exit 0; }; echo "GraphQL: Could not resolve to a Repository with the name '$3'." >&2; exit 1 ;;
  "repo create") git init -q --bare -b main "$STANDIN_BARE/$3.git" ;;
  *) exit 1 ;;
esac
`,
);
writeFileSync(
  join(bin, "ssh"),
  `#!/bin/bash
echo "ssh $*" >>"$STANDIN_SAID"
for word in "$@"; do case "$word" in UserKnownHostsFile=*) cp "\${word#UserKnownHostsFile=}" "$STANDIN_SAID.hosts" ;; esac; done
echo "Hi someone! You've successfully authenticated, but GitHub does not provide shell access." >&2
exit 1
`,
);
chmodSync(join(bin, "gh"), 0o755);
chmodSync(join(bin, "ssh"), 0o755);
const gitconfig = join(scratch, "gitconfig");
writeFileSync(gitconfig, "[user]\n\tname = A Person\n\temail = person@example.com\n[init]\n\tdefaultBranch = main\n");
Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, STANDIN_SAID: said, STANDIN_BARE: bare, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" });

const git = (args: string[], cwd?: string) => {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(ran.status, 0, `git ${args.join(" ")}: ${ran.stderr}`);
  return ran.stdout.trim();
};
const asked = () => (existsSync(said) ? readFileSync(said, "utf8") : "");
const HOSTS = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStandIn\n";

// The package's files, as the daemon hands them over.
function blocks(): PushAsk["files"] {
  const manifest = readFileSync(join(ROOT, "test/agentv/fixtures/apps/blocks/manifest.json"));
  return [
    { path: "manifest.json", data: manifest.toString("base64") },
    { path: "LICENSE", data: Buffer.from("MIT\n").toString("base64") },
    { path: "web/index.html", data: Buffer.from("<p>blocks</p>").toString("base64") },
  ];
}

test("ADR-045 a push never goes to AgenTV's own repos, or one named like them", () => {
  assert.deepEqual(parseRepo("blocks", "person"), { owner: "person", name: "blocks" });
  assert.deepEqual(parseRepo(" someone/blocks.git ", "person"), { owner: "someone", name: "blocks" });
  assert.deepEqual(parseRepo("https://github.com/someone/blocks", "person"), { owner: "someone", name: "blocks" });
  for (const typed of ["", "a/b/c", "-x/blocks", "person/..", "person/a b", 7]) assert.ok("error" in parseRepo(typed, "person"), String(typed));

  assert.equal(repoRefusal({ owner: "person", name: "blocks" }, "agentv-owner"), null);
  assert.equal(repoRefusal({ owner: "person", name: "agentv-blocks" }, "agentv-owner"), null, "a repo of theirs may start with agentv");
  assert.match(repoRefusal({ owner: "AgenTV-Owner", name: "agentv-os" }, "agentv-owner")!, /AgenTV's own repos/);
  assert.match(repoRefusal({ owner: "agentv-owner", name: "agentv-anything" }, "agentv-owner")!, /AgenTV's own repos/);
  assert.match(repoRefusal({ owner: "person", name: "agentv-apps" }, "agentv-owner")!, /named like one of AgenTV's own/);
  assert.match(repoRefusal({ owner: "person", name: "agentv-adapters" }, null)!, /named like one of AgenTV's own/, "even in a checkout, with no owner known");

  const settings = join(scratch, "settings-root");
  mkdirSync(settings);
  writeFileSync(join(settings, "settings"), "AGENTV_VERSION=0.1.3\nAGENTV_HOMEPAGE=https://github.com/agentv-owner/agentv-os\n");
  assert.equal(agentvOwner(settings), "agentv-owner");
  assert.equal(agentvOwner(join(scratch, "nowhere")), null);
});

test("ADR-045 the person's GitHub sign-in is found with gh, or with an SSH key checked against GitHub's own host keys", async () => {
  const home = join(scratch, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  process.env.STANDIN_LOGIN = "person";
  assert.deepEqual(await signedIn({ home, hosts: async () => HOSTS }), { via: "gh", login: "person" });

  delete process.env.STANDIN_LOGIN;
  assert.equal(await signedIn({ home, hosts: async () => HOSTS }), null, "no gh sign-in and no key: nothing to push with");
  assert.ok(!asked().includes("ssh "), "and ssh isn't tried without a key");

  writeFileSync(join(home, ".ssh", "id_ed25519"), "a key\n");
  assert.deepEqual(await signedIn({ home, hosts: async () => HOSTS }), { via: "ssh", login: "someone" });
  const ssh = asked().split("\n").find((line) => line.startsWith("ssh "))!;
  assert.match(ssh, /BatchMode=yes/);
  assert.match(ssh, /StrictHostKeyChecking=yes/, "GitHub's host keys are checked, not taken on trust");
  assert.equal(readFileSync(`${said}.hosts`, "utf8"), HOSTS);
  assert.match(ssh, /-T git@github\.com$/);
});

test("ADR-045 the app is pushed as the person's commit, in a folder of its own, and never forced", async () => {
  process.env.STANDIN_LOGIN = "person";
  const calls: string[][] = [];
  const recorded: Run = (command, args, o) => {
    calls.push([command, ...args]);
    return run(command, args, o);
  };
  const remote = (_who: unknown, repo: { owner: string; name: string }) => `file://${bare}/${repo.owner}/${repo.name}.git`;
  const ask: PushAsk = { kind: "push", id: "local.blocks", name: "Blocks", version: "1.0.0", repo: { owner: "person", name: "blocks" }, files: blocks() };

  // A repo that isn't there yet is made, private, and the app goes in.
  const first = await pushApp(ask, { run: recorded, remote, home: join(scratch, "home") });
  assert.deepEqual(first, { ok: true, url: "https://github.com/person/blocks", pushed: true });
  assert.match(asked(), /gh repo create person\/blocks --private/);
  const look = join(scratch, "look");
  git(["clone", "-q", `file://${bare}/person/blocks.git`, look]);
  assert.equal(readFileSync(join(look, "local.blocks", "LICENSE"), "utf8"), "MIT\n");
  assert.ok(existsSync(join(look, "local.blocks", "web", "index.html")));
  assert.equal(git(["log", "-1", "--format=%an <%ae> %s"], look), "A Person <person@example.com> Blocks 1.0.0, made by my agent on AgenTV");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], look), "main");

  // The same version again changes nothing, and pushes nothing.
  assert.deepEqual(await pushApp(ask, { run: recorded, remote }), { ok: true, url: "https://github.com/person/blocks", pushed: false });

  // What else is in the repo stays, and a newer version replaces the app's folder.
  writeFileSync(join(look, "README.md"), "my apps\n");
  writeFileSync(join(look, "local.blocks", "old.txt"), "gone next time\n");
  git(["add", "-A"], look);
  git(["commit", "-qm", "mine"], look);
  git(["push", "-q", "origin", "HEAD"], look);
  assert.deepEqual(await pushApp({ ...ask, version: "1.1.0" }, { run: recorded, remote }), { ok: true, url: "https://github.com/person/blocks", pushed: true });
  git(["pull", "-q"], look);
  assert.equal(readFileSync(join(look, "README.md"), "utf8"), "my apps\n");
  assert.ok(!existsSync(join(look, "local.blocks", "old.txt")));
  assert.match(git(["log", "-1", "--format=%s"], look), /Blocks 1\.1\.0/);

  // Every push is a plain one, and gh hands git the token as it goes.
  const pushes = calls.filter((call) => call.includes("push"));
  assert.equal(pushes.length, 2);
  for (const push of pushes) {
    assert.deepEqual(push.slice(push.indexOf("push")), ["push", "--quiet", "--no-verify", "origin", "HEAD"]);
    assert.ok(push.includes("credential.helper=!gh auth git-credential"));
  }
  assert.ok(!calls.flat().some((word) => word === "--force" || word === "-f" || word.startsWith("+")), "nothing is forced");

  // A file outside the app's folder isn't written.
  const outside = await pushApp({ ...ask, version: "1.2.0", files: [{ path: "../README.md", data: "eA==" }] }, { run: recorded, remote });
  assert.deepEqual(outside, { ok: false, error: "a file of the app is outside its folder" });
  assert.equal(readFileSync(join(look, "README.md"), "utf8"), "my apps\n");
});

test("ADR-045 with only an SSH key, the repo has to be there, and nobody signed in has nothing to push with", async () => {
  delete process.env.STANDIN_LOGIN;
  const remote = (_who: unknown, repo: { owner: string; name: string }) => `file://${bare}/${repo.owner}/${repo.name}.git`;
  const ask: PushAsk = { kind: "push", id: "local.blocks", name: "Blocks", version: "1.0.0", repo: { owner: "someone", name: "nothing-here" }, files: blocks() };
  const missing = await pushApp(ask, { remote, home: join(scratch, "home"), hosts: async () => HOSTS });
  assert.equal(missing.ok, false);
  assert.match(missing.error!, /the repo isn't there, or your SSH key can't reach it: make it on GitHub first/);
  assert.ok(!existsSync(join(bare, "someone", "nothing-here.git")), "an SSH key doesn't make repos");

  const nobody = join(scratch, "nobody");
  mkdirSync(nobody);
  assert.deepEqual(await pushApp(ask, { remote, home: nobody }), { ok: false, error: NOT_SIGNED_IN });
});

test("ADR-045 the phone offers a push only when the box is signed in, asks for the PIN each time, and the screen daemon does it", async () => {
  const { Daemon } = await import("../../../daemon/server.ts");
  const settings = join(scratch, "agentv");
  mkdirSync(settings);
  writeFileSync(join(settings, "settings"), "AGENTV_HOMEPAGE=https://github.com/agentv-owner/agentv-os\n");
  process.env.AGENTV_PATH = settings;
  const base = join(scratch, "daemon");
  mkdirSync(join(base, "root", "setup"), { recursive: true });
  const apps = join(base, "apps");
  const page = join(scratch, "page-app");
  cpSync(join(ROOT, "test/agentv/fixtures/apps/blocks"), page, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(page, "manifest.json"), "utf8"));
  writeFileSync(join(page, "manifest.json"), JSON.stringify({ ...manifest, id: "local.blocks", author: "your agent" }));
  mkdirSync(join(page, "fixtures"));
  writeFileSync(join(page, "fixtures", "page.html"), "<p>a saved page</p>");
  await installLocal(page, apps, async () => true);

  const daemon = new Daemon({ root: join(base, "root"), state: join(base, "state"), port: 0, log: () => {}, builtins: null, apps, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1", keyStatus: join(base, "key.json") });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  const lan = `http://127.0.0.1:${daemon.lanPort}`;
  // The screen daemon, as the person: signed in as "person" once asked to be.
  let login: string | null = null;
  const pushes: (GitHubAsk & { n: number })[] = [];
  const screen = new AskWatch<GitHubAsk, GitHubAnswer>({
    url: `${url}/`,
    path: "api/export/ask",
    what: "Export's push",
    handle: async (ask) => {
      if (ask.kind === "sign-in") return login ? { ok: true, via: "gh", login } : { ok: false, error: NOT_SIGNED_IN };
      pushes.push(ask);
      return { ok: true, url: `https://github.com/${ask.repo.owner}/${ask.repo.name}`, pushed: true };
    },
    failed: (error) => ({ ok: false, error: error.message }),
    log: () => {},
    retryMs: 50,
  });
  screen.start();
  try {
    const send = (method: string, path: string, body?: unknown, grant?: string) =>
      fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const code = (await (await send("POST", "/api/phones/pair", {})).json()).pairing.code;
    const token = (await (await fetch(`${lan}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "iphone" }) })).json()).token;
    const phone = (path: string, body?: unknown, grant?: string) =>
      fetch(`${lan}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const offered = async () => ((await (await phone("/api/phone/state")).json()) as { export: { github: unknown } | null }).export;
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 100 && !(await check()); i++) await new Promise((done) => setTimeout(done, 50));
    };
    await send("PUT", "/api/pin", { pin: "2468" });
    const pin = async () => (await (await phone("/api/phone/pin", { pin: "2468" })).json()).grant as string;

    // Not signed in: the phone saves the file, and has no push.
    assert.equal((await send("POST", "/api/apps/local.blocks/export", {})).status, 200);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal((await offered())!.github, null);
    assert.match((await (await phone("/api/phone/apps/local.blocks/push", { repo: "blocks" }, await pin())).json()).error, /isn't signed in to GitHub/);

    // Signed in: the offer says as whom, and the push asks for the PIN.
    login = "person";
    assert.equal((await send("POST", "/api/apps/local.blocks/export", {})).status, 200);
    await until(async () => (await offered())?.github !== null);
    assert.deepEqual((await offered())!.github, { via: "gh", login: "person" });
    const noPin = await phone("/api/phone/apps/local.blocks/push", { repo: "blocks" });
    assert.equal(noPin.status, 403);
    assert.equal((await noPin.json()).pin, true);

    for (const [repo, error] of [
      ["agentv-owner/agentv-apps", /AgenTV's own repos/],
      ["person/agentv-os", /named like one of AgenTV's own/],
      ["a/b/c", /name, or owner\/name/],
    ] as const) {
      const refused = await phone("/api/phone/apps/local.blocks/push", { repo }, await pin());
      assert.equal(refused.status, 400, repo);
      assert.match((await refused.json()).error, error);
    }
    assert.equal(pushes.length, 0, "nothing refused reaches the screen daemon");

    const pushed = await phone("/api/phone/apps/local.blocks/push", { repo: "blocks" }, await pin());
    assert.deepEqual(await pushed.json(), { ok: true, url: "https://github.com/person/blocks", pushed: true });
    const [push] = pushes as PushAsk[];
    assert.deepEqual(push!.repo, { owner: "person", name: "blocks" });
    assert.equal(push!.version, manifest.version);
    const paths = push!.files.map((file) => file.path);
    assert.ok(paths.includes("manifest.json"));
    assert.ok(!paths.some((path) => path.startsWith("fixtures/")), "a service's saved pages never leave the box");
    assert.equal(await offered(), null, "the offer goes once it's pushed");
    assert.match((await (await phone("/api/phone/apps/local.blocks/push", { repo: "blocks" }, await pin())).json()).error, /export it from its details on the tv first/);

    // A child watching can't push.
    assert.equal((await send("POST", "/api/apps/local.blocks/export", {})).status, 200);
    const grant = (await (await send("POST", "/api/pin/check", { pin: "2468" })).json()).grant;
    const child = (await (await send("POST", "/api/viewers", { name: "leo", role: "child" }, grant)).json()).profile;
    await send("POST", "/api/viewer", { id: child.id });
    assert.equal((await phone("/api/phone/apps/local.blocks/push", { repo: "blocks" }, await pin())).status, 403);
  } finally {
    screen.stop();
    delete process.env.AGENTV_PATH;
    await daemon.close();
  }
});
