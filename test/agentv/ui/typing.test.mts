// What's typed on the phone, in the TV's field as it's typed (ADR-065, track
// 8's T8.1), on the daemon itself, with home in a real Chromium at 1920 ×
// 1080 and a stand-in streaming site in a second Chromium held over a
// DevTools pipe, as the screen daemon holds the services' one. The phone is
// stood in for by its requests. The screen daemon's part is its own code:
// the stream it takes from the daemon (daemon/remote.ts) and the typing into
// what's in front (daemon/remote-text.ts). The site's search field keeps
// its own state, as a web framework's does, so it only holds what it heard
// typed.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { CdpPipe } from "../../../daemon/cdp.ts";
import { RemoteInput } from "../../../daemon/remote.ts";
import { FOCUS_BINDING, REMOTE_PAGE, REMOTE_WORLD, SPATIAL_NAVIGATION } from "../../../daemon/remote-page.ts";
import { type Bar, FIELD, PhoneTyping, type TypingFront } from "../../../daemon/remote-text.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";
import { pairPhone, type TestPhone } from "../unit/phone-client.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const PAGES = resolve(import.meta.dirname, "../fixtures/remote");
// What the phone sends, a change at a time: accents, another alphabet and an
// emoji, and back again past the emoji.
const CHANGES = ["s", "si", "sin", "sint", "sinté", "sinté ж", "sinté жар", "sinté жар 🎬", "sinté жар 🎬!", "sinté жар"];
const WITHIN_MS = 300;

let browser: Browser;
let daemon: Daemon;
let url = "";
let phoneUrl = "";
let token: TestPhone;
let state = "";
let server: Server;
let site = "";
let services: ChildProcess;
let cdp: CdpPipe;
let input: RemoteInput;
// What the stand-in screen daemon has in front, what it pressed and the
// bars it had the overlay draw.
let front: TypingFront = null;
const keys: Record<string, unknown>[] = [];
const bars: (Bar | null)[] = [];
const errors: string[] = [];

const dir = mkdtempSync(join(tmpdir(), "agentv-typing-ui-"));

before(async () => {
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  process.env.AGENTV_PASSWD = passwd;
  ({ daemon, url, state } = await startBox());
  // The new remote is switched on, which only an edge box does.
  writeFileSync(join(state, "features.json"), JSON.stringify({ remote2: true }));
  writeFileSync(join(state, "..", "channel"), "edge\n");
  phoneUrl = `http://127.0.0.1:${daemon.lanPort}`;
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
  server = createServer((request, response) => {
    const name = new URL(request.url ?? "/", "http://x").pathname.slice(1);
    if (!/^[a-z-]+\.html$/.test(name)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(readFileSync(join(PAGES, name)));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  services = spawn(
    process.env.AGENTV_UI_BROWSER!,
    ["--headless=new", "--no-sandbox", "--remote-debugging-pipe", "--no-first-run", "--window-size=1920,1080", SPATIAL_NAVIGATION, `--user-data-dir=${mkdtempSync(join(tmpdir(), "agentv-typing-"))}`, "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  cdp = new CdpPipe(services.stdio[3] as Writable, services.stdio[4] as Readable);
  const typing = new PhoneTyping({
    front: () => front,
    keys: async (request) => void keys.push(request),
    bar: async (bar) => void bars.push(bar),
  });
  input = new RemoteInput({
    url: `${url}/api/remote`,
    send: async (request) => void keys.push(request),
    ask: async (ask) => (ask.kind === "text" ? typing.text(ask.value, ask.caret, ask.bar) : ask.kind === "done" ? typing.done() : { ok: false }),
    log: () => {},
  });
  input.start();
  const { pairing } = await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json();
  token = await pairPhone(phoneUrl, pairing.code, "iphone");
  await until(async () => (await phoneState()).ok === true);
});

after(async () => {
  input?.stop();
  await browser?.close();
  services?.kill();
  server?.close();
  await daemon?.close();
  delete process.env.AGENTV_PASSWD;
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

async function until(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("it didn't happen in time");
    await new Promise((done) => setTimeout(done, 10));
  }
}

const phoneState = async () => (await token.fetch(`/api/phone/state`)).json();

async function typeOnPhone(body: object): Promise<{ ok: boolean; why?: string; by?: string }> {
  const response = await token.fetch(`/api/phone/text`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return response.json();
}

// Each change in turn, and how long the TV's field took to hold it.
async function typeAll(changes: string[], read: () => Promise<unknown>): Promise<number[]> {
  const took: number[] = [];
  for (const value of changes) {
    const started = performance.now();
    void typeOnPhone({ value, caret: value.length });
    await until(async () => (await read()) === value, 2000).catch(() => {
      throw new Error(`the tv's field never held the change to ${[...value].length} characters`);
    });
    took.push(Math.round(performance.now() - started));
  }
  return took;
}

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);

// The stand-in site, opened as the screen daemon opens an app's page: the
// ring and Back, and the nudge when its focus moves, which has the screen
// daemon read the field in front and tell the daemon, as it does.
async function streamingSite(): Promise<{ target: string; nudges: () => number; evaluate: (expression: string) => Promise<any> }> {
  const target = await cdp.open(`${site}stream.html`);
  const evaluate = (expression: string) => cdp.evaluateIn(target, expression);
  await until(async () => (await evaluate(`document.readyState === "complete" && !!window.site && !!document.getElementById("frame")?.contentDocument?.getElementById("name")`).catch(() => false)) === true);
  await cdp.addScriptIn(target, REMOTE_PAGE, REMOTE_WORLD);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true });
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  let nudged = 0;
  const tell = async () => {
    const field = await evaluate(FIELD).catch(() => null);
    await fetch(`${url}/api/tv/context`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ front: "app", playing: false, ...(field ? { appField: { ...field, app: "agentv.tube" } } : {}) }) });
  };
  await cdp.bindIn(target, FOCUS_BINDING, REMOTE_WORLD, () => {
    nudged++;
    void tell();
  });
  return { target, nudges: () => nudged, evaluate };
}

test("T8.1 typed on the phone, home's focused field holds each change within 300 ms, é, ж and an emoji included, and the typing bar shows it", async () => {
  const screen = await tv();
  await go(screen, "profile/new");
  await screen.waitForSelector(".profile-name.focused");
  await until(async () => (await phoneState()).tv.view === "keyboard");
  assert.deepEqual((await phoneState()).tv.field, { kind: "text", label: "Name" });
  front = { kind: "page", id: "home", overlay: false, evaluate: (expression) => screen.evaluate(expression) };
  const took = await typeAll(CHANGES, () => screen.evaluate(() => (document.querySelector(".profile-name") as HTMLInputElement).value));
  assert.ok(took.every((ms) => ms < WITHIN_MS), `each change within ${WITHIN_MS} ms: ${took.join(", ")}`);
  // The bar says whose phone and shows what arrived, with the caret after it.
  await screen.waitForSelector("#typing.on");
  assert.equal(await screen.locator(".typing-who").textContent(), "radomir's phone");
  assert.equal(await screen.locator(".typing-text").textContent(), "sinté жар");
  assert.equal(await screen.locator("#typing.password").count(), 0);
  assert.deepEqual(bars, [], "home draws its own bar, so the overlay draws none");
  // Enter: the field's own, as a key, and the bar goes.
  assert.deepEqual(await typeOnPhone({ done: true }), { ok: true, by: "page" });
  assert.deepEqual(keys.at(-1), { key: "enter" });
  await screen.waitForSelector("#typing:not(.on)");
  await screen.close();
});

test("T8.1 a stand-in streaming site's search opens the phone's keyboard, and each change shows there within 300 ms, heard by the site as typing", async () => {
  const page = await streamingSite();
  await page.evaluate(`document.getElementById("search").focus()`);
  await until(async () => (await phoneState()).tv.field?.app === "agentv.tube");
  assert.equal((await phoneState()).tv.view, "keyboard");
  assert.ok(page.nudges() > 0, "the page said its focus moved");
  assert.deepEqual((await phoneState()).tv.field, { kind: "search", label: "Search", value: "", app: "agentv.tube", name: "Tube" });
  assert.equal(await page.evaluate(`typeof window.${FOCUS_BINDING}`), "undefined", "the site's own scripts can't reach the nudge");
  front = { kind: "page", id: "agentv.tube", overlay: true, evaluate: page.evaluate };
  bars.length = 0;
  const took = await typeAll(CHANGES, () => page.evaluate(`window.site.query`));
  assert.ok(took.every((ms) => ms < WITHIN_MS), `each change within ${WITHIN_MS} ms: ${took.join(", ")}`);
  assert.equal(await page.evaluate(`document.getElementById("results").textContent`), "results for sinté жар");
  assert.ok((await page.evaluate(`window.site.heard`)) >= CHANGES.length, "the site heard every change as typing");
  // Over an app, the overlay draws the bar.
  assert.deepEqual(bars.at(-1), { from: "radomir's phone", text: "sinté жар", password: false });
  // A caret in the middle stays where the phone has it.
  await typeOnPhone({ value: "sintel жар", caret: 5 });
  await until(async () => (await page.evaluate(`window.site.query`)) === "sintel жар");
  assert.deepEqual(await page.evaluate(`[document.getElementById("search").selectionStart, document.getElementById("search").selectionEnd]`), [5, 5]);
  await cdp.close(page.target);
});

test("T8.1 a field inside a frame and a password inside a shadow root: the keyboard follows each, and the password shows only as dots", async () => {
  const page = await streamingSite();
  front = { kind: "page", id: "agentv.tube", overlay: true, evaluate: page.evaluate };
  // The frame's name field.
  await page.evaluate(`document.getElementById("frame").contentDocument.getElementById("name").focus()`);
  await until(async () => (await phoneState()).tv.field?.label === "Your name");
  await typeAll(["é", "éa", "éaж"], () => page.evaluate(`document.getElementById("frame").contentDocument.getElementById("name").value`));
  // The sign-in form's email, then its password, in a shadow root.
  await page.evaluate(`document.getElementById("signin").shadowRoot.getElementById("email").focus()`);
  await until(async () => (await phoneState()).tv.field?.kind === "email");
  await page.evaluate(`document.getElementById("signin").shadowRoot.getElementById("password").focus()`);
  await until(async () => (await phoneState()).tv.field?.kind === "password");
  assert.equal("value" in (await phoneState()).tv.field, false, "a password's value never goes to the phones");
  bars.length = 0;
  const secret = "hunter2é🎬";
  await typeAll([...secret].map((_, i) => [...secret].slice(0, i + 1).join("")), () => page.evaluate(`document.getElementById("signin").shadowRoot.getElementById("password").value`));
  assert.deepEqual(bars.at(-1), { from: "radomir's phone", text: "•".repeat(9), password: true });
  assert.ok(bars.every((bar) => !bar || !bar.text.includes("hunter")), "the bar only ever had dots");
  assert.ok(!JSON.stringify(await phoneState()).includes("hunter"));
  await cdp.close(page.target);
});

test("T8.1 a password on home shows as dots on the typing bar, and never reaches home's page", async () => {
  const screen = await tv();
  await go(screen, "music/sources");
  await screen.waitForSelector('input[type="password"]');
  await screen.evaluate(() => {
    const launcher = (window as unknown as { agentvLauncher: { focus: { set(el: HTMLElement): void } } }).agentvLauncher;
    launcher.focus.set(document.querySelector('input[type="password"]') as HTMLElement);
  });
  // The screen daemon says home's in front again, after the site.
  await fetch(`${url}/api/tv/context`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ front: "home", playing: false }) });
  await until(async () => (await phoneState()).tv.field?.kind === "password");
  front = { kind: "page", id: "home", overlay: false, evaluate: (expression) => screen.evaluate(expression) };
  const heard: string[] = [];
  await screen.exposeFunction("heardTyping", (text: string) => void heard.push(text));
  // What home's page hears, from before the first change goes.
  await screen.evaluate(
    () =>
      new Promise<void>((open) => {
        const source = new EventSource("/api/events");
        source.addEventListener("typing", (message) => (window as unknown as { heardTyping(text: string): void }).heardTyping((message as MessageEvent).data));
        source.addEventListener("open", () => open());
      }),
  );
  await typeAll(["h", "hu", "hun", "hunt"], () => screen.evaluate(() => (document.querySelector('input[type="password"]') as HTMLInputElement).value));
  await screen.waitForSelector("#typing.on.password");
  assert.equal(await screen.locator(".typing-text").textContent(), "••••");
  await until(() => heard.some((data) => data.includes("••••")));
  assert.ok(heard.some((data) => data.includes('"text":"••••"')), "the dots reached the page");
  assert.ok(heard.every((data) => !/"text":"[^"•]/.test(data)), "only dots reached the page");
  await screen.close();
});
