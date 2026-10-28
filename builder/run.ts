// The builder (ADR-011, ADR-043, ADR-046): one build, one phase at a time,
// in the agentv-builder sandbox. The daemon asks for each phase, through
// root, and reads status.json for how it goes.
//
// - understand: the agent says what the request is and which recipe fits,
//   and the TV asks an adult to confirm it.
// - plan: no recipe fits, so the agent writes a plan, and an adult approves
//   it on the phone before anything is built.
// - build: the builder walks the recipe's steps, or the approved plan's, in
//   order, starting the provider's CLI once for each with that step's tools
//   alone. A streaming service's build is its stage A here.
// - stage-b: a streaming service's steps after the household signed in.
//
// The agent can't skip a step, add one or leave one: the builder walks them,
// whatever the agent says, and a step that doesn't leave what it needs ends
// the build. Then the gates run, and the app waits for an adult's approval.
//
// Usage: node run.ts <build-dir>

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validatePackage } from "../apps/contract/manifest.ts";
import { pagePermissions } from "../apps/contract/page.ts";
import { Build, type BuildRequest, type BuildStatus, keepManifest } from "./build.ts";
import { PLAN, UNDERSTAND } from "./harness/server.ts";
import { lockedPackages } from "./packages.ts";
import { command, outcome, type Outcome, ownTools } from "./providers.ts";
import { signedIn } from "./sign-in.ts";
import { KINDS, loadRecipes, planRecipe, type Recipe, type Step } from "./recipe.ts";

export interface RunOptions {
  root?: string; // AgenTV's files: /usr/share/agentv
  home?: string; // the builder's home: /var/lib/agentv/builder
  proxy?: string; // the sandbox's way out
  relay?: string; // the key relay
  standIn?: string; // a recorded build to replay instead of a provider
  // The gates beyond the static checks (ADR-043): the headless checks and
  // the tests, once they're on the box. Each returns problems, or none.
  gates?: (build: Build, recipe: Recipe) => Promise<{ problems: string[]; shot?: string }>;
  log?: (line: string) => void;
}

const ROOT = join(import.meta.dirname, "..");

function now(): string {
  return new Date().toISOString();
}

// The steps this phase walks: a streaming service's stage A in build, its
// stage B in stage-b, and every step of any other recipe.
export function phaseSteps(recipe: Recipe, phase: BuildRequest["phase"]): Step[] {
  if (phase === "stage-b") return recipe.steps.filter((step) => step.stage === "b");
  if (recipe.steps.some((step) => step.stage)) return recipe.steps.filter((step) => step.stage !== "b");
  return recipe.steps;
}

function brief(root: string): string {
  return readFileSync(join(root, "builder/prompts/brief.md"), "utf8");
}

// What the agent is told for one step: the request, where the build is, the
// step in plain words and the tools it has. Never another step's.
export function stepPrompt(request: BuildRequest, recipe: Recipe, step: Step, index: number, count: number, understood?: string): string {
  const lines = [
    `The request: "${request.sentence}"`,
    understood ? `What it is: ${understood}` : null,
    request.change ? `This is a change to the app that's on the box: "${request.change}". Its last version's work is in the build already; change what the request asks and keep the rest.` : null,
    `The recipe: ${recipe.name}. This is step ${index + 1} of ${count}, "${step.id}".`,
    "",
    step.does,
    "",
    `Your tools in this step: ${step.tools.join(", ")}.`,
    step.writes?.length ? `You may write: ${step.writes.join(", ")}.` : "You write nothing in this step.",
    step.reads?.length ? `References you may read: ${step.reads.map((r) => `@${r}`).join(", ")} (list @ shows them).` : null,
    "When the step is done, say so in one line. The builder starts the next step itself.",
  ];
  return lines.filter((line) => line !== null).join("\n");
}

export class Runner {
  private build: Build;
  private options: RunOptions;
  private root: string;
  private spent = 0;
  private log: (line: string) => void;

  constructor(dir: string, options: RunOptions = {}) {
    this.build = new Build(dir);
    this.options = options;
    this.root = options.root ?? ROOT;
    this.log = options.log ?? ((line) => console.log(line));
  }

  private status(change: Partial<BuildStatus>): void {
    const request = this.build.request();
    const before = this.build.status();
    this.build.setStatus({
      build: request.build,
      id: request.id,
      version: request.version,
      phase: request.phase,
      state: "running",
      steps: [],
      started: before?.started ?? now(),
      at: now(),
      ...before,
      ...change,
      ...(this.spent ? { spent: Math.round(this.spent * 100) / 100 } : {}),
    } as BuildStatus);
  }

  private fail(reason: string): BuildStatus {
    this.build.log({ failed: reason });
    this.log(`the build failed: ${reason}`);
    this.status({ state: "failed", reason, step: undefined });
    return this.build.status()!;
  }

  // What this build may still spend, with a key: its own cap and the
  // month's, whichever is nearer.
  private budget(request: BuildRequest): number | undefined {
    if (request.path !== "key" || !request.budget) return undefined;
    return Math.min(request.budget.build - this.spent, request.budget.month - request.budget.spentMonth - this.spent);
  }

  // Runs the provider's CLI for one step, with that step's harness, until it
  // ends or the build's time is up.
  private async step(request: BuildRequest, step: Step, prompt: string, deadline: number): Promise<Outcome> {
    const harness = { command: process.execPath, args: ["--disable-warning=ExperimentalWarning", join(this.root, "builder/harness/server.ts"), resolve(this.build.dir), step.id] };
    const left = this.budget(request);
    const run = command(request.provider, {
      prompt,
      brief: brief(this.root),
      harness,
      cwd: this.build.work,
      turns: step.turns ?? 30,
      budget: left,
      home: this.options.home ?? process.env.HOME ?? "/var/lib/agentv/builder",
      proxy: this.options.proxy,
      relay: this.options.relay,
      path: request.path,
      standIn: this.options.standIn,
      step: step.id,
    });
    for (const [path, text] of Object.entries(run.files ?? {})) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    // Understanding and planning run beside an empty build: nothing is in
    // work/ until a recipe or a plan is walked.
    const cwd = existsSync(this.build.work) ? this.build.work : this.build.dir;
    this.build.log({ step: step.id, started: true });
    const lines: string[] = [];
    // A CLI that says it offers the agent tools of its own, beyond the
    // harness's, is stopped before the agent can use one.
    let own: string[] = [];
    const code = await new Promise<number | null>((done) => {
      const child = spawn(run.command, run.args, { cwd, env: run.env, stdio: ["ignore", "pipe", "pipe"] });
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          lines.push(line);
          buffer = buffer.slice(end + 1);
          if (own.length || !line.includes('"init"')) continue;
          try {
            own = ownTools(JSON.parse(line));
          } catch {}
          if (own.length) child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", () => {});
      const timer = setTimeout(() => child.kill("SIGTERM"), Math.max(1000, deadline - Date.now()));
      child.on("error", () => done(null));
      child.on("close", (exit) => {
        clearTimeout(timer);
        if (buffer) lines.push(buffer);
        done(exit);
      });
    });
    if (own.length) {
      this.build.log({ step: step.id, ended: true, ok: false, ownTools: own });
      return { ok: false, reason: `the agent's CLI offered tools of its own: ${own.slice(0, 5).join(", ")}` };
    }
    const result = outcome(this.options.standIn ? "stand-in" : request.provider, lines, code);
    if (Date.now() >= deadline) return { ok: false, reason: "the build took longer than it may" };
    this.spent += result.spent ?? 0;
    this.build.log({ step: step.id, ended: true, ok: result.ok, reason: result.reason, spent: result.spent, turns: result.turns });
    return result;
  }

  async run(): Promise<BuildStatus> {
    const request = this.build.request();
    this.build.setStatus({ build: request.build, id: request.id, version: request.version, phase: request.phase, state: "running", steps: [], started: now(), at: now() });
    if (!/^local\.[a-z0-9][a-z0-9-]*$/.test(request.id)) return this.fail("an app the agent builds has an id that starts with local.");
    // A plan signs in the first time the builder runs (ADR-040): a build
    // without its sign-in waits for it, and starts again once it's there.
    if (request.path === "plan" && !this.options.standIn) {
      const signed = await signedIn(request.provider, { home: this.options.home ?? process.env.HOME ?? "/var/lib/agentv/builder", proxy: this.options.proxy });
      if (signed === null) return this.fail(`${request.provider}'s plan is coming soon: use a key for it`);
      if (!signed) {
        // Once, so a sign-in that doesn't take isn't asked for again and again.
        if (request.signedIn) return this.fail(`the ${request.provider} plan's sign-in didn't take: try again`);
        this.log(`${request.provider}'s plan isn't signed in yet`);
        this.status({ state: "plan-sign-in", reason: `sign in to your ${request.provider} plan first`, step: undefined });
        return this.build.status()!;
      }
    }
    if (request.phase === "understand") return this.understand(request);
    if (request.phase === "plan") return this.plan(request);
    return this.walk(request);
  }

  private async understand(request: BuildRequest): Promise<BuildStatus> {
    const recipes = loadRecipes(join(this.root, "builder/recipes"));
    this.status({ state: "running", step: UNDERSTAND.id, steps: [{ id: UNDERSTAND.id, state: "running" }] });
    const prompt = [
      `The request: "${request.sentence}"`,
      "",
      "Say what it is with the understood tool: a short name for its tile, which of these recipes fits, and one line on what you'll build.",
      ...[...recipes.values()].map((r) => `- ${r.kind}: ${r.fits}`),
      "If none of them fits, say so with recipe null: an adult then sees a plan first. For a streaming service, give its own web address.",
      "Call understood once, then stop.",
    ].join("\n");
    const result = await this.step(request, UNDERSTAND, prompt, Date.now() + 5 * 60_000);
    const understood = this.build.state().understood;
    if (!result.ok && !understood) return this.fail(result.reason ?? "the agent didn't say what it understood");
    if (!understood) return this.fail("the agent didn't say what it understood");
    this.status({ state: "confirm", step: undefined, steps: [{ id: UNDERSTAND.id, state: "done" }], understood });
    return this.build.status()!;
  }

  private async plan(request: BuildRequest): Promise<BuildStatus> {
    if (request.recipe !== null) return this.fail("a plan is only for a request no recipe fits");
    this.status({ state: "running", step: PLAN.id, steps: [{ id: PLAN.id, state: "running" }] });
    const understood = this.build.state().understood;
    const prompt = [
      `The request: "${request.sentence}"`,
      understood ? `What it is: ${understood.says}` : "",
      "",
      "No recipe fits it, so write a plan for an adult to approve before anything is built. It's always a page app (read @kit/kit.md for what one can do). Submit it with submit_plan:",
      "- name: what it's called on home;",
      "- says: one line on what it is;",
      "- steps: up to 8, each an id and in plain words what it does (AgenTV adds its own tests and checks after them);",
      "- permissions: the internet origins it reaches (none if it needs none), the box's photos or music it reads, whether it has a tile on home and sends notices;",
      "- packages: the npm packages it expects, with exact versions where you know them;",
      request.path === "key" ? "- cost: a rough low and high in dollars, for the whole build." : "",
      "Ask for no more than the app needs. Then stop.",
    ]
      .filter(Boolean)
      .join("\n");
    const result = await this.step(request, PLAN, prompt, Date.now() + 10 * 60_000);
    const plan = this.build.state().plan;
    if (!plan) return this.fail(result.reason ?? "the agent didn't submit a plan");
    this.status({ state: "plan", step: undefined, steps: [{ id: PLAN.id, state: "done" }], plan });
    return this.build.status()!;
  }

  // The recipe this build walks: the kind's, or the plan an adult approved.
  // Nothing else: with no recipe and no approved plan, nothing is built.
  private recipeFor(request: BuildRequest): Recipe | string {
    if (request.recipe === null) {
      if (!request.plan) return "no recipe fits and no plan is approved, so nothing is built";
      return planRecipe(request.plan, this.root);
    }
    if (!KINDS.includes(request.recipe)) return `there's no recipe for ${String(request.recipe)}`;
    const recipe = loadRecipes(join(this.root, "builder/recipes")).get(request.recipe);
    return recipe ?? `there's no recipe for ${request.recipe}`;
  }

  private async walk(request: BuildRequest): Promise<BuildStatus> {
    const found = request.phase === "stage-b" && existsSync(join(this.build.dir, "recipe.json")) ? this.build.recipe() : this.recipeFor(request);
    if (typeof found === "string") return this.fail(found);
    const recipe = found;
    const steps = phaseSteps(recipe, request.phase);
    if (steps.length === 0) return this.fail(`the ${recipe.name} recipe has no steps for this phase`);

    if (request.phase === "build") {
      this.build.writeRecipe(recipe);
      // A change or a rebuild starts from the version it changes, a new app
      // from the recipe's template.
      rmSync(this.build.work, { recursive: true, force: true });
      const from = request.from ? join(request.from, "work") : join(recipe.dir, recipe.template);
      if (!existsSync(from)) return this.fail(request.from ? "the version this changes isn't on the box" : "the recipe's template isn't there");
      cpSync(from, this.build.work, { recursive: true, filter: (source) => !source.endsWith("/node_modules") });
      if (recipe.runtime !== "theme") keepManifest(this.build, recipe, request);
    }

    const understood = this.build.state().understood?.says;
    const deadline = Date.now() + recipe.minutes * 60_000;
    const states = steps.map((step) => ({ id: step.id, state: "waiting" as const }));
    const say = (index: number, state: "running" | "done" | "failed") => {
      (states[index] as { state: string }).state = state;
      this.status({ state: "running", step: steps[index].id, steps: [...states] });
    };
    const filled: { id: string; said?: string }[] = [];

    for (const [index, step] of steps.entries()) {
      const left = this.budget(request);
      if (left !== undefined && left <= 0) return this.fail("the build reached its spend cap");
      say(index, "running");
      this.log(`step ${index + 1} of ${steps.length}: ${step.id}`);
      const result = await this.step(request, step, stepPrompt(request, recipe, step, index, steps.length, understood), deadline);
      if (!result.ok) {
        say(index, "failed");
        return this.fail(`${step.id}: ${result.reason ?? "it didn't finish"}`);
      }
      const missing = (step.needs ?? []).filter((need) => !existsSync(join(this.build.work, need)));
      if (missing.length) {
        say(index, "failed");
        return this.fail(`${step.id} didn't leave ${missing.join(", ")}`);
      }
      if (recipe.runtime !== "theme") keepManifest(this.build, recipe, request);
      filled.push({ id: step.id, said: result.said });
      say(index, "done");
    }

    // What the agent filled the recipe in with, kept beside the app once
    // it's approved, for repairs, changes and rebuilds (ADR-046).
    writeFileSync(join(this.build.dir, "filled.json"), `${JSON.stringify({ recipe: recipe.kind, name: recipe.name, steps: filled }, null, 2)}\n`);

    // Gate 1, the static checks, and the gates beyond them.
    if (recipe.runtime !== "theme") {
      const { manifest, problems } = validatePackage(this.build.app, "local");
      if (!manifest) return this.fail(`the static checks found: ${problems[0]}`);
      const gates = await this.options.gates?.(this.build, recipe);
      if (gates?.problems.length) return this.fail(gates.problems[0]);
      const reaches = manifest.tv.runtime === "page" ? pagePermissions(manifest) : { always: [], declared: (manifest.tv.origins ?? []).map((o) => `the internet, at ${o.replace(/^https?:\/\//, "")}`) };
      const packages = this.packages();
      this.status({ state: "approve", step: undefined, steps: [...states], approval: { shot: gates?.shot, reaches, packages } });
      this.log("the build passed its checks, and waits for an adult's approval");
    } else {
      const gates = await this.options.gates?.(this.build, recipe);
      if (gates?.problems.length) return this.fail(gates.problems[0]);
      this.status({ state: "approve", step: undefined, steps: [...states], approval: { shot: gates?.shot, reaches: { always: [], declared: [] }, packages: [] } });
    }
    return this.build.status()!;
  }

  // The npm packages in the build, by name and version, from its lockfile.
  private packages(): { name: string; version: string }[] {
    try {
      return lockedPackages(JSON.parse(readFileSync(join(this.build.work, "package-lock.json"), "utf8")))
        .map(({ name, version }) => ({ name, version }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.removeAllListeners("warning");
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node run.ts <build-dir>");
    process.exit(2);
  }
  const status = await new Runner(dir, {
    root: process.env.AGENTV_PATH,
    home: process.env.HOME,
    proxy: process.env.AGENTV_BUILD_PROXY,
    relay: process.env.AGENTV_BUILD_RELAY,
    standIn: process.env.AGENTV_BUILD_STAND_IN,
  }).run();
  process.exit(status.state === "failed" ? 1 : 0);
}
