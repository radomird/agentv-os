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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page, Route as PageRoute } from "playwright-core";
import { validatePackage, type Manifest, type Tier } from "../../../apps/contract/manifest.ts";
import { type CheckPage, checkApp, type Result } from "../../../builder/contract-run.ts";
import { type Contract, differences, Fixtures } from "../../../builder/fixtures.ts";
import { MusicApp, MusicLibrary, type MusicPlayer, type Track } from "../../../daemon/music.ts";
import { cdpPage } from "../../../daemon/page.ts";
import type { Storage } from "../../../daemon/storage.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

export { differences, Fixtures, type Result };

// A request from the app's page in Chromium, answered from its fixtures.
function answerRoute(served: Fixtures, route: PageRoute): Promise<void> {
  const request = route.request();
  const answer = served.forPage(request.method(), request.url(), request.headers());
  if (!answer) return route.abort("blockedbyclient");
  return route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
}

// --- Running an app ---------------------------------------------------------------

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
  // Its page in Playwright's Chromium, driven over DevTools as the TV drives it.
  const openPage = async (): Promise<CheckPage> => {
    const page: Page = await (await browser()).newPage();
    await page.route("**/*", (route) => answerRoute(served, route));
    const session = await page.context().newCDPSession(page);
    const broker = cdpPage(
      {
        async evaluateIn(_target: string, expression: string) {
          const reply = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
          if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
          return reply.result.value;
        },
      },
      () => "contract",
    );
    return {
      broker,
      goto: async (url) => {
        await page.goto(url);
      },
      url: async () => page.url(),
      title: () => page.title(),
      close: () => page.close(),
    };
  };
  return [...results, ...(await checkApp({ dir, manifest: manifest as Manifest, contract, served, openPage }))];
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
