// Where the box is, as far as the built-in apps need to know (ADR-015): the
// time zone chosen in Omarchy's installer, and that zone's own city from the
// tz database's zone.tab, with its coordinates. Weather sends those, rounded,
// to MET Norway; Clock shows the city. Settings → Weather can pick another
// zone's city instead. Nothing here reaches the network.

import { readFile, readlink } from "node:fs/promises";

export interface City {
  zone: string; // "Europe/Amsterdam"
  name: string; // "amsterdam", as the tiles write it
  country: string; // "NL"
  lat: number;
  lon: number;
}

// Countries that write the temperature in Fahrenheit: the United States and
// the places that follow it.
const FAHRENHEIT = new Set(["US", "PR", "GU", "VI", "AS", "MP", "UM", "LR", "PW", "FM", "MH", "KY", "BS", "BZ"]);

// zone.tab writes a place as ±DDMM±DDDMM or ±DDMMSS±DDDMMSS (ISO 6709).
function coordinate(text: string, degreeDigits: number): number {
  const sign = text.startsWith("-") ? -1 : 1;
  const digits = text.slice(1);
  const degrees = Number(digits.slice(0, degreeDigits));
  const minutes = Number(digits.slice(degreeDigits, degreeDigits + 2));
  const seconds = Number(digits.slice(degreeDigits + 2) || 0);
  return sign * (degrees + minutes / 60 + seconds / 3600);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function cityName(zone: string): string {
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ").toLowerCase();
}

// Every city in zone.tab, by zone.
export function parseZoneTab(text: string): Map<string, City> {
  const cities = new Map<string, City>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [country, place, zone] = line.split("\t");
    const match = /^([+-]\d{4}(?:\d{2})?)([+-]\d{5}(?:\d{2})?)$/.exec(place ?? "");
    if (!country || !zone || !match) continue;
    cities.set(zone, {
      zone,
      name: cityName(zone),
      country: country.split(",")[0],
      lat: round(coordinate(match[1], 2)),
      lon: round(coordinate(match[2], 3)),
    });
  }
  return cities;
}

// AGENTV_ZONE_TAB and AGENTV_LOCALTIME stand in for the system's, in tests.
const tabs = new Map<string, Promise<Map<string, City>>>();

export function cities(): Promise<Map<string, City>> {
  const path = process.env.AGENTV_ZONE_TAB ?? "/usr/share/zoneinfo/zone.tab";
  if (!tabs.has(path)) tabs.set(path, readFile(path, "utf8").then(parseZoneTab, () => new Map()));
  return tabs.get(path)!;
}

// The box's time zone, from /etc/localtime, which Omarchy's installer links
// to the zone it was given. UTC when there's none.
export async function boxZone(): Promise<string> {
  const target = await readlink(process.env.AGENTV_LOCALTIME ?? "/etc/localtime").catch(() => "");
  const match = /zoneinfo\/(.+)$/.exec(target);
  return match ? match[1].replace(/^(posix|right)\//, "") : "UTC";
}

export async function cityOf(zone: string): Promise<City | null> {
  return (await cities()).get(zone) ?? null;
}

export function units(city: City | null): "c" | "f" {
  return city && FAHRENHEIT.has(city.country) ? "f" : "c";
}

// What a built-in app gets as its settings for a place: its name, its
// coordinates, its time zone and its units. A zone with no city in zone.tab,
// such as UTC, has a time zone and nothing else.
export function placeSettings(zone: string, city: City | null, unit?: "c" | "f"): Record<string, string> {
  const settings: Record<string, string> = { timeZone: zone, units: unit ?? units(city) };
  if (city) Object.assign(settings, { place: city.name, lat: String(city.lat), lon: String(city.lon) });
  return settings;
}
