// A streaming service's stage A (ADR-011, S6.1), in a real headless
// Chromium, against a stand-in service served here: look shows the agent
// a page's structure with the selectors an app would use, the origins it
// asked for and whether it plays protected video, and keeps the page as a
// fixture without its scripts. contract_tests then runs the app the agent
// wrote against those pages, with the recipe's own checks for the stage.

import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { after, before, test } from "node:test";
import { look, saidLook } from "../../../builder/browse.ts";
import { Build } from "../../../builder/build.ts";
import { contractTests } from "../../../builder/contract-run.ts";
import { loadRecipes } from "../../../builder/recipe.ts";

const ROOT = join(import.meta.dirname, "../../..");
const SERVICE = join(ROOT, "test/agentv/fixtures/stand-in-service");
const scratch = mkdtempSync(join(tmpdir(), "agentv-stage-a-"));

// The browser layer 4 uses, with its own sandbox off, as gates.test.mts
// starts it.
const browser = process.env.AGENTV_UI_BROWSER ?? "chromium";
const chromium = join(scratch, "chromium");
writeFileSync(chromium, `#!/bin/sh\nexec "${browser}" --no-sandbox "$@"\n`);
chmodSync(chromium, 0o755);

// The stand-in's site, and a second origin its start page takes a poster from.
let site = "";
let posters = "";
const servers: Server[] = [];
function serve(answer: (path: string) => { type: string; body: string | Buffer } | null): Promise<string> {
  const server = createServer((request, response) => {
    const found = answer(new URL(request.url ?? "/", "http://x").pathname);
    response.writeHead(found ? 200 : 404, { "Content-Type": found?.type ?? "text/plain" });
    response.end(found?.body ?? "");
  });
  servers.push(server);
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
}

before(async () => {
  posters = await serve((path) => (path === "/poster.png" ? { type: "image/png", body: Buffer.alloc(0) } : null));
  site = await serve((path) => {
    const file = { "/": "index.html", "/signin": "signin.html", "/browse": "browse.html", "/site.js": "site.js", "/site.css": "site.css" }[path];
    if (!file) return null;
    const text = readFileSync(join(SERVICE, "site", file), "utf8").replace("http://POSTERS", posters);
    return { type: extname(file) === ".html" ? "text/html" : extname(file) === ".js" ? "text/javascript" : "text/css", body: text };
  });
});

after(() => {
  for (const server of servers) server.close();
  rmSync(scratch, { recursive: true, force: true });
});

test("S6.1 look shows the start page's structure, the origins it asked for, and keeps it without its scripts", async () => {
  const seen = await look(`${site}/`, { chromium });
  assert.equal(seen.title, "Stand-in: films and series");
  assert.equal(seen.status, 200);
  assert.ok(seen.lines.includes('h1 "Stand-in" h1'), seen.lines.join("\n"));
  assert.ok(seen.lines.includes(`link "Sign in" -> ${site}/signin`));
  assert.ok(seen.lines.includes("region #menu"), "what the page draws once it has loaded is there too");
  assert.ok(seen.lines.includes(`icon -> ${site}/icon.png`));
  assert.ok(seen.asked.includes(site) && seen.asked.includes(posters), JSON.stringify(seen.asked));
  assert.equal(typeof seen.drm, "boolean");
  assert.ok(!/<script|<link|\ssrc=|\sstyle=/i.test(seen.html), "the kept page has nothing that runs or fetches");
  assert.match(seen.html, /^<!doctype html>\n<html/);
  assert.match(seen.html, /Sign in to watch\./);

  const said = saidLook({ ...seen, asked: ["https://stand-in.test", "https://posters.stand-in.test"] }, ["https://stand-in.test"]);
  assert.match(said, /it also asked for origins the build hasn't declared, which the filter refused: https:\/\/posters\.stand-in\.test/);
  assert.match(said, /protected video \(Widevine\) in this browser: (yes|no)/);
});

test("S6.1 look shows the sign-in form's fields as an app would find them", async () => {
  const seen = await look(`${site}/signin`, { chromium });
  assert.ok(seen.lines.includes(`form #sign-in action=/session`), seen.lines.join("\n"));
  assert.ok(seen.lines.includes('field #email type=email autocomplete=username label="Email"'));
  assert.ok(seen.lines.includes('field #password type=password autocomplete=current-password label="Password"'));
  assert.ok(seen.lines.includes('button "Continue" button[type="submit"]'));
});

// A build of the stand-in at the end of stage A, with the pages look kept.
async function stageA(): Promise<Build> {
  const dir = join(scratch, `build-${Date.now()}`);
  mkdirSync(join(dir, "work", "fixtures", "pages"), { recursive: true });
  cpSync(join(SERVICE, "app"), join(dir, "work", "app"), { recursive: true });
  writeFileSync(join(dir, "work", "fixtures", "pages", "home.html"), (await look(`${site}/`, { chromium })).html);
  writeFileSync(join(dir, "work", "fixtures", "pages", "browse.html"), (await look(`${site}/browse`, { chromium })).html);
  writeFileSync(
    join(dir, "work", "fixtures", "contract.json"),
    JSON.stringify({
      routes: [
        { url: "https://stand-in.test/", file: "pages/home.html" },
        { url: "https://stand-in.test/browse", file: "pages/browse.html" },
      ],
      checks: [
        { name: "launch opens the home page", page: "https://stand-in.test/browse", call: "launch", after: { url: "^https://stand-in\\.test/$" } },
        { name: "signed out, it says so", page: "https://stand-in.test/", call: "signIn.isSignedIn", expect: false },
        { name: "signed in, it says so", page: "https://stand-in.test/browse", call: "signIn.isSignedIn", expect: true },
      ],
    }),
  );
  return new Build(dir);
}

test("S6.1 contract_tests runs the stage A app against the pages look kept, with the recipe's checks for the stage", async () => {
  const build = await stageA();
  const streaming = loadRecipes(join(ROOT, "builder/recipes")).get("streaming")!;
  const a = await contractTests(build, streaming, { chromium, stage: "a" });
  assert.equal(a.ok, true, a.lines.join("\n"));
  assert.deepEqual(a.lines, ["ok: its module starts in a worker of its own", "ok: launch opens the home page", "ok: signed out, it says so", "ok: signed in, it says so"]);

  // Stage B's checks aren't there yet, and a check that's wrong says why.
  const contract = JSON.parse(readFileSync(join(build.work, "fixtures", "contract.json"), "utf8"));
  contract.checks.push({ name: "a page it has no fixture for", page: "https://stand-in.test/films", call: "signIn.isSignedIn", expect: false });
  writeFileSync(join(build.work, "fixtures", "contract.json"), JSON.stringify(contract));
  const b = await contractTests(build, streaming, { chromium, stage: "b" });
  assert.equal(b.ok, false);
  for (const call of ["search", "playback.open", "playback.readPlaybackState"]) assert.ok(b.lines.includes(`not ok: the recipe wants a check for ${call}, and fixtures/contract.json has none`), b.lines.join("\n"));
  assert.ok(b.lines.includes("not ok: a page it has no fixture for"), b.lines.join("\n"));
});
