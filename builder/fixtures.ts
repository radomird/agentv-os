// An app's fixtures (ADR-019 layer 3, ADR-046): the saved pages and recorded
// replies its contract checks run against, at the app's real addresses, and
// how a check's answer is matched against what it expects. Layer 3's runner
// (test/agentv/contract/runner.mts) uses them in CI, and the builder's
// contract_tests on the box (builder/contract-run.ts), where no network and
// no sign-in are needed to check an app the agent wrote.
//
// contract.json is described in the runner. On the box, a file it names
// stays in the build's own folder.

import { readFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { Tier } from "../apps/contract/manifest.ts";

const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/;
const DATE_HEADERS = ["date", "expires", "last-modified"];
export const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

export interface RouteSpec {
  url: string;
  method?: string;
  file?: string;
  reply?: string;
  status?: number;
  type?: string;
}

export interface Check {
  name: string;
  id?: string;
  call?: string;
  args?: unknown[];
  page?: string;
  expect?: unknown;
  throws?: string;
  after?: { url?: string; title?: string };
  asks?: { url: string; headers?: Record<string, string> }[];
  op?: string;
  request?: Record<string, unknown>;
}

export interface Contract {
  tier?: Tier;
  settings?: Record<string, string>;
  shiftTimes?: string;
  routes?: RouteSpec[];
  music?: string;
  checks: Check[];
}

export interface Answer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

// --- Matching -------------------------------------------------------------------

// Where actual differs from the pattern, as lines; none when it matches.
export function differences(actual: unknown, pattern: unknown, at = "it"): string[] {
  if (pattern && typeof pattern === "object" && !Array.isArray(pattern)) {
    const p = pattern as Record<string, unknown>;
    if ("$match" in p) return typeof actual === "string" && new RegExp(String(p.$match)).test(actual) ? [] : [`${at} is ${JSON.stringify(actual)}, not like /${p.$match}/`];
    if ("$min" in p) return typeof actual === "number" && actual >= Number(p.$min) ? [] : [`${at} is ${JSON.stringify(actual)}, not at least ${p.$min}`];
    if ("$type" in p) return typeof actual === p.$type ? [] : [`${at} is ${JSON.stringify(actual)}, not a ${p.$type}`];
    if ("$length" in p) {
      const length = Array.isArray(actual) || typeof actual === "string" ? actual.length : -1;
      return length === Number(p.$length) ? [] : [`${at} has ${length < 0 ? "no" : length} items, not ${p.$length}`];
    }
    if (!actual || typeof actual !== "object") return [`${at} is ${JSON.stringify(actual)}, not an object`];
    return Object.entries(p).flatMap(([key, value]) => differences((actual as Record<string, unknown>)[key], value, `${at}.${key}`));
  }
  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual)) return [`${at} is ${JSON.stringify(actual)}, not a list`];
    if (actual.length !== pattern.length) return [`${at} has ${actual.length} items, not ${pattern.length}`];
    return pattern.flatMap((value, i) => differences(actual[i], value, `${at}[${i}]`));
  }
  return Object.is(actual, pattern) ? [] : [`${at} is ${JSON.stringify(actual)}, not ${JSON.stringify(pattern)}`];
}

// --- The fixtures' answers ---------------------------------------------------------

// Moves every ISO time in a JSON value by ms.
function shiftJson(value: unknown, ms: number): unknown {
  if (typeof value === "string") return ISO_TIME.test(value) ? new Date(new Date(value).getTime() + ms).toISOString().replace(".000Z", "Z") : value;
  if (Array.isArray(value)) return value.map((item) => shiftJson(item, ms));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shiftJson(item, ms)]));
  return value;
}

export class Fixtures {
  private dir: string;
  private routes: RouteSpec[];
  private shift: number;
  private root?: string; // where the files it names must be, on the box
  asked: { method: string; url: string; headers: Record<string, string> }[] = [];
  missing: string[] = [];

  constructor(dir: string, contract: Contract, now = Date.now(), root?: string) {
    this.dir = dir;
    this.root = root;
    this.routes = contract.routes ?? [];
    this.shift = contract.shiftTimes ? Math.floor(now / 3_600_000) * 3_600_000 - new Date(contract.shiftTimes).getTime() : 0;
  }

  // A file the fixtures name, within root when there is one.
  private inside(file: string): string {
    const path = resolve(this.dir, file);
    if (!this.root) return path;
    const rel = relative(this.root, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${file} isn't in the build`);
    return path;
  }

  answer(method: string, address: string, headers: Record<string, string> = {}): Answer | null {
    this.asked.push({ method, url: address, headers });
    const url = new URL(address);
    const route = this.routes.find((r) => {
      const want = new URL(r.url);
      return (r.method ?? "GET").toUpperCase() === method.toUpperCase() && want.origin === url.origin && want.pathname === url.pathname && (!want.search || want.search === url.search);
    });
    if (!route) {
      this.missing.push(`${method} ${address}`);
      return null;
    }
    let status = route.status ?? 200;
    let type = route.type ?? "";
    let out: Record<string, string> = {};
    let body: Buffer;
    if (route.reply) {
      const recorded = JSON.parse(readFileSync(this.inside(route.reply), "utf8")) as { status?: number; headers?: Record<string, string>; body: unknown };
      status = route.status ?? recorded.status ?? 200;
      out = { ...(recorded.headers ?? {}) };
      const value = typeof recorded.body === "string" ? recorded.body : shiftJson(recorded.body, this.shift);
      body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
      type ||= typeof recorded.body === "string" ? "text/plain; charset=utf-8" : "application/json";
    } else if (route.file) {
      const path = this.inside(route.file);
      type ||= TYPES[extname(path)] ?? "application/octet-stream";
      body = readFileSync(path);
      if (type === "application/json" && this.shift) body = Buffer.from(JSON.stringify(shiftJson(JSON.parse(body.toString("utf8")), this.shift)));
    } else {
      body = Buffer.alloc(0);
    }
    for (const name of DATE_HEADERS) {
      if (out[name] && this.shift) out[name] = new Date(new Date(out[name]).getTime() + this.shift).toUTCString();
    }
    return { status, headers: { ...out, "content-type": type }, body };
  }

  // fetch for the app's worker, past the loader's own origin check.
  fetch: typeof fetch = async (input, init) => {
    const address = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const answer = this.answer(init?.method ?? "GET", address, headers);
    if (!answer) return new Response("not in the app's fixtures", { status: 404 });
    // A 204 or 304 carries no body, as the server sent it.
    const empty = [101, 103, 204, 205, 304].includes(answer.status);
    return new Response(empty ? null : new Uint8Array(answer.body), { status: answer.status, headers: answer.headers });
  };

  // The same for its page in Chromium. The tab's own favicon is Chromium's
  // asking, not the app's, so it gets a 404 rather than failing a check.
  forPage(method: string, address: string, headers: Record<string, string>): Answer | null {
    if (new URL(address).pathname === "/favicon.ico" && !this.routes.some((r) => new URL(r.url).pathname === "/favicon.ico")) {
      return { status: 404, headers: {}, body: Buffer.alloc(0) };
    }
    return this.answer(method, address, headers);
  }
}
