// What the daemon keeps for the home screen (daemon/home.ts): the apps and who
// made each, layouts it checks before it keeps them, the TV's settings, tile
// content from each app's tile(), images only from an app's own origins, and
// a theme that can only change colours.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { installLocal, removeApp } from "../../../daemon/apps/install.ts";
import { asAddress, cleanTheme } from "../../../daemon/home.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "../ui/box.mts";

let daemon: Daemon;
let url = "";
let updates = "";
let appsDir = "";

before(async () => {
  ({ daemon, url, updates, apps: appsDir } = await startBox());
});

after(() => daemon.close());

async function get(path: string): Promise<any> {
  return (await fetch(`${url}${path}`)).json();
}

async function send(method: string, path: string, body: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

test("the home screen gets the apps, who made each, and where they are", async () => {
  const home = await get("/api/home");
  assert.equal(home.viewer.role, "adult");
  const byId = Object.fromEntries(home.apps.map((app: any) => [app.id, app]));
  assert.equal(byId["agentv.sample"].maker, "official · made by agentv");
  assert.equal(byId["someone.radio"].maker, "community · made by someone");
  assert.equal(byId["local.mytv"].maker, "made by your agent · on this tv only");
  assert.deepEqual(byId["local.mytv"].sizes.map((s: any) => `${s.size} ${s.label}`), ["s logo", "m continue"]);
  assert.deepEqual(byId["agentv.tube"].sizes.map((s: any) => s.size), ["s"]);
  assert.equal(byId["someone.radio"].needsSetup, true);
  assert.equal(byId["agentv.sample"].needsSetup, false);
  // Until the viewer changes it, every app is on home, small, with all apps last.
  assert.deepEqual(home.layout.map((t: any) => t.id), ["agentv.sample", "agentv.tube", "someone.radio", "local.mytv", "agentv.games", "apps"]);
  assert.ok(home.layout.every((t: any) => t.size === "s"));
});

test("a layout is kept only when the grid can draw it", async () => {
  const good = [{ id: "agentv.sample", x: 0, y: 0, size: "l" }, { id: "apps", x: 2, y: 0, size: "s" }];
  assert.equal((await send("PUT", "/api/layout", { layout: good })).status, 200);
  assert.deepEqual((await get("/api/home")).layout, good);
  for (const [layout, why] of [
    [[{ id: "agentv.tube", x: 0, y: 0, size: "m" }], /can't be size m/],
    [[{ id: "agentv.sample", x: 3, y: 0, size: "l" }], /doesn't fit/],
    [[{ id: "agentv.nothing", x: 0, y: 0, size: "s" }], /isn't an app on this box/],
    [[{ id: "apps", x: 0, y: 0, size: "s" }, { id: "agentv.tube", x: 0, y: 0, size: "s" }], /overlaps/],
  ] as const) {
    const { status, data } = await send("PUT", "/api/layout", { layout });
    assert.equal(status, 400);
    assert.match(data.error, why);
  }
  assert.deepEqual((await get("/api/home")).layout, good);
});

test("the TV's settings change only to values they can take", async () => {
  // Updating overnight on its own is off until someone turns it on (Q79).
  assert.equal((await get("/api/home")).settings.updateOvernight, false);
  assert.equal((await send("POST", "/api/settings", { sound: { on: false, volume: 0.3 }, reduceMotion: true, idleMinutes: 15, updateOvernight: true })).status, 200);
  const settings = (await get("/api/home")).settings;
  assert.deepEqual(settings, { sound: { on: false, volume: 0.3 }, reduceMotion: true, idleMinutes: 15, updateOvernight: true });
  await send("POST", "/api/settings", { sound: { volume: 7 }, idleMinutes: 3, reduceMotion: "yes", updateOvernight: "on" });
  assert.deepEqual((await get("/api/home")).settings, settings);
  await send("POST", "/api/settings", { sound: { on: true, volume: 0.6 }, reduceMotion: false, idleMinutes: 10, updateOvernight: false });
});

test("a tile's content comes from its app's tile(), in its own worker", async () => {
  const { tile } = await get("/api/tile/agentv.sample/m");
  assert.equal(tile.headline.label, "Big Buck Bunny");
  assert.deepEqual(tile.entries.map((e: any) => e.label), ["Sintel", "Cosmos Laundromat"]);
  // An app without tile() has nothing to send.
  assert.equal((await get("/api/tile/agentv.tube/m")).tile, null);
});

test("an app's icon is served to be drawn, never run", async () => {
  const response = await fetch(`${url}/api/apps/agentv.sample/icon`);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.match(String(response.headers.get("content-security-policy")), /sandbox/);
  assert.equal((await fetch(`${url}/api/apps/agentv.games/icon`)).status, 404);
});

test("a native app with no logo of its own gets the icon its installed package gives it", async () => {
  // What Steam's package installs, with a stand-in icon of a few bytes.
  const share = join(appsDir, "..", "share");
  const byId = async () => Object.fromEntries((await get("/api/home")).apps.map((app: any) => [app.id, app]));
  assert.equal((await byId())["agentv.games"].icon, undefined);
  mkdirSync(join(share, "icons", "hicolor", "256x256", "apps"), { recursive: true });
  writeFileSync(join(share, "icons", "hicolor", "256x256", "apps", "steam.png"), "stand-in icon");
  mkdirSync(join(share, "applications"), { recursive: true });
  writeFileSync(join(share, "applications", "steam.desktop"), "[Desktop Entry]\nName=Steam\nExec=/usr/bin/steam %U\nIcon=steam\n");
  try {
    assert.equal((await byId())["agentv.games"].icon, "/api/apps/agentv.games/icon");
    const response = await fetch(`${url}/api/apps/agentv.games/icon`);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.match(String(response.headers.get("content-security-policy")), /sandbox/);
    assert.equal(await response.text(), "stand-in icon");
  } finally {
    rmSync(share, { recursive: true, force: true });
  }
  // Gone with the package, so the tile shows its name again.
  assert.equal((await byId())["agentv.games"].icon, undefined);
  assert.equal((await fetch(`${url}/api/apps/agentv.games/icon`)).status, 404);
});

test("opening an app means its home address with setup filled in, or its command, and its name for the TV to say", async () => {
  assert.deepEqual(await get("/api/apps/agentv.sample/launch"), { ok: true, runtime: "web", url: "http://127.0.0.1:1/web/", name: "Sample" });
  assert.deepEqual(await get("/api/apps/agentv.games/launch"), { ok: true, runtime: "native", exec: ["steam", "-gamepadui"], name: "Games" });
  // Not set up yet: there's no address to open.
  assert.equal((await fetch(`${url}/api/apps/someone.radio/launch`)).status, 404);
});

test("images come only from an app's own origins", async () => {
  const server = createServer((_request, response) => response.writeHead(200, { "Content-Type": "image/png" }).end("not really a png"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const image = (app: string, address: string) => fetch(`${url}/api/image?app=${app}&url=${encodeURIComponent(address)}`);
    // agentv.sample's origin is its server, http://127.0.0.1:1 in this box.
    assert.equal((await image("agentv.sample", `http://127.0.0.1:${port}/poster.png`)).status, 404);
    assert.equal((await image("agentv.sample", "file:///etc/passwd")).status, 404);
    assert.equal((await image("agentv.nothing", "https://image.tmdb.org/t/p/w500/x.jpg")).status, 404);
  } finally {
    server.close();
  }
});

test("a theme can only change colours", () => {
  const css = cleanTheme(`:root {\n  --background: #1a1b26;\n  --accent: rgb(122, 162, 247);\n  --evil: url(https://evil.example/);\n  color: red;\n}\nbody { background: url(x) }\n--fake: expression(alert(1));`);
  assert.equal(css, ":root {\n  --background: #1a1b26;\n  --accent: rgb(122, 162, 247);\n}\n");
  assert.equal(cleanTheme("body { color: red }"), "");
});

test("the theme reaches the TV, as colours only", async () => {
  const response = await fetch(`${url}/api/theme`, { method: "POST", headers: { "Content-Type": "text/css" }, body: ":root { --background: #eff1f5; --x: url(evil); }" });
  assert.equal(response.status, 200);
  assert.equal(await (await fetch(`${url}/api/theme.css`)).text(), ":root {\n  --background: #eff1f5;\n}\n");
  assert.equal((await fetch(`${url}/api/theme`, { method: "POST", headers: { "Content-Type": "text/css" }, body: "body {}" })).status, 400);
});

test("S2.12 the daemon passes on what the update check found and how an install is going", async () => {
  assert.deepEqual(await get("/api/updates"), {
    ok: true,
    status: null,
    progress: null,
    toasted: null,
    after: null,
    goBack: null,
    wentBack: null,
    seen: { kept: null, wentBack: null, later: null },
    tonight: null,
  });
  // The TV hears when either changes.
  const events = await fetch(`${url}/api/events`);
  const reader = events.body!.getReader();
  const status = { checked_at: "2026-10-23T09:12:00Z", ok: true, channel: "stable", agentv: { installed: "0.2.1-1", available: "0.3.0-1" } };
  writeFileSync(join(updates, "status.json"), JSON.stringify(status));
  let seen = "";
  const deadline = Date.now() + 3000;
  while (!seen.includes("event: updates") && Date.now() < deadline) {
    const { value } = await Promise.race([reader.read(), new Promise<{ value: undefined }>((r) => setTimeout(() => r({ value: undefined }), 500))]);
    if (value) seen += new TextDecoder().decode(value);
  }
  await reader.cancel();
  assert.match(seen, /event: updates/);
  assert.deepEqual((await get("/api/updates")).status, status);
  // Home's toast, once per release.
  assert.equal((await send("POST", "/api/updates/toasted", { version: "0.3.0" })).status, 200);
  assert.equal((await get("/api/updates")).toasted, "0.3.0");
  assert.equal((await send("POST", "/api/updates/toasted", { version: "../x" })).status, 400);
});

test("S2.14 the daemon passes on the check after an update and what Go back returns to", async () => {
  const check = { at: "2026-10-23T22:00:00Z", ok: false, agentv: "0.3.0-1", checks: [{ name: "daemon", ok: true, detail: "" }] };
  const go = { snapshot: 3, at: "2026-10-23T21:58:00Z", from: { agentv: "0.2.1-1" }, to: { agentv: "0.3.0-1" } };
  writeFileSync(join(updates, "after.json"), JSON.stringify(check));
  writeFileSync(join(updates, "go-back.json"), JSON.stringify(go));
  const state = await get("/api/updates");
  assert.deepEqual([state.after, state.goBack, state.wentBack], [check, go, null]);
  // Keep this version, and the toast after going back, by their times.
  assert.equal((await send("POST", "/api/updates/seen", { kept: check.at })).status, 200);
  assert.equal((await send("POST", "/api/updates/seen", { wentBack: "2026-10-23T22:05:00Z" })).status, 200);
  assert.deepEqual((await get("/api/updates")).seen, { kept: check.at, wentBack: "2026-10-23T22:05:00Z", later: null });
  assert.equal((await send("POST", "/api/updates/seen", { kept: "yesterday" })).status, 400);
  assert.equal((await send("POST", "/api/updates/seen", {})).status, 400);
});

test("S2.12 Tonight and Later, from the TV or the phone, are kept until they're changed", async () => {
  assert.equal((await get("/api/updates")).tonight, null);
  // Install tonight: the release, or "packages" when only those are new.
  assert.equal((await send("POST", "/api/updates/tonight", { version: "0.3.0-1" })).status, 200);
  const { tonight } = await get("/api/updates");
  assert.equal(tonight.version, "0.3.0-1");
  assert.match(tonight.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal((await send("POST", "/api/updates/tonight", { version: "packages" })).status, 200);
  assert.equal((await get("/api/updates")).tonight.version, "packages");
  for (const bad of [{ version: "../x" }, { version: 3 }, {}]) {
    assert.equal((await send("POST", "/api/updates/tonight", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await get("/api/updates")).tonight.version, "packages");
  assert.equal((await send("POST", "/api/updates/tonight", { version: null })).status, 200);
  assert.equal((await get("/api/updates")).tonight, null);
  // Later, for one release: home stops saying it's ready.
  assert.equal((await send("POST", "/api/updates/seen", { later: "0.3.0-1" })).status, 200);
  assert.equal((await get("/api/updates")).seen.later, "0.3.0-1");
  assert.equal((await send("POST", "/api/updates/seen", { later: "soon" })).status, 400);
});

test("S2.14 the check after an update loads every installed app, each in a worker of its own", async () => {
  const { apps } = await get("/api/apps/check");
  assert.ok(apps.length >= 3, `${apps.length} apps checked`);
  assert.deepEqual(apps.filter((app: { ok: boolean }) => !app.ok), []);
  // An update that broke an app's code, and one that broke its package.
  const code = join(appsDir, "agentv.sample", "app.ts");
  const manifest = join(appsDir, "someone.radio", "manifest.json");
  const [goodCode, goodManifest] = [readFileSync(code, "utf8"), readFileSync(manifest, "utf8")];
  try {
    writeFileSync(code, "throw new Error('broken by the update');\n");
    writeFileSync(manifest, "{");
    const broken = (await get("/api/apps/check")).apps.filter((app: { ok: boolean }) => !app.ok);
    assert.deepEqual(broken.map((app: { id: string; name: string }) => [app.id, app.name]), [["agentv.sample", "Sample"], ["someone.radio", "Radio"]]);
    for (const app of broken) assert.ok(app.error, `${app.id} says why`);
  } finally {
    writeFileSync(code, goodCode);
    writeFileSync(manifest, goodManifest);
  }
});

test("ADR-035 a box from before keeps the apps an adult ticked for children, from kids-apps.json", async () => {
  const box = await startBox();
  try {
    writeFileSync(join(box.state, "kids-apps.json"), JSON.stringify({ "agentv.tube": true }));
    const home = await (await fetch(`${box.url}/api/home`)).json();
    assert.equal(home.apps.find((app: any) => app.id === "agentv.tube").forChildren, true);
    assert.equal(existsSync(join(box.state, "children-apps.json")), true);
    assert.equal(existsSync(join(box.state, "kids-apps.json")), false);
  } finally {
    await box.daemon.close();
  }
});


test("a server's address is made whole, or turned down", () => {
  assert.equal(asAddress("192.168.1.20:8096"), "http://192.168.1.20:8096");
  assert.equal(asAddress("https://media.example/jellyfin/"), "https://media.example/jellyfin");
  assert.equal(asAddress("HTTP://Jellyfin.local:8096/"), "http://jellyfin.local:8096");
  for (const typed of ["ftp://media.example", "file:///etc/passwd", "javascript:alert(1)", "http://me:secret@media.example", "http://media.example/?x=1", "http://", "two words"]) {
    assert.equal(asAddress(typed), null, typed);
  }
});

test("an app's own setup, from its tile: its fields, then the sign-in, past the PIN once there is one", async () => {
  const box = await startBox();
  const call = async (method: string, path: string, body?: unknown, grant?: string) => {
    const response = await fetch(`${box.url}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.deepEqual((await call("GET", "/api/apps/someone.radio/setup")).data.setup, {
      id: "someone.radio",
      name: "Radio",
      fields: [{ key: "serverUrl", label: "Server address", value: "", address: true }],
      signIn: true,
    });
    assert.equal((await call("GET", "/api/apps/agentv.nothing/setup")).status, 404);
    for (const [values, why] of [
      [{ serverUrl: "ftp://media.example" }, "server address is an address like http://192.168.1.20:8096"],
      [{ serverUrl: "  " }, "server address is up to 500 characters, and not empty"],
      [{ password: "hunter2" }, "radio has no field called password"],
      [["serverUrl"], "send the fields to fill in"],
    ] as const) {
      assert.deepEqual(await call("POST", "/api/apps/someone.radio/setup", { values }), { status: 400, data: { ok: false, error: why } });
    }
    assert.equal((await call("POST", "/api/apps/agentv.nothing/setup", { values: { serverUrl: "media.example" } })).status, 404);

    // With a PIN, it needs the PIN: it says where the app goes.
    assert.equal((await call("PUT", "/api/pin", { pin: "4826" })).status, 200);
    assert.equal((await call("POST", "/api/apps/someone.radio/setup", { values: { serverUrl: "192.168.1.20:8096/" } })).status, 403);
    const grant = (await call("POST", "/api/pin/check", { pin: "4826" })).data.grant as string;
    const saved = await call("POST", "/api/apps/someone.radio/setup", { values: { serverUrl: "192.168.1.20:8096/" } }, grant);
    assert.equal(saved.status, 200);
    assert.equal(saved.data.setup.fields[0].value, "http://192.168.1.20:8096");

    // Set up: the tile no longer says so, the app can reach its server, and
    // it opens there.
    const radio = (await call("GET", "/api/home")).data.apps.find((app: any) => app.id === "someone.radio");
    assert.equal(radio.needsSetup, false);
    assert.deepEqual(radio.reach, ["192.168.1.20:8096"]);
    assert.equal((await call("GET", "/api/apps/someone.radio/launch")).data.url, "http://192.168.1.20:8096/web/");
    assert.deepEqual(JSON.parse(readFileSync(join(box.state, "app-settings.json"), "utf8"))["someone.radio"], { serverUrl: "http://192.168.1.20:8096" });
  } finally {
    await box.daemon.close();
  }
});

test("ADR-039 an app installed or removed from the command line shows on the TV at once", async () => {
  const box = await startBox();
  const built = mkdtempSync(join(tmpdir(), "agentv-built-"));
  try {
    cpSync(join(box.apps, "local.mytv"), built, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(built, "manifest.json"), "utf8"));
    writeFileSync(join(built, "manifest.json"), JSON.stringify({ ...manifest, id: "local.built", name: "Built" }));
    const ids = async () => ((await (await fetch(`${box.url}/api/home`)).json()).apps as { id: string }[]).map((app) => app.id);
    assert.ok(!(await ids()).includes("local.built"));

    // The TV hears of it, as agentv app install --local and remove do it.
    const heard = async (change: () => Promise<unknown>): Promise<string> => {
      const events = await fetch(`${box.url}/api/events`);
      const reader = events.body!.getReader();
      await change();
      let seen = "";
      const deadline = Date.now() + 3000;
      while (!seen.includes("event: apps") && Date.now() < deadline) {
        const { value } = await Promise.race([reader.read(), new Promise<{ value: undefined }>((r) => setTimeout(() => r({ value: undefined }), 500))]);
        if (value) seen += new TextDecoder().decode(value);
      }
      await reader.cancel();
      return seen;
    };
    assert.match(await heard(() => installLocal(built, box.apps, async () => true)), /event: apps/);
    assert.ok((await ids()).includes("local.built"), "the new app is in Apps");
    assert.match(await heard(() => removeApp("local.built", box.apps)), /event: apps/);
    assert.ok(!(await ids()).includes("local.built"), "and gone again once it's removed");
  } finally {
    rmSync(built, { recursive: true, force: true });
    await box.daemon.close();
  }
});
