// The weather tile against MET Norway, live, for `agentv selftest S3.8` and
// `S3.9` on the box: the tiles the daemon has for each size, next to what
// MET's forecast says now for the same place, read with the weather app's
// own code (apps/builtin/agentv.weather/met.ts). Prints lines that start
// with pass, fail or manual and the check's id.
//
// The tiles are drawn again for the check, but the weather app draws them
// from the forecast it keeps until MET's reply says it expires, as MET's
// terms ask, and that can be an hour. While MET publishes a new forecast it
// can hand out the old one and the new one for a few minutes, so the app's
// forecast and the check's can differ. On 2026-11-01 a box's large tile had
// today as partly cloudy, both of the check's fetches had it cloudy, and
// another box two minutes later got partly cloudy from MET again. So the
// check asks MET before and after drawing the tiles, and if the tiles match
// neither forecast, it asks MET again and draws the tiles again, every 15 s
// for up to 2 minutes. They pass once they match a forecast MET handed out.
// Tiles that are wrong for every forecast still fail, and say which ones
// they were compared with. The weather now may still match the hour before,
// as the hour can turn between the two. MET updates its forecast during
// the day, so a degree either way still matches.
//
// Usage: node weather-check.ts S3.8|S3.9
// AGENTV_HOME_URL is the daemon (http://127.0.0.1:3000/), AGENTV_MET_URL
// stands in for MET's address in tests, and AGENTV_MET_AGAIN_MS and
// AGENTV_MET_FOR_MS for how often and how long the check asks again.

import { days, degrees, label, now, steps, type Day, type Step } from "../apps/builtin/agentv.weather/met.ts";
import { userAgent } from "./identity.ts";

const HOME = process.env.AGENTV_HOME_URL ?? "http://127.0.0.1:3000/";
const MET = process.env.AGENTV_MET_URL ?? "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const ROOT = process.env.AGENTV_PATH ?? "/usr/share/agentv";
const AGAIN_MS = Number(process.env.AGENTV_MET_AGAIN_MS ?? 15_000);
const FOR_MS = Number(process.env.AGENTV_MET_FOR_MS ?? 120_000);

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

// One of MET's answers: its steps, and when MET says it updated the forecast.
interface Forecast {
  steps: Step[];
  updated?: string;
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
  return (await json<{ tile: TileData | null }>(new URL(`api/tile/agentv.weather/${size}?fresh=1`, HOME).href)).tile;
}

function near(shown: string | undefined, expected: string): boolean {
  const a = Number.parseInt(shown ?? "", 10);
  const b = Number.parseInt(expected, 10);
  return Number.isFinite(a) && Math.abs(a - b) <= 1;
}

// Compares what's drawn with every forecast seen so far, after one more
// answer from MET. Until one matches, and for up to FOR_MS, it waits
// AGAIN_MS, asks MET again and draws again. Returns what was drawn last and
// the forecast it matched, or null.
async function settle<T>(
  seen: Forecast[],
  ask: () => Promise<Forecast>,
  draw: () => Promise<T>,
  matches: (drawn: T, one: Forecast) => boolean,
  first?: T,
): Promise<{ drawn: T; matched: Forecast | null }> {
  let drawn = first ?? (await draw());
  seen.push(await ask());
  const until = Date.now() + FOR_MS;
  for (;;) {
    const matched = seen.find((one) => matches(drawn, one)) ?? null;
    if (matched || Date.now() >= until) return { drawn, matched };
    await new Promise((resolve) => setTimeout(resolve, AGAIN_MS));
    seen.push(await ask());
    drawn = await draw();
  }
}

// What the tiles were compared with, for a failure.
function compared(seen: Forecast[]): string {
  const times = [...new Set(seen.map((one) => one.updated).filter((time): time is string => Boolean(time)))];
  const when = times.length ? `, its forecasts updated at ${times.map((time) => `${time.slice(11, 16)}Z`).join(" and ")}` : "";
  return `(asked MET ${seen.length} times${when})`;
}

async function main(id: string): Promise<void> {
  const place = await json<{ name: string; zone: string; lat?: number; lon?: number; units: "c" | "f" }>(new URL("api/weather", HOME).href);
  if (place.lat === undefined || place.lon === undefined) {
    say("fail", id, `the box's time zone (${place.zone}) has no city, so the weather has no place: pick one in settings → weather`);
    return;
  }
  const where = `${place.name} (${place.lat}, ${place.lon})`;
  const ask = async (): Promise<Forecast> => {
    const body = await json<{ properties?: { meta?: { updated_at?: string } } }>(`${MET}?lat=${place.lat}&lon=${place.lon}`, {
      headers: { "User-Agent": `${userAgent(ROOT)} agentv-selftest` },
    });
    return { steps: steps(body), updated: body?.properties?.meta?.updated_at };
  };
  const seen = [await ask()];

  if (id === "S3.8") {
    // The weather now, or the hour before it.
    const nowIn = (one: Forecast) => {
      const at = new Date();
      return [now(one.steps, at), now(one.steps, new Date(at.getTime() - 30 * 60_000))];
    };
    const small = await tile("s");
    if (!small?.headline) {
      say("fail", id, `the weather tile for ${where} has nothing to show yet; is the box online?`);
      return;
    }
    const { drawn, matched } = await settle(
      seen,
      ask,
      () => tile("s"),
      (shown, one) => nowIn(one).some((step) => step && step.scene === shown?.headline?.icon),
      small,
    );
    const current = now(seen.at(-1)!.steps, new Date());
    if (!current) {
      say("fail", id, `MET's forecast for ${where} has nothing for now; is the box online?`);
      return;
    }
    const scene = drawn?.headline?.icon;
    const step = matched ? nowIn(matched).find((one) => one && one.scene === scene) : undefined;
    if (step) {
      say("pass", id, `the tile shows ${scene} at ${drawn?.headline?.value} for ${where}, as MET's ${step.symbol} with ${step.wind} m/s of wind does (${degrees(step.temp, place.units)})`);
    } else {
      say("fail", id, `the tile shows ${scene} for ${where}, but MET says ${current.symbol} with ${current.wind} m/s of wind, which is ${current.scene} ${compared(seen)}`);
    }
    say("manual", id, `on yr.no, ${place.name}'s forecast for now says ${label(current.symbol, current.wind)}; the TV's weather tile draws the ${current.scene} scene for it`);
    return;
  }

  // Today's column shows the weather now, with today's high and low under
  // it; every other day its scene, its high, and its low.
  const check = (problems: string[], what: string, entry: Entry | undefined, day: Day | undefined, today: boolean) => {
    if (!entry || !day) {
      problems.push(`${what} is missing`);
      return;
    }
    const high = degrees(day.high, place.units);
    const low = degrees(day.low, place.units);
    const caption = entry.caption ?? "";
    const shownHigh = today ? caption.match(/\bh (-?\d+)°/i)?.[1] : entry.value;
    const shownLow = caption.match(/\bl (-?\d+)°/i)?.[1] ?? caption.match(/^(-?\d+)°$/)?.[1];
    if (!today && entry.icon !== day.scene) problems.push(`${what} shows ${entry.icon}, MET says ${day.scene}`);
    if (!near(shownHigh, high)) problems.push(`${what}'s high is ${shownHigh ?? "missing"}, MET says ${high}`);
    if (!near(shownLow, low)) problems.push(`${what}'s low is ${shownLow ?? "missing"}, MET says ${low}`);
  };
  type Tiles = { medium: TileData | null; large: TileData | null };
  const against = ({ medium, large }: Tiles, one: Forecast) => {
    const week = days(one.steps, place.zone, new Date(), 7);
    const problems: string[] = [];
    check(problems, "medium: today", medium?.entries?.[0], week[0], true);
    check(problems, "medium: tomorrow", medium?.entries?.[1], week[1], false);
    for (let i = 0; i < 7; i++) check(problems, `large: ${large?.entries?.[i]?.label ?? `day ${i + 1}`}`, large?.entries?.[i], week[i], false);
    return { week, problems };
  };
  const { drawn, matched } = await settle(
    seen,
    ask,
    async (): Promise<Tiles> => ({ medium: await tile("m"), large: await tile("l") }),
    (tiles, one) => against(tiles, one).problems.length === 0,
  );
  if (matched) {
    const { week } = against(drawn, matched);
    say("pass", id, `the medium and large weather tiles match MET's forecast for ${where}: ${week.map((day) => `${day.scene} ${degrees(day.high, place.units)}/${degrees(day.low, place.units)}`).join(", ")}`);
  } else {
    say("fail", id, `the weather tiles don't match MET for ${where}: ${against(drawn, seen.at(-1)!).problems.join("; ")} ${compared(seen)}`);
  }
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
