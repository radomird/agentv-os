// The box's country (ADR-055): one setting, confirmed once in TV setup and
// changed later in Settings, that everything depending on the country
// follows, with nothing else to answer. Before anyone picks, it's the
// country of the time zone Omarchy's installer set, so setup's step is
// usually one press of OK.
//
// - TMDB's region, for New this week and new episodes (daemon/tmdb.ts).
// - The box's time zone, when another country is picked: the installer's
//   zone stays when it's in that country, and otherwise the zone most of
//   the country's people live in (MAIN, Q167), or the first the tz
//   database lists for it. Root sets it (bin/agentv-zone-set, through
//   agentv-zone.path), and Clock, Weather and the TV's own clock follow.
//
// The countries are the tz database's own, from iso3166.tab and zone.tab,
// so nothing here reaches the network.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { boxZone, cities, followZone } from "./place.ts";

export interface Country {
  code: string; // "NO", ISO 3166-1
  name: string; // "Norway", as the tz database writes it
}

export interface CountryState {
  code: string | null; // null when the zone has no country, such as UTC, and none was picked
  name: string | null;
  picked: boolean; // picked in setup or Settings, rather than the zone's
  zone: string; // the box's time zone now
}

// The zone most of a country's people live in, for a country with more than
// one (Q167). A country not here takes the first zone zone.tab lists for it.
export const MAIN: Record<string, string> = {
  AR: "America/Argentina/Buenos_Aires",
  AU: "Australia/Sydney",
  BR: "America/Sao_Paulo",
  CA: "America/Toronto",
  CD: "Africa/Kinshasa",
  CL: "America/Santiago",
  CN: "Asia/Shanghai",
  CY: "Asia/Nicosia",
  DE: "Europe/Berlin",
  EC: "America/Guayaquil",
  ES: "Europe/Madrid",
  GL: "America/Nuuk",
  ID: "Asia/Jakarta",
  KI: "Pacific/Tarawa",
  KZ: "Asia/Almaty",
  MH: "Pacific/Majuro",
  MN: "Asia/Ulaanbaatar",
  MX: "America/Mexico_City",
  MY: "Asia/Kuala_Lumpur",
  NZ: "Pacific/Auckland",
  PF: "Pacific/Tahiti",
  PG: "Pacific/Port_Moresby",
  PT: "Europe/Lisbon",
  RU: "Europe/Moscow",
  UA: "Europe/Kyiv",
  US: "America/New_York",
  UZ: "Asia/Tashkent",
};

// iso3166.tab: a country's two letters, a tab, and its name.
export function parseIso3166(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [code, name] = line.split("\t");
    if (/^[A-Z]{2}$/.test(code ?? "") && name) names.set(code, name.trim());
  }
  return names;
}

// AGENTV_ISO3166_TAB stands in for the system's, in tests.
let names: Promise<Map<string, string>> | null = null;
let namesPath = "";

function countryNames(): Promise<Map<string, string>> {
  const path = process.env.AGENTV_ISO3166_TAB ?? "/usr/share/zoneinfo/iso3166.tab";
  if (!names || namesPath !== path) {
    namesPath = path;
    names = readFile(path, "utf8").then(parseIso3166, () => new Map());
  }
  return names;
}

// Every country with a time zone of its own, by name.
export async function countries(): Promise<Country[]> {
  const all = await countryNames();
  const zoned = new Set([...(await cities()).values()].map((city) => city.country));
  return [...all].filter(([code]) => zoned.has(code)).map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export async function countryOf(code: string): Promise<Country | null> {
  return (await countries()).find((c) => c.code === code) ?? null;
}

// The country a time zone is in, by zone.tab, or null, as for UTC.
export async function zoneCountry(zone: string): Promise<string | null> {
  return (await cities()).get(zone)?.country ?? null;
}

// The time zone a country takes: the one the box has, when it's in that
// country, the zone most of its people live in, or the first zone.tab lists.
export async function zoneFor(code: string, current: string): Promise<string | null> {
  const zones = [...(await cities()).values()].filter((city) => city.country === code).map((city) => city.zone);
  if (zones.includes(current)) return current;
  if (MAIN[code] && zones.includes(MAIN[code])) return MAIN[code];
  return zones[0] ?? null;
}

export interface CountryOptions {
  state: string; // the daemon's state: country.json, and the drop for root
  // How long a pick waits for root to set the time zone.
  waitMs?: number;
  zone?: () => Promise<string>;
  log?: (line: string) => void;
}

export class CountryPlace {
  private o: CountryOptions;
  private path: string;
  readonly drop: string;
  // The box's zone as this daemon last saw it.
  private seen: string | null = null;

  constructor(options: CountryOptions) {
    this.o = options;
    this.path = join(options.state, "country.json");
    this.drop = join(options.state, "zone-drop", "zone.json");
  }

  private zone(): Promise<string> {
    return (this.o.zone ?? boxZone)();
  }

  // The daemon's clock follows the box's zone once it moves, as it does when
  // a country in another zone is picked. Node takes the zone as the daemon
  // starts and keeps it, so what's new's "today" would otherwise stay on the
  // old zone until the daemon restarts.
  private follow(zone: string): void {
    const moved = this.seen !== null && zone !== this.seen;
    this.seen = zone;
    if (moved && followZone(zone)) this.o.log?.(`the daemon's clock follows the time zone to ${zone}`);
  }

  private async saved(): Promise<string | null> {
    const data = await readFile(this.path, "utf8").then((text) => JSON.parse(text) as { code?: unknown }, () => ({}) as { code?: unknown });
    return typeof data.code === "string" && /^[A-Z]{2}$/.test(data.code) ? data.code : null;
  }

  async read(): Promise<CountryState> {
    const zone = await this.zone();
    this.follow(zone);
    const saved = await this.saved();
    const code = saved ?? (await zoneCountry(zone));
    const country = code ? await countryOf(code) : null;
    return { code: country?.code ?? null, name: country?.name ?? null, picked: Boolean(saved), zone };
  }

  // The country picked, in setup or Settings: kept, and the time zone moved
  // to it when the box's isn't in it. Setup's location step can say which
  // of the country's zones (daemon/location.ts). Waits a moment for root to
  // set it.
  async set(code: unknown, wanted?: string): Promise<{ state?: CountryState; error?: string }> {
    const country = typeof code === "string" ? await countryOf(code) : null;
    if (!country) return { error: "a country is two capital letters the tz database knows, such as NO" };
    const before = await this.zone();
    this.follow(before);
    const theirs = wanted ? [...(await cities()).values()].some((city) => city.zone === wanted && city.country === country.code) : false;
    if (wanted && !theirs) return { error: `${wanted} isn't one of ${country.name}'s time zones` };
    const zone = theirs ? wanted! : await zoneFor(country.code, before);
    await mkdir(dirname(this.path), { recursive: true });
    const next = join(dirname(this.path), ".country.json.next");
    await writeFile(next, `${JSON.stringify({ code: country.code, at: new Date().toISOString().replace(/\.\d+Z$/, "Z") })}\n`);
    await rename(next, this.path);
    if (zone && zone !== before) {
      await mkdir(dirname(this.drop), { recursive: true, mode: 0o700 });
      const nextDrop = `${this.drop}.next`;
      await writeFile(nextDrop, `${JSON.stringify({ zone })}\n`, { mode: 0o600 });
      await rename(nextDrop, this.drop);
      this.o.log?.(`the country is ${country.code} now, so the time zone moves from ${before} to ${zone}`);
      const until = Date.now() + (this.o.waitMs ?? 8000);
      while (Date.now() < until && (await this.zone()) !== zone) await new Promise((resolve) => setTimeout(resolve, 200));
      if ((await this.zone()) !== zone) this.o.log?.(`the time zone isn't ${zone} yet; root will set it`);
    } else {
      this.o.log?.(`the country is ${country.code} now, and the time zone stays ${before}`);
    }
    return { state: await this.read() };
  }
}
