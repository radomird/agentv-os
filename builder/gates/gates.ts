// Gates 2 and 3 for a build (ADR-043), after its static checks: AgenTV's
// headless checks and the tests, the recipe's and the agent's, on the test
// TV (testtv.ts). The runner calls them before an adult sees the app, and
// the harness's try and run_tests tools call them while the agent works.

import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Build } from "../build.ts";
import type { Recipe } from "../recipe.ts";
import { checkTheme, themeRules } from "../theme.ts";
import { type TestFile, tryApp, type TryReport } from "./testtv.ts";

export interface GateOptions {
  root: string; // AgenTV's files
  chromium?: string;
  proxy?: string;
}

export const CHROMIUM = "/usr/bin/chromium";

// The tests a build runs: its recipe's, then the agent's own in tests/.
export function testsFor(build: Build, recipe: Recipe): TestFile[] {
  const files: TestFile[] = [];
  const add = (dir: string, label: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".js")) continue;
      files.push({ name: `${label}/${name}`, code: readFileSync(join(dir, name), "utf8") });
    }
  };
  add(join(recipe.dir, recipe.tests), "recipe");
  add(join(build.work, "tests"), "tests");
  return files;
}

export function tryBuild(build: Build, recipe: Recipe, options: GateOptions, what: { checks: boolean; tests: boolean; shot?: boolean }): Promise<TryReport> {
  return tryApp({
    app: build.app,
    tests: what.tests ? testsFor(build, recipe) : [],
    checks: what.checks,
    root: options.root,
    chromium: options.chromium ?? CHROMIUM,
    proxy: options.proxy,
    storage: join(build.dir, "try-storage"),
    shot: what.shot ? join(build.dir, "shot.png") : undefined,
  });
}

// The gates before approval, for the runner: what failed, and the shot.
export async function gates(build: Build, recipe: Recipe, options: GateOptions): Promise<{ problems: string[]; shot?: string }> {
  // A theme passes its own check, which draws it, and its preview goes with
  // the approval.
  if (recipe.runtime === "theme") {
    const report = await checkTheme(build.work, themeRules(recipe), { chromium: options.chromium ?? CHROMIUM });
    const problems = report.lines.filter((line) => line.startsWith("not ok: ")).map((line) => line.slice("not ok: ".length));
    const preview = join(build.work, "theme", "preview.png");
    if (problems.length || !existsSync(preview)) return { problems: problems.length ? problems : ["it has no preview"] };
    copyFileSync(preview, join(build.dir, "shot.png"));
    return { problems: [], shot: join(build.dir, "shot.png") };
  }
  // A streaming service passes its contract tests instead, with its stage's
  // tools.
  if (recipe.runtime !== "page") return { problems: [] };
  const report = await tryBuild(build, recipe, options, { checks: true, tests: true, shot: true });
  return { problems: report.problems, shot: report.shot };
}
