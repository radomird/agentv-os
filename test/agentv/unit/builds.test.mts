// The household's builds (daemon/builds.ts, ADR-011, ADR-043 to ADR-046):
// a sentence becomes a build, an adult confirms it, approves a plan or the
// app behind the PIN, and changes, rebuilds, rolls back or removes it. And
// root's side of it (builder/sandbox/hand-over.ts): an approved app put in
// place as a Local app with the version before kept, a rollback, a removal.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Builds, idFor, nextVersion } from "../../../daemon/builds.ts";
import { HandOver } from "../../../builder/sandbox/hand-over.ts";
import { Daemon } from "../../../daemon/server.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-builds-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

function box() {
  const base = join(scratch, `box${++count}`);
  const o = { state: join(base, "daemon"), drop: join(base, "daemon", "build-drop"), builds: join(base, "build"), run: join(base, "run"), spend: join(base, "spend.json"), warnings: join(base, "warnings.json"), apps: join(base, "apps") };
  mkdirSync(o.builds, { recursive: true });
  let clock = Date.parse("2026-10-27T18:00:00Z");
  const builds = new Builds({ ...o, now: () => new Date((clock += 1000)) });
  const drop = (name: string) => {
    const path = join(o.drop, `${name}.json`);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    rmSync(path);
    return data;
  };
  // A build's status, as the builder writes it.
  const status = (id: string, version: string, change: Record<string, unknown>) => {
    mkdirSync(join(o.builds, id, version), { recursive: true });
    writeFileSync(join(o.builds, id, version, "status.json"), JSON.stringify({ id, version, phase: "build", steps: [], started: "", at: "", ...change }));
  };
  return { o, builds, drop, status };
}

const KEY = { provider: "claude" as const, path: "key" as const };

test("an app's id comes from what was asked, and each version moves the minor on", () => {
  assert.equal(idFor("A game like Tetris", () => false), "local.game-tetris");
  assert.equal(idFor("Browse the photos on my NAS", () => false), "local.browse-photos-on-nas");
  assert.equal(idFor("!!!", () => false), "local.app");
  assert.equal(idFor("a game like tetris", (id) => id === "local.game-tetris"), "local.game-tetris-2");
  assert.equal(nextVersion([]), "1.0.0");
  assert.equal(nextVersion(["1.0.0", "1.1.0"]), "1.2.0");
});

test("a sentence becomes a build: root is asked to understand it first, with the caps and safeguards", async () => {
  const { builds, drop } = box();
  const asked = await builds.ask("a game like tetris", KEY);
  assert.equal(asked.build?.state, "starting");
  const start = drop("start");
  assert.equal(start.phase, "understand");
  assert.equal(start.id, "local.game-tetris");
  assert.equal(start.version, "1.0.0");
  assert.equal(start.provider, "claude");
  assert.deepEqual(start.cap, { build: 5, month: 20 }, "with a key, the caps go with it");
  assert.equal(start.safeguards, true);
  assert.equal((await builds.ask("another", KEY)).error, "another build is going; one runs at a time");
  assert.match((await builds.ask("", KEY)).error!, /up to 300 characters/);
  const plan = box();
  await plan.builds.ask("a game like tetris", { provider: "claude", path: "plan" });
  assert.equal(plan.drop("start").cap, undefined, "a plan has its own limits (ADR-045)");
});

test("an adult confirms what the agent understood: its recipe's build, or with no recipe a plan to approve first", async () => {
  const { builds, drop, status } = box();
  const { build } = await builds.ask("a game like tetris", KEY);
  drop("start");
  status(build!.id, "1.0.0", { build: build!.build, phase: "understand", state: "confirm", understood: { name: "Blocks", recipe: "game", says: "a falling-block game" } });
  const listed = (await builds.list())[0];
  assert.equal(listed.state, "confirm");
  assert.equal(listed.name, "Blocks");
  await builds.confirm(build!.build);
  const start = drop("start");
  assert.equal(start.phase, "build");
  assert.equal(start.recipe, "game");
  assert.equal(start.name, "Blocks");

  // No recipe: a plan, then an adult's yes to it, then the build.
  status(build!.id, "1.0.0", { build: build!.build, phase: "understand", state: "confirm", understood: { name: "Sky", recipe: null, says: "tonight's sky" } });
  await builds.confirm(build!.build);
  assert.equal(drop("start").phase, "plan");
  const plan = { name: "Sky", says: "tonight's sky", steps: [{ id: "draw", does: "draw it" }], permissions: { origins: [], media: [], tile: false, notices: false }, packages: [] };
  status(build!.id, "1.0.0", { build: build!.build, phase: "plan", state: "plan", plan });
  await builds.approvePlan(build!.build);
  const planned = drop("start");
  assert.equal(planned.phase, "build");
  assert.equal(planned.recipe, null);
  assert.deepEqual(planned.plan, plan);
});

test("an approved app goes to root to install; a refused start says why; the spend shows", async () => {
  const { o, builds, drop, status } = box();
  const { build } = await builds.ask("a game like tetris", KEY);
  drop("start");
  mkdirSync(o.run, { recursive: true });
  writeFileSync(join(o.run, "answer.json"), JSON.stringify({ action: "start", build: build!.build, started: false, reason: "the box couldn't fetch claude" }));
  const refused = (await builds.list())[0];
  assert.equal(refused.state, "failed");
  assert.equal(refused.reason, "the box couldn't fetch claude");

  status(build!.id, "1.0.0", { build: build!.build, state: "approve", approval: { reaches: { always: [], declared: [] }, packages: [] } });
  writeFileSync(o.spend, JSON.stringify({ month: "2026-10", spent: 3.456, builds: { [build!.build]: 1.234 } }));
  const view = (await builds.list())[0];
  assert.equal(view.state, "approve");
  assert.equal(view.spent, 1.23);
  assert.deepEqual(await builds.spend(), { month: "2026-10", spent: 3.46, cap: { build: 5, month: 20 } });
  await builds.approve(build!.build);
  assert.deepEqual(drop("install"), { build: build!.build, id: build!.id, version: "1.0.0" });
  assert.match((await builds.approve("b-nope")).error!, /no such build/);
});

test("a change and a rebuild are new versions through the same steps; a rollback brings the kept one back", async () => {
  const { builds, drop, status } = box();
  const { build } = await builds.ask("a game like tetris", KEY);
  drop("start");
  status(build!.id, "1.0.0", { build: build!.build, state: "installed", understood: { name: "Blocks", recipe: "game", says: "" } });
  const changed = await builds.next(build!.id, "make it faster", KEY);
  assert.equal(changed.build?.version, "1.1.0");
  const start = drop("start");
  assert.equal(start.phase, "build");
  assert.equal(start.from, "1.0.0");
  assert.equal(start.change, "make it faster");
  assert.equal(start.recipe, "game");
  status(build!.id, "1.1.0", { build: changed.build!.build, state: "installed", understood: { name: "Blocks", recipe: "game", says: "" } });
  status(build!.id, "1.0.0", { build: build!.build, state: "kept", understood: { name: "Blocks", recipe: "game", says: "" } });
  const rebuilt = await builds.next(build!.id, undefined, KEY);
  assert.equal(rebuilt.build?.version, "1.2.0");
  const again = drop("start");
  assert.equal(again.from, undefined, "a rebuild starts from the recipe again");
  status(build!.id, "1.2.0", { build: rebuilt.build!.build, state: "failed" });
  await builds.rollback(build!.id);
  assert.deepEqual(drop("install"), { build: build!.build, id: build!.id, version: "1.0.0" });
  await builds.remove(build!.id);
  assert.deepEqual(drop("remove"), { id: build!.id });
  assert.deepEqual(await builds.list(), []);
});

test("the caps and the safeguards are an adult's to change, within bounds", async () => {
  const { builds } = box();
  assert.deepEqual(await builds.settings(), { cap: { build: 5, month: 20 }, safeguards: true });
  assert.deepEqual((await builds.setSettings({ cap: { build: 2.5 }, safeguards: false })).settings, { cap: { build: 2.5, month: 20 }, safeguards: false });
  assert.match((await builds.setSettings({ cap: { build: 30 } })).error!, /no more than the month's/);
  assert.match((await builds.setSettings({ cap: { month: -1 } })).error!, /a number of dollars/);
  assert.match((await builds.setSettings({ safeguards: "off" })).error!, /on or off/);
});

// --- Root's side -----------------------------------------------------------

test("Q117 root installs an approved app as Local, keeps the version before for one-press rollback, and removes it all", async () => {
  const { o } = box();
  const handOver = new HandOver({
    drop: o.drop,
    builds: o.builds,
    apps: o.apps,
    home: join(o.state, "home"),
    run: o.run,
    spend: o.spend,
    builder: { uid: process.getuid!(), gid: process.getgid!() },
    rootUid: process.getuid!(),
    systemctl: () => false,
  });
  // A version as the builder leaves it: its app, and its status.
  const built = (version: string, build: string, state: string) => {
    const dir = join(o.builds, "local.blocks", version);
    mkdirSync(dir, { recursive: true });
    cpSync(join(ROOT, "test/agentv/fixtures/apps/blocks"), join(dir, "work", "app"), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, "work", "app", "manifest.json"), "utf8"));
    writeFileSync(join(dir, "work", "app", "manifest.json"), JSON.stringify({ ...manifest, id: "local.blocks", version, author: "your agent" }));
    writeFileSync(join(dir, "status.json"), JSON.stringify({ build, id: "local.blocks", version, phase: "build", state, steps: [], started: "", at: "" }));
  };
  const state = (version: string) => JSON.parse(readFileSync(join(o.builds, "local.blocks", version, "status.json"), "utf8")).state;
  const install = async (data: object) => {
    mkdirSync(o.drop, { recursive: true });
    writeFileSync(join(o.drop, "install.json"), JSON.stringify(data));
    return handOver.handle();
  };
  const onHome = () => JSON.parse(readFileSync(join(o.apps, "local.blocks", "manifest.json"), "utf8")).version;

  built("1.0.0", "b1", "approve");
  assert.equal((await install({ build: "b1", id: "local.blocks", version: "1.0.0" }))!.started, true);
  assert.equal(onHome(), "1.0.0");
  assert.equal(JSON.parse(readFileSync(join(o.apps, "installed.json"), "utf8"))["local.blocks"].tier, "local", "a Local app");
  assert.equal(state("1.0.0"), "installed");

  built("1.1.0", "b2", "approve");
  await install({ build: "b2", id: "local.blocks", version: "1.1.0" });
  assert.equal(onHome(), "1.1.0");
  assert.equal(state("1.0.0"), "kept", "the version before stays, for a rollback");
  assert.equal(state("1.1.0"), "installed");

  await install({ build: "b1", id: "local.blocks", version: "1.0.0" });
  assert.equal(onHome(), "1.0.0", "one press back");
  assert.equal(state("1.1.0"), "kept");

  built("1.2.0", "b3", "failed");
  assert.match((await install({ build: "b3", id: "local.blocks", version: "1.2.0" }))!.reason!, /isn't approved/, "nothing that didn't pass gets in");
  assert.match((await install({ build: "b9", id: "local.blocks", version: "1.1.0" }))!.reason!, /isn't approved/, "nor another build's version");
  assert.match((await install({ build: "b1", id: "agentv.music", version: "1.0.0" }))!.reason!, /no such build/);

  writeFileSync(join(o.drop, "remove.json"), JSON.stringify({ id: "local.blocks" }));
  assert.equal((await handOver.handle())!.started, true);
  assert.ok(!existsSync(join(o.apps, "local.blocks")));
  assert.ok(!existsSync(join(o.builds, "local.blocks")));
});

// --- Through the daemon ------------------------------------------------------

test("the TV asks the builder once the AI is ready, and the phone sees the app and approves it behind the PIN", async () => {
  const base = join(scratch, "daemon");
  mkdirSync(join(base, "root", "setup"), { recursive: true });
  const builds = join(base, "build");
  const daemon = new Daemon({ root: join(base, "root"), state: join(base, "state"), port: 0, log: () => {}, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1", keyStatus: join(base, "key.json"), builds, buildRun: join(base, "run"), spend: join(base, "spend.json"), npmWarnings: join(base, "warnings.json") });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  const lan = `http://127.0.0.1:${daemon.lanPort}`;
  try {
    const send = (method: string, path: string, body?: unknown, grant?: string) =>
      fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const code = (await (await send("POST", "/api/phones/pair", {})).json()).pairing.code;
    const token = (await (await fetch(`${lan}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "iphone" }) })).json()).token;
    const phone = (method: string, path: string, body?: unknown, grant?: string) =>
      fetch(`${lan}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

    assert.match((await (await send("POST", "/api/builds", { sentence: "a game like tetris" })).json()).error, /pick the AI/, "nothing's built before the AI is picked and its terms accepted");
    assert.equal((await send("PUT", "/api/pin", { pin: "2468" })).status, 200);
    const grant = (await (await phone("POST", "/api/phone/pin", { pin: "2468" })).json()).grant;
    await send("POST", "/api/ai", { provider: "claude", path: "plan" }, grant);
    assert.equal((await phone("POST", "/api/phone/terms", { provider: "claude", path: "plan" }, grant)).status, 200);

    const asked = await (await send("POST", "/api/builds", { sentence: "a game like tetris" })).json();
    assert.equal(asked.ok, true, JSON.stringify(asked));
    const start = JSON.parse(readFileSync(join(base, "state", "build-drop", "start.json"), "utf8"));
    assert.equal(start.phase, "understand");
    assert.equal(start.path, "plan");

    // The builder's gates passed: the app waits for an adult, with its shot.
    const dir = join(builds, asked.build.id, "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ build: asked.build.build, id: asked.build.id, version: "1.0.0", phase: "build", state: "approve", steps: [], approval: { reaches: { always: ["the remote"], declared: ["a tile on home"] }, packages: [] }, started: "", at: "" }));
    writeFileSync(join(dir, "shot.png"), Buffer.from("\x89PNG\r\n\x1a\nnot really"));
    const listed = await (await phone("GET", "/api/phone/builds")).json();
    assert.equal(listed.builds[0].state, "approve");
    assert.deepEqual(listed.builds[0].approval.reaches.declared, ["a tile on home"]);
    assert.equal(listed.settings.safeguards, true);
    const shot = await phone("GET", `/api/phone/builds/${asked.build.build}/shot`);
    assert.equal(shot.headers.get("content-type"), "image/png");

    assert.equal((await phone("POST", `/api/phone/builds/${asked.build.build}/approve`, {})).status, 403, "approval needs the PIN");
    assert.equal((await phone("POST", `/api/phone/builds/${asked.build.build}/approve`, {}, grant)).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(base, "state", "build-drop", "install.json"), "utf8")), { build: asked.build.build, id: asked.build.id, version: "1.0.0" });

    assert.equal((await send("PUT", "/api/builds/settings", { safeguards: false })).status, 403, "the safeguards are behind the PIN");
    assert.equal((await (await send("PUT", "/api/builds/settings", { safeguards: false }, grant)).json()).settings.safeguards, false);
  } finally {
    await daemon.close();
  }
});
