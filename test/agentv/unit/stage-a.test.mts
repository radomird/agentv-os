// A streaming service's stage A tools in the harness (builder/harness/
// extra.ts, ADR-011): look and fetch_sample reach only the origins the build
// declared, keep what they save where the step writes, and contract_tests
// says what's missing before it runs anything. The browser itself is
// layer 4's (test/agentv/ui/stage-a.test.mts).

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Build } from "../../../builder/build.ts";
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
