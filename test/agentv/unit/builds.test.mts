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
import { validatePackage } from "../../../apps/contract/manifest.ts";
import { Build, reachesOf } from "../../../builder/build.ts";
import { plainReason, whyOf } from "../../../builder/reasons.ts";
import { HandOver } from "../../../builder/sandbox/hand-over.ts";
import { stopped } from "../../../builder/sandbox/start.ts";
import { Daemon } from "../../../daemon/server.ts";
import { pairPhone, type TestPhone } from "./phone-client.mts";

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
  assert.equal((await builds.ask("another", KEY)).error, "One at a time. Wait for the other app.");
  assert.equal((await builds.ask("", KEY)).error, "Keep it under 300 characters");
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
  // One plain line for why. Root's own reason stays in its answer and log.
  assert.equal(refused.reason, "Couldn't get Claude ready");

  status(build!.id, "1.0.0", { build: build!.build, state: "approve", approval: { reaches: { always: [], declared: [] }, packages: [] } });
  writeFileSync(o.spend, JSON.stringify({ month: "2026-10", spent: 3.456, builds: { [build!.build]: 1.234 } }));
  const view = (await builds.list())[0];
  assert.equal(view.state, "approve");
  assert.equal(view.spent, 1.23);
  assert.deepEqual(await builds.spend(), { month: "2026-10", spent: 3.46, cap: { build: 5, month: 20 } });
  await builds.approve(build!.build);
  assert.deepEqual(drop("install"), { build: build!.build, id: build!.id, version: "1.0.0" });
  assert.match((await builds.approve("b-nope")).error!, /Couldn't find that app/);
});

test("a build says it's starting until the builder writes, with its recipe's cost and time once it's read", async () => {
  const { o, builds, drop, status } = box();
  const { build } = await builds.ask("a game like tetris", KEY);
  assert.equal((await builds.list())[0].state, "starting", "root hasn't taken it yet");
  drop("start");
  mkdirSync(o.run, { recursive: true });
  writeFileSync(join(o.run, "answer.json"), JSON.stringify({ action: "start", build: build!.build, started: true, at: "2026-10-27T18:00:10.000Z" }));
  status(build!.id, "1.0.0", { build: build!.build, phase: "understand", state: "confirm", understood: { name: "Blocks", recipe: "game", says: "A falling-block puzzle" }, at: "2026-10-27T18:00:05.000Z" });
  assert.equal((await builds.list())[0].state, "starting", "root took it, and the builder hasn't written since");
  status(build!.id, "1.0.0", { build: build!.build, phase: "understand", state: "confirm", understood: { name: "Blocks", recipe: "game", says: "A falling-block puzzle" }, at: "2026-10-27T18:00:20.000Z" });
  const read = (await builds.list())[0];
  assert.deepEqual([read.state, read.cost, read.minutes, read.provider, read.path], ["confirm", { low: 0.5, high: 3 }, 20, "claude", "key"]);
  await builds.confirm(build!.build);
  assert.equal((await builds.list())[0].state, "starting", "confirmed, and waiting for root again");
});

test("a build never on home is put away, its folder with it; one going is stopped first, and one on home is removed instead", async () => {
  const { o, builds, drop, status } = box();
  const { build } = await builds.ask("a game like tetris", KEY);
  assert.match((await builds.forget("b-nope")).error!, /Couldn't find that app/);
  // Still starting: it's stopped, then put away.
  assert.deepEqual(await builds.forget(build!.build), {});
  assert.deepEqual(drop("stop"), {});
  assert.deepEqual(drop("remove"), { id: build!.id });
  assert.deepEqual(await builds.list(), []);

  const again = (await builds.ask("a game like tetris", KEY)).build!;
  drop("start");
  status(again.id, "1.0.0", { build: again.build, state: "running", at: "2026-10-27T19:00:00.000Z" });
  assert.match((await builds.forget(again.build)).error!, /Stop it first/);
  status(again.id, "1.0.0", { build: again.build, state: "installed", at: "2026-10-27T19:00:01.000Z" });
  assert.match((await builds.forget(again.build)).error!, /Remove the app instead/);
  // A change that failed is put away, and the app on home stays.
  const next = (await builds.next(again.id, "make it faster", KEY)).build!;
  drop("start");
  status(again.id, next.version, { build: next.build, state: "failed", reason: "its tests didn't pass", at: "2026-10-27T19:00:02.000Z" });
  assert.deepEqual(await builds.forget(next.build), {});
  assert.equal(drop("remove"), null, "the app's other version is still there");
  assert.deepEqual((await builds.list()).map((b) => b.state), ["installed"]);
  assert.ok(existsSync(o.state));
});

test("an install root couldn't do says why, and the app still waits for its yes", async () => {
  const { o, builds, drop, status } = box();
  const { build } = await builds.ask("a game like tetris", KEY);
  drop("start");
  status(build!.id, "1.0.0", { build: build!.build, state: "approve", at: "2026-10-27T18:00:05.000Z" });
  await builds.approve(build!.build);
  drop("install");
  mkdirSync(o.run, { recursive: true });
  writeFileSync(join(o.run, "answer.json"), JSON.stringify({ action: "install", build: build!.build, started: false, reason: "it couldn't be installed: no room", at: "2026-10-27T18:00:09.000Z" }));
  const view = (await builds.list())[0];
  assert.deepEqual([view.state, view.reason], ["approve", "Couldn't install it. Try again."]);
});

test("a build that failed shows one plain line for its kind, and never the builder's own reason", async () => {
  // Each reason the builder, root, the relay or an AI's own tool gives, and
  // the line a screen shows for it.
  const lines: [string, string][] = [
    ["try: the agent stopped (exit 1)", "Something went wrong"],
    ["the agent ended without a result", "Something went wrong"],
    ["build: the agent stopped with an error", "Something went wrong"],
    ["design: the step ran out of turns", "It took too many tries"],
    ["the build reached its spend cap", "It reached its $5 limit"],
    ["this month's agent spend reached its cap", "It reached this month's limit"],
    ["the build took longer than it may", "It took too long"],
    ["the agent didn't say what it understood", "Couldn't follow that. Try other words."],
    ["the agent didn't submit a plan", "Couldn't work out the steps"],
    ["no recipe fits and no plan is approved, so nothing is built", "You didn't approve the steps, so nothing was made"],
    ["the static checks found: main.js uses eval", "It didn't pass the safety checks"],
    ["the build declared https://a.example, and the app's manifest doesn't list it", "It didn't pass the safety checks"],
    ["the app's manifest lists https://a.example, which the build didn't declare", "It didn't pass the safety checks"],
    ["the agent's CLI offered tools of its own: Bash", "It didn't pass the safety checks"],
    ['the test "it opens" failed: no canvas', "It didn't pass its tests"],
    ["its tests didn't pass", "It didn't pass its tests"],
    ["the claude plan's sign-in didn't take: try again", "Couldn't sign in to Claude"],
    ["couldn't sign in to the plan: it took longer than 15 minutes", "Couldn't sign in to Claude"],
    ["couldn't sign in to the plan: you stopped it", "You stopped it"],
    ["another build is running; one runs at a time", "One at a time. Wait for the other app."],
    ["the box couldn't fetch claude", "Couldn't get Claude ready"],
    ["the builder's way out didn't start", "Couldn't start. Restart your TV and try again."],
    ["the builder didn't start", "Couldn't start. Restart your TV and try again."],
    ["the relay doesn't know what claude-next costs, so it can't keep the build inside its cap", "Can't track what this AI costs, so it stopped"],
    ["what the app reaches isn't what its approval showed", "It changed after you approved it"],
    ["the app's origins changed after they were approved", "It changed after you approved it"],
    ["the build reached https://cdn.example, which its approval didn't show", "It changed after you approved it"],
    ["the app this goes on with isn't on home any more", "That app isn't on home any more"],
    ["claude's plan is coming soon: use a key for it", "Claude's plan is coming soon. Use a key for now."],
    ['build: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', "Your Claude key was refused"],
    ["build: Your credit balance is too low to access the Anthropic API", "Your Claude key is out of credit"],
    ["you stopped it", "You stopped it"],
    ["something nobody has seen before", "Something went wrong"],
  ];
  for (const [raw, line] of lines) assert.equal(plainReason(raw, { ai: "Claude", cap: 5 }), line, raw);
  assert.equal(plainReason("the build reached its spend cap"), "It reached its limit", "with no limit to name");
  assert.equal(plainReason(undefined), "Something went wrong");
  // A kind the builder gave comes before what its words look like.
  assert.equal(plainReason("60 frames a second wasn't kept", { why: "tests" }), "It didn't pass its tests");
  assert.equal(whyOf("the build took longer than it may"), "slow");

  // In the daemon's view: the line, with the AI's name and the limit, while
  // the build's own status keeps the reason.
  const { builds, o, status, drop } = box();
  const { build } = await builds.ask("a game like tetris", KEY);
  drop("start");
  status(build!.id, "1.0.0", { build: build!.build, phase: "build", state: "failed", reason: "build: the build reached its spend cap", steps: [{ id: "design", state: "done" }, { id: "draw-the-board", state: "failed" }], understood: { name: "Blocks", recipe: "game", says: "x" }, at: "2026-10-27T19:00:02.000Z" });
  const view = (await builds.list())[0];
  assert.deepEqual([view.state, view.reason], ["failed", "It reached its $5 limit"]);
  assert.match(readFileSync(join(o.builds, build!.id, "1.0.0", "status.json"), "utf8"), /build: the build reached its spend cap/);
  // And each step has the label a screen shows: its recipe's, or its id as words.
  assert.deepEqual(view.steps.map((s) => s.label), ["Designing", "Draw the board"]);
  status(build!.id, "1.0.0", { build: build!.build, phase: "build", state: "failed", reason: "the frame rate fell", why: "tests", steps: [], at: "2026-10-27T19:00:03.000Z" });
  assert.equal((await builds.list())[0].reason, "It didn't pass its tests");
  // A build that's going has no reason to show, whatever its status holds.
  status(build!.id, "1.0.0", { build: build!.build, phase: "build", state: "running", reason: "left over", steps: [], at: "2026-10-27T19:00:04.000Z" });
  assert.equal((await builds.list())[0].reason, undefined);
});

test("a build stopped while it was going says so, with the step it was on", () => {
  const dir = join(scratch, "stopped");
  mkdirSync(dir, { recursive: true });
  const build = new Build(dir);
  build.setStatus({ build: "b1", id: "local.blocks", version: "1.0.0", phase: "build", state: "running", steps: [{ id: "design", state: "done" }, { id: "build", state: "running" }], started: "", at: "" });
  stopped(build);
  const now = build.status()!;
  assert.deepEqual([now.state, now.reason, now.steps.map((s) => s.state)], ["failed", "you stopped it", ["done", "failed"]]);
  // One that had already finished is left as it was.
  build.setStatus({ ...now, state: "approve", reason: undefined });
  stopped(build);
  assert.equal(build.status()!.state, "approve");
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
  assert.match((await builds.setSettings({ cap: { build: 30 } })).error!, /can't be more than the month's/);
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
    // What approval showed: what the app reaches, as the builder works it out.
    const reaches = reachesOf(validatePackage(join(dir, "work", "app"), "local").manifest!);
    writeFileSync(join(dir, "status.json"), JSON.stringify({ build, id: "local.blocks", version, phase: "build", state, steps: [], approval: { reaches, packages: [] }, started: "", at: "" }));
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

test("H2 root installs only the app its approval showed: every origin the build declared, and none added after", async () => {
  const { o } = box();
  const handOver = new HandOver({ drop: o.drop, builds: o.builds, apps: o.apps, home: join(o.state, "home"), run: o.run, spend: o.spend, builder: { uid: process.getuid!(), gid: process.getgid!() }, rootUid: process.getuid!(), systemctl: () => false });
  const dir = join(o.builds, "local.forecast", "1.0.0");
  const app = join(dir, "work", "app");
  // A build waiting for its yes: its app lists `lists`, its state says it
  // declared `declared`, and its approval showed what `shown` reaches.
  const built = (lists: string[], declared: string[], o2: { shown?: string[]; phase?: string } = {}) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(join(ROOT, "test/agentv/fixtures/apps/blocks"), app, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(app, "manifest.json"), "utf8"));
    const write = (origins: string[]) => writeFileSync(join(app, "manifest.json"), JSON.stringify({ ...manifest, id: "local.forecast", version: "1.0.0", author: "your agent", tv: { ...manifest.tv, ...(origins.length ? { origins } : {}) } }));
    write(o2.shown ?? lists);
    const reaches = reachesOf(validatePackage(app, "local").manifest!);
    write(lists);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ origins: declared.map((origin) => ({ origin, why: "the forecast" })) }));
    writeFileSync(join(dir, "status.json"), JSON.stringify({ build: "b1", id: "local.forecast", version: "1.0.0", phase: o2.phase ?? "build", state: "approve", steps: [], approval: { reaches, packages: [] }, started: "", at: "" }));
  };
  const install = async () => {
    mkdirSync(o.drop, { recursive: true });
    writeFileSync(join(o.drop, "install.json"), JSON.stringify({ build: "b1", id: "local.forecast", version: "1.0.0" }));
    return (await handOver.handle())!;
  };
  const onHome = () => existsSync(join(o.apps, "local.forecast", "manifest.json"));

  // Declared, live in the build's filter, and left out of the app: not installed.
  built(["https://api.example.org"], ["https://api.example.org", "https://cdn-metrics.example"]);
  assert.match((await install()).reason!, /the build reached https:\/\/cdn-metrics\.example, which its approval didn't show/);
  assert.ok(!onHome());
  // The app changed after its approval was written: not installed.
  built(["https://api.example.org", "https://cdn-metrics.example"], ["https://api.example.org", "https://cdn-metrics.example"], { shown: ["https://api.example.org"] });
  assert.match((await install()).reason!, /what the app reaches isn't what its approval showed/);
  assert.ok(!onHome());
  // One list everywhere: installed, and that's the approved list from now on.
  built(["https://api.example.org"], ["https://api.example.org"]);
  assert.equal((await install()).started, true);
  assert.deepEqual(handOver.approvedOrigins("local.forecast", "1.0.0"), ["https://api.example.org"]);

  // Stage B's app, the same version again: an origin more, or one fewer, isn't installed.
  built(["https://api.example.org", "https://late.example"], ["https://api.example.org", "https://late.example"], { phase: "stage-b" });
  assert.match((await install()).reason!, /the app's origins changed after they were approved/);
  built([], [], { phase: "stage-b" });
  assert.match((await install()).reason!, /the app's origins changed after they were approved/);
  assert.deepEqual(handOver.approvedOrigins("local.forecast", "1.0.0"), ["https://api.example.org"], "what's on home is untouched");
  built(["https://api.example.org"], ["https://api.example.org", "https://late.example"], { phase: "stage-b" });
  assert.equal((await install()).started, true, "the same origins go in, whatever its state says by then");
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
    const token = await pairPhone(lan, code, "iphone");
    const phone = (method: string, path: string, body?: unknown, grant?: string) =>
      token.fetch(`${path}`, { method, headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

    assert.match((await (await send("POST", "/api/builds", { sentence: "a game like tetris" })).json()).error, /Set up AI in Settings first/, "nothing's built before the AI is picked and its terms accepted");
    assert.equal((await send("PUT", "/api/pin", { pin: "2468" })).status, 200);
    const grant = (await (await phone("POST", "/api/phone/pin", { pin: "2468" })).json()).grant;
    // The TV's own pages hold a grant of their own: a phone's is no use to them.
    const onTv = (await (await send("POST", "/api/pin/check", { pin: "2468" })).json()).grant;
    await send("POST", "/api/ai", { provider: "claude", path: "plan" }, onTv);
    assert.equal((await phone("POST", "/api/phone/terms", { provider: "claude", path: "plan" }, grant)).status, 200);

    // What setup kept for later is listed, and asked no longer once asked.
    const setupPath = join(base, "state", "setup.json");
    writeFileSync(setupPath, JSON.stringify({ done: true, at: "2026-10-27T17:00:00Z", wishes: ["A game like Tetris", "a quiz"] }));
    assert.deepEqual((await (await send("GET", "/api/builds")).json()).wishes, ["A game like Tetris", "a quiz"]);
    const asked = await (await send("POST", "/api/builds", { sentence: "a game like tetris" })).json();
    assert.equal(asked.ok, true, JSON.stringify(asked));
    assert.deepEqual((await (await send("GET", "/api/builds")).json()).wishes, ["a quiz"]);
    const start = JSON.parse(readFileSync(join(base, "state", "build-drop", "start.json"), "utf8"));
    assert.equal(start.phase, "understand");
    assert.equal(start.path, "plan");
    rmSync(join(base, "state", "build-drop", "start.json"), { force: true }); // root took it

    // The builder's gates passed: the app waits for an adult, with its shot.
    const dir = join(builds, asked.build.id, "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ build: asked.build.build, id: asked.build.id, version: "1.0.0", phase: "build", state: "approve", steps: [], approval: { reaches: { always: ["the remote"], declared: ["a tile on home"] }, packages: [] }, started: "", at: "" }));
    writeFileSync(join(dir, "shot.png"), Buffer.from("\x89PNG\r\n\x1a\nnot really"));
    const listed = await (await phone("GET", "/api/phone/builds")).json();
    assert.equal(listed.builds[0].state, "approve");
    // The phone's own state carries it too, for its notices.
    const followed = (await (await phone("GET", "/api/phone/state")).json()).builds;
    assert.deepEqual(followed, [{ build: asked.build.build, id: asked.build.id, name: "a game like tetris", provider: "claude", state: "approve", phase: "build", done: 0, steps: 0 }]);
    assert.deepEqual(listed.builds[0].approval.reaches.declared, ["a tile on home"]);
    assert.equal(listed.settings.safeguards, true);
    const shot = await phone("GET", `/api/phone/builds/${asked.build.build}/shot`);
    assert.equal(shot.headers.get("content-type"), "image/png");

    assert.equal((await phone("POST", `/api/phone/builds/${asked.build.build}/approve`, {})).status, 403, "approval needs the PIN");
    assert.equal((await phone("POST", `/api/phone/builds/${asked.build.build}/approve`, {}, grant)).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(base, "state", "build-drop", "install.json"), "utf8")), { build: asked.build.build, id: asked.build.id, version: "1.0.0" });

    assert.equal((await send("PUT", "/api/builds/settings", { safeguards: false })).status, 403, "the safeguards are behind the PIN");
    assert.equal((await (await send("PUT", "/api/builds/settings", { safeguards: false }, onTv)).json()).settings.safeguards, false);
  } finally {
    await daemon.close();
  }
});
