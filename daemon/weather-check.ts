// The weather tile against MET Norway, live, for `agentv selftest S3.8` and
// `S3.9` on the box: the tiles the daemon has for each size, next to what
// MET's forecast says now for the same place, read with the weather app's
// own code (apps/builtin/agentv.weather/met.ts). Prints lines that start
// with pass, fail or manual and the check's id.
//
// A tile can be up to half an hour old, so the weather now may also match
// the hour before. MET updates its forecast during the day, so a degree
// either way still matches.
//
// Usage: node weather-check.ts S3.8|S3.9
// AGENTV_HOME_URL is the daemon (http://127.0.0.1:3000/), AGENTV_MET_URL
// stands in for MET's address in tests.

import { days, degrees, label, now, steps, type Day } from "../apps/builtin/agentv.weather/met.ts";
import { userAgent } from "./server.ts";

const HOME = process.env.AGENTV_HOME_URL ?? "http://127.0.0.1:3000/";
const MET = process.env.AGENTV_MET_URL ?? "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const ROOT = process.env.AGENTV_PATH ?? "/usr/share/agentv";

interface Entry {
  label?: string;
  icon?: string;
  value?: string;
  caption?: string;
}
interface TileData {
  headline?: Entry;
  entries?: Entry[];
}

function say(verdict: "pass" | "fail" | "manual", id: string, what: string): void {
  console.log(`${verdict} ${id} ${what}`);
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}

async function tile(size: string): Promise<TileData | null> {
  return (await json<{ tile: TileData | null }>(new URL(`api/tile/agentv.weather/${size}`, HOME).href)).tile;
}

function near(shown: string | undefined, expected: string): boolean {
  const a = Number.parseInt(shown ?? "", 10);
  const b = Number.parseInt(expected, 10);
  return Number.isFinite(a) && Math.abs(a - b) <= 1;
}

async function main(id: string): Promise<void> {
  const place = await json<{ name: string; zone: string; lat?: number; lon?: number; units: "c" | "f" }>(new URL("api/weather", HOME).href);
  if (place.lat === undefined || place.lon === undefined) {
    say("fail", id, `the box's time zone (${place.zone}) has no city, so the weather has no place: pick one in settings → weather`);
    return;
  }
  const where = `${place.name} (${place.lat}, ${place.lon})`;
  const body = await json<unknown>(`${MET}?lat=${place.lat}&lon=${place.lon}`, { headers: { "User-Agent": `${userAgent(ROOT)} agentv-selftest` } });
  const all = steps(body);
  const at = new Date();

  if (id === "S3.8") {
    const shown = await tile("s");
    const current = now(all, at);
    const before = now(all, new Date(at.getTime() - 30 * 60_000));
    if (!shown?.headline || !current) {
      say("fail", id, `the weather tile for ${where} has nothing to show yet; is the box online?`);
      return;
    }
    const scene = shown.headline.icon;
    const matches = [current, before].find((step) => step && step.scene === scene);
    if (matches) {
      say("pass", id, `the tile shows ${scene} at ${shown.headline.value} for ${where}, as MET's ${matches.symbol} with ${matches.wind} m/s of wind does (${degrees(matches.temp, place.units)})`);
    } else {
      say("fail", id, `the tile shows ${scene} for ${where}, but MET says ${current.symbol} with ${current.wind} m/s of wind, which is ${current.scene}`);
    }
    say("manual", id, `on yr.no, ${place.name}'s forecast for now says ${label(current.symbol, current.wind)}; the TV's weather tile draws the ${current.scene} scene for it`);
    return;
  }

  const week = days(all, place.zone, at, 7);
  const problems: string[] = [];
  // Today's column shows the weather now, with today's high and low under
  // it; every other day its scene, its high, and its low.
  const check = (what: string, entry: Entry | undefined, day: Day | undefined, today: boolean) => {
    if (!entry || !day) {
      problems.push(`${what} is missing`);
      return;
    }
    const high = degrees(day.high, place.units);
    const low = degrees(day.low, place.units);
    const caption = entry.caption ?? "";
    const shownHigh = today ? caption.match(/h (-?\d+)°/)?.[1] : entry.value;
    const shownLow = caption.match(/l (-?\d+)°/)?.[1] ?? caption.match(/^(-?\d+)°$/)?.[1];
    if (!today && entry.icon !== day.scene) problems.push(`${what} shows ${entry.icon}, MET says ${day.scene}`);
    if (!near(shownHigh, high)) problems.push(`${what}'s high is ${shownHigh ?? "missing"}, MET says ${high}`);
    if (!near(shownLow, low)) problems.push(`${what}'s low is ${shownLow ?? "missing"}, MET says ${low}`);
  };
  const medium = await tile("m");
  check("medium: today", medium?.entries?.[0], week[0], true);
  check("medium: tomorrow", medium?.entries?.[1], week[1], false);
  const large = await tile("l");
  for (let i = 0; i < 7; i++) check(`large: ${large?.entries?.[i]?.label ?? `day ${i + 1}`}`, large?.entries?.[i], week[i], false);
  if (problems.length) say("fail", id, `the weather tiles don't match MET for ${where}: ${problems.join("; ")}`);
  else say("pass", id, `the medium and large weather tiles match MET's forecast for ${where}: ${week.map((day) => `${day.scene} ${degrees(day.high, place.units)}/${degrees(day.low, place.units)}`).join(", ")}`);
  say("manual", id, `on yr.no, ${place.name}'s next 7 days: each day's picture and high and low match the large weather tile's (resize it in edit home)`);
}

const id = process.argv[2] ?? "";
if (id !== "S3.8" && id !== "S3.9") {
  console.error("Usage: node weather-check.ts S3.8|S3.9");
  process.exit(2);
}
main(id).catch((error: Error) => {
  say("fail", id, `couldn't compare the weather tile with MET Norway: ${error.message}`);
});
