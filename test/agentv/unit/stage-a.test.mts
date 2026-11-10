// A streaming service's stage A tools in the harness (builder/harness/
// extra.ts, ADR-011): look and fetch_sample reach only the origins the build
// declared, keep what they save where the step writes, and contract_tests
// says what's missing before it runs anything. The browser itself is
// layer 4's (test/agentv/ui/stage-a.test.mts).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AppHost } from "../../../daemon/apps/loader.ts";
import { Build } from "../../../builder/build.ts";
import { checkApp, workerJail } from "../../../builder/contract-run.ts";
import { Fixtures } from "../../../builder/fixtures.ts";
import { extraTools } from "../../../builder/harness/extra.ts";
import { loadRecipes } from "../../../builder/recipe.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-stage-a-unit-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

// A streaming build in stage A, with the stand-in's origin declared.
function build(): Build {
  const dir = join(scratch, `b${++count}`, "1.0.0");
  mkdirSync(join(dir, "work"), { recursive: true });
  writeFileSync(join(dir, "request.json"), JSON.stringify({ build: `b${count}`, id: "local.stand-in", version: "1.0.0", sentence: "add stand-in", phase: "build", recipe: "streaming", provider: "claude", path: "key", safeguards: true, at: "" }));
  const b = new Build(dir);
  b.writeRecipe(loadRecipes(join(ROOT, "builder/recipes")).get("streaming")!);
  b.setState({ origins: [{ origin: "https://stand-in.test", why: "its pages" }] });
  return b;
}

test("ADR-011 look and fetch_sample reach only what the build declared, over https", async () => {
  const b = build();
  const tools = await extraTools(b.dir, "site");
  await assert.rejects(tools.look!({ url: "https://elsewhere.test/" }), /declare https:\/\/elsewhere\.test with declare_origin first/);
  await assert.rejects(tools.look!({ url: "http://stand-in.test/" }), /only https addresses/);
  await assert.rejects(tools.fetch_sample!({ url: "https://elsewhere.test/api" }), /declare https:\/\/elsewhere\.test/);
  await assert.rejects(tools.look!({ url: "not an address" }), /an address like/);
});

test("H2 M5 in stage B the harness goes by the origins approved with the app, and only the pages the recipe names", async () => {
  const b = build();
  // The build's state says more than was approved: stage B doesn't go by it.
  b.setState({ origins: [{ origin: "https://stand-in.test", why: "its pages" }, { origin: "https://late.example", why: "after approval" }] });
  writeFileSync(join(b.dir, "request.json"), JSON.stringify({ ...b.request(), phase: "stage-b", origins: ["https://stand-in.test"] }));
  const tools = await extraTools(b.dir, "study");
  await assert.rejects(tools.page_snapshot!({ url: "https://late.example/search" }), /https:\/\/late\.example isn't one of the origins approved with the app, and stage B reaches no other/);
  await assert.rejects(tools.page_snapshot!({ url: "https://stand-in.test/account" }), /stage B looks only at the service's start page and its .*search.* pages, never at an account, settings or payment page/);
  await assert.rejects(tools.page_snapshot!({ url: "https://stand-in.test/en-gb/account/payment" }), /never at an account/);
});

test("ADR-046 what look and fetch_sample keep goes only where the step writes, checked before they open anything", async () => {
  const b = build();
  const site = await extraTools(b.dir, "site");
  await assert.rejects(site.look!({ url: "https://stand-in.test/", save: "fixtures/pages/home.html" }), /this step writes only NOTES\.md, not fixtures\/pages\/home\.html/);
  const signIn = await extraTools(b.dir, "sign-in");
  await assert.rejects(signIn.look!({ url: "https://stand-in.test/", save: "../outside.html" }), /isn't in the build/);
  await assert.rejects(signIn.look!({ url: "https://stand-in.test/", save: "app/../../x" }), /isn't in the build/);
});

test("contract_tests says what's missing before it runs anything", async () => {
  const b = build();
  const tools = await extraTools(b.dir, "sign-in");
  assert.equal(await tools.contract_tests!({}), "not ok: there's no fixtures/contract.json yet");
  mkdirSync(join(b.work, "fixtures"), { recursive: true });
  writeFileSync(join(b.work, "fixtures", "contract.json"), "{ not json");
  assert.match(await tools.contract_tests!({}), /^not ok: fixtures\/contract\.json isn't right/);
  writeFileSync(join(b.work, "fixtures", "contract.json"), JSON.stringify({ routes: [], checks: [] }));
  cpSync(join(ROOT, "test/agentv/fixtures/stand-in-service/app"), join(b.work, "app"), { recursive: true });
  const said = await tools.contract_tests!({});
  assert.match(said, /not ok: the recipe wants a check for launch, and fixtures\/contract\.json has none/);
  assert.match(said, /not ok: the recipe wants a check for signIn\.isSignedIn/);
  assert.match(said, /not ok: fixtures\/contract\.json has no checks yet/);
});

test("on the box, a fixture names files in the build and nowhere else", () => {
  const work = join(scratch, "work");
  mkdirSync(join(work, "fixtures"), { recursive: true });
  writeFileSync(join(work, "fixtures", "page.html"), "<p>ok</p>");
  const routes = [
    { url: "https://stand-in.test/", file: "page.html" },
    { url: "https://stand-in.test/secret", file: "../../../../etc/hostname" },
  ];
  const served = new Fixtures(join(work, "fixtures"), { routes, checks: [] }, Date.now(), work);
  assert.equal(served.answer("GET", "https://stand-in.test/")!.body.toString(), "<p>ok</p>");
  assert.throws(() => served.answer("GET", "https://stand-in.test/secret"), /isn't in the build/);
  // CI's own fixtures may share a recording with another app's.
  const shared = new Fixtures(join(work, "fixtures"), { routes: [{ url: "https://stand-in.test/", file: "../fixtures/page.html" }], checks: [] });
  assert.equal(shared.answer("GET", "https://stand-in.test/")!.status, 200);
});

// --- The app's own code, under bubblewrap (H3) --------------------------------

// A build with an app in it, a page it saved, and a builder's home with a
// CLI and a plan's sign-in, as on the box.
function jailed() {
  const base = join(scratch, `jail${++count}`);
  const home = join(base, "home");
  const dir = join(base, "build", "1.0.0");
  const app = join(dir, "work", "app");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), "a plan's sign-in");
  writeFileSync(join(home, ".local", "bin", "claude"), "#!/bin/sh\n");
  mkdirSync(join(dir, "work", "fixtures", "pages"), { recursive: true });
  writeFileSync(join(dir, "work", "fixtures", "pages", "page.html"), "a saved page");
  writeFileSync(join(dir, "state.json"), "{}");
  cpSync(join(ROOT, "test/agentv/fixtures/apps/sample"), app, { recursive: true });
  return { home, dir, app, jail: workerJail({ app, build: dir, home }) };
}

// Whether bubblewrap can start here: it isn't on every machine, and some
// don't let it make a user namespace. The box does (the image checks run
// the worker under it there).
const bwrap = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-user", "--unshare-net", "--", "/bin/true"]).status === 0;

test("H3 the contract tests' app worker runs under bubblewrap: the builder's home hidden, no network, its package read-only", async () => {
  const { home, dir, app, jail } = jailed();
  const at = (flag: string, ...values: string[]) => jail.some((arg, i) => arg === flag && values.every((value, n) => jail[i + 1 + n] === value));
  assert.equal(jail[0], "bwrap");
  assert.ok(at("--ro-bind", "/", "/"), "the system, read-only");
  assert.ok(at("--tmpfs", home), "the builder's home is an empty folder to it");
  assert.ok(at("--tmpfs", dir), "and so is the rest of the build");
  assert.ok(at("--tmpfs", "/run"), "and where the build's way out is");
  assert.ok(at("--ro-bind", app, app), "its own package, read-only");
  assert.ok(jail.indexOf(app) > jail.indexOf(dir), "the package goes back in after the build is hidden");
  assert.ok(jail.includes("--unshare-net"), "no network at all");
  for (const flag of ["--unshare-user", "--unshare-pid", "--die-with-parent", "--new-session"]) assert.ok(jail.includes(flag), flag);
  assert.ok(!jail.includes("--bind") && !jail.includes("--share-net"), "nothing writable, nothing shared");
  assert.equal(jail.at(-1), "--");

  // The builder's contract_tests uses it, with the builder's own home, and
  // the worker's Node and its permission flag come after it. A stand-in
  // for bubblewrap says what it was started with.
  const seen = join(scratch, `seen${count}.txt`);
  const fake = join(scratch, `fake-bwrap${count}`);
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" >${seen}\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
  chmodSync(fake, 0o755);
  const manifest = JSON.parse(readFileSync(join(app, "manifest.json"), "utf8"));
  const results = await checkApp({ dir: app, manifest, contract: { checks: [{ name: "it's signed in", call: "signIn.isSignedIn", expect: true }] } as never, served: new Fixtures(join(dir, "work", "fixtures"), { checks: [] } as never, Date.now(), join(dir, "work")), openPage: async () => assert.fail("no page"), wrap: workerJail({ app, build: dir, home, bwrap: fake }) });
  assert.deepEqual(results.map((r) => [r.name, r.ok, r.why]), [["its module starts in a worker of its own", true, []], ["it's signed in", true, []]]);
  const started = readFileSync(seen, "utf8").split("\n");
  const after = started.slice(started.indexOf("--") + 1);
  assert.equal(after[0], process.execPath);
  assert.ok(after.includes("--permission"), "Node's permission flag is still the second layer");
  assert.ok(started.includes(home) && started.includes("--unshare-net"));
  assert.match(readFileSync(join(ROOT, "builder/harness/extra.ts"), "utf8"), /contractTests\(build, build\.recipe\(\), \{ chromium: CHROMIUM, stage, jail: \{ home: process\.env\.HOME \?\? "\/var\/lib\/agentv\/builder" \} \}\)/);
});

test("H3 inside that bubblewrap the sign-in, the CLI and the saved pages aren't there, nothing is written, and the worker still answers", { skip: !bwrap && "bubblewrap can't start here" }, async () => {
  const { home, dir, app, jail } = jailed();
  const inside = (script: string) => spawnSync(jail[0], [...jail.slice(1), "/bin/sh", "-c", script], { encoding: "utf8" });
  assert.notEqual(inside(`cat ${home}/.claude/.credentials.json`).status, 0, "the plan's sign-in");
  assert.equal(inside(`ls -A ${home}`).stdout.trim(), "", "the home is empty to it");
  assert.notEqual(inside(`cat ${dir}/work/fixtures/pages/page.html`).status, 0, "a page the build saved");
  assert.notEqual(inside(`cat ${dir}/state.json`).status, 0);
  assert.equal(inside(`cat ${app}/manifest.json`).status, 0, "its own package is there");
  assert.notEqual(inside(`touch ${app}/added`).status, 0, "read-only");
  assert.notEqual(inside(`touch ${home}/.local/bin/claude 2>/dev/null && test -e ${home}/.local/bin/claude && rm ${home}/.claude 2>/dev/null`).status, 0);
  assert.ok(!existsSync(join(app, "added")));
  assert.equal(readFileSync(join(home, ".local", "bin", "claude"), "utf8"), "#!/bin/sh\n", "the CLI is as it was");
  // No network of any kind: not even this machine's own loopback, where
  // the sandbox's way out listens.
  const server = createServer(() => {});
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const reach = `require("node:net").connect(${(server.address() as { port: number }).port}, "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(1))`;
    assert.equal(spawnSync(process.execPath, ["-e", reach]).status, 0, "it's there from outside");
    assert.equal(spawnSync(jail[0], [...jail.slice(1), process.execPath, "-e", reach]).status, 1, "and not from inside");
  } finally {
    server.close();
  }

  // And the real worker, under the real thing, starts and answers.
  const manifest = JSON.parse(readFileSync(join(app, "manifest.json"), "utf8"));
  const host = new AppHost({ dir: app, manifest, settings: { serverUrl: "https://sample.test" }, wrap: jail });
  try {
    assert.equal(await host.call({ id: "contract", role: "adult" }, "signIn.isSignedIn"), true);
    const found = await host.call<{ title: string }[]>({ id: "contract", role: "adult" }, "search", "sint");
    assert.deepEqual(found.map((item) => item.title), ["Sintel"]);
  } finally {
    host.stop();
  }
});
