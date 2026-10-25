// A web app's page, in a real Chromium (the contract's AppPage, ADR-019 layer
// 4): the app in its worker, its page driven over DevTools the way the
// screen daemon drives the services' Chromium (daemon/page.ts). Its
// playback state comes from the page (S3.3), it opens a title with the
// site's own search, and the loader keeps the page on the app's origins.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, CDPSession, Page } from "playwright-core";
import { validatePackage } from "../../../apps/contract/manifest.ts";
import { AppHost } from "../../../daemon/apps/loader.ts";
import { cdpPage } from "../../../daemon/page.ts";
import { ROOT } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");
const PAGER = join(ROOT, "test/agentv/fixtures/apps/pager");
const viewer = { id: "you", role: "adult" as const };

const PAGES: Record<string, string> = {
  "/": `<!doctype html><title>Sintel · S1 E2</title><div id="player" data-position="42.4" data-duration="888" data-playing="yes"></div>`,
  "/search.html": `<!doctype html><title>Search</title>
    <input id="q"><button id="play" onclick="document.title = 'Playing ' + document.getElementById('q').value">play</button>
    <script>document.getElementById("q").addEventListener("keydown", (e) => { if (e.key === "Enter") document.body.dataset.searched = e.target.value; });</script>`,
};

let browser: Browser;
let page: Page;
let session: CDPSession;
let server: Server;
let origin = "";
let host: AppHost;

before(async () => {
  server = createServer((request, response) => {
    const body = PAGES[new URL(request.url ?? "/", "http://x").pathname];
    response.writeHead(body ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" }).end(body ?? "");
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
  page = await browser.newPage();
  await page.goto(`${origin}/`);
  session = await page.context().newCDPSession(page);
  // The screen daemon's evaluateIn, over this page's own DevTools session.
  const devtools = {
    async evaluateIn(_target: string, expression: string) {
      const reply = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result.value;
    },
  };
  const { manifest } = validatePackage(PAGER, "official");
  host = new AppHost({ dir: PAGER, manifest: manifest!, settings: { serverUrl: origin }, page: cdpPage(devtools, () => "t1") });
});

after(async () => {
  host?.stop();
  await browser?.close();
  server?.close();
});

test("S3.3 an app reads its playback state from its page in Chromium, through its worker", async () => {
  const state = await host.call(viewer, "playback.readPlaybackState");
  assert.deepEqual(state, { title: "Sintel", season: 1, episode: 2, position: 42.4, duration: 888, playing: true });
});

test("an app opens a title with the site's own search: goto, waitForSelector, fill, press and click", async () => {
  await host.call(viewer, "playback.open", { id: "x", kind: "film", title: "Spring" });
  assert.equal(new URL(page.url()).pathname, "/search.html");
  assert.equal(await page.inputValue("#q"), "Spring");
  assert.equal(await page.evaluate(() => document.body.dataset.searched), "Spring");
  assert.equal(await page.title(), "Playing Spring");
  // Off the player, the app says nothing is playing.
  assert.equal(await host.call(viewer, "playback.readPlaybackState"), null);
});

test("the loader keeps an app's page on its own origins", async () => {
  await assert.rejects(host.call(viewer, "search", "sintel"), /elsewhere\.invalid isn't one of the app's origins/);
  assert.equal(new URL(page.url()).origin, origin, "the page didn't go");
  // A page someone else took off the app's origins answers the app nothing.
  await page.goto("about:blank");
  await assert.rejects(host.call(viewer, "playback.open", { id: "x", kind: "film", title: "Spring" }), /isn't on one of the app's origins/);
  assert.equal(page.url(), "about:blank");
  await page.goto(`${origin}/`);
  assert.equal(((await host.call(viewer, "playback.readPlaybackState")) as { title: string }).title, "Sintel");
});

test("an app with no page open gets none", async () => {
  host.setPage(undefined);
  await assert.rejects(host.call(viewer, "playback.readPlaybackState"), /no page/);
});
