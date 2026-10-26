// The contract tests' runner (test/agentv/contract/runner.mts; ADR-019 layer
// 3, S3.1): what it matches and how, recorded times moved to now, and that
// it fails an app that answers wrong, asks for what its fixtures don't
// have, or doesn't pass the app contract's checks. The apps' own runs are
// layer 3's job (test/agentv/contract/run).

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appsHere, differences, Fixtures, run } from "../contract/runner.mts";

const ROOT = join(import.meta.dirname, "../../..");

test("patterns: objects by the keys given, lists item by item, and $match, $min, $length and $type", () => {
  assert.deepEqual(differences({ a: 1, b: { c: "x" }, d: 2 }, { a: 1, b: { c: "x" } }), []);
  assert.deepEqual(differences({ a: 1 }, { a: 2 }), ["it.a is 1, not 2"]);
  assert.deepEqual(differences([1, 2], [1]), ["it has 2 items, not 1"]);
  assert.deepEqual(differences({ t: "Playing Spring" }, { t: { $match: "^Playing" } }), []);
  assert.deepEqual(differences({ n: 3 }, { n: { $min: 4 } }), ["it.n is 3, not at least 4"]);
  assert.deepEqual(differences({ e: [1, 2, 3] }, { e: { $length: 3 } }), []);
  assert.deepEqual(differences({ e: null }, { e: { $length: 3 } }), ["it.e has no items, not 3"]);
  assert.deepEqual(differences({ p: 4.2 }, { p: { $type: "number" } }), []);
  assert.deepEqual(differences(null, {}), ["it is null, not an object"]);
});

test("recorded times move so the one named is the start of this hour, in JSON and date headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentv-contract-"));
  writeFileSync(
    join(dir, "reply.json"),
    JSON.stringify({ status: 200, headers: { expires: "Sun, 25 Oct 2026 11:02:23 GMT" }, body: { at: "2026-10-25T10:00:00Z", later: "2026-10-25T13:30:00Z", name: "2026" } }),
  );
  const now = Date.parse("2027-03-01T08:45:00Z");
  const fixtures = new Fixtures(dir, { shiftTimes: "2026-10-25T10:00:00Z", routes: [{ url: "https://api.test/x", reply: "reply.json" }], checks: [] }, now);
  const answer = fixtures.answer("GET", "https://api.test/x?any=query")!;
  assert.deepEqual(JSON.parse(answer.body.toString()), { at: "2027-03-01T08:00:00Z", later: "2027-03-01T11:30:00Z", name: "2026" });
  assert.equal(answer.headers.expires, "Mon, 01 Mar 2027 09:02:23 GMT");
  assert.equal(answer.headers["content-type"], "application/json");
  assert.equal(fixtures.answer("POST", "https://api.test/x"), null, "only the method given");
  assert.equal(fixtures.answer("GET", "https://elsewhere.test/x"), null);
  assert.deepEqual(fixtures.missing, ["POST https://api.test/x", "GET https://elsewhere.test/x"]);
});

test("a recorded 204 comes back with no body, as the server sent it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentv-contract-"));
  writeFileSync(join(dir, "none.json"), JSON.stringify({ status: 204, headers: { "content-type": "" }, body: null }));
  const fixtures = new Fixtures(dir, { routes: [{ url: "https://api.test/play", method: "POST", reply: "none.json" }], checks: [] });
  const response = await fixtures.fetch("https://api.test/play", { method: "POST" });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("every app here with fixtures is found: the built-ins and the test apps", () => {
  const found = appsHere().map((dir) => dir.slice(ROOT.length + 1));
  for (const dir of ["apps/builtin/agentv.clock", "apps/builtin/agentv.music", "apps/builtin/agentv.weather", "test/agentv/fixtures/apps/sample"]) {
    assert.ok(found.includes(dir), `${dir} is run`);
  }
});

test("S3.1 an app that answers wrong, asks for what its fixtures don't have, or isn't a valid package fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentv-contract-weather-"));
  cpSync(join(ROOT, "apps/builtin/agentv.weather"), dir, { recursive: true });
  const contractPath = join(dir, "fixtures", "contract.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  // The recorded reply stays where it is.
  contract.routes[0].reply = join(ROOT, "test/agentv/fixtures/met/amsterdam.json");
  contract.checks = [
    { name: "right", call: "tile", args: ["s"], expect: { headline: { label: "amsterdam" } } },
    { name: "wrong", call: "tile", args: ["s"], expect: { headline: { label: "oslo" } } },
    { name: "should fail but doesn't", call: "tile", args: ["s"], throws: "." },
  ];
  writeFileSync(contractPath, JSON.stringify(contract));
  const lines: string[] = [];
  let results = await run([dir], (line) => lines.push(line));
  assert.deepEqual(results.map((r) => [r.name, r.ok]), [
    ["the package passes the app contract's checks as official", true],
    ["its module starts in a worker of its own", true],
    ["right", true],
    ["wrong", false],
    ["should fail but doesn't", false],
  ]);
  assert.ok(lines.includes('    it.headline.label is "amsterdam", not "oslo"'), lines.join("\n"));

  // Its forecast isn't in the fixtures any more.
  contract.routes = [];
  contract.checks = [{ name: "no reply", call: "tile", args: ["s"], throws: "." }];
  writeFileSync(contractPath, JSON.stringify(contract));
  results = await run([dir], () => {});
  assert.deepEqual(results.at(-1)!.why.filter((line) => line.includes("fixtures don't have")).length, 1);

  // A package that isn't one: its id doesn't match its tier.
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  manifest.tv.runtime = "web";
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  results = await run([dir], () => {});
  assert.equal(results[0].ok, false);
  assert.equal(results.length, 1, "nothing runs from a package that isn't valid");
});
