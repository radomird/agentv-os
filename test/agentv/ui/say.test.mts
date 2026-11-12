// A sentence said to the TV, on the TV and the phone in a real Chromium
// (ADR-023, layer 4): the phone's box takes it, both show what the TV made
// of it, up to three to choose from on either, Back puts them away, and a
// sentence that can't be routed is "i didn't get that" on both, with
// nothing opened (S7.3). While the phone's box is open, the TV's listening
// bar shows the words as they arrive, then thinking, then what came of it
// (ADR-054). The router and the screen daemon are stand-ins.

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
import { PHASE_1, startBox } from "./box.mts";

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
  "play the frozen film": { ...NONE, intent: "play", query: "Frozen", kind: "film" },
  "play the frozen soundtrack": { ...NONE, intent: "play", query: "Frozen", kind: "album" },
};
// One the router takes a while over, as a real one can.
const SLOW = "play the frozen soundtrack";

before(async () => {
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  process.env.AGENTV_PASSWD = passwd;
  ({ daemon, url } = await startBox(0, undefined, {
    features: PHASE_1,
    listenIdleMs: 1500,
    router: async (sentence) => {
      if (sentence === SLOW) await new Promise((resolve) => setTimeout(resolve, 800));
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
  await fetch(`${url}/api/phones/pair`, { method: "POST" });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${phoneUrl}/#pair=${daemon.phones.secret()}`);
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
  assert.equal(await screen.locator("#said .notice-title").textContent(), "Which one?");
  assert.equal(await screen.locator("#said .said-heard").textContent(), '"play frozen"');
  assert.equal(await screen.evaluate(() => document.querySelector("#said .focused")?.textContent), "frozen · film · sample");
  // The phone: the same two, under its box.
  await hand.waitForSelector('[data-said="choose"]');
  assert.deepEqual(await hand.locator(".said-choice").allTextContents(), ["Frozen · film · Sample", "Frozen · album · Sample"]);
  // The soundtrack, picked with the remote on the TV.
  asks.length = 0;
  await screen.keyboard.press("ArrowDown");
  await screen.keyboard.press("Enter");
  await until(() => asks.some((a) => a.kind === "open"));
  assert.deepEqual(asks.find((a) => a.kind === "open"), { kind: "open", app: "agentv.sample", item: { id: "a1", kind: "album", title: "Frozen", subtitle: "Various Artists · Frozen" }, n: (asks.find((a) => a.kind === "open") as SayAsk & { n: number }).n });
  await screen.waitForFunction(() => !document.querySelector("#said.on"));
  // Asked from the phone's box, so the listening bar says what came of it,
  // in place of a toast (ADR-054).
  await screen.waitForFunction(() => document.querySelector("#listening.on .listening-words")?.textContent === "Frozen, on Sample");
  assert.equal(await screen.locator(".toast.ok", { hasText: "Frozen, on Sample" }).count(), 0);
  await hand.waitForSelector('[data-said="opened"]');
  assert.equal(await hand.locator(".said-say").textContent(), "Frozen, on Sample");
  await screen.close();
  await hand.close();
});

// Home draws again whenever something changes elsewhere, such as a phone
// pairing, a setting, or the catch-up as its events start. Drawn again under
// the "which one?" card, it leaves the remote's keys with the card.
test("home drawn again under the which one? card leaves the remote on the card", async () => {
  const screen = await tv();
  const hand = await phone();
  await ask(hand, "play frozen");
  await screen.waitForSelector("#said.on .said-choice");
  await screen.evaluate(() => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go("home"));
  asks.length = 0;
  await screen.keyboard.press("ArrowDown");
  await screen.keyboard.press("Enter");
  await until(() => asks.some((a) => a.kind === "open"));
  assert.equal((asks.find((a) => a.kind === "open") as { item: { kind: string } }).item.kind, "album");
  await screen.waitForFunction(() => !document.querySelector("#said.on"));
  await screen.waitForSelector(".grid .tile.focused");
  await hand.waitForSelector('[data-said="opened"]');
  await screen.close();
  await hand.close();
});

// Q162: a pick's reply and its outcome's event come back on two
// connections, in either order. Here the reply comes first, and the
// outcome after it, as the phone's pick.
test("a pick whose reply comes before its outcome keeps the bar on 'which one?' until the outcome takes its place, with no toast", async () => {
  const screen = await tv();
  const hand = await phone();
  await ask(hand, "play frozen");
  await screen.waitForSelector("#said.on .said-choice");
  await hand.waitForSelector('[data-said="choose"]');
  await screen.route(/\/api\/say\/pick$/, (route) => route.fulfill({ json: { ok: true } }));
  await screen.keyboard.press("Enter");
  await screen.waitForFunction(() => !document.querySelector("#said.on"));
  assert.equal(await screen.locator('#listening.on[data-state="said"] .listening-words').textContent(), "Which one?");
  await hand.click('[data-action="said-pick"][data-choice="1"]');
  await screen.waitForFunction(() => document.querySelector("#listening.on .listening-words")?.textContent === "Frozen, on Sample");
  assert.equal(await screen.locator(".toast", { hasText: "Frozen, on Sample" }).count(), 0);
  await screen.close();
  await hand.close();
});

// The phone sends its box's words a moment after each change, and the
// sentence on a connection of its own, so on a slow phone or network the
// last words land after the sentence. They don't bring the bar back over
// what came of it. Here they're held until the TV shows the choice.
test("words that land after their sentence leave the bar on 'which one?'", async () => {
  const screen = await tv();
  const hand = await phone();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  // What the phone sends is sealed, so the words are known by their turn:
  // the box's opening goes first, on its focus, and the words second.
  let words = 0;
  let live = 0;
  let late: unknown = null;
  await hand.route(/\/api\/phone\/say\/live$/, async (route) => {
    if (++live === 2) {
      late = route.request();
      words++;
      await held;
    }
    await route.continue();
  });
  await hand.fill("#say-text", "play frozen");
  await until(() => words === 1);
  await hand.click('[data-action="say"]');
  await screen.waitForSelector("#said.on .said-choice");
  assert.equal(await screen.locator('#listening.on[data-state="said"] .listening-words').textContent(), "Which one?");
  const landed = hand.waitForResponse((response) => response.request() === late);
  release();
  await landed;
  // Long enough for an event the late words set off to reach the TV.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await screen.locator('#listening.on[data-state="said"] .listening-words').textContent({ timeout: 2000 }), "Which one?");
  assert.equal(await screen.locator("#said.on .said-choice").count(), 2, "and the choice is still up");
  await screen.keyboard.press("Escape");
  await screen.waitForFunction(() => !document.querySelector("#said.on") && !document.querySelector("#listening.on"));
  await screen.close();
  await hand.close();
});

test("a pick that fails puts the bar away and says why", async () => {
  const screen = await tv();
  const hand = await phone();
  await ask(hand, "play frozen");
  await screen.waitForSelector("#said.on .said-choice");
  await screen.route(/\/api\/say\/pick$/, (route) => route.fulfill({ status: 409, json: { ok: false, error: "that choice has gone" } }));
  // The toast stays 5 s, so it's looked for from the moment the pick goes.
  const toast = screen.locator(".toast.fail", { hasText: "that choice has gone" }).waitFor();
  await screen.keyboard.press("Enter");
  await toast;
  await screen.waitForFunction(() => !document.querySelector("#said.on") && !document.querySelector("#listening.on"));
  await hand.click('[data-action="said-none"]').catch(() => {});
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
  assert.equal(await hand.locator(".said-say").textContent(), "Didn't get that");
  await screen.waitForFunction(() => document.querySelector('#listening.on[data-state="said"] .listening-words')?.textContent === "Didn't get that");
  assert.equal(await screen.locator("#said.on").count(), 0);
  // Only the bar, for over an app in front: nothing looked up or opened.
  await until(() => asks.some((a) => a.kind === "live" && a.state === "said"));
  assert.deepEqual(asks.filter((a) => a.kind !== "live"), []);
  // Said with no box open, there's no bar, and it's a toast.
  asks.length = 0;
  await fetch(`${url}/api/say`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sentence: "turn the lights off" }) });
  await screen.waitForFunction(() => [...document.querySelectorAll(".toast.fail")].some((t) => t.textContent === "Didn't get that"));
  await until(() => asks.some((a) => a.kind === "tell"));
  await screen.close();
  await hand.close();
});

// The bar's states, as the TV draws them, each one once.
async function watchBar(screen: Page): Promise<() => Promise<string[]>> {
  await screen.evaluate(() => {
    const w = window as unknown as { barStates: string[] };
    w.barStates = [];
    new MutationObserver(() => {
      const bar = document.getElementById("listening");
      const now = bar?.classList.contains("on") ? `${bar.dataset.state}: ${bar.querySelector(".listening-words")?.textContent}` : "off";
      if (w.barStates.at(-1) !== now) w.barStates.push(now);
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  return () => screen.evaluate(() => (window as unknown as { barStates: string[] }).barStates);
}

test("ADR-054 the phone's box brings a listening bar to the TV, and its words show there as they arrive", async () => {
  const screen = await tv();
  const hand = await phone();
  const states = await watchBar(screen);
  await hand.focus("#say-text");
  await screen.waitForSelector('#listening.on[data-state="listening"]');
  assert.equal(await screen.locator(".listening-words").textContent(), "listening");
  assert.equal(await screen.locator(".listening-dots span").count(), 3);
  // As the dictation fills the box: a fifth of a second after the last
  // change, the TV has the words so far.
  asks.length = 0;
  await hand.type("#say-text", "play fro", { delay: 20 });
  await screen.waitForFunction(() => document.querySelector("#listening .listening-words")?.textContent === "play fro");
  await until(() => asks.some((a) => a.kind === "live" && a.state === "words" && a.text === "play fro"));
  // Closed on the phone, unsent: the bar goes.
  await hand.evaluate(() => (document.getElementById("say-text") as HTMLInputElement).blur());
  await screen.waitForFunction(() => !document.querySelector("#listening.on"));
  assert.deepEqual((await states()).filter((s) => !s.startsWith("listening: play f") || s === "listening: play fro"), ["listening: listening", "listening: play fro", "off"]);
  await screen.close();
  await hand.close();
});

test("ADR-054 sent from the box, the bar says it's thinking, then what came of it, or brings the which one? card", async () => {
  const screen = await tv();
  const hand = await phone();
  const states = await watchBar(screen);
  await ask(hand, "turn the lights off");
  await screen.waitForFunction(() => document.querySelector('#listening.on[data-state="said"]'));
  const seen = await states();
  assert.ok(seen.includes("thinking: turn the lights off"), seen.join(" | "));
  assert.equal(seen.at(-1), "said: Didn't get that");
  assert.equal(await screen.locator(".toast", { hasText: "Didn't get that" }).count(), 0, "the bar, not a toast");
  // Which one: the bar says so, with the card over home, and goes with it.
  await ask(hand, "play frozen");
  await screen.waitForSelector("#said.on .said-choice");
  assert.equal(await screen.locator('#listening.on[data-state="said"] .listening-words').textContent(), "Which one?");
  await screen.keyboard.press("Escape");
  await screen.waitForFunction(() => !document.querySelector("#said.on") && !document.querySelector("#listening.on"));
  await screen.close();
  await hand.close();
});

test("ADR-054 what opened is on the bar, and a box opened again while a sentence is thought about keeps its words, on the TV and the phone", async () => {
  const screen = await tv();
  const hand = await phone();
  const states = await watchBar(screen);
  await ask(hand, "play the frozen film");
  await screen.waitForFunction(() => document.querySelector('#listening.on[data-state="said"] .listening-words')?.textContent === "Frozen, on Sample");
  assert.ok((await states()).includes("thinking: play the frozen film"));
  await hand.waitForSelector('[data-said="opened"]');
  assert.equal(await hand.locator(".said-say").textContent(), "Frozen, on Sample");
  assert.equal(await screen.locator(".toast", { hasText: "Frozen, on Sample" }).count(), 0, "the bar, not a toast");
  // The next one, begun while the last is thought about: the bar and the
  // phone's box keep its words, and what came of the last is a toast.
  await ask(hand, SLOW);
  await screen.waitForSelector('#listening.on[data-state="thinking"]');
  assert.equal(await screen.locator(".listening-says").textContent(), "thinking");
  await hand.waitForSelector('[data-said="routing"]');
  await hand.type("#say-text", "continue my show");
  await screen.waitForFunction(() => document.querySelector('#listening.on[data-state="listening"] .listening-words')?.textContent === "continue my show");
  await screen.waitForFunction(() => [...document.querySelectorAll(".toast.ok")].some((t) => t.textContent === "Frozen, on Sample"));
  await hand.waitForSelector('[data-said="opened"]');
  assert.equal(await hand.inputValue("#say-text"), "continue my show");
  assert.equal(await hand.evaluate(() => document.activeElement?.id), "say-text");
  assert.equal(await screen.locator(".listening-words").textContent(), "continue my show");
  assert.equal(await screen.locator(".listening-says").textContent(), "");
  await hand.evaluate(() => (document.getElementById("say-text") as HTMLInputElement).blur());
  await screen.waitForFunction(() => !document.querySelector("#listening.on"));
  await screen.close();
  await hand.close();
});

test("ADR-054 Back on the TV takes the bar away, and so does a while with no new words", async () => {
  const screen = await tv();
  const hand = await phone();
  await hand.focus("#say-text");
  await screen.waitForSelector("#listening.on");
  await screen.keyboard.press("Escape");
  await screen.waitForFunction(() => !document.querySelector("#listening.on"));
  // The daemon heard Back too: a new word brings it up again.
  await hand.type("#say-text", "pl");
  await screen.waitForSelector("#listening.on");
  // And with no new words for a while, it goes by itself.
  await screen.waitForFunction(() => !document.querySelector("#listening.on"), undefined, { timeout: 5000 });
  await screen.close();
  await hand.close();
});

test("ADR-054 the bar moves only by opacity, and stands still with reduce motion", async () => {
  const screen = await tv();
  const hand = await phone();
  await hand.focus("#say-text");
  await screen.waitForSelector("#listening.on");
  const look = () => screen.evaluate(() => {
    const dot = getComputedStyle(document.querySelector(".listening-dots span")!);
    const bar = getComputedStyle(document.getElementById("listening")!);
    return { dot: dot.animationName, bar: bar.transitionProperty, opacity: dot.opacity };
  });
  const moving = await look();
  assert.equal(moving.dot, "listening-dot");
  assert.equal(moving.bar, "opacity");
  await screen.evaluate(() => document.documentElement.classList.add("reduce-motion"));
  const still = await look();
  assert.deepEqual([still.dot, still.opacity], ["none", "1"]);
  await hand.evaluate(() => (document.getElementById("say-text") as HTMLInputElement).blur());
  await screen.close();
  await hand.close();
});

