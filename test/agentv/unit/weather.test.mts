// The built-in Weather app (apps/builtin/agentv.weather): MET Norway's symbol
// and the wind to one of ten scenes, the weather now and each day from
// MET's recorded replies, what each tile size shows (S3.8, S3.9), and the
// app in its own worker against a stand-in for MET: an identifying
// User-Agent, rounded coordinates, no request before the forecast expires,
// and the last forecast marked offline when MET can't be reached.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { validatePackage, type Manifest } from "../../../apps/contract/manifest.ts";
import { tileFor } from "../../../apps/builtin/agentv.weather/app.ts";
import { days, degrees, label, now, scene, steps, weekday, WINDY } from "../../../apps/builtin/agentv.weather/met.ts";
import { AppHost } from "../../../daemon/apps/loader.ts";
import { parseZoneTab, placeSettings } from "../../../daemon/place.ts";

const ROOT = join(import.meta.dirname, "../../..");
const WEATHER = join(ROOT, "apps/builtin/agentv.weather");
const viewer = { id: "you", role: "adult" as const };

interface Recorded {
  place: string;
  zone: string;
  recorded: string;
  headers: Record<string, string>;
  body: unknown;
}

function recorded(place: string): Recorded {
  return JSON.parse(readFileSync(join(ROOT, `test/agentv/fixtures/met/${place}.json`), "utf8"));
}

test("S3.8 MET's symbol codes give the ten scenes", () => {
  const cases: [string, string][] = [
    ["clearsky_day", "clear"],
    ["clearsky_polartwilight", "clear"],
    ["clearsky_night", "clear-night"],
    ["fair_day", "partly-cloudy"],
    ["fair_night", "clear-night"],
    ["partlycloudy_day", "partly-cloudy"],
    ["partlycloudy_night", "clear-night"],
    ["cloudy", "cloudy"],
    ["fog", "fog"],
    ["lightrain", "rain"],
    ["rain", "rain"],
    ["rainshowers_day", "rain"],
    ["lightrainshowers_night", "rain"],
    ["heavyrain", "heavy-rain"],
    ["heavyrainshowers_day", "heavy-rain"],
    ["sleet", "snow"],
    ["lightsnow", "snow"],
    ["heavysnowshowers_night", "snow"],
    ["rainandthunder", "thunderstorm"],
    ["heavyrainshowersandthunder_day", "thunderstorm"],
    ["lightssnowshowersandthunder_night", "thunderstorm"],
  ];
  for (const [symbol, expected] of cases) assert.equal(scene(symbol), expected, symbol);
});

test("S3.8 windy comes from the wind speed, at 10.8 m/s and up, and rain, heavy rain, snow and storms keep their own", () => {
  assert.equal(WINDY, 10.8);
  for (const symbol of ["clearsky_day", "clearsky_night", "fair_day", "partlycloudy_night", "cloudy", "fog"]) {
    assert.equal(scene(symbol, 10.8), "wind", symbol);
    assert.notEqual(scene(symbol, 10.7), "wind", symbol);
  }
  assert.equal(scene("rain", 20), "rain");
  assert.equal(scene("heavyrain", 20), "heavy-rain");
  assert.equal(scene("snow", 20), "snow");
  assert.equal(scene("rainandthunder", 20), "thunderstorm");
});

test("MET's symbols in plain words", () => {
  assert.equal(label("clearsky_night"), "clear night");
  assert.equal(label("fair_day"), "fair");
  assert.equal(label("partlycloudy_day"), "partly cloudy");
  assert.equal(label("lightrainshowers_day"), "light rain showers");
  assert.equal(label("heavyrainshowersandthunder_day"), "heavy rain showers and thunder");
  assert.equal(label("lightssleetshowersandthunder_night"), "light sleet showers and thunder");
  assert.equal(label("cloudy", 12), "windy");
});

test("S3.8 the weather now is MET's symbol for the current hour, from recorded replies", () => {
  const cases: [string, string, string, number][] = [
    // place, symbol, scene, temperature
    ["amsterdam", "partlycloudy_day", "wind", 11.6],
    ["oslo", "heavyrain", "heavy-rain", 7],
    ["longyearbyen", "cloudy", "cloudy", 3],
    ["new-york", "clearsky_night", "clear-night", 5],
    ["auckland", "fair_night", "clear-night", 14],
  ];
  for (const [place, symbol, expected, temp] of cases) {
    const reply = recorded(place);
    const found = now(steps(reply.body), new Date(reply.recorded))!;
    assert.equal(found.symbol, symbol, place);
    assert.equal(found.scene, expected, place);
    assert.equal(Math.round(found.temp), Math.round(temp), place);
  }
  // A while into the hour, it's still that hour's step.
  const reply = recorded("amsterdam");
  assert.equal(now(steps(reply.body), new Date("2026-10-25T12:59:00Z"))!.time.toISOString(), "2026-10-25T12:00:00.000Z");
});

test("S3.9 seven days from today, each from the six-hour symbol at local noon, with the day's high and low", () => {
  const reply = recorded("amsterdam");
  const week = days(steps(reply.body), reply.zone, new Date(reply.recorded), 7);
  assert.equal(week.length, 7);
  assert.deepEqual(
    week.map((day) => day.date),
    ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"],
  );
  // Tomorrow: Amsterdam's noon is 11:00 UTC in winter time, and MET's
  // six-hour symbol from then is cloudy; its temperatures run from 10.6 to 13.0.
  assert.deepEqual(
    { symbol: week[1].symbol, scene: week[1].scene, high: week[1].high, low: week[1].low },
    { symbol: "cloudy", scene: "cloudy", high: 13, low: 10.6 },
  );
  // Further out MET steps every six hours: noon's nearest is 12:00 UTC,
  // 13:00 in Amsterdam.
  assert.deepEqual({ symbol: week[5].symbol, high: week[5].high, low: week[5].low }, { symbol: "cloudy", high: 12.9, low: 8.9 });
  // Today counts from now.
  const all = steps(reply.body).filter((step) => step.time.toISOString() >= "2026-10-25T10:00" && step.time.toISOString() < "2026-10-25T23:00");
  assert.equal(week[0].high, Math.max(...all.map((step) => step.temp!)));
});

test("S3.9 days are the place's own: New York's and Auckland's dates are theirs, not UTC's", () => {
  const ny = recorded("new-york");
  // 06:39 in New York: today is the 25th there.
  assert.equal(days(steps(ny.body), ny.zone, new Date(ny.recorded), 7)[0].date, "2026-10-25");
  const auckland = recorded("auckland");
  // 23:39 in Auckland: today is the 25th for twenty more minutes, then
  // the 26th, which MET covers at noon with a six-hour symbol.
  const week = days(steps(auckland.body), auckland.zone, new Date(auckland.recorded), 7);
  assert.equal(week[0].date, "2026-10-25");
  assert.equal(week[1].date, "2026-10-26");
  assert.equal(week[1].symbol, "partlycloudy_day");
});

test("S3.9 a forecast that ends before seven days gives the days it has", () => {
  const reply = recorded("oslo");
  const all = steps(reply.body).slice(0, 30);
  assert.ok(days(all, reply.zone, new Date(reply.recorded), 7).length < 7);
});

test("temperatures in whole degrees, and in Fahrenheit where the country uses it", () => {
  assert.equal(degrees(11.6), "12°");
  assert.equal(degrees(-0.4), "0°");
  assert.equal(degrees(-2.6), "-3°");
  assert.equal(degrees(20, "f"), "68°");
  assert.equal(weekday("2026-10-29"), "thu");
  const tab = parseZoneTab(readFileSync(join(ROOT, "test/agentv/fixtures/met/zone.tab"), "utf8"));
  assert.equal(placeSettings("America/New_York", tab.get("America/New_York")!).units, "f");
  assert.deepEqual(placeSettings("Europe/Amsterdam", tab.get("Europe/Amsterdam")!), {
    timeZone: "Europe/Amsterdam",
    units: "c",
    place: "amsterdam",
    lat: "52.37",
    lon: "4.9",
  });
  assert.deepEqual(placeSettings("UTC", null), { timeZone: "UTC", units: "c" });
});

test("S3.8 S3.9 small shows now, medium today and tomorrow, large now and seven days", () => {
  const reply = recorded("amsterdam");
  const at = new Date(reply.recorded);
  const all = steps(reply.body);
  const place = { name: "amsterdam", lat: 52.37, lon: 4.9, zone: reply.zone, units: "c" as const };
  const current = now(all, at)!;
  const week = days(all, reply.zone, at, 7);

  const s = tileFor("s", place, current, week, false);
  assert.deepEqual(s.headline, { label: "amsterdam", icon: "wind", value: "12°", caption: "windy" });
  assert.deepEqual(s.entries, [{ caption: "h 13° · l 10°" }]);
  assert.equal(s.refreshMins, 30);

  const m = tileFor("m", place, current, week, false);
  assert.equal(m.headline?.label, "amsterdam");
  assert.deepEqual(
    m.entries?.map((entry) => [entry.label, entry.icon, entry.value, entry.caption]),
    [
      ["today", "wind", "12°", "windy\nh 13° · l 10°"],
      ["tomorrow", "cloudy", "13°", "cloudy\nh 13° · l 11°"],
    ],
  );

  const l = tileFor("l", place, current, week, false);
  assert.equal(l.headline?.label, "amsterdam · 7 days");
  assert.equal(l.headline?.icon, "wind");
  assert.deepEqual(
    l.entries?.map((entry) => entry.label),
    ["today", "mon", "tue", "wed", "thu", "fri", "sat"],
  );
  assert.deepEqual(l.entries?.[1], { label: "mon", icon: "cloudy", value: "13°", caption: "11°" });

  assert.equal(tileFor("s", place, current, week, true).headline?.label, "amsterdam · offline");
});

test("Weather and Clock pass the contract's checks as built-ins, and nothing else may be built in", () => {
  for (const name of ["agentv.weather", "agentv.clock"]) {
    const { manifest, problems } = validatePackage(join(ROOT, "apps/builtin", name), "official");
    assert.deepEqual(problems, [], name);
    assert.equal(manifest?.tv.runtime, "builtin");
  }
  const copy = mkdtempSync(join(tmpdir(), "agentv-builtin-"));
  cpSync(WEATHER, copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8"));
  manifest.id = "someone.weather";
  manifest.author = "someone";
  writeFileSync(join(copy, "manifest.json"), JSON.stringify(manifest));
  assert.ok(validatePackage(copy, "community").problems.some((p) => /only AgenTV's own built-in apps/.test(p)));
});

// --- In its worker, against a stand-in for MET ------------------------------

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
}

const seen: Seen[] = [];
let answer: "ok" | "down" = "ok";
const reply = recorded("amsterdam");

// The recorded reply with its steps moved to start this hour, so "now" is
// its first step whenever the test runs.
function shifted(): unknown {
  const body = structuredClone(reply.body) as { properties: { timeseries: { time: string }[] } };
  const first = new Date(body.properties.timeseries[0].time).getTime();
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  for (const step of body.properties.timeseries) step.time = new Date(new Date(step.time).getTime() - first + hour).toISOString();
  return body;
}

const server: Server = createServer((request, response) => {
  seen.push({ url: request.url ?? "", headers: request.headers });
  if (answer === "down") {
    response.writeHead(503).end();
    return;
  }
  if (request.headers["if-modified-since"] === "Sun, 25 Oct 2026 10:30:31 GMT") {
    response.writeHead(304, { Expires: new Date(Date.now() + 60_000).toUTCString() }).end();
    return;
  }
  // Expired already, so each tile asks again, as after half an hour.
  response.writeHead(200, {
    "Content-Type": "application/json",
    Expires: new Date(Date.now() - 1000).toUTCString(),
    "Last-Modified": "Sun, 25 Oct 2026 10:30:31 GMT",
  });
  response.end(JSON.stringify(shifted()));
});
const listening = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
let host: AppHost | undefined;

after(() => {
  host?.stop();
  server.close();
});

async function weatherHost(): Promise<AppHost> {
  const port = await listening;
  const dir = mkdtempSync(join(tmpdir(), "agentv-weather-"));
  cpSync(WEATHER, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  manifest.tv.origins = [`http://127.0.0.1:${port}`];
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return new AppHost({
    dir,
    manifest,
    userAgent: "AgenTV/0.2.0 (+https://example.invalid/agentv-os)",
    settings: {
      place: "amsterdam",
      lat: "52.3666",
      lon: "4.9",
      timeZone: "Europe/Amsterdam",
      units: "c",
      forecastUrl: `http://127.0.0.1:${port}/weatherapi/locationforecast/2.0/compact`,
    },
  });
}

test("S3.8 in its worker, Weather asks MET as AgenTV, with the place rounded, and shows what MET says", async () => {
  host = await weatherHost();
  const started = Date.now();
  const tile = await host.call<{ headline: { label: string; icon: string; value: string } }>(viewer, "tile", "s");
  assert.ok(Date.now() - started < 3000, "it answers within 3 s");
  assert.deepEqual([tile.headline.label, tile.headline.icon, tile.headline.value], ["amsterdam", "wind", "12°"]);
  const first = seen.at(-1)!;
  assert.equal(first.url, "/weatherapi/locationforecast/2.0/compact?lat=52.37&lon=4.9");
  assert.equal(first.headers["user-agent"], "AgenTV/0.2.0 (+https://example.invalid/agentv-os) agentv.weather/1.0.0");
});

test("Weather asks again only after the forecast expires, and says it already has it", async () => {
  const before = seen.length;
  await host!.call(viewer, "tile", "m");
  assert.equal(seen.length, before + 1);
  assert.equal(seen.at(-1)!.headers["if-modified-since"], "Sun, 25 Oct 2026 10:30:31 GMT");
  // MET said 304, and the forecast now keeps for a minute.
  const large = await host!.call<{ entries: unknown[] }>(viewer, "tile", "l");
  assert.equal(seen.length, before + 1);
  assert.ok(large.entries.length >= 5);
});

test("offline, Weather shows the last forecast, marked offline", async () => {
  const fresh = await weatherHost();
  try {
    await fresh.call(viewer, "tile", "s");
    answer = "down";
    // A new worker's forecast expired at once, so it asks and MET is down.
    const tile = await fresh.call<{ headline: { label: string; value: string } }>(viewer, "tile", "s");
    assert.equal(tile.headline.label, "amsterdam · offline");
    assert.equal(tile.headline.value, "12°");
  } finally {
    answer = "ok";
    fresh.stop();
  }
});

test("with no forecast yet and MET unreachable, the tile fails, and the daemon keeps what it had", async () => {
  answer = "down";
  const fresh = await weatherHost();
  try {
    await assert.rejects(fresh.call(viewer, "tile", "s"), /MET Norway answered 503/);
  } finally {
    answer = "ok";
    fresh.stop();
  }
});
