// Setup's location step (ADR-059, Q167, Q199): where the TV is, started from
// the phone's own time zone, which the captive page and the companion send.
// The step confirms a country, and only a country whose time zones really
// differ asks which one, unless the phone's zone is in it.
//
// A country's zones are the tz database's own (zone.tab), grouped by what
// the clock does: the same offset in January and in July and the same name
// are one choice. So Germany's two zones, or Argentina's twelve, are one,
// and the United States' are a handful. Each choice is the zone most of its
// people live in (MAIN), or the one zone.tab lists first, which the tz
// database keeps for the most populous.

import { countryOf, MAIN } from "./country.ts";
import { cities, cityName } from "./place.ts";

// One time zone to choose from: its tz name, what it's called in English
// ("eastern"), and its city ("new york").
export interface ZoneChoice {
  zone: string;
  name: string;
  city: string;
}

// Where the step starts: the country, as the headline says it ("the
// netherlands"), the zone that "yes" keeps, and whether that came from the
// phone or from the box's own zone.
export interface Start {
  code: string;
  name: string;
  called: string;
  zone: string;
  from: "phone" | "box";
}

// Countries whose names take "the" in a sentence, as the tz database spells
// them.
const THE = new Set(["AE", "BS", "CC", "CD", "CF", "CG", "CK", "CZ", "DO", "FK", "FO", "GM", "KM", "KY", "MH", "MP", "MV", "NL", "PH", "SB", "SC", "TC", "UM", "US", "VA", "VG", "VI"]);

// "the netherlands", "norway": as the TV says it.
export function called(code: string, name: string): string {
  return `${THE.has(code) ? "the " : ""}${name.toLowerCase()}`;
}

// How many, in a sentence: "six", or 14.
export function count(n: number): string {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"][n] ?? String(n);
}

function part(zone: string, at: Date, style: "longGeneric" | "longOffset"): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: style }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
}

// "Eastern Time" and "Mountain Standard Time" as "eastern" and "mountain".
function zoneName(zone: string): string {
  return part(zone, new Date(), "longGeneric")
    .replace(/ (standard )?time$/i, "")
    .toLowerCase();
}

// What the clock does in a zone: its offsets in January and July, and its
// name. Zones with the same are one choice.
function clockOf(zone: string, year: number): string {
  return [part(zone, new Date(Date.UTC(year, 0, 15)), "longOffset"), part(zone, new Date(Date.UTC(year, 6, 15)), "longOffset"), zoneName(zone)].join("|");
}

// A zone's tz name, as ICU knows it, so a phone's "Asia/Calcutta" and
// zone.tab's "Asia/Kolkata" are the same zone.
function canonical(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

// The zone a phone sent, as zone.tab names it, or as sent when zone.tab has
// no such zone (UTC, say). Null when it isn't a time zone at all.
export async function phoneZone(zone: unknown): Promise<string | null> {
  if (typeof zone !== "string" || zone.length > 64 || !ZONE.test(zone)) return null;
  const known = await cities();
  if (known.has(zone)) return zone;
  const wanted = canonical(zone);
  if (!wanted) return null;
  for (const name of known.keys()) if (canonical(name) === wanted) return name;
  return wanted;
}

// The country a zone is in, by zone.tab.
async function countryOfZone(zone: string): Promise<string | null> {
  return (await cities()).get(zone)?.country ?? null;
}

// Every zone zone.tab lists for a country, in its order.
async function zonesOf(code: string): Promise<string[]> {
  return [...(await cities()).values()].filter((city) => city.country === code).map((city) => city.zone);
}

// The time zones a country's people choose from: one for each different
// clock, in zone.tab's order.
export async function zoneChoices(code: string, now = new Date()): Promise<ZoneChoice[]> {
  const groups = new Map<string, string[]>();
  for (const zone of await zonesOf(code)) {
    const key = clockOf(zone, now.getUTCFullYear());
    groups.set(key, [...(groups.get(key) ?? []), zone]);
  }
  return [...groups.values()].map((zones) => {
    const zone = zones.includes(MAIN[code]) ? MAIN[code] : zones[0];
    return { zone, name: zoneName(zone), city: cityName(zone) };
  });
}

// Where the step starts: the phone's zone's country, or else the country
// the box already has (one picked before, or its own zone's). Null when
// neither has one, as for a box in UTC with no phone yet: then it's a pick.
export async function startOn(phone: string | null, box: { code: string | null; zone: string }): Promise<Start | null> {
  const fromPhone = phone ? await countryOfZone(phone) : null;
  const code = fromPhone ?? box.code;
  const country = code ? await countryOf(code) : null;
  if (!country) return null;
  const zones = await zonesOf(country.code);
  const zone = fromPhone && phone ? phone : zones.includes(box.zone) ? box.zone : ((await zoneChoices(country.code))[0]?.zone ?? box.zone);
  return { code: country.code, name: country.name, called: called(country.code, country.name), zone, from: fromPhone ? "phone" : "box" };
}

// The zone a country picked sets, or the zones to ask about: the one picked
// on the zone question; the phone's, when it's in that country; the box's
// own, when it is; the country's one clock; or, for a country whose zones
// differ, a question.
export async function decide(code: unknown, zone: unknown, phone: string | null, box: string): Promise<{ zone: string } | { ask: ZoneChoice[]; code: string; name: string; called: string } | { error: string }> {
  const country = typeof code === "string" ? await countryOf(code) : null;
  if (!country) return { error: "a country is two capital letters the tz database knows, such as NO" };
  const zones = await zonesOf(country.code);
  if (zone !== undefined && zone !== null) {
    if (typeof zone !== "string" || !zones.includes(zone)) return { error: `that isn't one of ${called(country.code, country.name)}'s time zones` };
    return { zone };
  }
  if (phone && zones.includes(phone)) return { zone: phone };
  if (zones.includes(box)) return { zone: box };
  const choices = await zoneChoices(country.code);
  if (choices.length === 1) return { zone: choices[0].zone };
  if (choices.length === 0) return { error: `${called(country.code, country.name)} has no time zone of its own` };
  return { ask: choices, code: country.code, name: country.name, called: called(country.code, country.name) };
}
