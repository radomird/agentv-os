// Export's push to a repo of the person's own (ADR-045). When the person's
// account on the box is signed in to GitHub, with gh (`gh auth login`) or
// an SSH key added on Omarchy's desktop, Export also offers "push to a repo
// of mine" on the phone, behind the adult PIN each time. The daemon checks
// the ask and hands it to the screen daemon (asks.ts), which runs as the
// person: it clones the repo, puts the app in a folder named after it,
// commits as them and pushes, never with --force. The builder has no part
// in it and holds nothing it could push with, and AgenTV's own repos are
// refused.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export interface Repo {
  owner: string;
  name: string;
}

export interface SignIn {
  via: "gh" | "ssh";
  login: string;
}

export interface PushAsk {
  kind: "push";
  id: string;
  name: string;
  version: string;
  repo: Repo;
  files: { path: string; data: string }[]; // the package's files, in base64
}

export type GitHubAsk = { kind: "sign-in" } | PushAsk;

export interface GitHubAnswer {
  ok: boolean;
  error?: string;
  via?: "gh" | "ssh";
  login?: string;
  url?: string; // the repo on GitHub, once it's pushed
  pushed?: boolean; // false when the repo had this version already
}

export const NOT_SIGNED_IN = "this box isn't signed in to GitHub: run gh auth login on Omarchy's desktop, or add an SSH key there";

// AgenTV's own repos, whose names a fork keeps.
const AGENTV_REPOS = ["agentv-os", "agentv-iso", "agentv-pkgs", "agentv-apps", "agentv-plugin", "agentv-adapters", "agentv-planning"];
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

// "name" or "owner/name", as typed on the phone, with the person's own
// login as the owner when it's left out.
export function parseRepo(typed: unknown, login: string): Repo | { error: string } {
  const text = typeof typed === "string" ? typed.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/, "") : "";
  const [owner, name, ...rest] = text.includes("/") ? text.split("/") : [login, text];
  if (rest.length || !owner || !name || !OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return { error: "type the repo as name, or owner/name" };
  return { owner, name };
}

// Why a repo is refused, or null: AgenTV's own, and any repo named like
// one of them.
export function repoRefusal(repo: Repo, agentv: string | null): string | null {
  const name = repo.name.toLowerCase();
  if (agentv && repo.owner.toLowerCase() === agentv.toLowerCase() && /^agentv(?:-|$)/.test(name)) return "that's one of AgenTV's own repos: pick one of yours";
  if (AGENTV_REPOS.includes(name)) return "that's named like one of AgenTV's own repos: pick another";
  return null;
}

// Only what an answer from the screen daemon has, within bounds.
export function cleanGitHub(said: unknown): GitHubAnswer {
  const a = (typeof said === "object" && said !== null ? said : {}) as Record<string, unknown>;
  if (a.ok !== true) return { ok: false, error: typeof a.error === "string" ? a.error.slice(0, 300) : "the TV couldn't do it" };
  return {
    ok: true,
    ...(a.via === "gh" || a.via === "ssh" ? { via: a.via } : {}),
    ...(typeof a.login === "string" && OWNER.test(a.login) ? { login: a.login } : {}),
    ...(typeof a.url === "string" && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(a.url) ? { url: a.url } : {}),
    ...(typeof a.pushed === "boolean" ? { pushed: a.pushed } : {}),
  };
}

// The screen daemon's side, as the person.

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

export type Run = (command: string, args: string[], o?: { cwd?: string; env?: NodeJS.ProcessEnv; ms?: number }) => Promise<Ran>;

// A program's output and exit code: -1 when it isn't there or ran too long.
export const run: Run = (command, args, o = {}) =>
  new Promise((done) => {
    const child = spawn(command, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], timeout: o.ms ?? 60_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 65_536) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 65_536) stderr += chunk.toString();
    });
    child.on("error", (error) => done({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
  });

export interface GitHubOptions {
  run?: Run;
  home?: string; // the person's home, for ~/.ssh
  hosts?: () => Promise<string>; // GitHub's SSH host keys, as known_hosts lines
  userAgent?: string;
  tmp?: string;
  remote?: (who: SignIn, repo: Repo) => string; // where git pushes, for tests
}

// GitHub's SSH host keys, from its API over HTTPS, so ssh knows it's
// GitHub without taking whatever answers first on trust.
export async function gitHubHosts(userAgent = "AgenTV"): Promise<string> {
  const response = await fetch("https://api.github.com/meta", { headers: { Accept: "application/vnd.github+json", "User-Agent": userAgent }, signal: AbortSignal.timeout(15_000) });
  const meta = (await response.json()) as { ssh_keys?: unknown };
  const keys = Array.isArray(meta.ssh_keys) ? meta.ssh_keys.filter((key): key is string => typeof key === "string" && /^(?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+$/.test(key)) : [];
  if (!keys.length) throw new Error("GitHub's SSH host keys couldn't be read");
  return keys.map((key) => `github.com ${key}\n`).join("");
}

// ssh with no prompts, checking GitHub's host keys from known_hosts.
function sshOptions(knownHosts: string): string[] {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`];
}

// A folder of the person's own for one ask, with GitHub's host keys in it
// when ssh will need them, and gone afterwards.
async function inFolder<T>(o: GitHubOptions, ssh: boolean, work: (dir: string, knownHosts: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(o.tmp ?? tmpdir(), "agentv-push-"));
  try {
    const knownHosts = join(dir, "known_hosts");
    if (ssh) writeFileSync(knownHosts, await (o.hosts ?? (() => gitHubHosts(o.userAgent)))());
    return await work(dir, knownHosts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Whether the person is signed in to GitHub here, and as whom: gh first,
// then an SSH key, if there is one.
export async function signedIn(o: GitHubOptions = {}): Promise<SignIn | null> {
  const exec = o.run ?? run;
  const gh = await exec("gh", ["api", "user", "--jq", ".login"], { ms: 20_000 });
  const login = gh.stdout.trim();
  if (gh.code === 0 && OWNER.test(login)) return { via: "gh", login };
  const keys = join(o.home ?? homedir(), ".ssh");
  if (!existsSync(keys) || !readdirSync(keys).some((name) => /^id_[a-z0-9_]+$/.test(name))) return null;
  return inFolder(o, true, async (_dir, knownHosts) => {
    const said = await exec("ssh", [...sshOptions(knownHosts), "-T", "git@github.com"], { ms: 30_000 });
    const found = /Hi ([A-Za-z0-9-]+)! You've successfully authenticated/.exec(said.stderr + said.stdout);
    return found ? { via: "ssh", login: found[1]! } : null;
  });
}

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 200) ?? "";

// The app, in a folder named after it in the person's repo, as a commit of
// theirs, pushed as it is: if the repo moved on meanwhile, GitHub refuses it
// and nothing is overwritten. With gh, a repo that isn't there yet is made,
// private.
export async function pushApp(ask: PushAsk, o: GitHubOptions = {}): Promise<GitHubAnswer> {
  const exec = o.run ?? run;
  const who = await signedIn(o);
  if (!who) return { ok: false, error: NOT_SIGNED_IN };
  const { owner, name } = ask.repo;
  const url = `https://github.com/${owner}/${name}`;
  const failed = (what: string, ran: Ran): GitHubAnswer => ({ ok: false, error: [what, firstLine(ran.stderr)].filter(Boolean).join(": ") });
  return inFolder(o, who.via === "ssh", async (dir, knownHosts) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (who.via === "ssh") env.GIT_SSH_COMMAND = ["ssh", ...sshOptions(knownHosts)].map((word) => `'${word}'`).join(" ");
    // With gh, git asks gh for the person's token as it pushes, and nothing
    // writes it down.
    const helper = who.via === "gh" ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : [];
    const git = (args: string[], cwd?: string) => exec("git", [...helper, ...args], { cwd, env, ms: 120_000 });

    if (who.via === "gh" && (await exec("gh", ["repo", "view", `${owner}/${name}`, "--json", "name"], { env, ms: 30_000 })).code !== 0) {
      const made = await exec("gh", ["repo", "create", `${owner}/${name}`, "--private", "--description", `${ask.name}, made by my agent on AgenTV`], { env, ms: 60_000 });
      if (made.code !== 0) return failed("GitHub didn't make the repo", made);
    }
    const work = join(dir, "repo");
    const remote = o.remote?.(who, ask.repo) ?? (who.via === "gh" ? `${url}.git` : `git@github.com:${owner}/${name}.git`);
    const cloned = await git(["clone", "--quiet", "--depth", "1", remote, work]);
    if (cloned.code !== 0) return failed(who.via === "ssh" ? "the repo isn't there, or your SSH key can't reach it: make it on GitHub first" : "the repo couldn't be read", cloned);

    // The app's folder is replaced, and the rest of the repo stays as it is.
    const folder = join(work, ask.id);
    rmSync(folder, { recursive: true, force: true });
    for (const file of ask.files) {
      const path = resolve(folder, file.path);
      if (!path.startsWith(folder + sep)) return { ok: false, error: "a file of the app is outside its folder" };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(file.data, "base64"));
    }
    await git(["add", "--all", "--", ask.id], work);
    if ((await git(["diff", "--cached", "--quiet"], work)).code === 0) return { ok: true, url, pushed: false };
    if ((await git(["rev-parse", "--verify", "--quiet", "HEAD"], work)).code !== 0) await git(["symbolic-ref", "HEAD", "refs/heads/main"], work);
    const committed = await git(["commit", "--quiet", "--no-verify", "-m", `${ask.name} ${ask.version}, made by my agent on AgenTV`], work);
    if (committed.code !== 0) return failed(/user\.(?:name|email)|identity/i.test(committed.stderr) ? "git doesn't know your name and email yet: set them on Omarchy's desktop" : "it couldn't be committed", committed);
    const pushed = await git(["push", "--quiet", "--no-verify", "origin", "HEAD"], work);
    if (pushed.code !== 0) return failed(/\[rejected\]|non-fast-forward|fetch first/.test(pushed.stderr) ? "the repo changed while this was pushing: try again" : "GitHub refused the push", pushed);
    return { ok: true, url, pushed: true };
  });
}

// The screen daemon's answer to each of the daemon's asks about GitHub.
export function answerGitHub(o: GitHubOptions = {}): (ask: GitHubAsk) => Promise<GitHubAnswer> {
  return async (ask) => {
    if (ask.kind === "push") return pushApp(ask, o);
    const who = await signedIn(o);
    return who ? { ok: true, ...who } : { ok: false, error: NOT_SIGNED_IN };
  };
}
