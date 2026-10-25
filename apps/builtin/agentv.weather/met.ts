// MET Norway's Locationforecast, read into what the weather tile shows
// (ADR-015, ADR-016): the weather now, and each day's scene, high and low.
// Nothing here reaches the network; app.ts fetches, and this reads.
//
// The ten scenes come from MET's symbol code, plus the wind: MET has no wind
// symbol, so a wind of at least 10.8 m/s (Beaufort 6) shows windy, except
// that rain, heavy rain, snow and thunderstorms keep their own scenes.

export type Scene =
  | "clear"
  | "clear-night"
  | "partly-cloudy"
  | "cloudy"
  | "rain"
  | "heavy-rain"
  | "snow"
  | "thunderstorm"
  | "wind"
  | "fog";

export const SCENES: Scene[] = ["clear", "clear-night", "partly-cloudy", "cloudy", "rain", "heavy-rain", "snow", "thunderstorm", "wind", "fog"];

export const WINDY = 10.8; // m/s, Beaufort 6

const KEEP_IN_WIND: Scene[] = ["rain", "heavy-rain", "snow", "thunderstorm"];

// The scene for a MET symbol code, like "lightrainshowers_day", and the wind
// speed in m/s at the same time.
export function scene(symbol: string, wind = 0): Scene {
  const [base = "", variant = ""] = symbol.split("_");
  const night = variant === "night";
  let found: Scene;
  if (base.includes("thunder")) found = "thunderstorm";
  else if (base === "heavyrain" || base === "heavyrainshowers") found = "heavy-rain";
  else if (base.includes("snow") || base.includes("sleet")) found = "snow";
  else if (base.includes("rain")) found = "rain";
  else if (base === "fog") found = "fog";
  else if (base === "clearsky") found = night ? "clear-night" : "clear";
  else if (base === "fair" || base === "partlycloudy") found = night ? "clear-night" : "partly-cloudy";
  else found = "cloudy";
  if (wind >= WINDY && !KEEP_IN_WIND.includes(found)) return "wind";
  return found;
}

// MET's symbol in plain words, the way the tile says it: "light rain
// showers", "clear night". Windy says windy.
export function label(symbol: string, wind = 0): string {
  if (scene(symbol, wind) === "wind") return "windy";
  const [base = "", variant = ""] = symbol.split("_");
  if (base === "clearsky") return variant === "night" ? "clear night" : "clear";
  if (base === "partlycloudy") return "partly cloudy";
  // MET spells two of its thunder codes "lightssleet..." and "lightssnow...".
  const words = base
    .replace(/^lights(?=s)/, "light")
    .replace(/andthunder$/, " and thunder")
    .replace(/showers/, " showers")
    .replace(/^(light|heavy)/, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
  return words || "cloudy";
}

export interface Step {
  time: Date;
  temp?: number; // °C
  wind?: number; // m/s
  symbol1?: string; // the next hour
  symbol6?: string; // the next six hours
  symbol12?: string; // the next twelve
}

interface MetStep {
  time?: string;
  data?: {
    instant?: { details?: { air_temperature?: number; wind_speed?: number } };
    next_1_hours?: { summary?: { symbol_code?: string } };
    next_6_hours?: { summary?: { symbol_code?: string } };
    next_12_hours?: { summary?: { symbol_code?: string } };
  };
}

// The forecast's steps, oldest first. Anything that isn't a forecast step
// is left out, so a reply that's half broken still gives what it can.
export function steps(body: unknown): Step[] {
  const series = (body as { properties?: { timeseries?: MetStep[] } })?.properties?.timeseries;
  if (!Array.isArray(series)) return [];
  const found: Step[] = [];
  for (const step of series) {
    const time = new Date(String(step?.time));
    if (Number.isNaN(time.getTime())) continue;
    const details = step.data?.instant?.details ?? {};
    found.push({
      time,
      temp: typeof details.air_temperature === "number" ? details.air_temperature : undefined,
      wind: typeof details.wind_speed === "number" ? details.wind_speed : undefined,
      symbol1: step.data?.next_1_hours?.summary?.symbol_code,
      symbol6: step.data?.next_6_hours?.summary?.symbol_code,
      symbol12: step.data?.next_12_hours?.summary?.symbol_code,
    });
  }
  return found.sort((a, b) => a.time.getTime() - b.time.getTime());
}

export interface Now {
  time: Date;
  temp: number;
  wind: number;
  symbol: string;
  scene: Scene;
  label: string;
}

// The weather now: the step for the current hour, with MET's symbol for the
// hour after it, as yr.no shows it. Before the first step, the first.
export function now(all: Step[], at: Date): Now | null {
  const usable = all.filter((step) => step.temp !== undefined && (step.symbol1 ?? step.symbol6 ?? step.symbol12));
  if (usable.length === 0) return null;
  let pick = usable[0];
  for (const step of usable) if (step.time.getTime() <= at.getTime()) pick = step;
  const symbol = (pick.symbol1 ?? pick.symbol6 ?? pick.symbol12)!;
  const wind = pick.wind ?? 0;
  return { time: pick.time, temp: pick.temp!, wind, symbol, scene: scene(symbol, wind), label: label(symbol, wind) };
}

// A time's date and hour in a time zone.
function local(time: Date, zone: string): { date: string; hour: number; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(time)
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minutes: Number(parts.minute) };
}

export interface Day {
  date: string; // YYYY-MM-DD, in the place's time zone
  high: number;
  low: number;
  symbol: string;
  wind: number;
  scene: Scene;
  label: string;
}

// Each day from today, in the place's time zone (ADR-016): the scene from
// MET's six-hour symbol that starts at local noon, and the high and low from
// the temperatures that day. Further out, where MET gives a step every six
// hours, the six-hour symbol that starts nearest to noon stands in. Today
// counts from now. A day the forecast doesn't reach isn't there.
export function days(all: Step[], zone: string, at: Date, count = 7): Day[] {
  const today = local(at, zone).date;
  const byDate = new Map<string, { step: Step; hour: number }[]>();
  for (const step of all) {
    const when = local(step.time, zone);
    if (when.date < today) continue;
    if (!byDate.has(when.date)) byDate.set(when.date, []);
    byDate.get(when.date)!.push({ step, hour: when.hour + when.minutes / 60 });
  }
  const found: Day[] = [];
  for (const [date, list] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (found.length >= count) break;
    // Today's high and low count from now, as yr.no's do.
    const counted = date === today ? list.filter(({ step }) => step.time.getTime() + 3_600_000 > at.getTime()) : list;
    const temps = counted.map(({ step }) => step.temp).filter((temp): temp is number => temp !== undefined);
    if (temps.length === 0) continue;
    const pick = (key: "symbol6" | "symbol12" | "symbol1") =>
      counted
        .filter(({ step }) => step[key])
        .sort((a, b) => Math.abs(a.hour - 12) - Math.abs(b.hour - 12) || a.hour - b.hour)[0];
    const noon = pick("symbol6") ?? pick("symbol12") ?? pick("symbol1");
    if (!noon) continue;
    const symbol = (noon.step.symbol6 ?? noon.step.symbol12 ?? noon.step.symbol1)!;
    const wind = noon.step.wind ?? 0;
    found.push({
      date,
      high: Math.max(...temps),
      low: Math.min(...temps),
      symbol,
      wind,
      scene: scene(symbol, wind),
      label: label(symbol, wind),
    });
  }
  return found;
}

// A temperature as the tile writes it, in whole degrees: "14°", "-2°".
export function degrees(celsius: number, units: "c" | "f" = "c"): string {
  const value = Math.round(units === "f" ? (celsius * 9) / 5 + 32 : celsius);
  return `${value === 0 ? 0 : value}°`;
}

// "thu" for a date, in English, as the launcher writes days.
export function weekday(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)).toLowerCase();
}
