// The test TV (builder/gates/, ADR-043): gates 2 and 3 in a real headless
// Chromium, as the builder runs them before an adult sees a page app. The
// Blocks game passes AgenTV's checks and the game recipe's tests; an app
// that does everything wrong fails each check it should, and a test that
// fails says why.

import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { tryApp } from "../../../builder/gates/testtv.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-gates-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The browser layer 4 uses, started as the rest of layer 4 starts it, with
// its own sandbox off, since a CI runner or a container may not let it make
// one. On the box the test TV keeps Chromium's sandbox, and the image layer
// checks it there (agentv-iso's s6.3 check).
const browser = process.env.AGENTV_UI_BROWSER ?? "chromium";
const chromium = join(scratch, "chromium");
writeFileSync(chromium, `#!/bin/sh\nexec "${browser}" --no-sandbox "$@"\n`);
chmodSync(chromium, 0o755);

// A page app in a folder of its own, as a build leaves it.
function app(name: string, files: Record<string, string>, manifest: Record<string, unknown> = {}): string {
  const dir = join(scratch, name);
  cpSync(join(ROOT, "test/agentv/fixtures/apps/blocks"), dir, { recursive: true });
  const base = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...base, id: `local.${name}`, author: "your agent", ...manifest }, null, 2));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  return dir;
}

const recipeTests = (kind: string) => {
  const dir = join(ROOT, "builder/recipes", kind, "tests");
  return [{ name: `recipe/${kind}.test.js`, code: readFileSync(join(dir, `${kind}.test.js`), "utf8") }];
};

test("ADR-043 the Blocks game passes AgenTV's checks and the game recipe's tests, and the approval gets its screenshot", async () => {
  const dir = app("blocks", {});
  const shot = join(scratch, "blocks.png");
  const report = await tryApp({ app: dir, tests: recipeTests("game"), checks: true, root: ROOT, chromium, storage: join(scratch, "blocks-storage"), shot });
  assert.deepEqual(report.problems, [], JSON.stringify(report, null, 2));
  assert.ok(report.ready);
  assert.deepEqual(report.checks.map((c) => c.id), ["ready", "remote", "gamepad", "frames", "held", "memory", "requests", "errors", "back"]);
  assert.equal(report.tests.length, 4);
  assert.ok(report.tests.every((t) => t.ok));
  assert.ok(existsSync(shot) && readFileSync(shot).subarray(1, 4).toString() === "PNG", "a PNG screenshot for the approval");
});

test("ADR-043 an app that asks for an undeclared site, throws, never says it's drawn and won't let go of Back fails each check", async () => {
  const dir = app(
    "wrong",
    {
      "index.html": `<!doctype html><html><head><meta charset="utf-8"><title>wrong</title></head><body><canvas id="c"></canvas><script src="/_agentv/kit.js"></script><script src="game.js"></script></body></html>`,
      "game.js": `
        agentv.input.on((event) => { if (event.button === "ok" && event.down) throw new Error("ok broke it"); });
        agentv.onBack(() => true);
        // Put together as it runs, so the static checks can't see it.
        fetch(["https://exa", "mple.com/track"].join("")).catch(() => {});
      `,
    },
    { tv: { contract: 2, category: "games", runtime: "page", capabilities: ["launch"], icon: "icon.svg", tiles: { s: "logo" } } },
  );
  const report = await tryApp({ app: dir, tests: [], checks: true, root: ROOT, chromium, storage: join(scratch, "wrong-storage") });
  const failed = (id: string) => report.checks.find((c) => c.id === id)?.ok === false;
  assert.equal(report.ready, false, JSON.stringify(report.problems));
  assert.ok(report.problems.includes("it didn't call agentv.ready() within 10 seconds"), JSON.stringify(report.problems));
  assert.ok(failed("requests"), "S6.8 a request to an origin it didn't declare is caught");
  assert.match(report.checks.find((c) => c.id === "requests")!.says, /example\.com/);
  assert.ok(failed("errors"));
  assert.match(report.checks.find((c) => c.id === "errors")!.says, /ok broke it/);
  assert.ok(failed("back"), "Back has to leave it by the fourth press");
});

test("a test that fails says why, and the agent's own tests run beside the recipe's", async () => {
  const dir = app("tested", {});
  const tests = [
    { name: "tests/score.test.js", code: `test("the best score is kept", async (t) => { await t.press("ok"); await t.frames(5); t.equal(t.storage().best, 999, "the best score"); });` },
    { name: "tests/tile.test.js", code: `test("it keeps a tile", async (t) => { t.ok(t.listening().back, "it has a Back of its own"); t.equal(t.calls("ready"), 1, "it said it's drawn once"); });` },
  ];
  const report = await tryApp({ app: dir, tests, checks: false, root: ROOT, chromium, storage: join(scratch, "tested-storage") });
  assert.equal(report.tests.length, 2);
  assert.equal(report.tests[0].ok, false);
  assert.match(report.tests[0].failed[0], /^the best score: /);
  assert.equal(report.tests[1].ok, true, JSON.stringify(report.tests[1]));
  assert.ok(report.problems.some((p) => p.startsWith('the test "the best score is kept" failed')));
});
