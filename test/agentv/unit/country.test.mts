// The box's country (ADR-055): the tz database's countries, the time zone a
// country takes (Q167), the one setting that setup confirms and Settings
// changes, the zone handed to root only when it moves, the daemon's routes
// behind the PIN, and setup's country step, which a box already past it
// skips.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { countries, CountryPlace, MAIN, parseIso3166, zoneFor } from "../../../daemon/country.ts";
import { Daemon } from "../../../daemon/server.ts";
import { Setup, STEPS } from "../../../daemon/setup.ts";

const ROOT = join(import.meta.dirname, "../../..");
process.env.AGENTV_ZONE_TAB = join(ROOT, "test/agentv/fixtures/met/zone.tab");
process.env.AGENTV_ISO3166_TAB = join(ROOT, "test/agentv/fixtures/met/iso3166.tab");
const scratch = mkdtempSync(join(tmpdir(), "agentv-country-"));
// A daemon here follows the zones these tests move it to, through TZ.
const startTZ = process.env.TZ;
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (startTZ === undefined) delete process.env.TZ;
  else process.env.TZ = startTZ;
});

test("the countries are the tz database's, each with a zone of its own, by name", async () => {
  assert.deepEqual([...parseIso3166("# a comment\nNO\tNorway\nnope\tNowhere\n")], [["NO", "Norway"]]);
  const all = await countries();
  assert.ok(!all.some((c) => c.code === "AQ"), "a country with no zone listed isn't offered");
  assert.deepEqual(all.map((c) => c.code), ["GB", "FR", "DE", "JP", "NL", "NZ", "NO", "PT", "RS", "SJ", "US"]);
  assert.equal(all.find((c) => c.code === "GB")?.name, "Britain (UK)");
});

test("Q167 a country keeps the box's zone when it's in it, or takes the zone most of its people live in", async () => {
  assert.equal(await zoneFor("US", "America/Chicago"), "America/Chicago", "the installer's zone stays");
  assert.equal(await zoneFor("US", "Europe/Oslo"), "America/New_York");
  assert.equal(MAIN.US, "America/New_York");
  assert.equal(await zoneFor("NO", "UTC"), "Europe/Oslo", "a country with one zone takes it");
  assert.equal(await zoneFor("AQ", "UTC"), null);
});

// A box whose time zone root moves when it's handed one, as agentv-zone.path
// and agentv-zone-set do.
function box(zone: string) {
  const state = mkdtempSync(join(scratch, "state-"));
  let now = zone;
  const lines: string[] = [];
  const place = new CountryPlace({ state, waitMs: 2000, zone: async () => now, log: (line) => lines.push(line) });
  const root = setInterval(() => {
    if (!existsSync(place.drop)) return;
    now = (JSON.parse(readFileSync(place.drop, "utf8")) as { zone: string }).zone;
    rmSync(place.drop);
  }, 20);
  return { state, place, lines, zone: () => now, stop: () => clearInterval(root) };
}

test("ADR-055 before anyone picks, the country is the time zone's, and UTC has none", async () => {
  const oslo = box("Europe/Oslo");
  const utc = box("UTC");
  try {
    assert.deepEqual(await oslo.place.read(), { code: "NO", name: "Norway", picked: false, zone: "Europe/Oslo" });
    assert.deepEqual(await utc.place.read(), { code: null, name: null, picked: false, zone: "UTC" });
  } finally {
    oslo.stop();
    utc.stop();
  }
});

test("ADR-055 confirming the country keeps the zone, and another one moves it, through root", async () => {
  const b = box("Europe/Oslo");
  try {
    const same = await b.place.set("NO");
    assert.deepEqual(same.state, { code: "NO", name: "Norway", picked: true, zone: "Europe/Oslo" });
    assert.ok(!b.lines.some((line) => line.includes("moves")), "no zone is handed over");
    const moved = await b.place.set("US");
    assert.deepEqual(moved.state, { code: "US", name: "United States", picked: true, zone: "America/New_York" });
    assert.ok(b.lines.some((line) => line === "the country is US now, so the time zone moves from Europe/Oslo to America/New_York"));
    assert.equal(JSON.parse(readFileSync(join(b.state, "country.json"), "utf8")).code, "US");
    assert.deepEqual(await b.place.set("Norway"), { error: "a country is two capital letters the tz database knows, such as NO" });
    assert.deepEqual(await b.place.set("AQ"), { error: "a country is two capital letters the tz database knows, such as NO" });
  } finally {
    b.stop();
  }
});

test("ADR-055 the daemon's country is TMDB's region, and picking another is an adult's, past the PIN", async () => {
  const base = mkdtempSync(join(scratch, "daemon-"));
  mkdirSync(join(base, "root"), { recursive: true });
  let zone = "Europe/Amsterdam";
  const daemon = new Daemon({ root: join(base, "root"), state: join(base, "state"), apps: join(base, "apps"), builtins: null, port: 0, log: () => {}, country: { zone: async () => zone, waitMs: 2000 } });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  const send = async (method: string, path: string, body?: unknown, grant?: string) => {
    const response = await fetch(`${url}${path}`, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
  };
  const drop = join(base, "state", "zone-drop", "zone.json");
  const root = setInterval(() => {
    if (!existsSync(drop)) return;
    zone = (JSON.parse(readFileSync(drop, "utf8")) as { zone: string }).zone;
    rmSync(drop);
  }, 20);
  try {
    const got = await send("GET", "/api/country");
    assert.equal(got.data.code, "NL");
    assert.equal((got.data.countries as { code: string }[]).length, 11);
    assert.equal((await send("GET", "/api/whats-new/settings")).data.region, "NL");
    const set = await send("PUT", "/api/country", { code: "NO" });
    assert.deepEqual([set.status, set.data.code, set.data.zone], [200, "NO", "Europe/Oslo"]);
    assert.equal((await send("GET", "/api/whats-new/settings")).data.region, "NO", "TMDB's region follows");
    assert.equal((await send("PUT", "/api/country", { code: "XX" })).status, 400);
    // With an adult PIN, the country is past it.
    assert.equal((await send("PUT", "/api/pin", { pin: "2468" })).status, 200);
    assert.equal((await send("PUT", "/api/country", { code: "DE" })).status, 403);
    const grant = (await send("POST", "/api/pin/check", { pin: "2468" })).data.grant as string;
    assert.equal((await send("PUT", "/api/country", { code: "DE" }, grant)).data.zone, "Europe/Berlin");
  } finally {
    clearInterval(root);
    await daemon.close();
  }
});

// Kiritimati is 14 hours ahead of UTC and Pago Pago 11 hours behind, so
// their dates are never the same: today has to move.
test("T12.3 after the country moves the zone, the daemon's today follows without a restart", async () => {
  const tabs = mkdtempSync(join(scratch, "tabs-"));
  writeFileSync(join(tabs, "zone.tab"), "KI\t+0152-15720\tPacific/Kiritimati\tLine Islands\nAS\t-1416-17042\tPacific/Pago_Pago\n");
  writeFileSync(join(tabs, "iso3166.tab"), "AS\tSamoa (American)\nKI\tKiribati\n");
  const was = { zones: process.env.AGENTV_ZONE_TAB, iso: process.env.AGENTV_ISO3166_TAB };
  process.env.AGENTV_ZONE_TAB = join(tabs, "zone.tab");
  process.env.AGENTV_ISO3166_TAB = join(tabs, "iso3166.tab");
  // The daemon starts in Kiritimati, as Node takes the box's zone.
  process.env.TZ = "Pacific/Kiritimati";
  const base = mkdtempSync(join(scratch, "daemon-"));
  mkdirSync(join(base, "root"), { recursive: true });
  let zone = "Pacific/Kiritimati";
  const lines: string[] = [];
  const daemon = new Daemon({ root: join(base, "root"), state: join(base, "state"), apps: join(base, "apps"), builtins: null, port: 0, log: (line) => lines.push(line), country: { zone: async () => zone, waitMs: 2000 } });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  const drop = join(base, "state", "zone-drop", "zone.json");
  const root = setInterval(() => {
    if (!existsSync(drop)) return;
    zone = (JSON.parse(readFileSync(drop, "utf8")) as { zone: string }).zone;
    rmSync(drop);
  }, 20);
  const dayIn = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const health = async () => (await (await fetch(`${url}/health`)).json()) as { zone: string };
  try {
    assert.equal((await health()).zone, "Pacific/Kiritimati");
    assert.equal(daemon.news.today(), dayIn("Pacific/Kiritimati"));
    assert.equal((await (await fetch(`${url}/api/country`)).json()).code, "KI");
    const set = await fetch(`${url}/api/country`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "AS" }) });
    assert.equal((await set.json()).zone, "Pacific/Pago_Pago");
    assert.equal((await health()).zone, "Pacific/Pago_Pago", "the daemon's clock follows, with no restart");
    assert.equal(daemon.news.today(), dayIn("Pacific/Pago_Pago"));
    assert.notEqual(daemon.news.today(), dayIn("Pacific/Kiritimati"), "and today moved");
    assert.ok(lines.includes("the daemon's clock follows the time zone to Pacific/Pago_Pago"), lines.join("\n"));
  } finally {
    clearInterval(root);
    await daemon.close();
    process.env.AGENTV_ZONE_TAB = was.zones;
    process.env.AGENTV_ISO3166_TAB = was.iso;
  }
});

test("a zone moved some other way, as from Omarchy's desktop, is followed the next time the daemon reads the country", async () => {
  process.env.TZ = "Europe/Oslo";
  const b = box("Europe/Oslo");
  try {
    await b.place.read();
    assert.equal(process.env.TZ, "Europe/Oslo", "the zone the daemon started in needs nothing");
    mkdirSync(join(b.state, "zone-drop"), { recursive: true });
    writeFileSync(b.place.drop, JSON.stringify({ zone: "America/New_York" }));
    for (let tries = 0; b.zone() !== "America/New_York" && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await b.place.read()).zone, "America/New_York");
    assert.equal(process.env.TZ, "America/New_York");
  } finally {
    b.stop();
  }
});

test("ADR-055 setup confirms the country after getting ready, and a box already past it carries on", async () => {
  assert.deepEqual(STEPS.slice(0, 4), ["welcome", "ready", "country", "ai"]);
  const fresh = new Setup({ path: join(scratch, "fresh", "setup.json") });
  await fresh.finish("welcome");
  await fresh.finish("ready");
  assert.equal((await fresh.read()).step, "country");
  assert.deepEqual(await fresh.finish("ai"), { error: "country isn't finished yet" });
  assert.equal((await fresh.finish("country")).state?.step, "ai");
  // A box on the AI step when an update brought the country step.
  const path = join(scratch, "past", "setup.json");
  mkdirSync(join(scratch, "past"), { recursive: true });
  writeFileSync(path, JSON.stringify({ done: false, step: "ai", finished: { welcome: "2026-11-01T10:00:00Z", ready: "2026-11-01T10:05:00Z" } }));
  const past = new Setup({ path });
  assert.equal((await past.read()).finished.country, "2026-11-01T10:05:00Z");
  assert.equal((await past.finish("ai")).state?.step, "people");
});
