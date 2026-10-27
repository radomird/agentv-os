// Setup's apps (daemon/setup-apps.ts, board 09): the official apps from the
// signed index, the goal's first and the rest under "more", beside the
// built-in Music; the ones picked handed to root to install, as
// agentv-setup-apps does, and the TV told as each moves on. And what the
// daemon answers the setup screens with.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { IndexEntry } from "../../../daemon/apps/index.ts";
import { Daemon } from "../../../daemon/server.ts";
import { GOAL_APPS, SetupApps, type Present } from "../../../daemon/setup-apps.ts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-setup-apps-"));
const COMMIT = "c73732a1416f35af05b89bf1f3586cf2810b5aaa";
const entry = (id: string, name: string, tier: IndexEntry["tier"] = "official"): IndexEntry => ({
  id,
  tier,
  name,
  version: "1.0.0",
  description: `Your ${name} on the TV`,
  repo: "https://example.invalid/agentv-apps.git",
  commit: COMMIT,
  path: `apps/${name.toLowerCase()}`,
});
const INDEX = [entry("agentv.immich", "Immich"), entry("agentv.jellyfin", "Jellyfin"), entry("agentv.steam", "Steam"), entry("someone.else", "Else", "community")];
const MUSIC: Present = { id: "agentv.music", name: "Music", description: "Your music", tier: "built-in" };
const CLOCK: Present = { id: "agentv.clock", name: "Clock", tier: "built-in" };

let daemon: Daemon;
let url = "";
const state = join(scratch, "state");
const status = join(scratch, "run", "state.json");
let catalogCalls = 0;

before(async () => {
  mkdirSync(join(scratch, "root", "setup"), { recursive: true });
  writeFileSync(join(scratch, "root", "settings"), "AGENTV_VERSION=0.2.1\nAGENTV_INDEX_URL=https://example.invalid/index\n");
  daemon = new Daemon({
    root: join(scratch, "root"),
    state,
    port: 0,
    log: () => {},
    builtins: join(import.meta.dirname, "../../../apps/builtin"),
    apps: join(scratch, "apps"),
    setupAppsStatus: status,
    setupAppsWaitMs: 1500,
    setupCatalog: async (source) => {
      assert.equal(source, "https://example.invalid/index", "the index from the package's settings");
      catalogCalls++;
      return INDEX;
    },
  });
  url = `http://127.0.0.1:${await daemon.listen()}`;
});

after(async () => {
  await daemon.close();
  rmSync(scratch, { recursive: true, force: true });
});

const post = (path: string, body: unknown, grant?: string) =>
  fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: JSON.stringify(body) });

// Root's side, as agentv-setup-apps does it: takes the drop away, then says
// how each app goes.
function root(drop: string, statusPath: string, outcome: (id: string) => "installed" | "failed" = () => "installed"): () => void {
  const timer = setInterval(() => {
    if (!existsSync(drop)) return;
    const apps: string[] = JSON.parse(readFileSync(drop, "utf8")).apps;
    rmSync(drop);
    mkdirSync(join(statusPath, ".."), { recursive: true });
    const write = (state: string) =>
      writeFileSync(statusPath, JSON.stringify({ apps: Object.fromEntries(apps.map((id) => [id, { state: state === "done" ? outcome(id) : state, ...(state === "done" && outcome(id) === "failed" ? { error: `couldn't fetch ${id}` } : {}) }])) }));
    write("installing");
    setTimeout(() => write("done"), 300);
  }, 20);
  return () => clearInterval(timer);
}

test("each goal puts its own official apps first, the rest go under more, and the built-in Music is there, ticked", async () => {
  const apps = new SetupApps({ state: join(scratch, "list"), source: async () => "index", catalog: async () => INDEX, status: join(scratch, "none.json") });
  const streaming = await apps.list("streaming", [MUSIC, CLOCK]);
  assert.deepEqual(streaming.for.map((app) => app.id), ["agentv.jellyfin"], "Plex isn't in the index yet, so it isn't shown");
  assert.deepEqual(streaming.more.map((app) => app.id), ["agentv.music", "agentv.immich", "agentv.steam"], "built-in first, then by name, and no community app");
  assert.deepEqual(streaming.more[0], { id: "agentv.music", name: "Music", description: "Your music", builtin: true, installed: true, state: null });
  assert.ok(!streaming.more.some((app) => app.id === "agentv.clock"), "Clock and Weather are on home anyway");
  assert.deepEqual((await apps.list("music", [MUSIC])).for.map((app) => app.id), ["agentv.music"]);
  assert.deepEqual((await apps.list("media", [MUSIC])).for.map((app) => app.id), ["agentv.jellyfin", "agentv.immich"]);
  assert.deepEqual((await apps.list("gaming", [MUSIC])).for.map((app) => app.id), ["agentv.steam"]);
  const none = await apps.list(null, [MUSIC]);
  assert.deepEqual(none.for, []);
  assert.equal(none.more.length, 4);
  // An app on the box already says so.
  const here = await apps.list("streaming", [MUSIC, { id: "agentv.jellyfin", name: "Jellyfin", tier: "official" }]);
  assert.equal(here.for[0].installed, true);
  for (const ids of Object.values(GOAL_APPS)) for (const id of ids) assert.match(id, /^agentv\./, "only AgenTV's own apps");
});

test("an index that can't be read says why, and is asked again a little later", async () => {
  let calls = 0;
  const apps = new SetupApps({
    state: join(scratch, "broken"),
    source: async () => "index",
    catalog: async () => {
      calls++;
      throw new Error("the app index isn't signed by AgenTV's key, so nothing was installed");
    },
  });
  const list = await apps.list("streaming", [MUSIC]);
  assert.match(list.error ?? "", /isn't signed/);
  assert.deepEqual(list.more.map((app) => app.id), ["agentv.music"], "the built-in apps are still there");
  await apps.list("streaming", [MUSIC]);
  assert.equal(calls, 1, "not asked again at once");
  assert.match((await apps.install(["agentv.jellyfin"])) ?? "", /isn't signed/);
  const nowhere = new SetupApps({ state: join(scratch, "nowhere"), source: async () => undefined });
  assert.match((await nowhere.list("music", [])).error ?? "", /no app index set up yet/);
});

test("the apps picked go to root in a drop only it takes, and only official apps from the index", async () => {
  const dir = join(scratch, "drop");
  const statusPath = join(scratch, "drop-run", "state.json");
  const heard: unknown[] = [];
  const apps = new SetupApps({ state: dir, source: async () => "index", catalog: async () => INDEX, status: statusPath, waitMs: 1500, onChange: (now) => heard.push(now) });
  assert.match((await apps.install([])) ?? "", /a list of their ids/);
  assert.match((await apps.install(["../../etc"])) ?? "", /a list of their ids/);
  assert.match((await apps.install(["someone.else"])) ?? "", /isn't one of AgenTV's official apps/);
  assert.match((await apps.install(["agentv.plex"])) ?? "", /isn't one of AgenTV's official apps/);

  // Nothing takes it: it doesn't stay.
  assert.match((await apps.install(["agentv.immich"])) ?? "", /agentv-setup-apps.path isn't running/);
  assert.ok(!existsSync(join(dir, "apps-drop", "install.json")));

  const stop = root(join(dir, "apps-drop", "install.json"), statusPath, (id) => (id === "agentv.steam" ? "failed" : "installed"));
  try {
    assert.equal(await apps.install(["agentv.immich", "agentv.steam", "agentv.immich"]), null);
    assert.deepEqual(Object.keys(apps.status()).sort(), ["agentv.immich", "agentv.steam"]);
    const until = Date.now() + 5000;
    while (Date.now() < until && !heard.some((now) => JSON.stringify(now).includes('"installed"'))) await new Promise((resolve) => setTimeout(resolve, 50));
    const last = apps.status();
    assert.equal(last["agentv.immich"].state, "installed");
    assert.deepEqual(last["agentv.steam"], { state: "failed", error: "couldn't fetch agentv.steam" });
    assert.ok(heard.length >= 1, "the TV heard it move on");
  } finally {
    stop();
    apps.stop();
  }
});

test("the setup screens get the apps for the goal, pick them past the PIN once there is one, and keep a wish", async () => {
  await post("/api/setup/goal", { goal: "media" });
  const list = await (await fetch(`${url}/api/setup/apps`)).json();
  assert.equal(list.goal, "media");
  assert.deepEqual(list.for.map((app: { id: string }) => app.id), ["agentv.jellyfin", "agentv.immich"]);
  assert.deepEqual(list.more.map((app: { id: string }) => app.id), ["agentv.music", "agentv.steam"]);
  assert.deepEqual(list.wishes, []);

  assert.equal((await fetch(`${url}/api/pin`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "2468" }) })).status, 200);
  assert.equal((await post("/api/setup/apps", { install: ["agentv.immich"] })).status, 403, "past the PIN");
  const grant = (await (await post("/api/pin/check", { pin: "2468" })).json()).grant;
  const stop = root(join(state, "apps-drop", "install.json"), status);
  try {
    const reply = await post("/api/setup/apps", { install: ["agentv.immich"] }, grant);
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).apps["agentv.immich"].state !== undefined, true);
    const until = Date.now() + 5000;
    let now = await (await fetch(`${url}/api/setup/apps`)).json();
    while (Date.now() < until && now.for[1].state !== "installed") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      now = await (await fetch(`${url}/api/setup/apps`)).json();
    }
    assert.equal(now.for[1].state, "installed");
  } finally {
    stop();
  }
  assert.equal(catalogCalls, 1, "the index is read once for a while");

  assert.equal((await post("/api/setup/wish", { text: "a radio app" })).status, 200);
  assert.deepEqual((await (await fetch(`${url}/api/setup/apps`)).json()).wishes, ["a radio app"]);
  assert.equal((await post("/api/setup/wish", { text: "" })).status, 400);

  await post("/api/setup", { done: true });
  assert.equal((await post("/api/setup/apps", { install: ["agentv.steam"] }, grant)).status, 409, "not once setup is done");
  assert.equal((await post("/api/setup/wish", { text: "more" })).status, 409);
});

test("ADR-042 Apps → add an app lists the official apps not on the TV, and adds one past the PIN", async () => {
  // After setup, with the PIN from the test before.
  const listed = async () => (await (await fetch(`${url}/api/apps/add`)).json()).apps as { id: string; state: string | null; error?: string }[];
  assert.deepEqual(
    (await listed()).map((app) => `${app.id} ${app.state}`),
    ["agentv.immich null", "agentv.jellyfin null", "agentv.steam null"],
    "by name, official only, and Immich, which root said it installed but isn't here, can be added again",
  );
  assert.equal((await post("/api/apps/add", { id: "agentv.steam" })).status, 403, "past the PIN");
  const grant = (await (await post("/api/pin/check", { pin: "2468" })).json()).grant;
  assert.equal((await post("/api/apps/add", { id: "someone.else" }, grant)).status, 400, "only an official app");
  assert.equal((await post("/api/apps/add", { id: "agentv.music" }, grant)).status, 400, "not one already on the TV");
  assert.equal((await post("/api/apps/add", { id: "../steam" }, grant)).status, 400);
  const stop = root(join(state, "apps-drop", "install.json"), status, () => "failed");
  try {
    assert.equal((await post("/api/apps/add", { id: "agentv.steam" }, grant)).status, 200);
    const until = Date.now() + 5000;
    let steam = (await listed()).find((app) => app.id === "agentv.steam");
    while (Date.now() < until && steam?.state !== "failed") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      steam = (await listed()).find((app) => app.id === "agentv.steam");
    }
    assert.deepEqual(steam, { id: "agentv.steam", name: "Steam", description: "Your Steam on the TV", state: "failed", error: "couldn't fetch agentv.steam" }, "its tile says it failed, and why");
  } finally {
    stop();
  }

  const child = (await (await post("/api/viewers", { name: "mia", role: "child" }, grant)).json()).profile;
  await post("/api/viewer", { id: child.id }, grant);
  assert.equal((await fetch(`${url}/api/apps/add`)).status, 403, "a child's profile doesn't see it");
  assert.equal((await post("/api/apps/add", { id: "agentv.jellyfin" }, grant)).status, 403, "even with the PIN");
});
