// An app's contract checks against its fixtures (ADR-019 layer 3, ADR-046):
// each check calls one capability of the app in its own worker, as the TV
// runs it, with its page in a headless Chromium and every request answered
// from the fixtures, at the app's real addresses. Layer 3's runner
// (test/agentv/contract/runner.mts) runs them in CI with Playwright's
// Chromium; on the box the builder's contract_tests runs them with the
// browser that's there, over its DevTools pipe, with no network at all.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Manifest } from "../apps/contract/manifest.ts";
import { validatePackage } from "../apps/contract/manifest.ts";
import { AppHost, type PageBroker } from "../daemon/apps/loader.ts";
import { cdpPage } from "../daemon/page.ts";
import { REMOTE_PAGE, REMOTE_WORLD, SPATIAL_NAVIGATION } from "../daemon/remote-page.ts";
import type { Build } from "./build.ts";
import { type Contract, differences, Fixtures } from "./fixtures.ts";
import { headless } from "./gates/chromium.ts";
import type { Recipe } from "./recipe.ts";

const VIEWER = { id: "contract", role: "adult" as const };

export interface Result {
  app: string;
  id: string;
  name: string;
  ok: boolean;
  why: string[];
}

// The phone's d-pad as a check presses it, by the virtual input device's
// names, and the key each one is in the page (ADR-008).
export const REMOTE_KEYS: Record<string, { key: string; code: number }> = {
  up: { key: "ArrowUp", code: 38 },
  down: { key: "ArrowDown", code: 40 },
  left: { key: "ArrowLeft", code: 37 },
  right: { key: "ArrowRight", code: 39 },
  enter: { key: "Enter", code: 13 },
  back: { key: "Escape", code: 27 },
};

// What has focus in the page, by what a screen reader would call it: its
// label, or its text. Nothing when nothing has focus.
export const FOCUSED = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return "";
  return (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200);
})()`;

// The app's page while its checks run, in whichever browser runs them. It
// runs as the services' Chromium on the TV does, with spatial navigation and
// the d-pad's ring and Back (daemon/remote-page.ts).
export interface CheckPage {
  broker: PageBroker;
  goto(url: string): Promise<void>;
  url(): Promise<string>;
  title(): Promise<string>;
  // One of REMOTE_KEYS, pressed and let go, and the page settled after it.
  press(key: string): Promise<void>;
  focused(): Promise<string>;
  close(): Promise<void>;
}

// bubblewrap and its arguments for the app's worker in a build, up to the
// worker's own command. This is the one place a build's own code runs, so
// Node's permission flag isn't left to hold it alone. The worker sees the
// system and its own package, both read-only, and nothing else: the
// builder's home, with the CLI and a plan's sign-in, is an empty folder to
// it, and so are the rest of the build, with the pages it saved, and /run,
// where the build's way out is. It has no network at all, not even the
// sandbox's: what it asks for is answered from the fixtures, by the builder.
// /proc is as an install script gets it (builder/packages.ts).
export function workerJail(o: { app: string; build: string; home: string; bwrap?: string }): string[] {
  return [
    o.bwrap ?? "bwrap",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--tmpfs", "/proc",
    "--ro-bind-try", "/proc/cpuinfo", "/proc/cpuinfo",
    "--ro-bind-try", "/proc/meminfo", "/proc/meminfo",
    "--ro-bind-try", "/proc/stat", "/proc/stat",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    "--tmpfs", o.home,
    "--tmpfs", o.build,
    "--ro-bind", o.app, o.app,
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net", "--unshare-cgroup-try",
    "--die-with-parent", "--new-session",
    "--chdir", o.app,
    "--",
  ];
}

// Every check in contract.json, after the package passed its static checks.
export async function checkApp(o: { dir: string; manifest: Manifest; contract: Contract; served: Fixtures; openPage: () => Promise<CheckPage>; wrap?: string[] }): Promise<Result[]> {
  const { manifest, contract, served } = o;
  const app = manifest.id;
  const results: Result[] = [];
  const page = contract.checks.some((check) => check.page || check.remote) ? await o.openPage() : undefined;
  const host = new AppHost({ dir: o.dir, manifest, settings: contract.settings ?? {}, page: page?.broker, fetch: served.fetch, userAgent: "AgenTV-contract", ...(o.wrap ? { wrap: o.wrap } : {}) });
  try {
    await host.start();
    results.push({ app, id: "S3.1", name: "its module starts in a worker of its own", ok: true, why: [] });
  } catch (error) {
    results.push({ app, id: "S3.1", name: "its module starts in a worker of its own", ok: false, why: [(error as Error).message] });
    host.stop();
    await page?.close();
    return results;
  }

  for (const check of contract.checks) {
    const why: string[] = [];
    served.asked = [];
    served.missing = [];
    try {
      if (check.page && page) await page.goto(check.page);
      host.setPage(check.page ? page?.broker : undefined);
      let value: unknown;
      let failed: Error | undefined;
      // A check of the d-pad alone calls nothing.
      if (check.call || !check.remote) {
        try {
          value = await host.call(VIEWER, check.call ?? "", ...(check.args ?? []));
        } catch (error) {
          failed = error as Error;
        }
      }
      for (const key of check.remote ?? []) {
        if (!REMOTE_KEYS[key]) throw new Error(`the remote has no ${key}: ${Object.keys(REMOTE_KEYS).join(", ")}`);
        await page!.press(key);
      }
      if (check.throws) {
        if (!failed) why.push(`it answered ${JSON.stringify(value)} instead of failing`);
        else if (!new RegExp(check.throws).test(failed.message)) why.push(`it failed with "${failed.message}", not like /${check.throws}/`);
      } else if (failed) {
        why.push(`it failed: ${failed.message}`);
      } else if (check.expect !== undefined) {
        why.push(...differences(value, check.expect));
      }
      if (check.after?.url && page) {
        const url = await page.url();
        if (!new RegExp(check.after.url).test(url)) why.push(`its page is at ${url}, not like /${check.after.url}/`);
      }
      if (check.after?.title !== undefined && page) {
        const title = await page.title();
        if (!new RegExp(check.after.title).test(title)) why.push(`its page's title is "${title}", not like /${check.after.title}/`);
      }
      if (check.after?.focused !== undefined && page) {
        const focused = await page.focused();
        if (!new RegExp(check.after.focused).test(focused)) why.push(`what has focus is "${focused}", not like /${check.after.focused}/`);
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

// A moment for what a key started, such as a page Enter or Back opened, to
// load and draw.
export async function settled(evaluate: (expression: string) => Promise<unknown>): Promise<void> {
  await new Promise((done) => setTimeout(done, 250));
  for (let tries = 0; tries < 50; tries++) {
    if ((await evaluate("document.readyState").catch(() => "")) === "complete") return;
    await new Promise((done) => setTimeout(done, 100));
  }
}

// The app's page in a headless Chromium of its own, with every request it
// makes answered from the fixtures, or refused. Nothing reaches a network.
export async function cdpCheckPage(chromium: string, served: Fixtures): Promise<CheckPage> {
  const browser = headless(chromium, { flags: [SPATIAL_NAVIGATION] });
  const { cdp } = browser;
  try {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    cdp.on("Fetch.requestPaused", (event: { requestId: string; request: { url: string; method: string; headers: Record<string, string> } }, from?: string) => {
      if (from !== sessionId) return;
      let answer: ReturnType<Fixtures["forPage"]> = null;
      try {
        answer = served.forPage(event.request.method, event.request.url, Object.fromEntries(Object.entries(event.request.headers).map(([k, v]) => [k.toLowerCase(), v])));
      } catch {}
      const reply = answer
        ? cdp.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: answer.status, responseHeaders: Object.entries(answer.headers).map(([name, value]) => ({ name, value })), body: answer.body.toString("base64") }, sessionId)
        : cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }, sessionId);
      reply.catch(() => {});
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: REMOTE_PAGE, worldName: REMOTE_WORLD }, sessionId);
    let loaded: (() => void) | null = null;
    cdp.on("Page.loadEventFired", (_event, from) => {
      if (from === sessionId) loaded?.();
    });
    const evaluate = async (expression: string) => {
      const reply = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result.value;
    };
    return {
      broker: cdpPage({ evaluateIn: (_target: string, expression: string) => evaluate(expression) }, () => "contract"),
      async goto(url) {
        const there = new Promise<void>((done) => {
          const timer = setTimeout(done, 15_000);
          loaded = () => {
            clearTimeout(timer);
            done();
          };
        });
        const { errorText } = await cdp.send("Page.navigate", { url }, sessionId);
        if (errorText) throw new Error(`its page couldn't open ${url}: ${errorText}`);
        await there;
        loaded = null;
      },
      url: () => evaluate("location.href"),
      title: () => evaluate("document.title"),
      async press(name) {
        const { key, code } = REMOTE_KEYS[name];
        const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
        await cdp.send("Input.dispatchKeyEvent", key === "Enter" ? { type: "keyDown", text: "\r", unmodifiedText: "\r", ...base } : { type: "rawKeyDown", ...base }, sessionId);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
        await settled(evaluate);
      },
      focused: () => evaluate(FOCUSED),
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// The builder's contract_tests: the app the agent wrote, against the pages
// it saved, and the checks the recipe wants for the stage it's in. On the
// box the app's worker runs under bubblewrap (jail), with the builder's
// home hidden.
export async function contractTests(build: Build, recipe: Recipe, o: { chromium: string; stage?: "a" | "b"; jail?: { home: string; bwrap?: string } }): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const contractPath = join(build.work, "fixtures", "contract.json");
  if (!existsSync(contractPath)) return { ok: false, lines: ["not ok: there's no fixtures/contract.json yet"] };
  let contract: Contract;
  try {
    contract = JSON.parse(readFileSync(contractPath, "utf8")) as Contract;
    if (!Array.isArray(contract.checks)) throw new Error("it has no checks list");
  } catch (error) {
    return { ok: false, lines: [`not ok: fixtures/contract.json isn't right: ${(error as Error).message}`] };
  }
  const { manifest, problems } = validatePackage(build.app, "local");
  if (!manifest) return { ok: false, lines: problems.map((problem) => `not ok: the static checks found: ${problem}`) };

  // The calls every app of this recipe has checks for, at this stage.
  const required = recipeRequires(recipe, o.stage);
  for (const call of required) {
    if (!contract.checks.some((check) => check.call === call)) lines.push(`not ok: the recipe wants a check for ${call}, and fixtures/contract.json has none`);
  }
  const served = new Fixtures(join(build.work, "fixtures"), contract, Date.now(), build.work);
  const wrap = o.jail ? workerJail({ app: resolve(build.app), build: resolve(build.dir), home: o.jail.home, bwrap: o.jail.bwrap }) : undefined;
  const results = await checkApp({ dir: build.app, manifest: manifest as Manifest, contract, served, openPage: () => cdpCheckPage(o.chromium, served), wrap });
  for (const result of results) {
    lines.push(`${result.ok ? "ok" : "not ok"}: ${result.name}`);
    for (const why of result.why) lines.push(`    ${why}`);
  }
  if (contract.checks.length === 0) lines.push("not ok: fixtures/contract.json has no checks yet");
  return { ok: !lines.some((line) => line.startsWith("not ok")), lines };
}

// The recipe's required calls for a stage, from its tests folder.
function recipeRequires(recipe: Recipe, stage: "a" | "b" | undefined): string[] {
  const path = join(recipe.dir, recipe.tests, "required.json");
  if (!stage || !existsSync(path)) return [];
  try {
    const required = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return Array.isArray(required[stage]) ? (required[stage] as unknown[]).filter((call): call is string => typeof call === "string") : [];
  } catch {
    return [];
  }
}
