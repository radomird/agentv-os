// One build on the box (ADR-011, ADR-043, ADR-046): its folder, what it was
// asked, what its steps have found, and how it's going.
//
// A build lives in /var/lib/agentv/build/<id>/<version>/:
// - request.json: what root handed over from the daemon, read only here;
// - recipe.json: the recipe this build walks, the kind's or an approved plan's;
// - state.json: what the agent declared through the harness (what it
//   understood, its plan, the origins it declared);
// - status.json: how it's going, for the daemon;
// - work/: the agent's own folder: the app in app/, its tests and notes;
// - log.jsonl: every step and every tool call, as it happened.
//
// Whatever the agent writes, the builder sets the app's id, name, version
// and author, and keeps what it reaches inside the recipe's bounds.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Media } from "../apps/contract/manifest.ts";
import type { Kind, Plan, Recipe } from "./recipe.ts";

// The provider the household picked, by its product's name (ADR-011, ADR-047).
export type Provider = "claude" | "chatgpt" | "gemini" | "grok" | "muse";
export type Phase = "understand" | "plan" | "build" | "stage-b";

export interface BuildRequest {
  build: string; // this build's own name, like "b1730000000"
  id: string; // the app's id, local.*
  version: string; // the version this build makes
  sentence: string; // what was asked, in the person's words
  phase: Phase;
  recipe: Kind | null; // null: no recipe fits, so a plan
  name?: string; // the app's name, once understood
  plan?: Plan; // the plan an adult approved, when there's no recipe
  change?: string; // a change to the app this builds on (Q117)
  from?: string; // the build of the version this one starts from
  provider: Provider;
  path: "plan" | "key";
  // With a key: what this build may spend, in dollars (ADR-045).
  budget?: { build: number; month: number; spentMonth: number };
  safeguards: boolean; // npm's guards (ADR-044)
  at: string;
}

export interface Understood {
  name: string; // what the app is called on home
  recipe: Kind | null;
  says: string; // one line: what the agent understood
  address?: string; // a streaming service's own web address
  category?: string;
}

export interface BuildState {
  understood?: Understood;
  plan?: Plan;
  origins: { origin: string; why: string }[];
}

export type StepState = "waiting" | "running" | "done" | "failed";

export interface BuildStatus {
  build: string;
  id: string;
  version: string;
  phase: Phase;
  state: "running" | "confirm" | "plan" | "approve" | "installed" | "sign-in" | "failed";
  steps: { id: string; state: StepState }[];
  step?: string;
  reason?: string; // one line, why it failed
  spent?: number; // dollars, with a key
  turns?: number;
  understood?: Understood;
  plan?: Plan;
  // What approval shows (ADR-043): a screenshot, what it reaches in plain
  // words, and its packages.
  approval?: { shot?: string; reaches: { always: string[]; declared: string[] }; packages: { name: string; version: string }[] };
  started: string;
  at: string;
}

export class Build {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get work(): string {
    return join(this.dir, "work");
  }

  get app(): string {
    return join(this.work, "app");
  }

  request(): BuildRequest {
    return JSON.parse(readFileSync(join(this.dir, "request.json"), "utf8"));
  }

  recipe(): Recipe {
    return JSON.parse(readFileSync(join(this.dir, "recipe.json"), "utf8"));
  }

  writeRecipe(recipe: Recipe): void {
    this.write("recipe.json", recipe);
  }

  state(): BuildState {
    try {
      return { origins: [], ...JSON.parse(readFileSync(join(this.dir, "state.json"), "utf8")) };
    } catch {
      return { origins: [] };
    }
  }

  setState(change: Partial<BuildState>): BuildState {
    const next = { ...this.state(), ...change };
    this.write("state.json", next);
    return next;
  }

  status(): BuildStatus | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, "status.json"), "utf8"));
    } catch {
      return null;
    }
  }

  setStatus(status: BuildStatus): void {
    this.write("status.json", { ...status, at: new Date().toISOString() });
  }

  log(event: Record<string, unknown>): void {
    appendFileSync(join(this.dir, "log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  }

  private write(name: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, name);
    writeFileSync(`${path}.next`, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
    renameSync(`${path}.next`, path);
  }
}

// --- The app's manifest, as the builder keeps it -------------------------

const CATEGORY: Record<string, string> = { game: "games", photos: "photos", api: "utility", streaming: "streaming", plan: "utility" };

// The manifest in the work folder, with the builder's own fields set and
// what the app reaches kept inside the recipe's bounds. Says what it changed,
// for the agent to read.
export function keepManifest(build: Build, recipe: Recipe, request: BuildRequest): string[] {
  const path = join(build.app, "manifest.json");
  if (!existsSync(path)) return ["there's no app/manifest.json yet"];
  let m: Record<string, any>;
  try {
    m = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return ["app/manifest.json isn't valid JSON"];
  }
  if (typeof m !== "object" || m === null || Array.isArray(m)) return ["app/manifest.json has to be an object"];
  const said: string[] = [];
  const state = build.state();
  const name = request.name ?? state.understood?.name;
  m.schemaVersion = 1;
  m.id = request.id;
  if (name) m.name = name;
  m.version = request.version;
  m.author = "your agent";
  if (typeof m.license !== "string" || !m.license) m.license = "MIT";
  m.kinds = ["tv-app"];
  m.tv = typeof m.tv === "object" && m.tv !== null ? m.tv : {};
  const tv = m.tv;
  tv.category = typeof tv.category === "string" && tv.category ? tv.category : (CATEGORY[recipe.kind] ?? "utility");
  if (recipe.runtime === "page") {
    tv.contract = 2;
    tv.runtime = "page";
    m.entryPoints = { page: typeof m.entryPoints?.page === "string" ? m.entryPoints.page : "index.html" };
  } else if (recipe.runtime === "web") {
    tv.runtime = "web";
    if (tv.contract !== 1 && tv.contract !== 2) tv.contract = 1;
  }

  // What it reaches: only inside the bounds, and only origins declared.
  const bounds = recipe.bounds;
  const declared = new Set(recipe.kind === "plan" ? (request.plan?.permissions.origins ?? []) : state.origins.map((o) => o.origin));
  if (Array.isArray(tv.origins)) {
    const kept = tv.origins.filter((origin: unknown) => typeof origin === "string" && bounds.origins && declared.has(origin));
    for (const origin of tv.origins) if (!kept.includes(origin)) said.push(`took out ${String(origin)}: it isn't an origin this build declared`);
    if (kept.length) tv.origins = kept;
    else delete tv.origins;
  }
  if (Array.isArray(tv.media)) {
    const kept = tv.media.filter((media: unknown) => bounds.media.includes(media as Media));
    for (const media of tv.media) if (!kept.includes(media)) said.push(`took out tv.media ${String(media)}: this recipe doesn't read it`);
    if (kept.length) tv.media = kept;
    else delete tv.media;
  }
  if (Array.isArray(tv.capabilities) && tv.capabilities.includes("tile") && !bounds.tile) {
    tv.capabilities = tv.capabilities.filter((c: unknown) => c !== "tile");
    said.push("took out the tile capability: this recipe has no tile");
  }
  if (tv.notices !== undefined && !bounds.notices) {
    delete tv.notices;
    said.push("took out tv.notices: this recipe sends none");
  }
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
  return said;
}
