// AgenTV's built-in Weather app (ADR-015, ADR-016): MET Norway's forecast for
// the city of the box's time zone, as a tile in three sizes. It runs in a
// worker of its own like any app, and reaches only api.met.no. The launcher
// draws the scenes from its own pixel set; this only sends their names.
//
// MET's terms: every request says who's asking (the daemon gives each app's
// requests AgenTV's User-Agent, with a web address), only the place's
// rounded coordinates are sent, and a forecast isn't asked for again before
// the time MET's reply says it expires. Offline, the tile shows the last
// forecast, marked so.

import type { AppContext, Tile, TileEntry, TileSize, TvApp } from "../../contract/contract.ts";
import { days, degrees, now, steps, weekday, type Day, type Now } from "./met.ts";

const API = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const REFRESH_MINS = 30;
const FETCH_MS = 2_500;

interface Kept {
  url: string;
  body: unknown;
  expires: number;
  modified?: string;
}

let kept: Kept | null = null;

// Where the forecast is for, from the daemon: the place's name, its
// coordinates, its time zone and its units.
interface Place {
  name: string;
  lat: number;
  lon: number;
  zone: string;
  units: "c" | "f";
}

function placeOf(ctx: AppContext): Place | null {
  const lat = Number(ctx.settings.lat);
  const lon = Number(ctx.settings.lon);
  if (!ctx.settings.lat || !ctx.settings.lon || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return {
    name: ctx.settings.place || "here",
    // Two decimals is about a kilometre, and all MET needs.
    lat: Math.round(lat * 100) / 100,
    lon: Math.round(lon * 100) / 100,
    zone: ctx.settings.timeZone || "UTC",
    units: ctx.settings.units === "f" ? "f" : "c",
  };
}

function expiresOf(response: Response): number {
  const at = Date.parse(response.headers.get("expires") ?? "");
  // Without an Expires header, half an hour, as the tile refreshes.
  return Number.isNaN(at) ? Date.now() + REFRESH_MINS * 60_000 : at;
}

// The forecast for a place: the one kept while it's fresh, else MET's, else
// the one kept, marked offline.
async function forecast(ctx: AppContext, place: Place): Promise<{ body: unknown; offline: boolean }> {
  const base = ctx.settings.forecastUrl || API;
  const url = `${base}?lat=${place.lat}&lon=${place.lon}`;
  const same = kept?.url === url ? kept : null;
  if (same && Date.now() < same.expires) return { body: same.body, offline: false };
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (same?.modified) headers["If-Modified-Since"] = same.modified;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_MS) });
    if (response.status === 304 && same) {
      same.expires = expiresOf(response);
      return { body: same.body, offline: false };
    }
    if (!response.ok) throw new Error(`MET Norway answered ${response.status}`);
    const body = await response.json();
    if (steps(body).length === 0) throw new Error("MET Norway's answer had no forecast in it");
    kept = { url, body, expires: expiresOf(response), modified: response.headers.get("last-modified") ?? undefined };
    return { body, offline: false };
  } catch (error) {
    if (same) return { body: same.body, offline: true };
    throw error;
  }
}

function hilo(day: Day | undefined, units: Place["units"]): string {
  return day ? `h ${degrees(day.high, units)} · l ${degrees(day.low, units)}` : "";
}

// What each size shows: the weather now (small), today and tomorrow
// (medium), and now plus seven days (large).
export function tileFor(size: TileSize, place: Place, current: Now, week: Day[], offline: boolean): Tile {
  const where = offline ? `${place.name} · offline` : place.name;
  const today = week[0];
  const nowEntry: TileEntry = {
    icon: current.scene,
    value: degrees(current.temp, place.units),
    caption: current.label,
  };
  if (size === "s") {
    return { headline: { label: where, ...nowEntry }, entries: [{ caption: hilo(today, place.units) }], refreshMins: REFRESH_MINS };
  }
  if (size === "m") {
    const tomorrow = week[1];
    const entries: TileEntry[] = [{ label: "today", ...nowEntry, caption: `${current.label}\n${hilo(today, place.units)}` }];
    if (tomorrow) {
      entries.push({
        label: "tomorrow",
        icon: tomorrow.scene,
        value: degrees(tomorrow.high, place.units),
        caption: `${tomorrow.label}\n${hilo(tomorrow, place.units)}`,
      });
    }
    return { headline: { label: where }, entries, refreshMins: REFRESH_MINS };
  }
  return {
    headline: { label: `${where} · 7 days`, ...nowEntry, caption: `${current.label}\n${hilo(today, place.units)}` },
    entries: week.map((day, i) => ({
      label: i === 0 ? "today" : weekday(day.date),
      icon: day.scene,
      value: degrees(day.high, place.units),
      caption: degrees(day.low, place.units),
    })),
    refreshMins: REFRESH_MINS,
  };
}

const app: TvApp = {
  id: "agentv.weather",

  // The launcher opens a built-in itself.
  async launch() {},

  async tile(ctx: AppContext, size: TileSize): Promise<Tile> {
    const place = placeOf(ctx);
    // A time zone like UTC has no city: the tile says where to pick one.
    if (!place) return { headline: { label: "no city yet", caption: "pick one in\nsettings → weather" } };
    const { body, offline } = await forecast(ctx, place);
    const all = steps(body);
    const at = new Date();
    const current = now(all, at);
    if (!current) throw new Error("MET Norway's forecast has nothing for now");
    return tileFor(size, place, current, days(all, place.zone, at, 7), offline);
  },
};

export default app;
