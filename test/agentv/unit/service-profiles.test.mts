// A service's own profiles for who's watching (ADR-009): the screen daemon's
// half (daemon/service-profiles.ts), which opens the profile an adult picked
// for children when a child watches and lists the profiles the first time an
// adult opens the app, and the daemon's, which keeps the list and the pick,
// with the pick past the adult PIN.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AppHost, PageBroker, Viewer } from "../../../daemon/apps/loader.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { ServiceProfiles, type ServiceProfileDeps } from "../../../daemon/service-profiles.ts";
import { FIXTURES, startBox, type Fixture } from "../ui/box.mts";

const adult: Viewer = { id: "radomir", role: "adult" };
const child: Viewer = { id: "v-mila", role: "child" };
const page = { url: async () => "https://family.example/", call: async () => null } as PageBroker;

// A stand-in for an app's worker with profiles: list() and select() answer,
// or throw while its page "comes up".
function fakeHost(app: { list?: () => string[] | Error; select?: (name: string) => void | Error }) {
  const calls: [string, unknown[]][] = [];
  let stopped = 0;
  const host = {
    setPage() {},
    async call(_viewer: Viewer, path: string, ...args: unknown[]) {
      calls.push([path, args]);
      const answer = path === "profiles.list" ? (app.list?.() ?? []) : app.select?.(args[0] as string);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    stop() {
      stopped++;
    },
  } as unknown as AppHost;
  return { host, calls, stopped: () => stopped };
}

function profiles(host: AppHost | null, viewer: Viewer, known: { names: string[]; forChildren: string | null } | null, extra: Partial<ServiceProfileDeps> = {}) {
  const listed: [string, string[]][] = [];
  const lines: string[] = [];
  const deps: ServiceProfileDeps = {
    host: async () => host,
    viewer: async () => viewer,
    known: async () => known,
    listed: async (id, names) => void listed.push([id, names]),
    settle: 0,
    retry: 10,
    pageWithin: 200,
    log: (line) => lines.push(line),
    ...extra,
  };
  return { service: new ServiceProfiles(deps), listed, lines };
}

test("ADR-009 a child watching gets the profile picked for children, tried while the app's page comes up", async () => {
  let ready = false;
  const app = fakeHost({ select: () => (ready ? undefined : new Error("the page isn't there yet")) });
  const { service, listed, lines } = profiles(app.host, child, { names: ["Radomir", "Kids"], forChildren: "Kids" });
  setTimeout(() => (ready = true), 30);
  assert.equal(await service.apply("local.family", page), "selected");
  assert.ok(app.calls.length > 1, "it's tried again while the page comes up");
  assert.deepEqual(app.calls.at(-1), ["profiles.select", ["Kids"]]);
  assert.ok(app.calls.every(([path]) => path === "profiles.select"), "a child's doesn't list them");
  assert.deepEqual(listed, []);
  assert.equal(app.stopped(), 1, "its worker goes after");
  assert.deepEqual(lines, ["local.family: opened the profile for children"]);
});

test("ADR-009 with nothing picked, a child's app opens as it is, and that's logged", async () => {
  const app = fakeHost({});
  const { service, lines } = profiles(app.host, child, { names: ["Radomir", "Kids"], forChildren: null });
  assert.equal(await service.apply("local.family", page), "none picked");
  assert.deepEqual(app.calls, []);
  assert.deepEqual(lines, ["local.family: no profile is picked for children, so it opens as it is"]);
});

test("ADR-009 when the profile for children won't open, it says so", async () => {
  const app = fakeHost({ select: () => new Error("there's no profile called Kids") });
  const { service, lines } = profiles(app.host, child, { names: ["Kids"], forChildren: "Kids" });
  assert.equal(await service.apply("local.family", page), "not selected");
  assert.match(lines.join("\n"), /local\.family's profiles\.select didn't work: there's no profile called Kids/);
  assert.equal(app.stopped(), 1);
});

test("ADR-009 an adult's app lists its profiles the first time, and leaves the service's profile as it is", async () => {
  const app = fakeHost({ list: () => ["Radomir", "Ana", "Kids"] });
  const first = profiles(app.host, adult, { names: [], forChildren: null });
  assert.equal(await first.service.apply("local.family", page), "listed");
  assert.deepEqual(first.listed, [["local.family", ["Radomir", "Ana", "Kids"]]]);
  assert.deepEqual(app.calls, [["profiles.list", []]], "no profile is selected for an adult");
  // Once they're listed, an adult's app is left alone.
  const again = profiles(app.host, adult, { names: ["Radomir", "Ana", "Kids"], forChildren: "Kids" });
  assert.equal(await again.service.apply("local.family", page), null);
  assert.equal(app.calls.length, 1);
  // An app without profiles does nothing at all.
  assert.equal(await profiles(null, child, null).service.apply("agentv.tube", page), null);
});

// --- The daemon's half -----------------------------------------------------------

const FAMILY: Fixture = {
  id: "local.family",
  name: "Family TV",
  tier: "local",
  category: "streaming",
  edit: (m) => ((m.tv.capabilities = ["launch", "profiles"]), delete m.tv.tiles, (m.tv.homeUrl = "https://family.example/"), (m.tv.origins = ["https://family.example"]), (m.tv.setup = [])),
};
const PIN = "4826";
const dir = mkdtempSync(join(tmpdir(), "agentv-service-profiles-"));
let daemon: Daemon;
let url = "";

before(async () => {
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  process.env.AGENTV_PASSWD = passwd;
  ({ daemon, url } = await startBox(0, [...FIXTURES, FAMILY]));
});

after(async () => {
  await daemon?.close();
  delete process.env.AGENTV_PASSWD;
  rmSync(dir, { recursive: true, force: true });
});

async function send(method: string, path: string, body?: unknown, grant?: string) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as Record<string, any> };
}
const family = async () => (await send("GET", "/api/home")).data.apps.find((app: { id: string }) => app.id === "local.family");

test("ADR-009 the daemon keeps the profiles an app listed and the one an adult picks, past the PIN", async () => {
  assert.equal((await send("GET", "/api/apps/agentv.tube/profiles")).status, 404, "an app without profiles has none");
  assert.deepEqual((await send("GET", "/api/apps/local.family/profiles")).data, { ok: true, names: [], forChildren: null });
  assert.deepEqual((await family()).profiles, { names: [], forChildren: null }, "its details know it has profiles, none listed yet");
  assert.equal((await send("GET", "/api/home")).data.apps.find((app: { id: string }) => app.id === "agentv.tube").profiles, undefined);

  // The screen daemon hands over what the app listed.
  for (const names of [undefined, "Kids", [""], ["x".repeat(61)], Array.from({ length: 21 }, (_, i) => `p${i}`)]) {
    assert.equal((await send("POST", "/api/apps/local.family/profiles", { names })).status, 400, JSON.stringify(names));
  }
  assert.equal((await send("POST", "/api/apps/agentv.tube/profiles", { names: ["Kids"] })).status, 400);
  assert.equal((await send("POST", "/api/apps/local.family/profiles", { names: [" Radomir ", "Kids", "Kids"] })).status, 200);
  assert.deepEqual((await send("GET", "/api/apps/local.family/profiles")).data.names, ["Radomir", "Kids"]);

  // An adult picks one of those, and only one of those.
  assert.equal((await send("PUT", "/api/apps/local.family/child-profile", { name: "Ana" })).status, 400);
  assert.equal((await send("PUT", "/api/apps/local.family/child-profile", {})).status, 400);
  assert.equal((await send("PUT", "/api/apps/local.family/child-profile", { name: "Kids" })).status, 200);
  assert.deepEqual((await family()).profiles, { names: ["Radomir", "Kids"], forChildren: "Kids" });

  // With a PIN set, picking needs it.
  assert.equal((await send("PUT", "/api/pin", { pin: PIN })).status, 200);
  const grant = (await send("POST", "/api/pin/check", { pin: PIN })).data.grant as string;
  assert.equal((await send("PUT", "/api/apps/local.family/child-profile", { name: null })).status, 403);
  assert.equal((await send("PUT", "/api/apps/local.family/child-profile", { name: null }, grant)).status, 200);
  assert.equal((await family()).profiles.forChildren, null);

  // Listing again keeps the pick, even one the service no longer lists.
  assert.equal((await send("PUT", "/api/apps/local.family/child-profile", { name: "Kids" }, grant)).status, 200);
  assert.equal((await send("POST", "/api/apps/local.family/profiles", { names: ["Radomir"] })).status, 200);
  assert.deepEqual((await send("GET", "/api/apps/local.family/profiles")).data, { ok: true, names: ["Radomir"], forChildren: "Kids" });
});
