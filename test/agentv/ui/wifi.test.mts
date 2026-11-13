// Wi-Fi in Settings, in a real Chromium (ADR-019, layer 4; track 16's
// T16.1), on the daemon itself, in each look: Settings, network lists the
// networks nearby with the one the TV is on marked, a network with a
// password opens its field and the paired phone types into it, the TV joins
// and says how it went, and a TV that lost its network says so on home with
// the hotspot's QR code, clear of the bar in each look. Changing the Wi-Fi asks for the adult PIN where one
// is set and for nothing where none is, and a child's profile can't.
//
// Root is stood in for by what it writes: a stand-in /run/agentv-hotspot,
// and something that takes the daemon's drop as agentv-hotspot does. The
// phone is stood in for by its requests, and the screen daemon's part in
// typing is its own code, as in typing.test.mts. qrencode is a stand-in.
// The radio, NetworkManager and the hotspot itself are the image layer's.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { RemoteInput } from "../../../daemon/remote.ts";
import { PhoneTyping, type TypingFront } from "../../../daemon/remote-text.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { rest, startBox } from "./box.mts";
import { rendered, shortfalls } from "./legible.mts";
import { pairFromTv, type TestPhone } from "../unit/phone-client.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
type Look = (typeof LOOKS)[number];
const SIZES = { larger: 1600, standard: 1920, more: 2400 } as const;
type Size = keyof typeof SIZES;
// A dark theme and a light one.
const THEMES = ["tokyo-night", "catppuccin-latte"];
const NETWORKS = [
  { ssid: "neighbours", signal: 30, secure: true },
  { ssid: "Home", signal: 82, secure: true },
  { ssid: "café open", signal: 55, secure: false },
  { ssid: "Cafe 5G", signal: 61, secure: true },
];
const PASSWORD = "correct horse";
const WRONG = "wrong horse 1";

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
let hotspot = "";
let phone: TestPhone;
let input: RemoteInput;
let front: TypingFront = null;
let online = true;
// What root has said, what it was asked, and its timers.
let said: Record<string, unknown> = {};
const asked: Record<string, unknown>[] = [];
let rootTimer: ReturnType<typeof setInterval>;
const keys: Record<string, unknown>[] = [];
const errors: string[] = [];
const tools = mkdtempSync(join(tmpdir(), "agentv-wifi-ui-"));
const path = process.env.PATH;

// What agentv-hotspot writes.
function rootSays(fields: Record<string, unknown>): void {
  said = { on: false, radio: true, ...fields };
  writeFileSync(join(hotspot, "state.json"), JSON.stringify(said));
}

// What agentv-hotspot does with the daemon's drop, for a box with no root:
// a look writes the list and which network the TV is on, and a join takes a
// moment, then works, or doesn't with the wrong password, and the TV stays
// on the network it was on.
function root(): void {
  const drop = join(state, "hotspot-drop", "request.json");
  rootTimer = setInterval(() => {
    let request: { id?: string; scan?: boolean; join?: { ssid: string; password: string; hidden: boolean } };
    try {
      request = JSON.parse(readFileSync(drop, "utf8"));
    } catch {
      return;
    }
    rmSync(drop, { force: true });
    // Its answer names the ask, as agentv-hotspot's does.
    const { id: answered, ...what } = request;
    asked.push(what);
    if (request.scan) {
      writeFileSync(join(hotspot, "networks.json"), JSON.stringify(NETWORKS));
      rootSays({ ...said, scanned: new Date().toISOString(), answered });
      return;
    }
    const join_ = request.join;
    if (!join_) return;
    const before = said;
    rootSays({ ...before, on: false, joining: join_.ssid, error: null, why: null });
    setTimeout(() => {
      if (join_.password === WRONG) rootSays({ ...before, joining: null, error: `that password didn't work for ${join_.ssid}`, why: "password", answered });
      else rootSays({ ...before, on: false, joining: null, wifi: join_.ssid, joined: { ssid: join_.ssid, address: "192.168.1.20" }, error: null, why: null, answered });
    }, 500);
  }, 30);
}

before(async () => {
  writeFileSync(join(tools, "qrencode"), `#!/bin/bash\necho '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21"><rect width="21" height="21"/><rect x="3" y="3" width="6" height="6" fill="#fff"/></svg>'\n`);
  chmodSync(join(tools, "qrencode"), 0o755);
  process.env.PATH = `${tools}:${path}`;
  const wifi = { wlan0: [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:01", internal: false, cidr: "192.168.1.20/24" }] };
  ({ daemon, url, state, hotspot } = await startBox(0, undefined, { interfaces: () => (online ? wifi : {}) }));
  writeFileSync(join(hotspot, "networks.json"), JSON.stringify(NETWORKS));
  rootSays({ wifi: "Home" });
  root();
  await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "field" }) });
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
  // The screen daemon's part in typing, with home's page in front.
  const typing = new PhoneTyping({ front: () => front, keys: async (request) => void keys.push(request), bar: async () => {} });
  input = new RemoteInput({
    url: `${url}/api/remote`,
    send: async (request) => void keys.push(request),
    ask: async (ask) => (ask.kind === "text" ? typing.text(ask.value, ask.caret, ask.bar) : ask.kind === "done" ? typing.done() : { ok: false }),
    log: () => {},
  });
  input.start();
  phone = await pairFromTv(url, `http://127.0.0.1:${daemon.lanPort}`, "iphone");
  await until(async () => (await phoneState()).ok === true);
});

after(async () => {
  clearInterval(rootTimer);
  input?.stop();
  await browser?.close();
  await daemon?.close();
  process.env.PATH = path;
  rmSync(tools, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

async function until(check: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("it didn't happen in time");
    await new Promise((done) => setTimeout(done, 20));
  }
}

const phoneState = async () => (await phone.fetch(`/api/phone/state`)).json();
const typeOnPhone = async (body: object) => (await phone.fetch(`/api/phone/text`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const network = async () => (await fetch(`${url}/api/network`)).json();
// The join root was handed last, once it has taken it. A look can come in
// between, as when Settings has just opened.
async function joinAsked(ssid: string): Promise<unknown> {
  const last = () => asked.filter((request) => request.join).at(-1) as { join: { ssid: string } } | undefined;
  await until(() => last()?.join.ssid === ssid);
  return last();
}

async function send(method: string, route: string, body?: unknown, grant?: string): Promise<{ status: number; data: any }> {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function useLook(look: Look): Promise<void> {
  assert.equal((await send("PUT", "/api/look", { look })).status, 200);
}

async function useTheme(theme: string): Promise<void> {
  assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200, `the theme ${theme} took`);
}

async function tv(size: Size = "standard"): Promise<Page> {
  const width = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height: Math.round((width * 9) / 16) } });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  await page.goto(`${url}/?size=${size}`);
  await page.waitForSelector("html[data-look] #page .focused");
  await rest(page);
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const text = (page: Page, selector: string) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);
// The focus on an element, as the remote's arrows put it there, then OK.
async function pick(page: Page, selector: string): Promise<void> {
  await page.evaluate((s) => {
    const launcher = (window as unknown as { agentvLauncher: { focus: { set(el: HTMLElement): void } } }).agentvLauncher;
    launcher.focus.set(document.querySelector(s) as HTMLElement);
  }, selector);
  await page.keyboard.press("Enter");
}

// The words as the page writes them, the same in every look: Terminal lowers
// them in CSS, which textContent doesn't see. A network's name goes in as it is.
const words = (_look: Look, sentence: string, ssid = "") => sentence.replace("%s", ssid);

// What's on the page outside the screen.
function offScreen(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((s) => {
    const found: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(s)) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      // What's in a list that scrolls with the focus is further down on
      // purpose. It still has to fit across.
      const scrolls = el.parentElement?.closest("[data-scroll]");
      if (scrolls && box.left >= -1 && box.right <= innerWidth + 1) continue;
      if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) found.push(`${el.className}: ${Math.round(box.left)},${Math.round(box.top)} to ${Math.round(box.right)},${Math.round(box.bottom)}`);
      if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).textOverflow !== "ellipsis" && getComputedStyle(el).overflowX !== "visible") found.push(`${el.className} cuts off what's in it`);
    }
    return found;
  }, selector);
}

// Settings, Network's Wi-Fi row opens this page.
async function settingsNetwork(page: Page): Promise<void> {
  await go(page, "settings/wifi");
  await page.waitForSelector(".wifi-panel button.network");
}

for (const look of LOOKS) {
  test(`T16.1 Settings, network in ${look}: the networks nearby with the TV's own marked, a password typed on the phone, and a join that works and one that doesn't`, async () => {
    await useLook(look);
    await useTheme(THEMES[0]);
    online = true;
    rootSays({ wifi: "Home" });
    asked.length = 0;
    const page = await tv();

    // How the TV is online, on Network's row: one line, with the network's
    // name as its value, which keeps its capitals where Terminal lowers the
    // words. OK on it opens the page.
    await go(page, "settings/network");
    await page.waitForFunction(() => document.querySelector('.settings-panel [data-action="wifi"] .button-value')?.textContent === "Home");
    assert.match(await page.locator('.settings-panel [data-action="wifi"]').innerText(), look === "terminal" ? /^wi-fi\s+Home$/ : /^Wi-Fi\s+Home$/);
    assert.equal(await page.locator(".settings-panel .panel-note").count(), 0);
    await pick(page, '.settings-panel [data-action="wifi"]');
    await page.waitForSelector(".wifi-panel button.network");

    // And at the top of its page.
    const on = `${words(look, "Wi-Fi")} · Home`;
    await page.waitForFunction((want) => document.querySelector('[data-line="online"]')?.textContent === want, on);
    assert.equal(await page.locator('[data-line="online"]').innerText(), look === "terminal" ? "wi-fi · Home" : "Wi-Fi · Home");
    // Strongest first, the one the TV is on marked, a lock on each with a
    // password, and a row for one that hides its name.
    assert.deepEqual(await page.locator(".wifi-panel [data-ssid]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-ssid"))), ["Home", "Cafe 5G", "café open", "neighbours", ""]);
    assert.deepEqual(await page.locator(".wifi-panel .network.current").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-ssid"))), ["Home"]);
    assert.equal(await page.locator('.network[data-ssid="Home"] .glyph-check').count(), 1);
    assert.deepEqual(await page.locator(".wifi-panel .network:has(.glyph-lock)").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-ssid"))), ["Home", "Cafe 5G", "neighbours"]);
    assert.equal(await text(page, '.network[data-ssid="Cafe 5G"] .network-name'), "Cafe 5G", "a network's name keeps its capitals in every look");
    assert.equal(await text(page, '.wifi-panel [data-ssid=""] .network-name'), words(look, "Another network"));
    assert.match((await text(page, '[data-action="look"]')) ?? "", new RegExp(`^${words(look, "Look again")}`));
    // Opening it had root look again, with the hotspot closed.
    await until(() => asked.some((request) => request.scan === true));
    assert.equal((await network()).hotspot, null);

    // A network with a password: its page, with no PIN pad where no PIN is
    // set, and the phone's keyboard opens for the field.
    await pick(page, '.network[data-ssid="Cafe 5G"]');
    await page.waitForSelector('.wifi-join input[type="password"].focused');
    assert.equal(await page.locator("#pin.on").count(), 0, "no PIN pad where no PIN is set");
    assert.equal(await text(page, ".wifi-join .headline"), words(look, "Join %s", "Cafe 5G"));
    await until(async () => (await phoneState()).tv.view === "keyboard");
    const field = (await phoneState()).tv.field;
    assert.equal(field.kind, "password");
    assert.equal("value" in field, false, "a password's value never goes to the phones");
    front = { kind: "page", id: "home", overlay: false, evaluate: (expression) => page.evaluate(expression) };
    for (const value of ["c", "corr", PASSWORD]) {
      void typeOnPhone({ value, caret: value.length });
      await until(async () => (await page.evaluate(() => (document.querySelector('.wifi-join input[type="password"]') as HTMLInputElement).value)) === value);
    }
    // The typing bar shows dots, and the phones never get it back.
    await page.waitForSelector("#typing.on.password");
    assert.equal(await text(page, ".typing-text"), "•".repeat(PASSWORD.length));
    assert.ok(!JSON.stringify(await phoneState()).includes(PASSWORD));
    assert.ok(!(await page.evaluate(() => document.body.innerText)).includes(PASSWORD), "the password is nowhere on the screen");
    // Enter on the phone is the field's own Enter, which joins.
    assert.deepEqual(await typeOnPhone({ done: true }), { ok: true, by: "page" });
    assert.deepEqual(keys.at(-1), { key: "enter" });
    await page.keyboard.press("Enter");
    await page.waitForFunction((want) => document.querySelector(".wifi-join .headline")?.textContent === want, words(look, "Joining %s…", "Cafe 5G"));
    assert.deepEqual(await joinAsked("Cafe 5G"), { join: { ssid: "Cafe 5G", password: PASSWORD, hidden: false } });
    // It worked: back in Settings, on the new network.
    await page.waitForSelector('.wifi-panel .network.current[data-ssid="Cafe 5G"]');
    assert.equal(await text(page, '[data-line="online"]'), `${words(look, "Wi-Fi")} · Cafe 5G`);
    assert.equal(await page.locator('[data-line="problem"]').count(), 0);

    // A wrong password: one line says what didn't happen, the TV is still
    // on the network it was on, and no hotspot opened.
    await pick(page, '.network[data-ssid="neighbours"]');
    await page.waitForSelector('.wifi-join input[type="password"].focused');
    await page.keyboard.type(WRONG);
    await page.keyboard.press("Enter");
    await page.waitForFunction((want) => document.querySelector('[data-line="wifi"]')?.textContent === want, words(look, "Couldn't join %s. Check the password.", "neighbours"));
    assert.equal(await text(page, ".wifi-join .headline"), words(look, "Join %s", "neighbours"));
    assert.equal(await page.evaluate(() => (document.querySelector('.wifi-join input[type="password"]') as HTMLInputElement).value), "", "the field is empty for another try");
    await page.waitForSelector('.wifi-join input[type="password"].focused');
    const now = await network();
    assert.deepEqual([now.online, now.name, now.hotspot, now.problem], [true, "Cafe 5G", null, { ssid: "neighbours", why: "password" }]);
    assert.deepEqual(await offScreen(page, "#page *:not(svg):not(svg *)"), []);
    assert.deepEqual(await shortfalls(page), []);
    // Too short to be a Wi-Fi password: nothing is sent.
    const sent = asked.length;
    await page.keyboard.type("short");
    await page.keyboard.press("Enter");
    await page.waitForFunction((want) => document.querySelector('[data-line="wifi"]')?.textContent === want, words(look, "Wi-Fi passwords have at least 8 characters"));
    // Too long, or with a character Wi-Fi can't use: the line says which.
    for (const [typed, line] of [["x".repeat(70), "Wi-Fi passwords have at most 63 characters"], ["pässword1", "Wi-Fi passwords use plain letters, numbers and symbols"]]) {
      await page.keyboard.press("Control+a");
      await page.keyboard.type(typed);
      await page.keyboard.press("Enter");
      await page.waitForFunction((want) => document.querySelector('[data-line="wifi"]')?.textContent === want, words(look, line));
    }
    assert.equal(asked.length, sent);
    await page.keyboard.press("Escape");
    await page.waitForSelector('.wifi-panel .network.current[data-ssid="Cafe 5G"]');
    assert.equal(await text(page, '[data-line="problem"]'), words(look, "Couldn't join %s. Check the password.", "neighbours"));

    // An open network joins at once, and one that hides its name asks for it.
    await pick(page, '.network[data-ssid="café open"]');
    await page.waitForSelector('.wifi-panel .network.current[data-ssid="café open"]');
    assert.deepEqual(await joinAsked("café open"), { join: { ssid: "café open", password: "", hidden: false } });
    await pick(page, '.wifi-panel [data-ssid=""]');
    await page.waitForSelector('.wifi-join input[type="text"].focused');
    assert.equal(await text(page, ".wifi-join .headline"), words(look, "Another network"));
    assert.equal(await page.locator(".wifi-join input").evaluateAll((inputs) => inputs.map((i) => i.getAttribute("placeholder")).join("|")), `${words(look, "Network name")}|${words(look, "Password")}`);
    // Its name has "$&" in it, which means something to a replacement and
    // is only a name here.
    await page.keyboard.type("attic $&");
    await page.keyboard.press("Tab");
    await pick(page, '.wifi-join input[type="password"]');
    await page.keyboard.type("upstairs1");
    await page.keyboard.press("Enter");
    await page.waitForFunction((want) => document.querySelector(".wifi-join .headline")?.textContent === want, `${words(look, "Joining")} attic $&…`);
    await page.waitForFunction(() => (document.querySelector('[data-line="online"]')?.textContent ?? "").endsWith("attic $&"));
    assert.deepEqual(await joinAsked("attic $&"), { join: { ssid: "attic $&", password: "upstairs1", hidden: true } });
    await page.close();
  });

  test(`T16.1 Settings, network in ${look} fits and reads clearly at each size, dark and light`, async () => {
    await useLook(look);
    online = true;
    rootSays({ wifi: "Home" });
    const problems: string[] = [];
    for (const theme of THEMES) {
      await useTheme(theme);
      for (const size of Object.keys(SIZES) as Size[]) {
        if (theme !== THEMES[0] && size !== "standard") continue;
        const page = await tv(size);
        await settingsNetwork(page);
        await page.waitForTimeout(400);
        for (const one of await offScreen(page, "#page .panel, #page .wifi-panel *:not(svg):not(svg *)")) problems.push(`${theme} at ${size}: ${one}`);
        for (const one of await shortfalls(page)) problems.push(`${theme} at ${size}: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
        await page.close();
      }
    }
    await useTheme(THEMES[0]);
    assert.deepEqual(problems, []);
  });

  test(`T16.1 a TV that lost its network says so on home in ${look}, with the hotspot's QR code, until it's back`, async () => {
    await useLook(look);
    online = true;
    rootSays({ wifi: "Home" });
    const page = await tv();
    const focused = await page.evaluate(() => document.querySelector("#page .focused")?.getAttribute("data-id") ?? document.querySelector("#page .focused")?.className);
    assert.equal(await page.locator("#offline").count(), 0, "nothing while the TV is online");
    // The network goes, and root's watch opens the hotspot.
    online = false;
    rootSays({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", wifi: null, watch: true });
    await page.waitForSelector("#offline", { timeout: 8000 });
    assert.equal(await text(page, "#offline .offline-title"), words(look, "Your TV is offline"));
    assert.equal(await text(page, "#offline .offline-line"), words(look, "Scan to pick your Wi-Fi"));
    await page.waitForFunction(() => {
      const qr = document.querySelector("#offline img") as HTMLImageElement | null;
      return Boolean(qr && /^\/api\/hotspot\/qr/.test(qr.getAttribute("src") ?? "") && qr.complete && qr.naturalWidth > 0);
    });
    assert.deepEqual(await offScreen(page, "#offline, #offline *"), []);
    // The bar's links stay clear of it.
    const covered = await page.evaluate(() => {
      const card = document.querySelector("#offline")!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>("#page .bar-link, #page .bar *[data-focus], #page [class*='bar'] [data-focus]")]
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.left < card.right && box.right > card.left && box.top < card.bottom && box.bottom > card.top;
        })
        .map((el) => el.textContent ?? el.className);
    });
    assert.deepEqual(covered, []);
    assert.equal(await page.evaluate(() => document.querySelector("#page .focused")?.getAttribute("data-id") ?? document.querySelector("#page .focused")?.className), focused, "it takes no focus");
    // It's home's alone, so it never covers another page. Settings says
    // "Offline" itself, keeps the list, and looking again waits for the
    // radio.
    await settingsNetwork(page);
    assert.equal(await page.locator("#offline").isVisible(), false);
    assert.equal(await text(page, '[data-line="online"]'), words(look, "Offline"));
    assert.equal(await page.locator('[data-action="look"]').count(), 0);
    // A pick from the phone that didn't work says so.
    rootSays({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", wifi: null, watch: true, error: "that password didn't work for Home", why: "password" });
    await page.waitForFunction((want) => document.querySelector("#offline .offline-line")?.textContent === want, words(look, "Couldn't join. Scan to try again."), { timeout: 8000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector("#offline", { state: "visible" });
    assert.deepEqual(await offScreen(page, "#offline, #offline *"), []);
    // Back online: the notice goes.
    online = true;
    rootSays({ on: false, wifi: "Home", joined: { ssid: "Home", address: "192.168.1.20" } });
    await page.waitForSelector("#offline", { state: "detached", timeout: 8000 });
    await page.close();
  });
}

test("T16.1 with a PIN set, changing the Wi-Fi asks for it first, and a child's profile has no Network and can't change it", async () => {
  await useLook("glass");
  online = true;
  rootSays({ wifi: "Home" });
  assert.equal((await send("PUT", "/api/pin", { pin: "4826" })).status, 200);
  const page = await tv();
  await settingsNetwork(page);
  const sent = asked.filter((request) => request.join).length;
  await pick(page, '.network[data-ssid="Cafe 5G"]');
  await page.waitForSelector("#pin.on");
  assert.equal(await page.locator(".wifi-join").count(), 0, "the password's page waits for the PIN");
  // Without it, nothing: Back closes the pad, and Settings is as it was.
  await page.keyboard.press("Escape");
  await page.waitForSelector("#pin:not(.on)", { state: "attached" });
  assert.equal(await page.locator(".wifi-join").count(), 0);
  // The daemon checks too, whatever the page does.
  const refused = await send("POST", "/api/network/join", { ssid: "café open", password: "" });
  assert.deepEqual([refused.status, refused.data.pin], [403, true]);
  // With the PIN: on to the password.
  await pick(page, '.network[data-ssid="Cafe 5G"]');
  await page.waitForSelector("#pin.on");
  await page.keyboard.type("4826");
  await page.waitForSelector('.wifi-join input[type="password"].focused');
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForSelector('.wifi-panel .network.current[data-ssid="Cafe 5G"]');
  assert.equal(asked.filter((request) => request.join).length, sent + 1);
  await page.close();

  // A child's profile: Settings is behind the PIN, and it has no Network.
  const grant = (await send("POST", "/api/pin/check", { pin: "4826" })).data.grant as string;
  const adult = (await send("GET", "/api/viewers")).data.active as string;
  const child = (await send("POST", "/api/viewers", { name: "mila", role: "child" }, grant)).data.profile;
  assert.equal((await send("POST", "/api/viewer", { id: child.id })).status, 200);
  const kid = await tv();
  await go(kid, "settings/network");
  await kid.waitForSelector("#pin.on");
  await kid.keyboard.type("4826");
  await kid.waitForSelector(".page.settings .menu-item");
  assert.equal(await kid.locator('.menu-item[data-key="network"]').count(), 0);
  await go(kid, "settings/wifi");
  await kid.waitForSelector(".page.settings .menu-item");
  assert.equal(await kid.locator(".wifi-panel").count(), 0, "nor the page with the networks to pick");
  const held = (await send("POST", "/api/pin/check", { pin: "4826" })).data.grant as string;
  assert.deepEqual((await send("POST", "/api/network/join", { ssid: "café open", password: "" }, held)).data, { ok: false, error: "child" });
  assert.deepEqual((await send("POST", "/api/network/scan", undefined, held)).data, { ok: false, error: "child" });
  await go(kid, "wifi");
  assert.equal(await kid.locator(".wifi-join").count(), 0, "the password's page isn't a child's either");
  await kid.close();
  assert.equal((await send("POST", "/api/viewer", { id: adult }, held)).status, 200);
  assert.equal((await send("DELETE", `/api/viewers/${child.id}`, undefined, held)).status, 200);
  assert.equal((await send("DELETE", "/api/pin", undefined, held)).status, 200);
});

test("the hotspot's page after setup: the same page as setup's, with the adult PIN asked where one is set, and nothing about a new code", async () => {
  const captive = `http://127.0.0.1:${daemon.setupPort}`;
  online = false;
  rootSays({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", wifi: null, watch: true });
  const hand = async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${captive}/`);
    await page.waitForSelector("button.network");
    return page;
  };
  // No PIN set: the password and nothing else.
  let page = await hand();
  assert.deepEqual(await page.locator("button.network").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-ssid"))), ["Home", "Cafe 5G", "café open", "neighbours"]);
  await page.locator('button.network[data-ssid="Home"]').tap();
  await page.waitForSelector('input[type="password"]');
  assert.equal(await page.locator('[data-field="pin"]').count(), 0, "no PIN field where no PIN is set");
  await page.close();

  // With one set, the page asks for it with the password.
  assert.equal((await send("PUT", "/api/pin", { pin: "4826" })).status, 200);
  page = await hand();
  await page.locator('button.network[data-ssid="Home"]').tap();
  await page.waitForSelector('[data-field="pin"]');
  assert.equal(await page.locator('[data-field="pin"]').getAttribute("placeholder"), "Adult PIN");
  const sent = asked.filter((request) => request.join).length;
  await page.locator('input[type="password"]:not([data-field="pin"])').fill(PASSWORD);
  await page.locator('[data-action="join"]').tap();
  await page.waitForFunction(() => /The adult PIN has 4 digits/.test(document.getElementById("toast")?.textContent ?? ""));
  await page.locator('[data-field="pin"]').fill("0000");
  await page.locator('[data-action="join"]').tap();
  await page.waitForFunction(() => /Wrong PIN/.test(document.getElementById("toast")?.textContent ?? ""));
  assert.equal(await page.locator('[data-field="pin"]').inputValue(), "", "the PIN's field is empty for another try");
  assert.equal(asked.filter((request) => request.join).length, sent, "nothing went to root");
  await page.locator('[data-field="pin"]').fill("4826");
  await page.locator('[data-action="join"]').tap();
  await page.waitForFunction(() => /^Joining Home$/.test(document.querySelector("h1")?.textContent ?? ""));
  assert.match(await page.locator(".page").innerText(), /Once it's on, go back to that Wi-Fi$/);
  assert.doesNotMatch(await page.locator(".page").innerText(), /new code|setup/);
  await until(() => asked.filter((request) => request.join).length === sent + 1);
  assert.deepEqual(await joinAsked("Home"), { join: { ssid: "Home", password: PASSWORD, hidden: false } }, "the PIN goes no further than the daemon");
  await page.close();
  online = true;
  const grant = (await send("POST", "/api/pin/check", { pin: "4826" })).data.grant as string;
  assert.equal((await send("DELETE", "/api/pin", undefined, grant)).status, 200);
});
