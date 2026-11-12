// AgenTV's built-in apps in the daemon (daemon/home.ts, daemon/place.ts):
// Clock, Music, New this week and Weather come with AgenTV and say so in
// their details; Clock and Weather are pinned to each viewer's home once,
// New this week too, large, for a streaming household, take where the box
// is from its time zone, and Settings → Weather can pick another city
// (ADR-015, ADR-016, ADR-017, S3.8, S8.1).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, ROOT, startBox } from "../ui/box.mts";
import { startMet, type Met } from "../ui/met.mts";

// daemon/weather-check.ts, as agentv selftest runs it, against this box and
// a forecast at forecast. It asks MET again every 20 ms for up to 600 ms
// here, where the box asks every 15 s for up to 2 minutes.
function weatherCheck(id: string, forecast: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...process.execArgv.filter((arg) => arg === "--experimental-strip-types"), "--disable-warning=ExperimentalWarning", join(ROOT, "daemon/weather-check.ts"), id],
      {
        env: {
          ...process.env,
          AGENTV_HOME_URL: `${url}/`,
          AGENTV_MET_URL: forecast,
          AGENTV_PATH: ROOT,
          AGENTV_MET_AGAIN_MS: "20",
          AGENTV_MET_FOR_MS: "600",
          ...env,
        },
      },
      (_error, stdout, stderr) => resolve(`${stdout}${stderr}`),
    );
  });
}

let daemon: Daemon;
let url = "";
let apps = "";
let state = "";
let met: Met;

before(async () => {
  met = await startMet();
  ({ daemon, url, apps, state } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", forecast: met.url }));
});

after(async () => {
  await daemon.close();
  met.close();
});

async function get(path: string): Promise<any> {
  return (await fetch(`${url}${path}`)).json();
}

// Home as it ships, with the looks on, then with them turned off, which is
// how home was before them: Clock pinned and the all apps tile last.
async function withLooksOff(check: () => Promise<void>): Promise<void> {
  const looks = (on: boolean) => fetch(`${url}/api/features`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ looks: on }) });
  assert.equal((await looks(false)).status, 200);
  try {
    await check();
  } finally {
    await looks(true);
  }
}

async function post(path: string, body: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

test("Clock, Music, New this week and Weather come with AgenTV, first, and their details say they're built in", async () => {
  const home = await get("/api/home");
  assert.deepEqual(home.apps.slice(0, 4).map((app: any) => app.id), ["agentv.clock", "agentv.music", "agentv.new", "agentv.weather"]);
  const [clock, music, news, weather] = home.apps;
  for (const app of [clock, music, news, weather]) {
    assert.equal(app.tier, "built-in");
    assert.equal(app.maker, "Built in");
    assert.equal(app.owner, undefined);
    assert.equal(app.needsSetup, false);
    assert.equal(app.icon, `/api/apps/${app.id}/icon`);
  }
  assert.deepEqual(clock.sizes.map((s: any) => `${s.size} ${s.label}`), ["s time", "m time and date"]);
  assert.deepEqual(weather.sizes.map((s: any) => `${s.size} ${s.label}`), ["s now", "m today and tomorrow", "l 7 days"]);
  assert.equal(weather.credit, "Weather data from MET Norway, under CC BY 4.0");
  assert.deepEqual(weather.reach, ["127.0.0.1:" + new URL(met.url).port]);
  assert.deepEqual(clock.reach, ["Nothing online"]);
  // New this week is TMDB's, through the daemon (S8.1), and credits TMDB and
  // JustWatch as their terms ask.
  assert.deepEqual(news.sizes.map((s: any) => `${s.size} ${s.label}`), ["s logo", "m new this week", "l new this week"]);
  assert.equal(news.credit, "This product uses the TMDB API but is not endorsed or certified by TMDB. Where to watch is from JustWatch.");
  assert.equal(news.category, "utility", "the router never hears of it as something to play");
  assert.equal(news.forChildren, true);
  assert.deepEqual(music.sizes.map((s: any) => `${s.size} ${s.label}`), ["s logo", "m now playing", "l now playing and recent"]);
  assert.equal(music.category, "music");
  assert.deepEqual(music.reach, ["Nothing online"]);
});

test("on a new box Weather is on home first, pinned small, Clock too with the looks off, and Music waits in apps", async () => {
  const layout = (await get("/api/home")).layout;
  // The looks show the time themselves, so Clock waits in apps.
  assert.deepEqual(layout[0], { id: "agentv.weather", size: "s", x: 0, y: 0 });
  assert.ok(!layout.some((tile: any) => tile.id === "agentv.clock"));
  assert.ok(!layout.some((tile: any) => tile.id === "agentv.music"));
  assert.ok(!layout.some((tile: any) => tile.id === "agentv.new"), "New this week waits in apps unless the TV is for streaming");
  await withLooksOff(async () => {
    const before = (await get("/api/home")).layout;
    assert.deepEqual(before.slice(0, 2), [
      { id: "agentv.clock", size: "s", x: 0, y: 0 },
      { id: "agentv.weather", size: "s", x: 1, y: 0 },
    ]);
    assert.ok(!before.some((tile: any) => tile.id === "agentv.music"));
  });
});

test("S8.1 a streaming household's home gets New this week once, at the largest size that fits, and its tile says what it needs", async () => {
  const viewer = (await get("/api/home")).viewer.id;
  // The box's own files, as they were, put back after.
  const kept = ["setup.json", "layouts.json", "builtins-pinned.json"].map((name) => {
    try {
      return { name, text: readFileSync(join(state, name), "utf8") };
    } catch {
      return { name, text: null };
    }
  });
  try {
    const fresh = () => {
      writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true, goal: "streaming" }));
      writeFileSync(join(state, "builtins-pinned.json"), "{}");
      writeFileSync(join(state, "layouts.json"), "{}");
    };
    // The built-ins in their order, New this week large first, then Weather.
    fresh();
    assert.deepEqual((await get("/api/home")).layout.slice(0, 2), [
      { id: "agentv.new", size: "l", x: 0, y: 0 },
      { id: "agentv.weather", size: "s", x: 2, y: 0 },
    ]);
    // On a saved home with only a medium's room left, it's medium. The
    // looks take the all apps tile off, which leaves room at the start of
    // the last row.
    const saved = () => {
      writeFileSync(join(state, "builtins-pinned.json"), JSON.stringify({ [viewer]: ["agentv.clock", "agentv.weather"] }));
      const full = [{ id: "agentv.sample", x: 0, y: 0, size: "l" }, { id: "agentv.clock", x: 2, y: 0, size: "m" }, { id: "agentv.weather", x: 2, y: 1, size: "m" }, { id: "apps", x: 0, y: 2, size: "s" }];
      writeFileSync(join(state, "layouts.json"), JSON.stringify({ [viewer]: full }));
    };
    saved();
    assert.deepEqual((await get("/api/home")).layout.find((tile: any) => tile.id === "agentv.new"), { id: "agentv.new", size: "m", x: 0, y: 2 });
    await withLooksOff(async () => {
      // With Clock pinned, New this week large between the two.
      fresh();
      assert.deepEqual((await get("/api/home")).layout.slice(0, 3), [
        { id: "agentv.clock", size: "s", x: 0, y: 0 },
        { id: "agentv.new", size: "l", x: 1, y: 0 },
        { id: "agentv.weather", size: "s", x: 3, y: 0 },
      ]);
      saved();
      assert.deepEqual((await get("/api/home")).layout.find((tile: any) => tile.id === "agentv.new"), { id: "agentv.new", size: "m", x: 1, y: 2 });
    });
    // With no TMDB key, its tile says where to add one.
    const tile = await get("/api/tile/agentv.new/l");
    assert.equal(tile.tile.headline.caption, "add a tmdb key in settings → new this week");
  } finally {
    for (const { name, text } of kept) {
      if (text === null) rmSync(join(state, name), { force: true });
      else writeFileSync(join(state, name), text);
    }
  }
});

test("S3.8 the weather tile shows the forecast for the time zone's city, asked for with its coordinates", async () => {
  const { tile } = await get("/api/tile/agentv.weather/s");
  assert.deepEqual(tile.headline, { label: "amsterdam", icon: "wind", value: "12°", caption: "Windy" });
  assert.match(met.seen.at(-1)!.url, /\?lat=52\.37&lon=4\.9$/);
  assert.match(String(met.seen.at(-1)!.headers["user-agent"]), /^AgenTV\/\S+ agentv\.weather\/1\.0\.0$/);
  const clock = await get("/api/tile/agentv.clock/m");
  assert.equal(clock.tile.headline.label, "amsterdam");
});

test("S3.8 S3.9 agentv selftest compares the weather tiles with MET's forecast, fetched again", async () => {
  const now = await weatherCheck("S3.8", met.url);
  assert.match(now, /^pass S3\.8 the tile shows wind at 12° for amsterdam \(52\.37, 4\.9\), as MET's partlycloudy_day with 11\.2 m\/s of wind does/m);
  assert.match(now, /^manual S3\.8 on yr\.no, amsterdam's forecast for now says Windy/m);
  const week = await weatherCheck("S3.9", met.url);
  assert.match(week, /^pass S3\.9 the medium and large weather tiles match MET's forecast for amsterdam/m);
  // Another forecast than the tile's: Oslo's heavy rain.
  const oslo = await startMet("oslo");
  try {
    // Asking again doesn't help a tile that's wrong for every forecast.
    assert.match(await weatherCheck("S3.8", oslo.url), /^fail S3\.8 the tile shows wind for amsterdam .*, but MET says heavyrain.* \(asked MET \d+ times/m);
    assert.match(await weatherCheck("S3.9", oslo.url), /^fail S3\.9 the weather tiles don't match MET for amsterdam.* \(asked MET \d+ times/m);
    assert.ok(Number(/asked MET (\d+) times/.exec(await weatherCheck("S3.9", oslo.url))?.[1]) >= 3, "it asked MET again");
  } finally {
    oslo.close();
  }
});

test("S3.9 agentv selftest compares MET's forecast with tiles drawn from it, not ones kept from before it changed", async () => {
  // Tiles drawn from Amsterdam's forecast and kept, from a reply that said
  // it was good until now: the weather moves to Oslo and back, so the app
  // asks MET again. Then MET's forecast changes, to Oslo's heavy rain.
  met.expiresIn(0);
  await post("/api/weather", { zone: "Europe/Oslo" });
  await get("/api/tile/agentv.weather/s");
  await post("/api/weather", { zone: null });
  for (const size of ["s", "m", "l"]) await get(`/api/tile/agentv.weather/${size}`);
  const kept = (await get("/api/tile/agentv.weather/l")).tile;
  met.serve("oslo");
  try {
    assert.match(await weatherCheck("S3.9", met.url), /^pass S3\.9 the medium and large weather tiles match MET's forecast for amsterdam/m);
    assert.match(await weatherCheck("S3.8", met.url), /^pass S3\.8 the tile shows heavy-rain at /m);
    assert.notDeepEqual((await get("/api/tile/agentv.weather/l")).tile, kept);
  } finally {
    met.serve("amsterdam");
    for (const size of ["s", "m", "l"]) await get(`/api/tile/agentv.weather/${size}?fresh=1`);
    met.expiresIn(30 * 60_000);
  }
  // Without fresh, a tile is the one kept, for up to its refreshMins.
  met.serve("oslo");
  try {
    assert.equal((await get("/api/tile/agentv.weather/s")).tile.headline.icon, "wind");
  } finally {
    met.serve("amsterdam");
  }
});

test("S3.8 S3.9 agentv selftest asks MET again when it hands out another forecast than the one the tiles were drawn from", async () => {
  // The app keeps Amsterdam's forecast for 30 minutes, as MET's Expires
  // says, so tiles drawn again for the check still come from it. Then MET
  // hands out Oslo's for the check's own two fetches, before and after the
  // tiles, and Amsterdam's again after that: 2026-11-01, when a box's large
  // tile had today as partly cloudy, both of the check's fetches had it
  // cloudy, and another box got partly cloudy two minutes later.
  met.expiresIn(30 * 60_000);
  for (const size of ["s", "m", "l"]) await get(`/api/tile/agentv.weather/${size}?fresh=1`);
  const asked = met.seen.length;
  try {
    // Asking only before and after the tiles, as the check did, fails a box
    // whose tiles are right.
    met.serveNext("oslo", "oslo");
    assert.match(await weatherCheck("S3.9", met.url, { AGENTV_MET_FOR_MS: "0" }), /^fail S3\.9 the weather tiles don't match MET for amsterdam/m);
    assert.equal(met.seen.length, asked + 2, "the app kept its forecast, and only the check asked MET");

    // Asking again finds the forecast the tiles were drawn from.
    met.serveNext("oslo", "oslo");
    assert.match(await weatherCheck("S3.9", met.url), /^pass S3\.9 the medium and large weather tiles match MET's forecast for amsterdam/m);
    met.serveNext("oslo", "oslo");
    assert.match(await weatherCheck("S3.8", met.url), /^pass S3\.8 the tile shows wind at 12° for amsterdam/m);
  } finally {
    // The app asks MET again from here on, as the tests after this expect:
    // the weather moves to Oslo and back, with replies that are good until now.
    met.expiresIn(0);
    await post("/api/weather", { zone: "Europe/Oslo" });
    await get("/api/tile/agentv.weather/s");
    await post("/api/weather", { zone: null });
    for (const size of ["s", "m", "l"]) await get(`/api/tile/agentv.weather/${size}?fresh=1`);
    met.expiresIn(30 * 60_000);
  }
});

test("S3.8 S3.9 a forecast MET publishes while the tiles are drawn still matches, since the check asks MET again after", async () => {
  // The check's first ask gets Amsterdam's forecast; the tiles' asks, and
  // the check's second, get Oslo's heavy rain, as when MET publishes a new
  // forecast in between.
  met.expiresIn(0);
  try {
    met.serveAfterNext("oslo");
    assert.match(await weatherCheck("S3.8", met.url), /^pass S3\.8 the tile shows heavy-rain at /m);
    met.serve("amsterdam");
    met.serveAfterNext("oslo");
    assert.match(await weatherCheck("S3.9", met.url), /^pass S3\.9 the medium and large weather tiles match MET's forecast for amsterdam/m);
  } finally {
    met.serve("amsterdam");
    for (const size of ["s", "m", "l"]) await get(`/api/tile/agentv.weather/${size}?fresh=1`);
    met.expiresIn(30 * 60_000);
  }
});

test("Settings → Weather picks another city in the same part of the world, and the units", async () => {
  const place = await get("/api/weather");
  assert.equal(place.zone, "Europe/Amsterdam");
  assert.equal(place.name, "amsterdam");
  assert.equal(place.units, "c");
  assert.equal(place.chosen, false);
  assert.ok(place.cities.every((city: any) => city.zone.startsWith("Europe/")));
  assert.ok(place.cities.some((city: any) => city.name === "oslo"));

  const picked = await post("/api/weather", { zone: "Europe/Oslo" });
  assert.equal(picked.status, 200);
  assert.equal(picked.data.name, "oslo");
  assert.equal(picked.data.chosen, true);
  // The tile asks again at once, for the new city.
  assert.equal((await get("/api/tile/agentv.weather/s")).tile.headline.label, "oslo");
  assert.match(met.seen.at(-1)!.url, /\?lat=59\.92&lon=10\.75$/);
  // Clock stays on the box's own time zone.
  assert.equal((await get("/api/tile/agentv.clock/m")).tile.headline.label, "amsterdam");

  assert.equal((await post("/api/weather", { units: "f" })).data.units, "f");
  assert.equal((await get("/api/tile/agentv.weather/s")).tile.headline.value, "53°");

  for (const bad of [{ zone: "Mars/Olympus_Mons" }, { units: "k" }, "oslo"]) {
    assert.equal((await post("/api/weather", bad)).status, 400);
  }
  const back = await post("/api/weather", { zone: null, units: null });
  assert.deepEqual([back.data.name, back.data.units, back.data.chosen], ["amsterdam", "c", false]);
});

test("a new time zone reaches the tiles at once, and one with no city says where to pick one", async () => {
  const link = process.env.AGENTV_LOCALTIME!;
  const amsterdam = readlinkSync(link);
  try {
    rmSync(link);
    symlinkSync("/usr/share/zoneinfo/UTC", link);
    const { tile } = await get("/api/tile/agentv.weather/s");
    assert.deepEqual(tile.headline, { label: "No city yet", caption: "Pick one in\nSettings" });
    const place = await get("/api/weather");
    assert.equal(place.zone, "UTC");
    assert.equal(place.lat, undefined);
    // UTC has no part of the world, so every city is there to pick.
    assert.ok(place.cities.some((city: any) => city.zone === "America/New_York"));
    assert.ok(place.cities.some((city: any) => city.zone === "Europe/Oslo"));
  } finally {
    rmSync(link);
    symlinkSync(amsterdam, link);
  }
  assert.equal((await get("/api/tile/agentv.weather/s")).tile.headline.label, "amsterdam");
});

test("a box from before gets them on its saved home once, and one the viewer unpins stays off", async () => {
  const viewer = (await get("/api/home")).viewer.id;
  const before = () => {
    writeFileSync(join(state, "builtins-pinned.json"), "{}");
    writeFileSync(
      join(state, "layouts.json"),
      JSON.stringify({ [viewer]: [{ id: "agentv.sample", x: 0, y: 0, size: "l" }, { id: "apps", x: 2, y: 0, size: "s" }] }),
    );
  };
  // With the looks off, Clock and Weather join the all apps tile.
  await withLooksOff(async () => {
    before();
    assert.deepEqual((await get("/api/home")).layout.map((tile: any) => tile.id), ["agentv.sample", "apps", "agentv.clock", "agentv.weather"]);
  });
  // As it ships, the looks take the all apps tile off and show the time
  // themselves, so only Weather joins.
  before();
  const layout = (await get("/api/home")).layout;
  assert.deepEqual(layout.map((tile: any) => tile.id), ["agentv.sample", "agentv.weather"]);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "layouts.json"), "utf8"))[viewer], layout);

  const without = layout.filter((tile: any) => tile.id !== "agentv.weather");
  const response = await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: without }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await get("/api/home")).layout, without);
});

test("an installed app can't pass for a built-in", async () => {
  const record = JSON.parse(readFileSync(join(apps, "installed.json"), "utf8"));
  for (const [id, runtime] of [["agentv.weather", "web"], ["agentv.fake", "builtin"]]) {
    const dir = join(apps, id);
    cpSync(join(ROOT, "test/agentv/fixtures/apps/sample"), dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    manifest.id = id;
    manifest.tv.runtime = runtime;
    if (runtime === "builtin") delete manifest.tv.homeUrl;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "app.ts"), readFileSync(join(dir, "app.ts"), "utf8").replace('id: "agentv.sample"', `id: "${id}"`));
    record[id] = { id, name: id, version: "1.0.0", tier: "official", installedAt: "2026-10-25T12:00:00Z" };
  }
  writeFileSync(join(apps, "installed.json"), JSON.stringify(record));
  const ids = (await get("/api/home")).apps.map((app: any) => app.id);
  assert.equal(ids.filter((id: string) => id === "agentv.weather").length, 1);
  assert.ok(!ids.includes("agentv.fake"));
});

test("the check after an update loads the built-ins too", async () => {
  const { apps: checked } = await get("/api/apps/check");
  const byId = Object.fromEntries(checked.map((app: any) => [app.id, app]));
  assert.equal(byId["agentv.clock"].ok, true);
  assert.equal(byId["agentv.music"].ok, true);
  assert.equal(byId["agentv.weather"].ok, true);
});
