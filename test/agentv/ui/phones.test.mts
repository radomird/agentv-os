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
import { startBox } from "./box.mts";

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
  ({ daemon, url } = await startBox());
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

  const hand = await phone();
  await hand.waitForSelector(".field.code");
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

test("the phone's d-pad and typed text go to the TV, and its header says who's watching", async () => {
  const pairing = (await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json()).pairing;
  // The QR code's address pairs at once.
  const hand = await phone(`/?code=${pairing.code}`);
  await hand.waitForSelector(".dpad");
  assert.equal(new URL(hand.url()).search, "", "the code goes from the address bar");
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
  await hand.close();
});

test("a phone the TV forgot goes back to pairing, and one that's paired stays paired", async () => {
  const pairing = (await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json()).pairing;
  const hand = await phone(`/?code=${pairing.code}`);
  await hand.waitForSelector(".dpad");
  // Opened again, it's still paired.
  await hand.goto(`${phoneUrl}/`);
  await hand.waitForSelector(".dpad");
  const phones = (await (await fetch(`${url}/api/phones`)).json()).phones as { id: string }[];
  for (const p of phones) await fetch(`${url}/api/phones/${p.id}`, { method: "DELETE" });
  await hand.locator('[data-key="up"]').tap();
  await hand.waitForSelector(".field.code");
  await hand.close();
});
