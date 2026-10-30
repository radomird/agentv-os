// A sentence said to the TV, on the TV and the phone in a real Chromium
// (ADR-023, layer 4): the phone's box takes it, both show what the TV made
// of it, up to three to choose from on either, Back puts them away, and a
// sentence that can't be routed is "i didn't get that" on both, with
// nothing opened (S7.3). The router and the screen daemon are stand-ins.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { AskWatch } from "../../../daemon/asks.ts";
import { NONE, type Route } from "../../../daemon/router.ts";
import type { SayAnswer, SayAsk } from "../../../daemon/say.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let phoneUrl = "";
let watch: AskWatch<SayAsk, SayAnswer>;
const asks: SayAsk[] = [];
const errors: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "agentv-say-ui-"));

// What the stand-in router makes of each sentence; anything else is none.
const ROUTES: Record<string, Route> = {
  "play frozen": { ...NONE, intent: "play", query: "Frozen" },
};

before(async () => {
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  process.env.AGENTV_PASSWD = passwd;
  ({ daemon, url } = await startBox(0, undefined, {
    router: async (sentence) => {
      const route = ROUTES[sentence];
      return { sentence, route: route ?? { ...NONE }, ...(route ? {} : { none: "unroutable" as const }), provider: "claude", via: "api", model: "test", ms: 5 };
    },
  }));
  phoneUrl = `http://127.0.0.1:${daemon.lanPort}`;
  // The screen daemon: the sample app finds Frozen the film and its
  // soundtrack, and anything chosen opens.
  watch = new AskWatch<SayAsk, SayAnswer>({
    url: `${url}/`,
    path: "api/say/ask",
    what: "a sentence",
    handle: async (ask) => {
      asks.push(ask);
      if (ask.kind !== "search") return { ok: true };
      return { ok: true, found: ask.apps.map((app) => ({ app, items: [{ id: "f1", kind: "film" as const, title: "Frozen" }, { id: "a1", kind: "album" as const, title: "Frozen", subtitle: "Various Artists · Frozen" }] })) };
    },
    failed: (error) => ({ ok: false, error: error.message }),
    log: () => {},
    retryMs: 50,
  });
  watch.start();
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  watch.stop();
  await browser?.close();
  await daemon?.close();
  delete process.env.AGENTV_PASSWD;
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

async function phone(): Promise<Page> {
  const { pairing } = await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${phoneUrl}/?code=${pairing.code}`);
  await page.waitForSelector(".dpad");
  return page;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("it didn't happen in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function ask(hand: Page, sentence: string): Promise<void> {
  await hand.fill("#say-text", sentence);
  await hand.click('[data-action="say"]');
}

test("S7.1 'play frozen' from the phone: the TV and the phone both offer the film and the soundtrack, and the TV's pick opens it", async () => {
  const screen = await tv();
  const hand = await phone();
  assert.equal(await hand.getAttribute("#say-text", "enterkeyhint"), "send");
  await ask(hand, "play frozen");
  // The TV: a card with the two and "none of these", the first focused.
  await screen.waitForSelector("#said.on .said-choice");
  assert.deepEqual(await screen.locator("#said .said-choice").allTextContents(), ["frozen · film · sample", "frozen · album · sample"]);
  assert.equal(await screen.locator("#said .notice-title").textContent(), "which one?");
  assert.equal(await screen.locator("#said .said-heard").textContent(), '"play frozen"');
  assert.equal(await screen.evaluate(() => document.querySelector("#said .focused")?.textContent), "frozen · film · sample");
  // The phone: the same two, under its box.
  await hand.waitForSelector('[data-said="choose"]');
  assert.deepEqual(await hand.locator(".said-choice").allTextContents(), ["frozen · film · sample", "frozen · album · sample"]);
  // The soundtrack, picked with the remote on the TV.
  asks.length = 0;
  await screen.keyboard.press("ArrowDown");
  await screen.keyboard.press("Enter");
  await until(() => asks.some((a) => a.kind === "open"));
  assert.deepEqual(asks.find((a) => a.kind === "open"), { kind: "open", app: "agentv.sample", item: { id: "a1", kind: "album", title: "Frozen", subtitle: "Various Artists · Frozen" }, n: (asks.find((a) => a.kind === "open") as SayAsk & { n: number }).n });
  await screen.waitForFunction(() => !document.querySelector("#said.on"));
  await screen.waitForFunction(() => [...document.querySelectorAll(".toast.ok")].some((t) => t.textContent === "frozen, on sample"));
  await hand.waitForSelector('[data-said="opened"]');
  assert.equal(await hand.locator(".said-say").textContent(), "frozen, on sample");
  await screen.close();
  await hand.close();
});

test("the phone can pick one too, and Back on the TV puts the choice away", async () => {
  const screen = await tv();
  const hand = await phone();
  await ask(hand, "play frozen");
  await screen.waitForSelector("#said.on");
  await screen.keyboard.press("Escape");
  await screen.waitForFunction(() => !document.querySelector("#said.on"));
  await hand.waitForFunction(() => !document.querySelector('[data-said="choose"]'));
  // Again, and this time the phone picks the film.
  await ask(hand, "play frozen");
  await hand.waitForSelector('[data-said="choose"]');
  asks.length = 0;
  await hand.click('[data-action="said-pick"][data-choice="0"]');
  await until(() => asks.some((a) => a.kind === "open"));
  assert.equal((asks.find((a) => a.kind === "open") as { item: { kind: string } }).item.kind, "film");
  await screen.waitForFunction(() => !document.querySelector("#said.on"));
  await screen.close();
  await hand.close();
});

test("S7.3 a sentence that can't be routed is 'i didn't get that' on the TV and the phone, and nothing opens", async () => {
  const screen = await tv();
  const hand = await phone();
  asks.length = 0;
  await ask(hand, "turn the lights off");
  await hand.waitForSelector('[data-said="none"]');
  assert.equal(await hand.locator(".said-say").textContent(), "i didn't get that");
  await screen.waitForFunction(() => [...document.querySelectorAll(".toast.fail")].some((t) => t.textContent === "i didn't get that"));
  assert.equal(await screen.locator("#said.on").count(), 0);
  // Only the line for over an app in front: nothing looked up or opened.
  await until(() => asks.length > 0);
  assert.deepEqual(asks.map((a) => a.kind), ["tell"]);
  await screen.close();
  await hand.close();
});
