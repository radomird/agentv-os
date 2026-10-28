// AgenTV's test TV (ADR-043): gates 2 and 3 for a page app, before an
// adult sees it. It serves the app as the box does, from its own origin with
// the policy its manifest allows and the kit, puts it in a frame on a page
// like home with home's own kit host, and opens that in a headless Chromium
// with no window, driven over its DevTools pipe. Then it runs AgenTV's own
// checks (builder/gates/host.ts) and the tests, the recipe's and the
// agent's, each in the app afresh (builder/gates/frame.ts), and takes the
// screenshot the approval shows.
//
// On the box it runs in the builder's sandbox, whose only way out is its
// filter, so the app reaches only the origins it declared.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { validatePackage, type Manifest } from "../../apps/contract/manifest.ts";
import { CdpPipe } from "../../daemon/cdp.ts";
import { pageAppId, pageOrigin, PageApps, refusal } from "../../daemon/page-apps.ts";
import type { Check } from "./host.ts";
import { media } from "./media.ts";

export interface TestFile {
  name: string;
  code: string;
}

export interface TryOptions {
  app: string; // the app's folder
  tests: TestFile[];
  checks: boolean; // AgenTV's own checks
  root: string; // AgenTV's files, for the kit and the kit host
  chromium: string;
  proxy?: string; // the sandbox's filter
  storage: string; // a folder for the app's storage while it's tried
  shot?: string; // where the screenshot goes
}

export interface TestResult {
  name: string;
  ok: boolean;
  failed: string[];
}

export interface TryReport {
  ready: boolean;
  checks: Check[];
  tests: TestResult[];
  shot?: string;
  problems: string[]; // each failed check and test, a line each
}

const HOST_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>AgenTV test TV</title>
<style>html, body { margin: 0; height: 100%; background: #000; overflow: hidden } iframe { border: 0; width: 100%; height: 100% }</style>
</head>
<body><iframe id="app" sandbox="allow-scripts" allow="autoplay"></iframe><script type="module" src="/builder/gates/host.ts"></script></body>
</html>
`;

// Each test, as the frame loads it.
const testScript = (test: TestFile) => `// ${test.name.replace(/[^\w./ -]/g, "")}\n${test.code}\n`;

export async function tryApp(o: TryOptions): Promise<TryReport> {
  const { manifest, problems } = validatePackage(o.app, "local");
  if (!manifest) return { ready: false, checks: [], tests: [], problems: [`the static checks found: ${problems[0]}`] };
  if (manifest.tv.runtime !== "page") return { ready: false, checks: [], tests: [], problems: ["the test TV tries apps with a page of their own"] };
  rmSync(o.storage, { recursive: true, force: true });
  mkdirSync(o.storage, { recursive: true });
  const apps = new PageApps({
    state: o.storage,
    root: o.root,
    find: async (id) => (id === manifest.id ? { manifest, dir: o.app } : null),
    viewer: async () => ({ id: "adult", name: "Test", role: "adult" }),
  });

  const stripped = (path: string) => stripTypeScriptTypes(readFileSync(join(o.root, path), "utf8"), { mode: "strip" });
  const sent = (response: ServerResponse, status: number, type: string, body: string | Buffer) => {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(body);
  };
  const body = async (request: IncomingMessage) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    return JSON.parse(text || "{}");
  };

  let port = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://x");
      const id = pageAppId(request.headers.host, port);
      if (id) {
        if (id !== manifest.id) return sent(response, 404, "text/plain", "no such app\n");
        if (url.pathname === "/_agentv/test.js") return sent(response, 200, "text/javascript", stripped("builder/gates/frame.ts"));
        const test = /^\/_agentv\/tests\/(\d+)\.js$/.exec(url.pathname);
        if (test) return o.tests[Number(test[1])] ? sent(response, 200, "text/javascript", testScript(o.tests[Number(test[1])])) : sent(response, 404, "text/plain", "");
        if (url.pathname === "/" || url.pathname === `/${manifest.entryPoints.page}`) return entryPage(apps, manifest, o.tests, request, response, port);
        return apps.serve(id, request, response, port);
      }
      // The page like home, on localhost, which the app's policy lets frame it.
      if (url.pathname === "/") return sent(response, 200, "text/html; charset=utf-8", HOST_PAGE);
      if (url.pathname === "/builder/gates/host.ts" || url.pathname === "/launcher/kit-host.ts") return sent(response, 200, "text/javascript", stripped(url.pathname.slice(1)));
      if (url.pathname === "/plan") return sent(response, 200, "application/json", JSON.stringify({ app: manifest.id, origin: pageOrigin(manifest.id, port), declared: manifest.tv.origins ?? [] }));
      if (url.pathname === "/state") {
        const storage: Record<string, unknown> = {};
        const keys = ((await apps.call(manifest.id, "storage.keys", [])).value as string[]) ?? [];
        for (const key of keys) storage[key] = (await apps.call(manifest.id, "storage.get", [key])).value;
        return sent(response, 200, "application/json", JSON.stringify({ storage, tile: await apps.tile(manifest.id) }));
      }
      if (url.pathname === "/kit" && request.method === "POST") {
        const { call, args } = await body(request);
        const answer = media.has(call) ? (refusal(manifest, call, true) ? { error: refusal(manifest, call, true) } : { value: media.get(call)!(Array.isArray(args) ? args : []) }) : await apps.call(manifest.id, call, Array.isArray(args) ? args : []);
        return sent(response, 200, "application/json", JSON.stringify(answer));
      }
      sent(response, 404, "text/plain", "not here\n");
    } catch (error) {
      if (!response.headersSent) sent(response, 500, "text/plain", `${(error as Error).message}\n`);
    }
  });
  port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

  const profile = mkdtempSync(join(tmpdir(), "agentv-testtv-"));
  const flags = [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-component-update",
    "--disable-breakpad",
    // The sandbox's /dev is a small one of its own: shared memory goes in /tmp.
    "--disable-dev-shm-usage",
    "--disable-crash-reporter",
    "--mute-audio",
    "--window-size=1920,1080",
    "--enable-precise-memory-info",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--autoplay-policy=no-user-gesture-required",
    ...(o.proxy ? [`--proxy-server=${o.proxy}`, "--proxy-bypass-list=localhost;*.localhost;127.0.0.1"] : []),
    `http://localhost:${port}/`,
  ];
  // In a process group of its own, so all of Chromium goes when it's done.
  const browser = spawn(o.chromium, flags, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], detached: true });
  const cdp = new CdpPipe(browser.stdio[3] as Writable, browser.stdio[4] as Readable);
  const home = `http://localhost:${port}/`;
  const report: TryReport = { ready: false, checks: [], tests: [], problems: [] };
  try {
    // The page, with its test TV ready to drive.
    const until = Date.now() + 30_000;
    for (;;) {
      const there = await cdp.evaluate(home, "typeof window.testTv").catch(() => "");
      if (there === "object") break;
      if (Date.now() > until) throw new Error("the test TV didn't open");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // A TV's screen, whatever the headless window around it.
    const page = (await cdp.pages()).find((p) => p.url.startsWith(home));
    if (page) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sessionId);
    }
    const started = (await cdp.evaluate(home, "testTv.start()")) as { ready: boolean; names: string[] };
    report.ready = started.ready;
    if (!started.ready) report.problems.push("it didn't call agentv.ready() within 10 seconds");
    if (o.shot) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      report.shot = await screenshot(cdp, home, o.shot).catch(() => undefined);
    }
    if (o.checks) {
      report.checks = (await cdp.evaluate(home, "testTv.checks()")) as Check[];
      for (const check of report.checks) if (!check.ok && check.id !== "ready") report.problems.push(check.says);
    }
    for (let i = 0; i < started.names.length; i++) {
      const result = (await cdp.evaluate(home, `testTv.test(${i})`)) as TestResult;
      report.tests.push(result);
      if (!result.ok) report.problems.push(`the test "${result.name}" failed: ${result.failed.slice(0, 3).join("; ")}`);
    }
    if (o.tests.length && started.names.length === 0) report.problems.push("the tests registered no test()");
  } catch (error) {
    report.problems.push(`the test TV couldn't try it: ${(error as Error).message}`);
  } finally {
    await stop(browser.pid);
    server.closeAllConnections();
    server.close();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {}
  }
  return report;
}

// Chromium and every process it started, gently, then not.
async function stop(pid: number | undefined): Promise<void> {
  if (!pid) return;
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 30 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (alive()) process.kill(-pid, "SIGKILL");
}

// The app's own page, with the test TV's runner first and the tests last,
// under the app's own policy, which lets in scripts of its own origin.
async function entryPage(apps: PageApps, manifest: Manifest, tests: TestFile[], request: IncomingMessage, response: ServerResponse, port: number): Promise<void> {
  const captured: { status: number; headers: Record<string, string>; body: Buffer } = { status: 500, headers: {}, body: Buffer.alloc(0) };
  const fake = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return fake;
    },
    end(body?: string | Buffer) {
      captured.body = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
    },
  };
  await apps.serve(manifest.id, request, fake as unknown as ServerResponse, port);
  let html = captured.body.toString("utf8");
  if (captured.status === 200) {
    const first = `<script src="/_agentv/test.js"></script>`;
    const last = tests.map((_, i) => `<script src="/_agentv/tests/${i}.js"></script>`).join("");
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => `${head}${first}`) : `${first}${html}`;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${last}</body>`) : `${html}${last}`;
  }
  const headers = { ...captured.headers, "Content-Length": String(Buffer.byteLength(html)) };
  response.writeHead(captured.status, headers);
  response.end(html);
}

async function screenshot(cdp: CdpPipe, home: string, path: string): Promise<string> {
  const page = (await cdp.pages()).find((p) => p.url.startsWith(home));
  if (!page) throw new Error("no page");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(path, Buffer.from(data, "base64"));
  return path;
}

// A test TV's report, for the agent to read.
export function said(report: TryReport): string {
  const lines: string[] = [];
  lines.push(report.ready ? "it opened and said it's drawn" : "it didn't say it's drawn: call agentv.ready() once the first frame is there");
  for (const check of report.checks) lines.push(`${check.ok ? "ok" : "not ok"}: ${check.says}`);
  for (const test of report.tests) lines.push(`${test.ok ? "ok" : "not ok"}: ${test.name}${test.ok ? "" : ` (${test.failed.join("; ")})`}`);
  for (const problem of report.problems) if (!lines.some((line) => line.includes(problem))) lines.push(`not ok: ${problem}`);
  return lines.join("\n");
}
