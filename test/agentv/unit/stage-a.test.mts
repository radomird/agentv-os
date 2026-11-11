// A streaming service's stage A tools in the harness (builder/harness/
// extra.ts, ADR-011): look and fetch_sample reach only the origins the build
// declared, keep what they save where the step writes, and contract_tests
// says what's missing before it runs anything. The browser itself is
// layer 4's (test/agentv/ui/stage-a.test.mts).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AppHost, systemPaths, workerJail } from "../../../daemon/apps/loader.ts";
import { Build } from "../../../builder/build.ts";
import { checkApp } from "../../../builder/contract-run.ts";
import { Fixtures } from "../../../builder/fixtures.ts";
import { headless } from "../../../builder/gates/chromium.ts";
import { extraTools } from "../../../builder/harness/extra.ts";
import { loadRecipes } from "../../../builder/recipe.ts";
import { SANDBOX_PROBLEM } from "../harness.mts";

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
  const node = realpathSync(process.execPath);
  return { home, dir, app, node, jail: workerJail({ dir: app, node, read: [], system: systemPaths() }) };
}

test("H3 the builder's contract_tests starts the app's worker in its sandbox, with nothing switched off", async () => {
  // A stand-in for bubblewrap says what it was started with.
  const { home, dir, app } = jailed();
  const seen = join(scratch, `seen${count}.txt`);
  const fake = join(scratch, `fake-bwrap${count}`);
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" >${seen}\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
  chmodSync(fake, 0o755);
  const manifest = JSON.parse(readFileSync(join(app, "manifest.json"), "utf8"));
  const host = new AppHost({ dir: app, manifest, settings: { serverUrl: "https://sample.test" }, bwrap: fake });
  try {
    assert.equal(await host.call({ id: "contract", role: "adult" }, "signIn.isSignedIn"), true);
  } finally {
    host.stop();
  }
  const started = readFileSync(seen, "utf8").split("\n");
  const before = started.slice(0, started.indexOf("--"));
  assert.ok(before.includes("--unshare-all"), "no network at all, and namespaces of its own");
  assert.ok(!before.includes("--bind") && !before.includes("--share-net"), "nothing writable, nothing shared");
  assert.ok(!before.includes("/") && !before.includes(home) && !before.includes(dir), "the builder's home and the rest of the build aren't put in it");
  assert.ok(started.slice(started.indexOf("--") + 1).includes("--permission"), "Node's permission flag is still the second layer");
  // And the harness asks for it that way: no harness option, so no way to
  // leave the sandbox off.
  assert.match(readFileSync(join(ROOT, "builder/harness/extra.ts"), "utf8"), /contractTests\(build, build\.recipe\(\), \{ chromium: CHROMIUM, stage \}\)/);
});

test("H3 inside that sandbox the sign-in, the CLI and the saved pages aren't there, nothing is written, and the worker still answers", { skip: SANDBOX_PROBLEM !== null && "bubblewrap can't start here" }, async () => {
  const { home, dir, app, node, jail } = jailed();
  const look = (script: string) => spawnSync("bwrap", [...jail, node, "-e", script], { env: {}, encoding: "utf8" });
  const reads = (path: string) => look(`require("node:fs").readFileSync(${JSON.stringify(path)})`).status === 0;
  assert.equal(reads(join(app, "manifest.json")), true, "its own package is there");
  assert.equal(reads(join(home, ".claude", ".credentials.json")), false, "the plan's sign-in");
  assert.equal(reads(join(home, ".local", "bin", "claude")), false, "the CLI");
  assert.equal(reads(join(dir, "work", "fixtures", "pages", "page.html")), false, "a page the build saved");
  assert.equal(reads(join(dir, "state.json")), false);
  assert.notEqual(look(`require("node:fs").writeFileSync(${JSON.stringify(join(app, "added"))}, "")`).status, 0, "read-only");
  assert.ok(!existsSync(join(app, "added")));
  // No network of any kind: not even this machine's own loopback, where
  // the sandbox's way out listens.
  const server = createServer(() => {});
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const reach = `require("node:net").connect(${(server.address() as { port: number }).port}, "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(1))`;
    assert.equal(spawnSync(process.execPath, ["-e", reach]).status, 0, "it's there from outside");
    assert.equal(look(reach).status, 1, "and not from inside");
  } finally {
    server.close();
  }

  // And the real worker, under the real thing, starts and answers the
  // contract's checks.
  const manifest = JSON.parse(readFileSync(join(app, "manifest.json"), "utf8"));
  const results = await checkApp({ dir: app, manifest, contract: { checks: [{ name: "it's signed in", call: "signIn.isSignedIn", expect: true }] } as never, served: new Fixtures(join(dir, "work", "fixtures"), { checks: [] } as never, Date.now(), join(dir, "work")), openPage: async () => assert.fail("no page") });
  assert.deepEqual(results.map((r) => [r.name, r.ok, r.why]), [["its module starts in a worker of its own", true, []], ["it's signed in", true, []]]);
});

test("H3 a build's Chromium keeps its own files in its throwaway profile, not in the builder's read-only ~/.config", async () => {
  // A stand-in for Chromium says where it was told to keep them.
  const seen = join(scratch, `xdg${++count}.txt`);
  const fake = join(scratch, `fake-chromium${count}`);
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$XDG_CONFIG_HOME" >${seen}\nfor arg in "$@"; do printf '%s\\n' "$arg" >>${seen}; done\nsleep 30\n`);
  chmodSync(fake, 0o755);
  const browser = headless(fake);
  try {
    for (let i = 0; i < 100 && !(existsSync(seen) && readFileSync(seen, "utf8").includes("about:blank")); i++) await new Promise((done) => setTimeout(done, 50));
    const said = readFileSync(seen, "utf8").split("\n");
    const profile = said.find((line) => line.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    assert.equal(said[0], join(profile, "config"));
    assert.ok(!said[0].startsWith(process.env.HOME ?? "/nowhere") || profile.startsWith(process.env.HOME ?? "/nowhere"), "not the home's own ~/.config");
  } finally {
    await browser.close();
  }
});
