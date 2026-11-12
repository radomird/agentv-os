// Phones in a real Chromium (ADR-019, layer 4; stage 4): Settings → Phones
// and the pairing screen on the TV at 1920 × 1080, and the phone companion at
// 390 × 844 pairing with the code, then sending the d-pad and typed text to
// the TV, through the daemon's stream for the screen daemon. A real phone on
// the home network, the firewall and the virtual input device are the image
// layer's and the NUC's.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { PHASE_1, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let phoneUrl = "";
const errors: string[] = [];
// What the screen daemon would hand to the virtual input device.
const remote: string[] = [];
let stopRemote = () => {};

before(async () => {
  ({ daemon, url } = await startBox(0, undefined, { features: PHASE_1 }));
  phoneUrl = `http://127.0.0.1:${daemon.lanPort}`;
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
  const controller = new AbortController();
  stopRemote = () => controller.abort();
  const stream = await fetch(`${url}/api/remote`, { headers: { "X-AgenTV-Screen": "1" }, signal: controller.signal });
  void (async () => {
    for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
      for (const match of new TextDecoder().decode(chunk).matchAll(/data: (.*)/g)) remote.push(match[1]);
    }
  })().catch(() => {});
});

after(async () => {
  stopRemote();
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

async function phone(path = "/"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36", hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${phoneUrl}${path}`);
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);

test("pairing: the TV shows a code, the phone types it, and the TV says the phone is paired", async () => {
  const screen = await tv();
  await go(screen, "settings/phones");
  await screen.waitForFunction(() => /none yet/.test(document.querySelector(".panel")?.textContent ?? ""));
  assert.match(await screen.locator('.menu-item[data-key="phones"]').innerText(), /phones\s+0/);
  await screen.keyboard.press("Enter");
  await screen.keyboard.press("Enter");
  await screen.waitForFunction(() => /^[A-HJKMNP-Z2-9]{6}$/.test(document.querySelector(".pair-code")?.textContent ?? ""));
  const code = await screen.locator(".pair-code").innerText();
  assert.match(await screen.locator(".page.pair").innerText(), new RegExp(`open http://127\\.0\\.0\\.1:${daemon.lanPort}/ and type the code[\\s\\S]*the code lasts 10 more minutes`));

  // The code is typed. One in the address pairs nothing: it would go over
  // the network as it is.
  const hand = await phone(`/?code=${code}`);
  await hand.waitForSelector(".field.code");
  assert.deepEqual((await (await fetch(`${url}/api/phones`)).json()).phones, []);
  assert.match(await hand.locator(".page").innerText(), /pair with the tv[\s\S]*settings → phones → pair a phone/);
  await hand.locator(".field.code").fill(code.toLowerCase());
  await hand.locator("button.primary").click();
  await hand.waitForSelector(".dpad");
  // The TV: a toast, and back to Settings → Phones with the phone listed.
  await screen.waitForFunction(() => /android phone is paired/.test(document.body.textContent ?? ""));
  await screen.waitForFunction(() => /android phone/.test(document.querySelector(".panel")?.textContent ?? ""));
  assert.match(await screen.locator('.menu-item[data-key="phones"]').innerText(), /phones\s+1/);
  await screen.close();
  await hand.close();
});

test("F1 the QR code's address pairs at once, and nothing the phone sends after can be read or used again", async () => {
  const pairing = (await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json()).pairing;
  const secret = `#pair=${daemon.phones.secret()}`;
  assert.match(secret, /^#pair=[A-Za-z0-9_-]{22}$/);
  // The TV's page gets the address to type the code at, with no secret in it.
  assert.equal(pairing.url, `http://127.0.0.1:${daemon.lanPort}/`);
  // Everything the page sends, as someone listening would see it.
  const hand = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36", hasTouch: true });
  hand.on("pageerror", (error) => errors.push(error.message));
  const wire: { method: string; path: string; headers: Record<string, string>; body: Buffer | null }[] = [];
  hand.on("request", (request) => wire.push({ method: request.method(), path: new URL(request.url()).pathname + new URL(request.url()).search, headers: request.headers(), body: request.postDataBuffer() }));
  // A token from before requests were signed is still in the browser.
  await hand.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) localStorage.setItem("agentv-phone-token", "an-old-token-from-before-signing-0123456789");
    sessionStorage.setItem("seeded", "1");
  });
  await hand.goto(`${phoneUrl}/${secret}`);
  await hand.waitForSelector(".dpad");
  assert.deepEqual([new URL(hand.url()).search, new URL(hand.url()).hash], ["", ""], "the secret goes from the address bar");
  const kept = await hand.evaluate(() => ({ token: localStorage.getItem("agentv-phone-token"), key: JSON.parse(localStorage.getItem("agentv-phone-key") ?? "null") }));
  assert.equal(kept.token, null, "the old token is gone");
  assert.match(kept.key.id, /^p-[0-9a-f]{8}$/);
  assert.equal(Buffer.from(kept.key.key, "base64url").length, 32);
  assert.match(await hand.locator(".who").innerText(), /\w+/);
  remote.length = 0;
  for (const key of ["up", "right", "enter", "back", "home", "playpause"]) await hand.locator(`[data-key="${key}"]`).tap();
  await hand.locator('[data-mode="type"]').tap();
  await hand.locator("#tv-text").fill("hello tv");
  await hand.locator('[data-action="send"]').tap();
  await hand.locator('[data-key="backspace"]').tap();
  await hand.waitForFunction(() => (document.getElementById("tv-text") as HTMLInputElement).value === "");
  const wait = Date.now() + 3000;
  while (remote.length < 8 && Date.now() < wait) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(remote, ['{"key":"up"}', '{"key":"right"}', '{"key":"enter"}', '{"key":"back"}', '{"key":"home"}', '{"key":"playpause"}', '{"text":"hello tv"}', '{"key":"backspace"}']);

  // On the wire: the secret, the code and the key are nowhere, what was typed
  // can't be read, and every request past pairing is signed with a counter
  // of its own.
  const all = Buffer.concat(wire.map((sent) => Buffer.concat([Buffer.from(`${sent.method} ${sent.path} ${JSON.stringify(sent.headers)} `), sent.body ?? Buffer.alloc(0)])));
  for (const hidden of [secret.slice("#pair=".length), pairing.code, kept.key.key, "hello tv", "an-old-token", "authorization"]) assert.ok(!all.toString("latin1").toLowerCase().includes(hidden.toLowerCase()), hidden);
  const asked = wire.filter((sent) => sent.path.startsWith("/api/phone/"));
  assert.deepEqual(asked.slice(0, 2).map((sent) => sent.path), ["/api/phone/pair", "/api/phone/hello"]);
  assert.deepEqual(Object.keys(JSON.parse(asked[0].body!.toString())).sort(), ["key", "name", "proof"]);
  const signed = asked.filter((sent) => !["/api/phone/pair", "/api/phone/hello"].includes(sent.path));
  assert.ok(signed.length >= 9);
  for (const sent of signed) {
    assert.match(sent.headers["x-agentv-sig"] ?? "", /^[A-Za-z0-9_-]{43}$/, sent.path);
    if (sent.body) assert.equal(sent.headers["content-type"], "application/agentv-sealed", sent.path);
  }
  const counters = signed.map((sent) => `${sent.headers["x-agentv-session"]} ${sent.headers["x-agentv-counter"]}`);
  assert.equal(new Set(counters).size, counters.length, "no counter is used twice");
  await hand.close();
});

test("F1 a phone that still holds only a token from before gets the pairing page, and the token goes", async () => {
  const hand = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  hand.on("pageerror", (error) => errors.push(error.message));
  await hand.addInitScript(() => localStorage.setItem("agentv-phone-token", "an-old-token-from-before-signing-0123456789"));
  await hand.goto(`${phoneUrl}/`);
  await hand.waitForSelector(".field.code");
  assert.equal(await hand.evaluate(() => localStorage.getItem("agentv-phone-token")), null);
  await hand.close();
});

test("F1 when the box no longer knows the phone's session, as after a restart, the page goes on and shows nothing", async () => {
  await fetch(`${url}/api/phones/pair`, { method: "POST" });
  const hand = await phone(`/#pair=${daemon.phones.secret()}`);
  await hand.waitForSelector(".dpad");
  const hellos: string[] = [];
  hand.on("request", (request) => {
    if (request.url().endsWith("/api/phone/hello")) hellos.push(request.url());
  });
  const id = await hand.evaluate(() => JSON.parse(localStorage.getItem("agentv-phone-key")!).id as string);
  // What a restart does to the sessions, without taking the page's server away.
  (daemon as unknown as { phoneChannel: { forget(id: string): void } }).phoneChannel.forget(id);
  remote.length = 0;
  await hand.locator('[data-key="down"]').tap();
  await hand.locator('[data-key="enter"]').tap();
  const wait = Date.now() + 3000;
  while (remote.length < 2 && Date.now() < wait) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(remote, ['{"key":"down"}', '{"key":"enter"}']);
  assert.ok(hellos.length >= 1 && hellos.length <= 2, `${hellos.length} hellos`);
  assert.equal(await hand.locator(".field.code").count(), 0, "no pairing page");
  assert.equal(await hand.locator("#toast.on").count(), 0, "and no toast");
  await hand.close();
});

test("a phone the TV forgot goes back to pairing, and one that's paired stays paired", async () => {
  await fetch(`${url}/api/phones/pair`, { method: "POST" });
  const hand = await phone(`/#pair=${daemon.phones.secret()}`);
  await hand.waitForSelector(".dpad");
  // Opened again, it's still paired.
  await hand.goto(`${phoneUrl}/`);
  await hand.waitForSelector(".dpad");
  const phones = (await (await fetch(`${url}/api/phones`)).json()).phones as { id: string }[];
  for (const p of phones) await fetch(`${url}/api/phones/${p.id}`, { method: "DELETE" });
  // Its ask for the state, waiting on the box, hears at once.
  await hand.waitForSelector(".field.code", { timeout: 1500 });
  // It still holds its old key, and a new code pairs it again with a new one.
  const old = await hand.evaluate(() => JSON.parse(localStorage.getItem("agentv-phone-key") ?? "null")?.id as string | undefined);
  assert.equal(old, phones[phones.length - 1].id);
  const { pairing } = await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json();
  await hand.locator(".field.code").fill(pairing.code);
  await hand.locator("button.primary").click();
  await hand.waitForSelector(".dpad");
  const now = await hand.evaluate(() => JSON.parse(localStorage.getItem("agentv-phone-key")!).id as string);
  assert.notEqual(now, old);
  remote.length = 0;
  await hand.locator('[data-key="up"]').tap();
  const wait = Date.now() + 3000;
  while (remote.length < 1 && Date.now() < wait) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(remote, ['{"key":"up"}']);
  // Opened again, it's the new one.
  await hand.goto(`${phoneUrl}/`);
  await hand.waitForSelector(".dpad");
  await hand.close();
  await fetch(`${url}/api/phones/${now}`, { method: "DELETE" });
});

test("an answer nobody sealed doesn't take the phone's key: after a made-up \"pair again\" the phone is still paired", async () => {
  await fetch(`${url}/api/phones/pair`, { method: "POST" });
  const hand = await phone(`/#pair=${daemon.phones.secret()}`);
  await hand.waitForSelector(".dpad");
  const key = await hand.evaluate(() => localStorage.getItem("agentv-phone-key"));
  assert.ok(key);
  // Someone on the network answers in the box's place, hellos too.
  const again = JSON.stringify({ ok: false, error: "this phone isn't paired: pair it from the tv", pair: true });
  await hand.route("**/api/phone/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: again }));
  remote.length = 0;
  await hand.locator('[data-key="down"]').tap();
  // The page has nothing better to show than the pairing page.
  await hand.waitForSelector(".field.code");
  assert.equal(await hand.evaluate(() => localStorage.getItem("agentv-phone-key")), key, "the key is still kept");
  assert.deepEqual(remote, []);
  // Once the box answers for itself again, the phone is who it was.
  await hand.unroute("**/api/phone/**");
  await hand.goto(`${phoneUrl}/`);
  await hand.waitForSelector(".dpad");
  assert.equal(await hand.evaluate(() => localStorage.getItem("agentv-phone-key")), key);
  await hand.locator('[data-key="down"]').tap();
  const wait = Date.now() + 3000;
  while (remote.length < 1 && Date.now() < wait) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(remote, ['{"key":"down"}']);
  await hand.close();
  await fetch(`${url}/api/phones/${JSON.parse(key).id}`, { method: "DELETE" });
});

test("F6 with a PIN set, pair a phone and forget ask for it once, on the pad Settings has, and Back leaves things as they were", async () => {
  const send = async (method: string, path: string, body?: unknown, grant?: string) =>
    (await fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
  await send("PUT", "/api/pin", { pin: "4826" });
  const before = (await send("GET", "/api/phones")).pairing?.code ?? null;
  const screen = await tv();
  await go(screen, "settings/phones");
  await screen.locator('[data-action="pair"]').click();
  await screen.waitForSelector(".pin-pad");
  assert.match(await screen.locator(".pin-pad").innerText(), /enter the adult pin[\s\S]*for settings$/m);
  await screen.keyboard.press("Escape");
  await screen.waitForSelector(".pin-pad", { state: "detached" });
  assert.equal(await screen.locator(".page.pair").count(), 0, "still on Settings → Phones");
  assert.equal((await send("GET", "/api/phones")).pairing?.code ?? null, before, "and no new code");

  await screen.locator('[data-action="pair"]').click();
  await screen.waitForSelector(".pin-pad");
  for (const digit of "4826") await screen.keyboard.press(digit);
  await screen.waitForFunction(() => /^[A-HJKMNP-Z2-9]{6}$/.test(document.querySelector(".pair-code")?.textContent ?? ""));
  const code = await screen.locator(".pair-code").innerText();
  const hand = await phone();
  await hand.locator(".field.code").fill(code);
  await hand.locator("button.primary").click();
  await hand.waitForSelector(".dpad");
  await screen.waitForFunction(() => /is paired/.test(document.body.textContent ?? ""));

  // Forgetting it, in the same visit to Settings, doesn't ask again.
  await go(screen, "settings/phones");
  await screen.waitForSelector('[data-action^="phone-p-"]');
  await screen.locator('[data-action^="phone-p-"]').first().click();
  await screen.waitForFunction(() => /is forgotten/.test(document.getElementById("toasts")?.textContent ?? ""));
  assert.equal(await screen.locator(".pin-pad").count(), 0);
  assert.deepEqual((await send("GET", "/api/phones")).phones, []);
  const grant = (await send("POST", "/api/pin/check", { pin: "4826" })).grant;
  await send("DELETE", "/api/pin", undefined, grant);
  await screen.close();
  await hand.close();
});
