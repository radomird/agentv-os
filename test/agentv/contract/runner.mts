// AgenTV's contract tests (ADR-019, layer 3; S3.1): any app, run in its own
// worker the way the TV runs it, against its fixtures, with no network and
// no sign-in.
//
// An app's fixtures are in its package's fixtures/ folder, which never ships
// to a box: contract.json, and the saved pages and recorded replies it names.
// Every request the app makes, from its worker or from its page in Chromium,
// is answered from those, at the app's real addresses, so the app runs with
// its own manifest and its own origins. A request the fixtures don't have
// fails the check that made it.
//
// contract.json:
//   tier        how it's installed: official, community or local (from its
//               id when left out)
//   settings    its setup fields and settings, as the daemon would give them
//   shiftTimes  a recorded time that becomes the start of this hour: every
//               ISO time in a JSON reply, and every date header, moves with
//               it, so a recorded forecast or "last played" is fresh
//   routes      [{ url, method?, file? | reply?, status?, type? }]: what an
//               address answers. file is served as it is; reply is a
//               recording, { status, headers, body }. A url with no query
//               answers whatever query comes.
//   music       for the built-in Music app: the folder its library reads
//   checks      [{ name, id?, call, args?, page?, expect?, throws?, after?,
//               asks? }], or for Music [{ name, op, request?, expect? }]
//               call     a capability, like "tile" or "playback.open"
//               page     where the app's page is first, for a web app
//               expect   what it answers, matched as a pattern: objects by
//                        the keys given, arrays item by item, and
//                        { "$match": "regex" }, { "$min": n }, { "$length": n },
//                        { "$type": "number" }
//               throws   a regex its error matches instead
//               after    where its page is after the call: { url?, title? }
//               asks     requests it must have made: [{ url: "regex",
//                        headers?: { name: "regex" } }]
//
// Usage: node runner.mts [<app-dir>...]   (test/agentv/contract/run sets it up)
// With no app, every app in this repo with fixtures/contract.json.

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page, Route as PageRoute } from "playwright-core";
import { validatePackage, type Manifest, type Tier } from "../../../apps/contract/manifest.ts";
import { AppHost, type PageBroker } from "../../../daemon/apps/loader.ts";
import { MusicApp, MusicLibrary, type MusicPlayer, type Track } from "../../../daemon/music.ts";
import { cdpPage } from "../../../daemon/page.ts";
import type { Storage } from "../../../daemon/storage.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const VIEWER = { id: "contract", role: "adult" as const };
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/;
const DATE_HEADERS = ["date", "expires", "last-modified"];
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

interface RouteSpec {
  url: string;
  method?: string;
  file?: string;
  reply?: string;
  status?: number;
  type?: string;
}

interface Check {
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

interface Contract {
  tier?: Tier;
  settings?: Record<string, string>;
  shiftTimes?: string;
  routes?: RouteSpec[];
  music?: string;
  checks: Check[];
}

interface Answer {
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
  asked: { method: string; url: string; headers: Record<string, string> }[] = [];
  missing: string[] = [];

  constructor(dir: string, contract: Contract, now = Date.now()) {
    this.dir = dir;
    this.routes = contract.routes ?? [];
    this.shift = contract.shiftTimes ? Math.floor(now / 3_600_000) * 3_600_000 - new Date(contract.shiftTimes).getTime() : 0;
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
      const recorded = JSON.parse(readFileSync(resolve(this.dir, route.reply), "utf8")) as { status?: number; headers?: Record<string, string>; body: unknown };
      status = route.status ?? recorded.status ?? 200;
      out = { ...(recorded.headers ?? {}) };
      const value = typeof recorded.body === "string" ? recorded.body : shiftJson(recorded.body, this.shift);
      body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
      type ||= typeof recorded.body === "string" ? "text/plain; charset=utf-8" : "application/json";
    } else if (route.file) {
      const path = resolve(this.dir, route.file);
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
  // asking, not the app's.
  async route(route: PageRoute): Promise<void> {
    const request = route.request();
    if (new URL(request.url()).pathname === "/favicon.ico" && !this.routes.some((r) => new URL(r.url).pathname === "/favicon.ico")) {
      return route.fulfill({ status: 404, body: "" });
    }
    const answer = this.answer(request.method(), request.url(), request.headers());
    if (!answer) return route.abort("blockedbyclient");
    return route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
  }
}

// --- Running an app ---------------------------------------------------------------

export interface Result {
  app: string;
  id: string;
  name: string;
  ok: boolean;
  why: string[];
}

function tierOf(id: string, contract: Contract): Tier {
  if (contract.tier) return contract.tier;
  if (id.startsWith("agentv.")) return "official";
  if (id.startsWith("local.")) return "local";
  return "community";
}

// The built-in Music app runs in the TV session, not a worker: its contract
// is the requests the launcher sends it, against a library read from its
// fixture folder, with a stand-in for mpv.
async function runMusic(app: string, dir: string, contract: Contract): Promise<Result[]> {
  const folder = resolve(dir, contract.music!);
  const source = { id: `folder:${folder}`, kind: "folder" as const, name: "music", path: folder, available: true };
  const storage = { sources: async () => [source], paths: async () => [{ source, path: folder }], mountUsb: async () => "", mountShare: async () => "" } as unknown as Storage;
  let queue: Track[] = [];
  let index = 0;
  const player = {
    async play(tracks: Track[], from = 0) {
      queue = tracks;
      index = from;
    },
    async now() {
      const track = queue[index];
      return track ? { title: track.title, artist: track.artist, album: track.album, albumId: track.albumId, position: 0, duration: track.duration, playing: true, index, count: queue.length } : null;
    },
    async next() {
      index = Math.min(index + 1, queue.length);
    },
    async previous() {
      index = Math.max(0, index - 1);
    },
    async pause() {},
    async stop() {
      queue = [];
    },
    close() {},
  } as unknown as MusicPlayer;
  const music = new MusicApp({ storage, library: new MusicLibrary({ dir: mkdtempSync(join(tmpdir(), "agentv-contract-music-")) }), player });
  await music.scan();
  const results: Result[] = [];
  for (const check of contract.checks) {
    const reply = await music.handle({ op: check.op, ...(check.request ?? {}) }).catch((error: Error) => ({ ok: false, error: error.message }));
    const why = differences(reply, check.expect ?? { ok: true });
    results.push({ app, id: check.id ?? "S3.1", name: check.name, ok: why.length === 0, why });
  }
  music.stop();
  return results;
}

async function runApp(dir: string, browser: () => Promise<Browser>): Promise<Result[]> {
  const contractPath = join(dir, "fixtures", "contract.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8")) as Contract;
  const fixtures = dirname(contractPath);
  const raw = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { id: string };
  const app = raw.id;
  const tier = tierOf(app, contract);
  const { manifest, problems } = validatePackage(dir, tier);
  const results: Result[] = [{ app, id: "S3.1", name: `the package passes the app contract's checks as ${tier}`, ok: !!manifest && problems.length === 0, why: problems }];
  if (!manifest) return results;
  if (contract.music) return [...results, ...(await runMusic(app, fixtures, contract))];

  const served = new Fixtures(fixtures, contract);
  let page: Page | undefined;
  let broker: PageBroker | undefined;
  if (contract.checks.some((check) => check.page)) {
    page = await (await browser()).newPage();
    await page.route("**/*", (route) => served.route(route));
    const session = await page.context().newCDPSession(page);
    broker = cdpPage(
      {
        async evaluateIn(_target: string, expression: string) {
          const reply = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
          if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
          return reply.result.value;
        },
      },
      () => "contract",
    );
  }
  const host = new AppHost({ dir, manifest: manifest as Manifest, settings: contract.settings ?? {}, page: broker, fetch: served.fetch, userAgent: "AgenTV-contract" });
  try {
    await host.start();
    results.push({ app, id: "S3.1", name: "its module starts in a worker of its own", ok: true, why: [] });
  } catch (error) {
    results.push({ app, id: "S3.1", name: "its module starts in a worker of its own", ok: false, why: [(error as Error).message] });
    host.stop();
    return results;
  }

  for (const check of contract.checks) {
    const why: string[] = [];
    served.asked = [];
    served.missing = [];
    try {
      if (check.page && page) await page.goto(check.page);
      host.setPage(check.page ? broker : undefined);
      let value: unknown;
      let failed: Error | undefined;
      try {
        value = await host.call(VIEWER, check.call ?? "", ...(check.args ?? []));
      } catch (error) {
        failed = error as Error;
      }
      if (check.throws) {
        if (!failed) why.push(`it answered ${JSON.stringify(value)} instead of failing`);
        else if (!new RegExp(check.throws).test(failed.message)) why.push(`it failed with "${failed.message}", not like /${check.throws}/`);
      } else if (failed) {
        why.push(`it failed: ${failed.message}`);
      } else if (check.expect !== undefined) {
        why.push(...differences(value, check.expect));
      }
      if (check.after?.url && page && !new RegExp(check.after.url).test(page.url())) why.push(`its page is at ${page.url()}, not like /${check.after.url}/`);
      if (check.after?.title !== undefined && page) {
        const title = await page.title();
        if (!new RegExp(check.after.title).test(title)) why.push(`its page's title is "${title}", not like /${check.after.title}/`);
      }
      for (const ask of check.asks ?? []) {
        const made = served.asked.find((request) => new RegExp(ask.url).test(request.url) && Object.entries(ask.headers ?? {}).every(([name, value]) => new RegExp(value).test(request.headers[name.toLowerCase()] ?? "")));
        if (!made) why.push(`it never asked for /${ask.url}/${ask.headers ? ` with ${JSON.stringify(ask.headers)}` : ""}`);
      }
      for (const request of served.missing) why.push(`it asked for ${request}, which its fixtures don't have`);
    } catch (error) {
      why.push(`the check couldn't run: ${(error as Error).message}`);
    }
    results.push({ app, id: check.id ?? "S3.1", name: check.name, ok: why.length === 0, why });
  }
  host.stop();
  await page?.close();
  return results;
}

// Every app here with fixtures: the built-ins and the test apps.
export function appsHere(): string[] {
  const found: string[] = [];
  for (const parent of [join(ROOT, "apps/builtin"), join(ROOT, "test/agentv/fixtures/apps")]) {
    for (const name of readdirSync(parent).sort()) {
      if (existsSync(join(parent, name, "fixtures", "contract.json"))) found.push(join(parent, name));
    }
  }
  return found;
}

export async function run(dirs: string[], log: (line: string) => void = console.log): Promise<Result[]> {
  let launched: Browser | undefined;
  const browser = async () => {
    if (!launched) {
      const require = createRequire(`${process.env.AGENTV_CONTRACT_MODULES ?? ROOT}/`);
      const { chromium } = require("playwright-core") as typeof import("playwright-core");
      launched = await chromium.launch({ executablePath: process.env.AGENTV_CONTRACT_BROWSER });
    }
    return launched;
  };
  const all: Result[] = [];
  try {
    for (const dir of dirs) {
      for (const result of await runApp(resolve(dir), browser)) {
        all.push(result);
        log(`${result.ok ? "ok" : "not ok"} - ${result.id} ${result.app}: ${result.name}`);
        for (const line of result.why) log(`    ${line}`);
      }
    }
  } finally {
    await launched?.close();
  }
  return all;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  const results = await run(dirs.length ? dirs : appsHere());
  const failed = results.filter((result) => !result.ok);
  const apps = new Set(results.map((result) => result.app)).size;
  console.log(failed.length ? `\n${failed.length} of ${results.length} contract checks failed.` : `\nAll ${results.length} contract checks passed, for ${apps} apps.`);
  process.exit(failed.length ? 1 : 0);
}
