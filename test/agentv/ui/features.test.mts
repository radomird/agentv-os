// The feature switches on the TV's pages, in a real Chromium (layer 4).
// Every phase 2 track hides what people can see behind one of these
// (PHASE-2-PLAN.md, "Feature switches"), and layer 4 runs each switched
// screen both ways with bothWays from box.mts. Here, home reads its switch
// each way, marks it on <html> for CSS, and follows `agentv feature on`
// without a reload. A stable box's page never sees a switch turned on.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { FEATURE_NAMES } from "../../../daemon/features.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { bothWays, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
});

// The TV pages' own module for the switches, as the page imports it.
const MODULE = "/launcher/features.ts";
type PageFeatures = typeof import("../../../launcher/features.ts");

// Home on the TV, and the switches as its page reads them.
async function home(url: string): Promise<{ page: Page; on: (name: string) => Promise<boolean>; marked: () => Promise<string> }> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  await page.evaluate((path) => (import(path) as Promise<PageFeatures>).then((m) => m.features()), MODULE);
  return {
    page,
    on: (name) => page.evaluate(([path, name]) => (import(path) as Promise<PageFeatures>).then((m) => m.featureOn(name)), [MODULE, name]),
    marked: () => page.evaluate(() => document.documentElement.dataset.features ?? ""),
  };
}

function put(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/features`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

bothWays("looks", "T12.1 home reads its switch and marks it for CSS", async (on, options) => {
  const { daemon, url } = await startBox(0, undefined, options);
  try {
    const tv = await home(url);
    assert.equal(await tv.on("looks"), on);
    assert.equal((await tv.marked()).split(" ").includes("looks"), on);
    // Every other switch stays off either way.
    for (const name of FEATURE_NAMES.filter((name) => name !== "looks")) assert.equal(await tv.on(name), false, name);
    await tv.page.close();
  } finally {
    await daemon.close();
  }
});

test("T12.1 a switch turned on shows on the TV without a reload, and off again", async () => {
  // An edge box, as `agentv channel edge` leaves it, with nothing switched.
  const { daemon, url } = await startBox(0, undefined, { features: { sizes: true } });
  let tv: Awaited<ReturnType<typeof home>> | undefined;
  try {
    tv = await home(url);
    assert.equal(await tv.on("remote2"), false);
    const seen = tv.page.evaluate(
      (path) =>
        new Promise<boolean>((resolve) => {
          void (import(path) as Promise<PageFeatures>).then((m) => m.onFeatures((all) => all.remote2 && resolve(true)));
        }),
      MODULE,
    );
    const answer = await put(url, { remote2: true });
    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).remote2, true);
    assert.equal(await seen, true);
    assert.equal(await tv.on("remote2"), true);
    assert.match(await tv.marked(), /\bremote2\b/);
    await put(url, { remote2: false });
    await tv.page.waitForFunction(() => !(document.documentElement.dataset.features ?? "").split(" ").includes("remote2"));
    assert.equal(await tv.on("remote2"), false);
  } finally {
    await tv?.page.close();
    await daemon.close();
  }
});

test("T12.1 a stable box's page never sees a switch turned on", async () => {
  const { daemon, url } = await startBox(0, undefined, {});
  let tv: Awaited<ReturnType<typeof home>> | undefined;
  try {
    const refused = await put(url, { looks: true });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /only turn on on edge/);
    tv = await home(url);
    assert.equal(await tv.on("looks"), false);
    assert.equal(await tv.marked(), "");
  } finally {
    await tv?.page.close();
    await (daemon as Daemon).close();
  }
});
