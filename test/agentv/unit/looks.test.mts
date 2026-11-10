// The three looks' plumbing (ADR-063): the look the box is drawn in, and what
// turning the looks on does to home's layout: no all apps tile anywhere, and
// Clock off the home of anyone who never arranged it. The box is on edge, so
// its switches can turn on. And which pictures a look's preview serves itself
// (D3): the seven posters it stands in with, and nothing else.

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Daemon } from "../../../daemon/server.ts";
import { isShowcaseImage, SHOWCASE_APP, showcasePicture } from "../../../launcher/looks/showcase.ts";
import { startBox } from "../ui/box.mts";

let daemon: Daemon;
let url = "";
let state = "";

before(async () => {
  ({ daemon, url, state } = await startBox(0, undefined, { builtins: true }));
  writeFileSync(join(state, "..", "channel"), "edge\n");
});

after(() => daemon.close());

async function get(path: string): Promise<any> {
  return (await fetch(`${url}${path}`)).json();
}

async function send(method: string, path: string, body: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

function looks(on: boolean | null): void {
  const file = join(state, "features.json");
  if (on === null) rmSync(file, { force: true });
  else writeFileSync(file, JSON.stringify({ looks: on }));
}

test("the box is in Terminal until another look is picked, and the TV hears the change", async () => {
  const first = await get("/api/look");
  assert.equal(first.look, "terminal");
  assert.deepEqual(first.looks.map((look: any) => `${look.id} ${look.name} ${look.font}`), ["terminal Terminal JetBrains Mono", "glass Glass Manrope", "cinema Cinema Instrument Sans"]);
  assert.ok(first.looks.every((look: any) => look.line.length > 0 && look.line.length <= 80));

  // The TV's pages hear it on the event stream.
  const controller = new AbortController();
  const events = await fetch(`${url}/api/events`, { signal: controller.signal });
  const reader = events.body!.getReader();
  const heard = (async () => {
    let text = "";
    while (!text.includes("event: look")) text += new TextDecoder().decode((await reader.read()).value);
    return text;
  })();
  const picked = await send("PUT", "/api/look", { look: "glass" });
  assert.equal(picked.status, 200);
  assert.match(await heard, /event: look\ndata: \{"look":"glass"\}/);
  controller.abort();
  assert.equal((await get("/api/look")).look, "glass");
  assert.deepEqual(JSON.parse(readFileSync(join(state, "look.json"), "utf8")), { look: "glass" });

  const wrong = await send("PUT", "/api/look", { look: "apple" });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /terminal, glass, cinema/);
  assert.equal((await get("/api/look")).look, "glass");

  // A look that's gone from the box, as after an update, is Terminal again.
  writeFileSync(join(state, "look.json"), JSON.stringify({ look: "gone" }));
  assert.equal((await get("/api/look")).look, "terminal");
  await send("PUT", "/api/look", { look: "terminal" });
});

test("with the looks off, home keeps its all apps tile and Clock, as before", async () => {
  looks(false);
  const home = await get("/api/home");
  assert.ok(home.layout.some((tile: any) => tile.id === "apps"));
  assert.ok(home.layout.some((tile: any) => tile.id === "agentv.clock"));
});

test("with the looks on, the all apps tile goes and Clock leaves a home nobody arranged", async () => {
  looks(true);
  const home = await get("/api/home");
  const ids = home.layout.map((tile: any) => tile.id);
  assert.ok(!ids.includes("apps"), `no all apps tile: ${ids.join(", ")}`);
  assert.ok(!ids.includes("agentv.clock"), `Clock isn't pinned by default: ${ids.join(", ")}`);
  assert.ok(ids.includes("agentv.weather"), "Weather still is");
  assert.ok(ids.includes("agentv.sample"));
  // Clock is still an app, there to pin.
  assert.ok(home.apps.some((app: any) => app.id === "agentv.clock"));
  looks(null);
});

test("a home someone arranged keeps its Clock, and only loses the all apps tile", async () => {
  looks(false);
  const arranged = [
    { id: "agentv.clock", x: 0, y: 0, size: "m" },
    { id: "agentv.sample", x: 2, y: 0, size: "s" },
    { id: "apps", x: 3, y: 0, size: "s" },
    { id: "agentv.weather", x: 0, y: 1, size: "s" },
  ];
  assert.equal((await send("PUT", "/api/layout", { layout: arranged })).status, 200);
  looks(true);
  assert.deepEqual((await get("/api/home")).layout, arranged.filter((tile) => tile.id !== "apps"));
  // Turning the looks off again, as an edge box can, gives the tile back.
  looks(false);
  assert.deepEqual((await get("/api/home")).layout, arranged);
  looks(null);
});

test("a preview serves only its seven posters itself, on New this week's tile, and everything else goes through the daemon", () => {
  const poster = "/launcher/looks/showcase/poster-sintel.jpg";
  assert.equal(isShowcaseImage(poster), true);
  assert.equal(showcasePicture(SHOWCASE_APP, poster, true), true);
  // An address that climbs out of the folder, or anything else in it, isn't one.
  for (const url of [
    "/launcher/looks/showcase/../../api/apps",
    "/launcher/looks/showcase/poster-sintel.jpg/../../../api/setup",
    "/launcher/looks/showcase/%2e%2e/%2e%2e/api/apps",
    "/launcher/looks/showcase/CREDITS.md",
    "/launcher/looks/showcase/poster-sintel.jpg?x=1",
    "/launcher/looks/showcase/",
  ]) {
    assert.equal(isShowcaseImage(url), false, url);
    assert.equal(showcasePicture(SHOWCASE_APP, url, true), false, url);
  }
  // Home itself never takes one, and no other app's tile does.
  assert.equal(showcasePicture(SHOWCASE_APP, poster, false), false);
  assert.equal(showcasePicture("agentv.sample", poster, true), false);
});
