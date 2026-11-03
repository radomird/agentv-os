// The harness's tools (ADR-011, ADR-046): the only way the agent touches
// the build. A step gets the tools its recipe lists for it and no others,
// and each tool keeps to what the step allows: writes only where the step
// writes, reads in the build and the references the step names, origins
// only when the recipe has any. The agent has no shell and no files of its
// own; whatever a page or a package tells it, this is all it can do.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { validatePackage } from "../../apps/contract/manifest.ts";
import { pageOriginProblem } from "../../apps/contract/page.ts";
import { type Build, keepManifest, type Understood } from "../build.ts";
import { KINDS, planProblems, type Kind, type Plan, type Recipe, type Step, type Tool, TOOLS, writable } from "../recipe.ts";
import { ToolError, type ToolSpec } from "./mcp.ts";

const READ_MAX = 200 * 1024;
const WRITE_MAX = 2 * 1024 * 1024;
const LIST_MAX = 500;
const ORIGINS_MAX = 8;

// What a step's reads name, and the files behind each: AgenTV's own, or
// the recipe's tests.
export function references(root: string, recipe: Recipe, omarchy: string): Record<string, Record<string, string>> {
  const tests: Record<string, string> = { "tests.md": join(root, "builder/prompts/tests.md") };
  const testDir = join(recipe.dir, recipe.tests);
  if (existsSync(testDir)) for (const name of readdirSync(testDir)) tests[name] = join(testDir, name);
  return {
    kit: { "kit.md": join(root, "builder/prompts/kit.md"), "kit.ts": join(root, "apps/contract/kit.ts") },
    contract: { "contract.md": join(root, "builder/prompts/contract.md"), "contract.ts": join(root, "apps/contract/contract.ts") },
    tests,
    omarchy: { "theming.md": join(omarchy, "default/agents/skills/omarchy/theming.md") },
  };
}

// Tools AgenTV has, beyond the ones here, given by whoever runs the harness:
// the gates, npm and the browser come with them.
export type Extra = Partial<Record<Tool, (args: Record<string, unknown>) => Promise<string>>>;

export interface ToolsOptions {
  build: Build;
  recipe: Recipe;
  step: Step;
  root: string; // AgenTV's files: /usr/share/agentv
  omarchy: string; // Omarchy's: /usr/share/omarchy
  extra?: Extra;
}

// A path in the work folder, as the agent names it: relative, with nothing
// that climbs out, and no link on the way.
export function inWork(work: string, rel: unknown): string {
  if (typeof rel !== "string" || !rel.trim()) throw new ToolError("which file: a path in the build, like app/main.js");
  const clean = posix.normalize(rel.replace(/^\.\/+/, ""));
  if (clean.startsWith("/") || clean.startsWith("..") || clean.includes("\0") || clean.split("/").includes("..")) {
    throw new ToolError(`${rel} isn't in the build`);
  }
  let at = work;
  for (const part of clean.split("/")) {
    at = join(at, part);
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new ToolError(`${rel} goes through a link, which the build doesn't follow`);
  }
  return join(work, clean);
}

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

export function stepTools(options: ToolsOptions): ToolSpec[] {
  const { build, recipe, step } = options;
  const refs = references(options.root, recipe, options.omarchy);
  const reads = new Set(step.reads ?? []);
  const writes = step.writes ?? [];
  const log = (tool: string, detail: Record<string, unknown>) => build.log({ step: step.id, tool, ...detail });

  const all: Record<Tool, Omit<ToolSpec, "name" | "description">> = {
    read: {
      inputSchema: schema({ path: { type: "string", description: "A path in the build, like app/main.js, or a reference this step names, like @kit/kit.md" } }, ["path"]),
      async run(args) {
        const path = String(args.path ?? "");
        if (path.startsWith("@")) {
          const [name, ...rest] = path.slice(1).split("/");
          if (!reads.has(name)) throw new ToolError(`${path} isn't a reference this step reads; it reads ${[...reads].map((r) => `@${r}`).join(", ") || "none"}`);
          // The plan an adult approved, as this build walks it.
          if (name === "plan") return JSON.stringify(build.request().plan ?? null, null, 2);
          const file = refs[name]?.[rest.join("/")];
          if (!file || !existsSync(file)) throw new ToolError(`${path} isn't there; list @ shows what is`);
          return readFileSync(file, "utf8").slice(0, READ_MAX);
        }
        const file = inWork(build.work, path);
        if (!existsSync(file) || !statSync(file).isFile()) throw new ToolError(`${path} isn't a file in the build`);
        const data = readFileSync(file);
        if (data.includes(0)) return `${path} is a binary file of ${data.length} bytes`;
        return data.length > READ_MAX ? `${data.subarray(0, READ_MAX).toString("utf8")}\n... (${data.length} bytes; the rest isn't shown)` : data.toString("utf8");
      },
    },
    list: {
      inputSchema: schema({ path: { type: "string", description: "A folder in the build, or @ for the references this step reads" } }),
      async run(args) {
        if (args.path === "@") return [...reads].flatMap((name) => (name === "plan" ? ["plan.json"] : Object.keys(refs[name] ?? {})).map((file) => `@${name}/${file}`)).join("\n") || "no references";
        const root = args.path ? inWork(build.work, args.path) : build.work;
        if (!existsSync(root)) return "nothing there yet";
        const found: string[] = [];
        const walk = (dir: string, prefix: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (found.length >= LIST_MAX) return;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              if (entry.name === "node_modules") found.push(`${rel}/ (packages)`);
              else walk(join(dir, entry.name), rel);
            } else if (entry.isFile()) {
              found.push(`${rel} (${statSync(join(dir, entry.name)).size} bytes)`);
            }
          }
        };
        walk(root, args.path ? posix.normalize(String(args.path)) : "");
        return found.length ? found.join("\n") : "nothing there yet";
      },
    },
    write: {
      inputSchema: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      async run(args) {
        const path = String(args.path ?? "");
        const file = inWork(build.work, path);
        if (!writable(posix.normalize(path.replace(/^\.\/+/, "")), writes)) throw new ToolError(`this step writes only ${writes.join(", ")}, not ${path}`);
        if (typeof args.content !== "string") throw new ToolError("content is the file's text");
        if (Buffer.byteLength(args.content) > WRITE_MAX) throw new ToolError(`a file is up to ${WRITE_MAX / 1024 / 1024} MB`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, args.content);
        log("write", { path, bytes: Buffer.byteLength(args.content) });
        return `wrote ${path}`;
      },
    },
    remove: {
      inputSchema: schema({ path: { type: "string" } }, ["path"]),
      async run(args) {
        const path = String(args.path ?? "");
        const file = inWork(build.work, path);
        if (!writable(posix.normalize(path.replace(/^\.\/+/, "")), writes)) throw new ToolError(`this step writes only ${writes.join(", ")}, not ${path}`);
        if (!existsSync(file)) throw new ToolError(`${path} isn't there`);
        rmSync(file, { recursive: true, force: true });
        log("remove", { path });
        return `removed ${path}`;
      },
    },
    check: {
      inputSchema: schema({}),
      async run() {
        const request = build.request();
        const said = keepManifest(build, recipe, request);
        const { manifest, problems } = validatePackage(build.app, "local");
        const kept = said.length ? `\nthe builder kept the manifest in bounds: ${said.join("; ")}` : "";
        return manifest ? `the app passes the static checks${kept}` : `the static checks found:\n- ${problems.join("\n- ")}${kept}`;
      },
    },
    declare_origin: {
      inputSchema: schema({ origin: { type: "string", description: "Like https://api.example.org" }, why: { type: "string" } }, ["origin", "why"]),
      async run(args) {
        if (!recipe.bounds.origins) throw new ToolError("this recipe's apps reach no internet origin");
        const origin = String(args.origin ?? "").replace(/\/+$/, "");
        const why = pageOriginProblem(origin);
        if (why) throw new ToolError(why);
        if (typeof args.why !== "string" || !args.why.trim()) throw new ToolError("say why the app reaches it");
        const state = build.state();
        if (state.origins.some((o) => o.origin === origin)) return `${origin} is declared already`;
        if (state.origins.length >= ORIGINS_MAX) throw new ToolError(`an app reaches up to ${ORIGINS_MAX} origins`);
        build.setState({ origins: [...state.origins, { origin, why: args.why.trim().slice(0, 200) }] });
        log("declare_origin", { origin });
        return `declared ${origin}; approval will show it`;
      },
    },
    understood: {
      inputSchema: schema(
        {
          name: { type: "string", description: "What the app is called on home, up to 24 characters" },
          recipe: { type: ["string", "null"], enum: [...KINDS, null], description: "The recipe that fits, or null when none does" },
          says: { type: "string", description: "One line: what you understood the request to be" },
          address: { type: "string", description: "A streaming service's own web address" },
          category: { type: "string" },
        },
        ["name", "recipe", "says"],
      ),
      async run(args) {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name || name.length > 24) throw new ToolError("the name is up to 24 characters");
        if (args.recipe !== null && !KINDS.includes(args.recipe as Kind)) throw new ToolError(`recipe is one of ${KINDS.join(", ")}, or null`);
        if (typeof args.says !== "string" || !args.says.trim() || args.says.length > 160) throw new ToolError("says is one line, up to 160 characters");
        const understood: Understood = { name, recipe: (args.recipe as Kind | null) ?? null, says: args.says.trim() };
        if (typeof args.address === "string" && /^https:\/\/[a-z0-9.-]+(\/.*)?$/i.test(args.address)) understood.address = args.address;
        if (typeof args.category === "string") understood.category = args.category.slice(0, 20);
        build.setState({ understood });
        log("understood", { recipe: understood.recipe });
        return "noted; the TV shows it for an adult to confirm";
      },
    },
    submit_plan: {
      inputSchema: schema({ plan: { type: "object", description: "name, says, steps [{id, does}], permissions {origins, media, tile, notices}, packages [{name, version}], cost {low, high}" } }, ["plan"]),
      async run(args) {
        const problems = planProblems(args.plan);
        if (problems.length) throw new ToolError(`the plan isn't ready: ${problems.join("; ")}`);
        build.setState({ plan: args.plan as Plan });
        log("submit_plan", {});
        return "submitted; an adult approves it on the phone before anything is built";
      },
    },
    // The rest come from whoever runs the harness: the gates, npm, the
    // browser and the theme check.
    npm_info: { inputSchema: schema({ name: { type: "string" } }, ["name"]), run: missing("npm_info") },
    npm_add: { inputSchema: schema({ name: { type: "string" }, version: { type: "string" } }, ["name"]), run: missing("npm_add") },
    bundle: { inputSchema: schema({}), run: missing("bundle") },
    try: { inputSchema: schema({}), run: missing("try") },
    run_tests: { inputSchema: schema({}), run: missing("run_tests") },
    fetch_sample: { inputSchema: schema({ url: { type: "string" }, save: { type: "string", description: "Keep the answer as a recorded reply for fixtures/contract.json, like fixtures/replies/search.json" } }, ["url"]), run: missing("fetch_sample") },
    look: { inputSchema: schema({ url: { type: "string" }, save: { type: "string", description: "Keep the page, without its scripts, as a fixture, like fixtures/pages/home.html" } }, ["url"]), run: missing("look") },
    page_snapshot: { inputSchema: schema({ url: { type: "string" }, save: { type: "string", description: "Keep the page, without its scripts, as a fixture, like fixtures/pages/player.html" } }, ["url"]), run: missing("page_snapshot") },
    contract_tests: { inputSchema: schema({}), run: missing("contract_tests") },
    theme_check: { inputSchema: schema({}), run: missing("theme_check") },
  };

  function missing(tool: Tool) {
    return async (args: Record<string, unknown>) => {
      const given = options.extra?.[tool];
      if (!given) throw new ToolError(`${tool} isn't on this box yet`);
      log(tool, {});
      return given(args);
    };
  }

  return step.tools.map((tool) => ({ name: tool, description: TOOLS[tool], ...all[tool] }));
}
