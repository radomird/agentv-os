// Setup's location step (ADR-059, Q167, Q199): it starts on the country of
// the phone's own time zone, a country's zones are grouped by what the clock
// does there, and a country whose zones differ asks which one, unless the
// phone's zone is in it. The tz database's tables are the tests' few lines
// of them.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { called, count, decide, phoneZone, startOn, zoneChoices } from "../../../daemon/location.ts";
import { Daemon } from "../../../daemon/server.ts";

const ROOT = join(import.meta.dirname, "../../..");
process.env.AGENTV_ZONE_TAB = join(ROOT, "test/agentv/fixtures/met/zone.tab");
process.env.AGENTV_ISO3166_TAB = join(ROOT, "test/agentv/fixtures/met/iso3166.tab");

test("T7.1 a country's time zones are one choice for each different clock, each with its city", async () => {
  assert.deepEqual(await zoneChoices("US"), [
    { zone: "America/New_York", name: "eastern", city: "new york" },
    { zone: "America/Chicago", name: "central", city: "chicago" },
    { zone: "America/Denver", name: "mountain", city: "denver" },
    { zone: "America/Phoenix", name: "mountain", city: "phoenix" },
    { zone: "America/Los_Angeles", name: "pacific", city: "los angeles" },
    { zone: "Pacific/Honolulu", name: "hawaii-aleutian", city: "honolulu" },
  ]);
  assert.deepEqual(await zoneChoices("DE"), [{ zone: "Europe/Berlin", name: "central european", city: "berlin" }], "Busingen keeps Berlin's clock, so Germany is one");
  assert.deepEqual(await zoneChoices("NO"), [{ zone: "Europe/Oslo", name: "central european", city: "oslo" }]);
  assert.deepEqual(await zoneChoices("AQ"), []);
});

test("the phone's time zone, as zone.tab names it, or as ICU does, and nothing that isn't a zone", async () => {
  assert.equal(await phoneZone("Europe/Amsterdam"), "Europe/Amsterdam");
  assert.equal(await phoneZone("US/Pacific"), "America/Los_Angeles", "an old name for a zone zone.tab lists");
  assert.equal(await phoneZone("UTC"), "UTC");
  for (const junk of ["Mars/Olympus_Mons", "../../etc/passwd", "", 42, null, "a".repeat(80)]) assert.equal(await phoneZone(junk), null, String(junk));
});

test("T7.1 the step starts on the phone's zone's country, else the box's, else on a pick", async () => {
  assert.deepEqual(await startOn("America/Chicago", { code: null, zone: "UTC" }), { code: "US", name: "United States", called: "the united states", zone: "America/Chicago", from: "phone" });
  assert.deepEqual(await startOn("Europe/Amsterdam", { code: "NO", zone: "Europe/Oslo" }), { code: "NL", name: "Netherlands", called: "the netherlands", zone: "Europe/Amsterdam", from: "phone" });
  assert.deepEqual(await startOn(null, { code: "NO", zone: "Europe/Oslo" }), { code: "NO", name: "Norway", called: "norway", zone: "Europe/Oslo", from: "box" });
  assert.deepEqual(await startOn("UTC", { code: "NO", zone: "Europe/Oslo" }), { code: "NO", name: "Norway", called: "norway", zone: "Europe/Oslo", from: "box" }, "a phone in UTC says nothing of where it is");
  assert.equal(await startOn(null, { code: null, zone: "UTC" }), null);
});

test("Q167 a country picked keeps the phone's zone or the box's when it's in it, takes its one clock, or asks", async () => {
  assert.deepEqual(await decide("US", undefined, "America/Chicago", "UTC"), { zone: "America/Chicago" }, "the phone's zone is in it, so nothing is asked");
  assert.deepEqual(await decide("US", undefined, null, "America/Denver"), { zone: "America/Denver" }, "the box's own zone is in it");
  const asked = await decide("US", undefined, "Europe/Amsterdam", "UTC");
  assert.ok("ask" in asked);
  assert.deepEqual([asked.code, asked.called, asked.ask.length], ["US", "the united states", 6]);
  assert.deepEqual(await decide("US", "America/Phoenix", "Europe/Amsterdam", "UTC"), { zone: "America/Phoenix" }, "the zone picked on the question");
  assert.deepEqual(await decide("DE", undefined, null, "UTC"), { zone: "Europe/Berlin" }, "one clock, so no question");
  assert.deepEqual(await decide("NL", undefined, "America/Chicago", "UTC"), { zone: "Europe/Amsterdam" });
  assert.match((await decide("US", "Europe/Oslo", null, "UTC") as { error: string }).error, /isn't one of the united states's time zones/);
  assert.match((await decide("XX", undefined, null, "UTC") as { error: string }).error, /two capital letters/);
});

test("how the step says a country and a number", () => {
  assert.deepEqual([called("NL", "Netherlands"), called("NO", "Norway"), called("GB", "Britain (UK)")], ["the netherlands", "norway", "britain (uk)"]);
  assert.deepEqual([count(2), count(6), count(12), count(14)], ["two", "six", "twelve", "14"]);
});

// The routes, on a daemon whose time zone root moves when it's handed one.
const scratch = mkdtempSync(join(tmpdir(), "agentv-location-"));
let daemon: Daemon;
let url = "";
let lanUrl = "";
let captiveUrl = "";
let zone = "UTC";
let root: ReturnType<typeof setInterval>;

before(async () => {
  const state = join(scratch, "state");
  daemon = new Daemon({
    root: ROOT,
    state,
    port: 0,
    log: () => {},
    builtins: null,
    lanPort: 0,
    lanHost: "127.0.0.1",
    address: () => "127.0.0.1",
    setupPort: 0,
    setupHost: "127.0.0.1",
    hotspotAddress: "127.0.0.1",
    hotspotRun: join(scratch, "hotspot"),
    country: { zone: async () => zone, waitMs: 2000 },
  });
  url = `http://127.0.0.1:${await daemon.listen()}`;
  lanUrl = `http://127.0.0.1:${daemon.lanPort}`;
  captiveUrl = `http://127.0.0.1:${daemon.setupPort}`;
  const drop = join(state, "zone-drop", "zone.json");
  root = setInterval(() => {
    if (!existsSync(drop)) return;
    zone = (JSON.parse(readFileSync(drop, "utf8")) as { zone: string }).zone;
    rmSync(drop);
  }, 20);
});

after(async () => {
  clearInterval(root);
  await daemon.close();
  rmSync(scratch, { recursive: true, force: true });
});

const send = (base: string, method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("T7.1 the captive page sends the phone's zone, and the location step starts on its country", async () => {
  assert.equal((await (await fetch(`${url}/api/setup/location`)).json()).start, null, "a box in UTC with no phone yet: a pick");
  assert.equal((await send(captiveUrl, "POST", "/api/setup/zone", { zone: "Mars/Base" })).status, 400);
  assert.equal((await send(captiveUrl, "POST", "/api/setup/zone", { zone: "America/Chicago" })).status, 200);
  const where = await (await fetch(`${url}/api/setup/location`)).json();
  assert.deepEqual(where.start, { code: "US", name: "United States", called: "the united states", zone: "America/Chicago", from: "phone" });
  assert.ok(where.countries.some((c: { code: string }) => c.code === "NL"));
  assert.equal((await send(captiveUrl, "POST", "/api/setup/location", {})).status, 404, "the captive page only sends the zone");
});

test("T7.1 yes keeps the phone's zone, and another country with several zones asks which one", async () => {
  const yes = await (await send(url, "PUT", "/api/setup/location", { code: "US" })).json();
  assert.deepEqual([yes.location.code, yes.location.zone, zone], ["US", "America/Chicago", "America/Chicago"]);

  // A box back in UTC, with a phone in Amsterdam: nothing to go on in the US.
  zone = "UTC";
  await send(captiveUrl, "POST", "/api/setup/zone", { zone: "Europe/Amsterdam" });
  const asked = await (await send(url, "PUT", "/api/setup/location", { code: "US" })).json();
  assert.deepEqual([asked.ask.called, asked.ask.zones.map((z: { city: string }) => z.city)], ["the united states", ["new york", "chicago", "denver", "phoenix", "los angeles", "honolulu"]]);
  assert.equal(zone, "UTC", "nothing moves until a zone is picked");
  const picked = await (await send(url, "PUT", "/api/setup/location", { code: "US", zone: "America/Phoenix" })).json();
  assert.deepEqual([picked.location.zone, zone], ["America/Phoenix", "America/Phoenix"]);
  const zones = await (await fetch(`${url}/api/setup/zones?code=DE`)).json();
  assert.deepEqual(zones.zones.map((z: { zone: string }) => z.zone), ["Europe/Berlin"]);
});

test("a paired phone sends its zone, picks the location, and the TV's step moves on", async () => {
  await send(url, "POST", "/api/setup/finish", { step: "welcome" });
  await send(url, "POST", "/api/setup/ready", { update: "none" });
  await send(url, "POST", "/api/setup/finish", { step: "ready" });
  await send(url, "POST", "/api/setup/finish", { step: "box" });
  const code = (await (await send(url, "POST", "/api/phones/pair", {})).json()).pairing.code;
  const paired = await (await send(lanUrl, "POST", "/api/phone/pair", { code, name: "pixel" })).json();
  const auth = { Authorization: `Bearer ${paired.token}` };
  assert.equal((await send(lanUrl, "POST", "/api/phone/zone", { zone: "Europe/Oslo" }, auth)).status, 200);
  const where = await (await fetch(`${lanUrl}/api/phone/location`, { headers: auth })).json();
  assert.equal(where.start.called, "norway");
  const set = await (await send(lanUrl, "PUT", "/api/phone/location", { code: "NO" }, auth)).json();
  assert.deepEqual([set.location.zone, set.setup.step], ["Europe/Oslo", "ai"]);
  assert.equal((await send(lanUrl, "POST", "/api/phone/zone", { zone: "Europe/Oslo" })).status, 401, "only a paired phone");
});
