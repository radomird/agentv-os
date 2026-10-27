// The builder's recipes (ADR-046). Each kind of app has one: its steps in
// plain words, the tools each step may use, a package template, and the
// tests the result must pass. AgenTV's builder walks the steps in order and
// gives the agent only that step's tools; the agent fills each step in. A
// recipe names no service and holds no selectors, so it can be public: the
// service-specific part is learned on the box and kept there.
//
// With no recipe for a request, the agent writes a one-off plan instead, and
// an adult approves it before anything is built. An approved plan becomes
// that app's recipe: AgenTV's own steps around the plan's, each with
// AgenTV's tools for a page app, never ones the plan names.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MEDIA, type Media } from "../apps/contract/manifest.ts";

export const KINDS = ["streaming", "game", "photos", "api", "theme"] as const;
export type Kind = (typeof KINDS)[number];

// Every tool the harness has, and what each one does, as the agent sees it.
// A step lists the ones it may use; the harness offers it those alone.
export const TOOLS = {
  read: "Read a file in the build, or one of the references this step lists.",
  list: "List the files in the build, or in a folder of it.",
  write: "Write a file in the build, where this step may write.",
  remove: "Remove a file in the build, where this step may write.",
  npm_info: "Look up a package in the npm registry: its versions, when each was published, and what it says it does.",
  npm_add: "Add an npm package at an exact version, under AgenTV's safeguards.",
  bundle: "Bundle src/main.js and the packages it imports into the app's main.js.",
  check: "Run AgenTV's static checks on the app: the contract, no remote scripts or eval, requests only to declared origins, the size limit.",
  try: "Run AgenTV's own checks on the app in a headless TV: it opens, answers the remote and a gamepad, Back leaves it, 60 fps, its memory, and no undeclared request.",
  run_tests: "Run the app's tests, yours and the recipe's.",
  declare_origin: "Declare an internet origin the app reaches, with why. Approval shows it.",
  fetch_sample: "Fetch an address on a declared origin, to see what it answers, and with save keep it as a recorded reply for the fixtures.",
  look: "Open a page on the app's declared origins in a fresh browser with no sign-in, and see its structure, the origins it asked for and whether it plays protected video. With save, keep the page as a fixture.",
  page_snapshot: "See the structure of the service's page in the TV's browser, signed in, on the app's declared origins.",
  contract_tests: "Run the contract tests on the app against what was saved from the service's page.",
  theme_check: "Check the theme folder the way Omarchy will read it.",
  understood: "Say what you understood the request to be.",
  submit_plan: "Submit the plan for an adult to approve.",
} as const;
export type Tool = keyof typeof TOOLS;

// The tools a page app's build has, which an approved plan's steps get.
export const PAGE_TOOLS: Tool[] = ["read", "list", "write", "remove", "npm_info", "npm_add", "bundle", "check"];

export interface Step {
  id: string;
  does: string; // in plain words: what the agent supplies here
  tools: Tool[];
  writes?: string[]; // where the write and remove tools may write: globs in the build's work folder
  reads?: string[]; // references it may read beyond the build: "kit", "contract", "omarchy/theming.md"
  needs?: string[]; // files the step leaves, checked before the next step
  stage?: "a" | "b"; // a streaming service's stage: before sign-in, or after (ADR-011)
  turns?: number; // how many turns the agent gets, 30 by default
}

// What a recipe lets the app reach: the bounds its manifest stays within.
export interface Bounds {
  origins: boolean; // internet origins, declared in a step
  media: Media[];
  tile: boolean;
  notices: boolean;
}

export interface Recipe {
  kind: Kind | "plan";
  name: string; // the confirm step says "recipe: <name>"
  fits: string; // when the recipe fits, for understanding a request
  runtime: "page" | "web" | "theme";
  bounds: Bounds;
  steps: Step[];
  template: string; // a folder in the recipe, copied into the work folder first
  tests: string; // a folder of the recipe's own tests
  cost: { low: number; high: number }; // US dollars on Claude with a key, rough
  minutes: number; // the whole build
  dir: string; // where the recipe is
}

// A plan, for a request no recipe fits (Q123): always a page app.
export interface Plan {
  name: string;
  says: string; // one line: what it'll be
  steps: { id: string; does: string }[];
  permissions: { origins: string[]; media: Media[]; tile: boolean; notices: boolean };
  packages: { name: string; version?: string }[];
  cost?: { low: number; high: number };
}

const STEP_ID = /^[a-z][a-z0-9-]{0,30}$/;
const MAX_STEPS = 12;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

// A recipe's own checks: its steps, their tools and where they write.
export function recipeProblems(data: unknown, dir: string): string[] {
  const problems: string[] = [];
  if (!isObject(data)) return ["recipe.json has to be an object"];
  if (!KINDS.includes(data.kind as Kind)) problems.push(`kind is one of ${KINDS.join(", ")}`);
  if (!text(data.name, 40)) problems.push("a recipe has a name");
  if (!text(data.fits, 400)) problems.push("a recipe says when it fits");
  if (!["page", "web", "theme"].includes(data.runtime as string)) problems.push("runtime is page, web or theme");
  const bounds = data.bounds as Bounds | undefined;
  if (!isObject(bounds) || typeof bounds.origins !== "boolean" || !Array.isArray(bounds.media) || !bounds.media.every((m) => MEDIA.includes(m)) || typeof bounds.tile !== "boolean" || typeof bounds.notices !== "boolean") {
    problems.push("bounds says whether the app may have origins, which media, a tile and notices");
  }
  if (!Array.isArray(data.steps) || data.steps.length === 0 || data.steps.length > MAX_STEPS) {
    problems.push(`a recipe has 1 to ${MAX_STEPS} steps`);
  } else {
    const ids = new Set<string>();
    for (const step of data.steps as unknown[]) {
      if (!isObject(step) || typeof step.id !== "string" || !STEP_ID.test(step.id)) {
        problems.push("each step has an id of lowercase letters");
        continue;
      }
      if (ids.has(step.id)) problems.push(`the step ${step.id} is there twice`);
      ids.add(step.id);
      if (!text(step.does, 1200)) problems.push(`the step ${step.id} says what it does`);
      if (!Array.isArray(step.tools) || step.tools.length === 0) problems.push(`the step ${step.id} lists its tools`);
      for (const tool of Array.isArray(step.tools) ? step.tools : []) {
        if (!(tool in TOOLS)) problems.push(`the step ${step.id} lists ${String(tool)}, which isn't a tool`);
      }
      const writes: unknown[] = Array.isArray(step.writes) ? step.writes : [];
      if ((step.writes !== undefined && !Array.isArray(step.writes)) || !writes.every((glob) => typeof glob === "string" && !glob.startsWith("/") && !glob.split("/").includes(".."))) {
        problems.push(`the step ${step.id} writes only inside the build`);
      }
      if (Array.isArray(step.tools) && step.tools.some((tool) => tool === "write" || tool === "remove") && writes.length === 0) {
        problems.push(`the step ${step.id} writes, so it says where`);
      }
      if (step.stage !== undefined && step.stage !== "a" && step.stage !== "b") problems.push(`the step ${step.id}'s stage is a or b`);
    }
  }
  for (const folder of [data.template, data.tests]) {
    if (typeof folder !== "string" || !existsSync(join(dir, folder))) problems.push(`${String(folder)} isn't a folder in the recipe`);
  }
  const cost = data.cost as Recipe["cost"] | undefined;
  if (!isObject(cost) || !(cost.low > 0) || !(cost.high >= cost.low)) problems.push("cost has a low and a high, in dollars");
  if (!(Number(data.minutes) > 0)) problems.push("minutes is how long the build may take");
  return problems;
}

export function loadRecipe(dir: string): Recipe {
  const data = JSON.parse(readFileSync(join(dir, "recipe.json"), "utf8"));
  const problems = recipeProblems(data, dir);
  if (problems.length) throw new Error(`the recipe in ${dir} isn't right: ${problems.join("; ")}`);
  return { ...data, dir } as Recipe;
}

// Every recipe AgenTV has, by kind.
export function loadRecipes(root: string): Map<Kind, Recipe> {
  const found = new Map<Kind, Recipe>();
  for (const name of readdirSync(root).sort()) {
    if (!existsSync(join(root, name, "recipe.json"))) continue;
    const recipe = loadRecipe(join(root, name));
    found.set(recipe.kind as Kind, recipe);
  }
  return found;
}

// --- Plans ---------------------------------------------------------------

const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// Why a plan can't go to an adult as it is, or nothing.
export function planProblems(data: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(data)) return ["a plan is an object"];
  if (!text(data.name, 40)) problems.push("a plan names the app, in up to 40 characters");
  if (!text(data.says, 160)) problems.push("a plan says in one line what the app is");
  if (!Array.isArray(data.steps) || data.steps.length === 0 || data.steps.length > 8) {
    problems.push("a plan has 1 to 8 steps");
  } else {
    const ids = new Set<string>();
    for (const step of data.steps as unknown[]) {
      if (!isObject(step) || typeof step.id !== "string" || !STEP_ID.test(step.id) || ids.has(step.id) || ["tests", "try"].includes(step.id)) {
        problems.push("each step has its own id of lowercase letters, and tests and try are AgenTV's");
        continue;
      }
      ids.add(step.id);
      if (!text(step.does, 600)) problems.push(`the step ${step.id} says what it does`);
    }
  }
  const p = data.permissions as Plan["permissions"] | undefined;
  if (!isObject(p) || !Array.isArray(p.origins) || !Array.isArray(p.media) || typeof p.tile !== "boolean" || typeof p.notices !== "boolean") {
    problems.push("a plan says which origins and media the app reaches, and whether it has a tile and notices");
  } else {
    for (const origin of p.origins) if (typeof origin !== "string" || !ORIGIN.test(origin)) problems.push(`'${String(origin)}' isn't an origin`);
    for (const media of p.media) if (!MEDIA.includes(media)) problems.push(`'${String(media)}' isn't photos or music`);
  }
  if (!Array.isArray(data.packages)) {
    problems.push("a plan lists the npm packages it expects, or none");
  } else {
    for (const pkg of data.packages as unknown[]) {
      if (!isObject(pkg) || typeof pkg.name !== "string" || !PACKAGE.test(pkg.name) || (pkg.version !== undefined && (typeof pkg.version !== "string" || !VERSION.test(pkg.version)))) {
        problems.push("each package is a name, and an exact version if it has one");
      }
    }
  }
  if (data.cost !== undefined) {
    const cost = data.cost as Plan["cost"];
    if (!isObject(cost) || !(Number(cost!.low) >= 0) || !(Number(cost!.high) >= Number(cost!.low))) problems.push("a plan's cost has a low and a high, in dollars");
  }
  return problems;
}

// An approved plan as the recipe the builder walks: the plan's steps, then
// AgenTV's tests and checks, each with AgenTV's page app tools, never ones
// the plan names, and the plan's permissions as its bounds. It starts from
// AgenTV's page app template and tests (builder/recipes/page).
export function planRecipe(plan: Plan, root: string): Recipe {
  const work = ["app/**", "src/**", "DESIGN.md", "NOTES.md"];
  return {
    kind: "plan",
    name: "plan",
    fits: plan.says,
    runtime: "page",
    bounds: { origins: plan.permissions.origins.length > 0, media: plan.permissions.media, tile: plan.permissions.tile, notices: plan.permissions.notices },
    steps: [
      ...plan.steps.map((step): Step => ({ id: step.id, does: step.does, tools: PAGE_TOOLS, writes: work, reads: ["kit", "plan"], turns: 60 })),
      {
        id: "tests",
        does: "Write tests in tests/ for what the plan says the app does. Use the test API the tests reference describes, and run them with run_tests.",
        tools: ["read", "list", "write", "run_tests"],
        writes: ["tests/**"],
        reads: ["kit", "tests", "plan"],
        needs: ["tests"],
      },
      {
        id: "try",
        does: "Run AgenTV's checks with try and the tests with run_tests, and fix what they find, until both pass: it opens, answers the remote and a gamepad, Back leaves it, it keeps 60 frames a second within its memory, and it reaches only what the plan says.",
        tools: ["read", "list", "write", "remove", "bundle", "check", "try", "run_tests"],
        writes: [...work, "tests/**"],
        reads: ["kit", "tests", "plan"],
        turns: 60,
      },
    ],
    template: "template",
    tests: "tests",
    cost: plan.cost ?? { low: 0.5, high: 3 },
    minutes: 25,
    dir: join(root, "builder/recipes/page"),
  };
}

// --- Where a step may write ---------------------------------------------

// Whether rel, a path in the work folder, matches one of a step's globs:
// "app/**" is everything under app/, "*" any one part, and anything else is
// itself.
export function writable(rel: string, globs: string[]): boolean {
  if (!rel || rel.startsWith("/") || rel.split("/").some((part) => part === ".." || part === "." || part === "")) return false;
  return globs.some((glob) => {
    const pattern = glob
      .split("/")
      .map((part) => (part === "**" ? "(?:.+)" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
      .join("/");
    return new RegExp(`^${pattern}$`).test(rel);
  });
}
