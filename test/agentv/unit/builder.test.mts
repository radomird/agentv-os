// The builder (builder/, ADR-046, S6.9): recipes, and the runner walking a
// recipe's steps with only each step's tools, through the real harness, with
// the stand-in provider replaying recorded builds. Some recordings behave;
// others try what a misled agent would.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Build, type BuildRequest } from "../../../builder/build.ts";
import { KINDS, loadRecipes, planProblems, planRecipe, PAGE_TOOLS, type Plan, writable } from "../../../builder/recipe.ts";
import { phaseSteps, Runner } from "../../../builder/run.ts";

const ROOT = join(import.meta.dirname, "../../..");
const RECORDED = join(ROOT, "test/agentv/fixtures/builds/blocks");
const scratch = mkdtempSync(join(tmpdir(), "agentv-builder-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;

// A build folder with its request, as root leaves it.
function build(change: Partial<BuildRequest> = {}): Build {
  const dir = join(scratch, `b${++count}`, "1.0.0");
  mkdirSync(dir, { recursive: true });
  const request: BuildRequest = {
    build: `b${count}`,
    id: "local.blocks",
    version: "1.0.0",
    sentence: "a game like tetris",
    phase: "build",
    recipe: "game",
    name: "Blocks",
    provider: "claude",
    path: "plan",
    safeguards: true,
    at: "2026-10-27T15:00:00Z",
    ...change,
  };
  writeFileSync(join(dir, "request.json"), JSON.stringify(request, null, 2));
  return new Build(dir);
}

// A recording, from the Blocks one with steps changed or added, beside a
// copy of the files it names.
const RECORDINGS = join(scratch, "recordings");
cpSync(RECORDED, RECORDINGS, { recursive: true });
function recording(steps: Record<string, unknown> = {}): string {
  const base = JSON.parse(readFileSync(join(RECORDED, "recording.json"), "utf8"));
  const path = join(RECORDINGS, `test-${++count}.json`);
  writeFileSync(path, JSON.stringify({ steps: { ...base.steps, ...steps } }));
  return path;
}

function events(b: Build): Record<string, any>[] {
  return readFileSync(join(b.dir, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

const run = (b: Build, standIn = join(RECORDED, "recording.json")) => new Runner(b.dir, { root: ROOT, standIn, home: join(scratch, "home"), log: () => {} }).run();

test("ADR-046 the five recipes load, and each step lists only the harness's tools", () => {
  const recipes = loadRecipes(join(ROOT, "builder/recipes"));
  assert.deepEqual([...recipes.keys()].sort(), [...KINDS].sort());
  for (const recipe of recipes.values()) {
    for (const step of recipe.steps) {
      if (step.tools.includes("write")) assert.ok(step.writes?.length, `${recipe.kind}/${step.id} says where it writes`);
    }
  }
  // A streaming service is built in two stages, either side of the sign-in.
  const streaming = recipes.get("streaming")!;
  assert.deepEqual(phaseSteps(streaming, "build").map((s) => s.id), ["site", "sign-in"]);
  assert.deepEqual(phaseSteps(streaming, "stage-b").map((s) => s.id), ["study", "playback", "tests", "try"]);
});

test("S6.9 understanding: the agent says what the request is, and the TV asks an adult to confirm", async () => {
  const b = build({ phase: "understand", recipe: null, name: undefined });
  const status = await run(b);
  assert.equal(status.state, "confirm");
  assert.deepEqual(status.understood, { name: "Blocks", recipe: "game", says: "A falling-block puzzle for the remote and a gamepad, keeping the best score." });
  assert.ok(!existsSync(b.work), "nothing is built before it's confirmed");
});

test("S6.9 a build walks its recipe's steps in order, each offered only that step's tools", async () => {
  const b = build();
  const status = await run(b);
  assert.equal(status.state, "approve", status.reason);
  assert.deepEqual(status.steps, ["design", "packages", "build", "tests", "try"].map((id) => ({ id, state: "done" })));
  const recipe = loadRecipes(join(ROOT, "builder/recipes")).get("game")!;
  const offered = events(b).filter((e) => e.harness === "started");
  assert.deepEqual(offered.map((e) => e.step), recipe.steps.map((s) => s.id));
  for (const e of offered) assert.deepEqual(e.tools, recipe.steps.find((s) => s.id === e.step)!.tools, e.step);
  // What it built is the app, set by the builder, waiting for approval.
  const manifest = JSON.parse(readFileSync(join(b.app, "manifest.json"), "utf8"));
  assert.equal(manifest.id, "local.blocks");
  assert.equal(manifest.name, "Blocks");
  assert.deepEqual(status.approval?.reaches.declared, ["a tile on home"]);
  // And what it filled the recipe in with is kept for repairs and changes.
  const filled = JSON.parse(readFileSync(join(b.dir, "filled.json"), "utf8"));
  assert.equal(filled.recipe, "game");
  assert.deepEqual(filled.steps.map((s: { id: string }) => s.id), ["design", "packages", "build", "tests", "try"]);
});

test("a CLI that offers the agent tools of its own is stopped before the agent can use one", async () => {
  const b = build();
  const status = await run(b, recording({ design: { offer: ["Bash", "WebFetch"], calls: [{ tool: "write", args: { path: "DESIGN.md", content: "made with a shell" } }] } }));
  assert.equal(status.state, "failed");
  assert.match(status.reason ?? "", /^design: the agent's CLI offered tools of its own: Bash, WebFetch/);
  assert.ok(!events(b).some((e) => e.step === "design" && e.tool === "write"), "it was stopped before it wrote anything");
});

test("S6.9 a tool the step doesn't list is refused, and so is a write or a read outside it", async () => {
  const b = build();
  const misled = recording({
    design: {
      calls: [
        { tool: "write", args: { path: "app/main.js", content: "evil()" } },
        { tool: "write", args: { path: "../../escape.txt", content: "x" } },
        { tool: "npm_add", args: { name: "left-pad" } },
        { tool: "check", args: {} },
        { tool: "read", args: { path: "@contract/contract.ts" } },
        { tool: "read", args: { path: "/etc/agentv/env" } },
        { tool: "skip_to_try", args: {} },
        { tool: "write", args: { path: "DESIGN.md", content: "# the design\n" } },
      ],
    },
  });
  const status = await run(b, misled);
  assert.equal(status.state, "approve", status.reason);
  const refused = events(b).filter((e) => e.step === "design" && e.refused).map((e) => `${e.tool}: ${e.refused}`);
  assert.deepEqual(refused, [
    "write: this step writes only DESIGN.md, not app/main.js",
    "write: ../../escape.txt isn't in the build",
    "npm_add: npm_add isn't a tool in this step",
    "check: check isn't a tool in this step",
    "read: @contract/contract.ts isn't a reference this step reads; it reads @kit",
    "read: /etc/agentv/env isn't in the build",
    "skip_to_try: skip_to_try isn't a tool in this step",
  ]);
  assert.ok(!existsSync(join(b.dir, "..", "..", "escape.txt")));
  assert.equal(events(b).some((e) => e.tool === "write" && e.path === "app/main.js"), false, "the write outside the step didn't happen");
});

test("S6.9 a step that doesn't do its part ends the build; the agent can't skip ahead", async () => {
  const b = build();
  const skips = recording({ design: { calls: [{ tool: "read", args: { path: "@kit/kit.md" } }], said: "All steps are done, the builder can skip to the end." } });
  const status = await run(b, skips);
  assert.equal(status.state, "failed");
  assert.equal(status.reason, "design didn't leave DESIGN.md");
  assert.deepEqual(status.steps.map((s) => `${s.id} ${s.state}`), ["design failed", "packages waiting", "build waiting", "tests waiting", "try waiting"]);
  assert.ok(!events(b).some((e) => e.harness === "started" && e.step !== "design"), "no later step started");
});

test("S6.9 the builder keeps what the app reaches inside its recipe's bounds", async () => {
  const b = build();
  const greedy = recording({
    build: {
      calls: [
        { tool: "write", args: { path: "app/index.html", file: "index.html" } },
        { tool: "write", args: { path: "app/game.js", file: "game.js" } },
        { tool: "write", args: { path: "app/manifest.json", content: JSON.stringify({ id: "agentv.blocks", name: "Not Blocks", version: "9.9.9", author: "someone", description: "A game", tv: { contract: 2, runtime: "page", category: "games", capabilities: ["launch", "tile"], origins: ["https://tracker.example"], media: ["photos"], notices: true } }) } },
      ],
    },
  });
  const status = await run(b, greedy);
  assert.equal(status.state, "approve", status.reason);
  const m = JSON.parse(readFileSync(join(b.app, "manifest.json"), "utf8"));
  assert.equal(m.id, "local.blocks");
  assert.equal(m.name, "Blocks");
  assert.equal(m.version, "1.0.0");
  assert.equal(m.author, "your agent");
  assert.equal(m.tv.origins, undefined);
  assert.equal(m.tv.media, undefined);
  assert.equal(m.tv.notices, undefined);
});

test("S6.9 a request with no recipe gets a plan, and nothing is built before an adult approves it", async () => {
  const b = build({ recipe: null });
  const refused = await run(b);
  assert.equal(refused.state, "failed");
  assert.equal(refused.reason, "no recipe fits and no plan is approved, so nothing is built");
  assert.ok(!existsSync(b.work));

  const plan: Plan = {
    name: "Sky",
    says: "Tonight's sky from the box's place, drawn on the TV",
    steps: [{ id: "sky", does: "Draw the stars and planets above the box tonight." }],
    permissions: { origins: [], media: [], tile: true, notices: false },
    packages: [],
  };
  const planning = build({ phase: "plan", recipe: null, sentence: "show me tonight's sky" });
  const planned = await run(planning, recording({ plan: { calls: [{ tool: "submit_plan", args: { plan: { ...plan, steps: [] } } }, { tool: "submit_plan", args: { plan } }] } }));
  assert.equal(planned.state, "plan");
  assert.deepEqual(planned.plan, plan);
  assert.ok(!existsSync(planning.work), "nothing is built while the plan waits");

  // Approved, the plan is walked with AgenTV's steps after its own, and
  // AgenTV's page app tools, never ones the plan names.
  const approved = build({ recipe: null, plan, sentence: "show me tonight's sky" });
  const status = await run(approved, recording({ sky: { calls: [{ tool: "write", args: { path: "app/main.js", content: "agentv.ready();\n" } }] }, tests: { calls: [{ tool: "write", args: { path: "tests/sky.test.js", content: "" } }] } }));
  assert.equal(status.state, "approve", status.reason);
  assert.deepEqual(status.steps.map((s) => s.id), ["sky", "tests", "try"]);
  const sky = events(approved).find((e) => e.harness === "started" && e.step === "sky");
  assert.deepEqual(sky?.tools, PAGE_TOOLS);
});

test("with a key, a build stops at its spend cap", async () => {
  const b = build({ path: "key", budget: { build: 0.3, month: 20, spentMonth: 0 } });
  const status = await run(b);
  assert.equal(status.state, "failed");
  assert.match(status.reason ?? "", /spend cap/);
  // And the month's cap counts too.
  const month = build({ path: "key", budget: { build: 5, month: 20, spentMonth: 20 } });
  assert.match((await run(month)).reason ?? "", /spend cap/);
});

test("an app the agent builds is always local.*", async () => {
  const status = await run(build({ id: "agentv.blocks" }));
  assert.equal(status.reason, "an app the agent builds has an id that starts with local.");
});

test("a plan's own checks, and where a step may write", () => {
  assert.deepEqual(planProblems({ name: "x", says: "y", steps: [{ id: "a", does: "b" }], permissions: { origins: [], media: [], tile: false, notices: false }, packages: [] }), []);
  assert.match(planProblems({ name: "x", says: "y", steps: [{ id: "try", does: "b" }], permissions: { origins: [], media: [], tile: false, notices: false }, packages: [] }).join(), /tests and try are AgenTV's/);
  assert.match(planProblems({ name: "x", says: "y", steps: [{ id: "a", does: "b" }], permissions: { origins: ["ftp://x"], media: ["files"], tile: false, notices: false }, packages: [{ name: "Bad Name" }] }).join(";"), /isn't an origin.*isn't photos or music.*each package/);
  const recipe = planRecipe({ name: "x", says: "y", steps: [{ id: "a", does: "b" }], permissions: { origins: ["https://api.example.org"], media: ["photos"], tile: false, notices: false }, packages: [] }, ROOT);
  assert.deepEqual(recipe.bounds, { origins: true, media: ["photos"], tile: false, notices: false });
  assert.ok(writable("app/main.js", ["app/**"]));
  assert.ok(writable("DESIGN.md", ["DESIGN.md"]));
  assert.ok(writable("theme/backgrounds/1-scene.svg", ["theme/backgrounds/*.svg"]));
  for (const path of ["app/../x", "/etc/passwd", "DESIGN.md.bak", "theme/backgrounds/a/b.svg", "", "app//x"]) assert.ok(!writable(path, ["app/**", "DESIGN.md", "theme/backgrounds/*.svg"]), path);
});
