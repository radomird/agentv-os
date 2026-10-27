// Root's side of a build (agentv-build.service, which agentv-build.path
// starts): the daemon can't start the sandbox itself, so it leaves what it
// wants in its own state, and this checks it and starts it.
//
// - start.json: a build's next phase. This checks the request, makes the
//   build's folder (the app's folder is root's, so the builder can't swap
//   it), copies the version a change starts from, writes request.json and
//   the ticket the filter and the relay go by, fetches the CLI into the
//   builder's home the first time, and starts agentv-builder@.service.
// - stop.json: stops the running build.
//
// One build runs at a time. What happened goes to /run/agentv-build/answer.json
// for the daemon, and a refused build's status.json says why.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BuildRequest, BuildStatus, Provider } from "../build.ts";
import { CLIS } from "../providers.ts";
import { KINDS, planProblems, type Plan } from "../recipe.ts";
import { DEFAULT_CAP, type Spend, type Ticket } from "./relay.ts";

export interface HandOverOptions {
  drop: string; // the daemon's drop folder
  builds: string; // /var/lib/agentv/build
  home: string; // the builder's home
  run: string; // /run/agentv-build
  spend: string; // the relay's spend.json
  builder: { uid: number; gid: number };
  rootUid: number; // who owns what the builder mustn't change
  systemctl: (args: string[]) => boolean;
}

const BUILD = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ID = /^local\.[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const PHASES = ["understand", "plan", "build", "stage-b"];
const PROVIDERS: Provider[] = ["claude", "chatgpt", "gemini"];

const clean = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : null;

// A start.json as a request the builder can run, or why not.
export function checkRequest(data: unknown): { request?: BuildRequest; from?: string; cap?: { build: number; month: number }; error?: string } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { error: "a request is an object" };
  const d = data as Record<string, unknown>;
  if (typeof d.build !== "string" || !BUILD.test(d.build)) return { error: "a build has a name of lowercase letters, digits and dashes" };
  if (typeof d.id !== "string" || !ID.test(d.id)) return { error: "an app the agent builds has an id that starts with local." };
  if (typeof d.version !== "string" || !VERSION.test(d.version)) return { error: "a build makes a version like 1.0.0" };
  const sentence = clean(d.sentence, 500);
  if (!sentence) return { error: "a build says what was asked" };
  if (typeof d.phase !== "string" || !PHASES.includes(d.phase)) return { error: "understand, plan, build or stage-b" };
  if (d.recipe !== null && !KINDS.includes(d.recipe as never)) return { error: "a recipe AgenTV has, or null for a plan" };
  if (!PROVIDERS.includes(d.provider as Provider)) return { error: "claude, chatgpt or gemini" };
  if (d.path !== "plan" && d.path !== "key") return { error: "a plan or a key" };
  if (d.provider === "gemini" && d.path === "plan") return { error: "google's plans aren't offered yet" };
  if (typeof d.safeguards !== "boolean") return { error: "whether npm's safeguards are on" };
  let plan: Plan | undefined;
  if (d.plan !== undefined) {
    if (d.recipe !== null) return { error: "a plan is only for a request no recipe fits" };
    const problems = planProblems(d.plan);
    if (problems.length) return { error: problems[0] };
    plan = d.plan as Plan;
  }
  if (d.recipe === null && d.phase === "build" && !plan) return { error: "no recipe fits and no plan is approved, so nothing is built" };
  if (d.from !== undefined && (typeof d.from !== "string" || !VERSION.test(d.from) || d.from === d.version)) return { error: "a change starts from another version of the app" };
  let cap: { build: number; month: number } | undefined;
  if (d.cap !== undefined) {
    const c = d.cap as Record<string, unknown>;
    const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1000;
    if (typeof c !== "object" || c === null || !ok(c.build) || !ok(c.month)) return { error: "a cap is a build's dollars and a month's, each up to 1000" };
    cap = { build: c.build as number, month: c.month as number };
  }
  const request: BuildRequest = {
    build: d.build,
    id: d.id,
    version: d.version,
    sentence,
    phase: d.phase as BuildRequest["phase"],
    recipe: d.recipe as BuildRequest["recipe"],
    provider: d.provider as Provider,
    path: d.path,
    safeguards: d.safeguards,
    at: new Date().toISOString(),
  };
  const name = clean(d.name, 40);
  if (name) request.name = name;
  const change = clean(d.change, 500);
  if (change) request.change = change;
  if (plan) request.plan = plan;
  return { request, from: d.from as string | undefined, cap };
}

// systemd-escape --path, for the build's unit: local.my-app/1.0.0 is
// local.my\x2dapp-1.0.0.
export function escapePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^A-Za-z0-9:_.]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`).replace(/^\./, "\\x2e"))
    .join("-");
}

function write(path: string, data: unknown): void {
  const next = `${path}.next`;
  rmSync(next, { force: true });
  writeFileSync(next, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  renameSync(next, path);
}

// Everything under path, the builder's own.
function giveToBuilder(path: string, builder: { uid: number; gid: number }): void {
  lchownSync(path, builder.uid, builder.gid);
  if (!lstatSync(path).isDirectory()) return;
  for (const name of readdirSync(path)) giveToBuilder(join(path, name), builder);
}

export class HandOver {
  private o: HandOverOptions;

  constructor(options: HandOverOptions) {
    this.o = options;
  }

  private answer(build: string | null, started: boolean, reason?: string): { started: boolean; reason?: string } {
    mkdirSync(this.o.run, { recursive: true });
    write(join(this.o.run, "answer.json"), { build, started, ...(reason ? { reason } : {}), at: new Date().toISOString() });
    if (reason) console.error(`agentv-build-start: ${reason}`);
    return { started, reason };
  }

  running(): boolean {
    // With a pattern, is-active says yes when any build's unit is running.
    return this.o.systemctl(["--quiet", "is-active", "agentv-builder@*.service"]);
  }

  // A folder root keeps, or null if something else is there.
  private rootDir(path: string): string | null {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o755 });
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === this.o.rootUid ? path : null;
  }

  handle(): { started: boolean; reason?: string } | null {
    const stop = join(this.o.drop, "stop.json");
    if (existsSync(stop)) {
      rmSync(stop, { force: true });
      this.o.systemctl(["stop", "--no-block", "agentv-builder@*.service"]);
      return this.answer(null, false, "stopped");
    }
    const startPath = join(this.o.drop, "start.json");
    if (!existsSync(startPath)) return null;
    let data: unknown = null;
    // Only a file the daemon wrote, never one it points somewhere else.
    try {
      if (lstatSync(startPath).isFile()) data = JSON.parse(readFileSync(startPath, "utf8"));
    } catch {}
    rmSync(startPath, { force: true });
    return this.start(data);
  }

  start(data: unknown): { started: boolean; reason?: string } {
    const checked = checkRequest(data);
    const name = typeof (data as { build?: unknown })?.build === "string" ? ((data as { build: string }).build as string) : null;
    if (!checked.request) return this.answer(name, false, checked.error);
    const request = checked.request;
    if (this.running()) return this.answer(request.build, false, "another build is running; one runs at a time");

    const builds = this.rootDir(this.o.builds);
    const app = builds && this.rootDir(join(builds, request.id));
    if (!app) return this.answer(request.build, false, "the build folders aren't root's");
    const dir = join(app, request.version);
    // A new build starts from nothing: what an earlier try at this version
    // understood or wrote isn't this one's.
    if (request.phase === "understand") rmSync(dir, { recursive: true, force: true });
    if (existsSync(dir)) {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return this.answer(request.build, false, "the build's folder isn't a folder");
    } else {
      mkdirSync(dir, { mode: 0o755 });
      lchownSync(dir, this.o.builder.uid, this.o.builder.gid);
    }
    const refuse = (reason: string) => {
      const status: BuildStatus = { build: request.build, id: request.id, version: request.version, phase: request.phase, state: "failed", steps: [], reason, started: request.at, at: request.at };
      write(join(dir, "status.json"), status);
      return this.answer(request.build, false, reason);
    };

    // A change starts from a copy of the version it changes, in the build's
    // own folder, since the sandbox sees no other build.
    if (request.phase === "build" && checked.from) {
      const base = join(app, checked.from, "work");
      if (!existsSync(base) || lstatSync(join(app, checked.from)).isSymbolicLink()) return refuse("the version this changes isn't on the box");
      const copy = join(dir, "from");
      rmSync(copy, { recursive: true, force: true });
      cpSync(base, join(copy, "work"), { recursive: true, verbatimSymlinks: true, filter: (source) => !source.endsWith("/node_modules") });
      giveToBuilder(copy, this.o.builder);
      request.from = copy;
    }

    // With a key, what the build may spend: the relay keeps to it either way.
    if (request.path === "key") {
      const cap = { ...DEFAULT_CAP, ...checked.cap };
      let spend: Spend | null = null;
      try {
        spend = JSON.parse(readFileSync(this.o.spend, "utf8"));
      } catch {}
      const month = new Date().toISOString().slice(0, 7);
      request.budget = { build: cap.build, month: cap.month, spentMonth: spend?.month === month ? spend.spent : 0 };
    }

    write(join(dir, "request.json"), request);
    const ticket: Ticket = {
      build: request.build,
      id: request.id,
      version: request.version,
      dir,
      provider: request.provider,
      path: request.path,
      recipe: request.recipe,
      ...(request.plan ? { origins: request.plan.permissions.origins } : {}),
      ...(request.path === "key" ? { cap: { ...DEFAULT_CAP, ...checked.cap } } : {}),
    };
    mkdirSync(this.o.run, { recursive: true });
    write(join(this.o.run, "ticket.json"), ticket);

    // The provider's CLI, fetched into the builder's own home the first time.
    const cli = CLIS[request.provider];
    if (!existsSync(join(this.o.home, ".local/bin", cli)) && !this.o.systemctl(["start", `agentv-builder-cli@${cli}.service`])) {
      rmSync(join(this.o.run, "ticket.json"), { force: true });
      return refuse(`the box couldn't fetch ${cli}`);
    }
    // A fresh start for the way out, with the key as it is now.
    if (!this.o.systemctl(["restart", "agentv-build-net.service"])) {
      rmSync(join(this.o.run, "ticket.json"), { force: true });
      return refuse("the builder's way out didn't start");
    }
    if (!this.o.systemctl(["start", "--no-block", `agentv-builder@${escapePath(`${request.id}/${request.version}`)}.service`])) {
      rmSync(join(this.o.run, "ticket.json"), { force: true });
      return refuse("the builder didn't start");
    }
    return this.answer(request.build, true);
  }
}

// The builder's user and group, from the system's own list.
function builderIds(): { uid: number; gid: number } {
  const line = readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .find((l) => l.startsWith("agentv-builder:"));
  const [, , uid, gid] = line?.split(":") ?? [];
  if (!uid || !gid) throw new Error("there's no agentv-builder user");
  return { uid: Number(uid), gid: Number(gid) };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.removeAllListeners("warning");
  const handOver = new HandOver({
    drop: process.env.AGENTV_BUILD_DROP ?? "/var/lib/private/agentv/daemon/build-drop",
    builds: "/var/lib/agentv/build",
    home: "/var/lib/agentv/builder",
    run: "/run/agentv-build",
    spend: "/var/lib/agentv/spend/spend.json",
    builder: builderIds(),
    rootUid: 0,
    systemctl: (args) => {
      try {
        execFileSync("systemctl", args, { stdio: ["ignore", "ignore", "inherit"], timeout: 20 * 60_000 });
        return true;
      } catch {
        return false;
      }
    },
  });
  const done = handOver.handle();
  process.exit(done && !done.started && done.reason !== "stopped" ? 1 : 0);
}
