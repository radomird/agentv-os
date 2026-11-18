// A name of its own for the TV (PHASE-2-PLAN.md track 28, T28.5's layer 4
// half), in a real Chromium, behind the announce switch:
//
// - with the switch off, Settings' System has no Name row, there's no page
//   to name the TV on, and the phone's remote says nothing of a name;
// - with it on, System's first row is Name, with OrigaiTV beside it, and OK
//   opens "Name this TV": one field, whose example is "Living room", and
//   Save. The row and the page fit and read clearly in each look;
// - the field opens the phone's keyboard, as any field on the TV does;
// - a name saved there shows on the row, in the phone's state, on the first
//   line of the phone's menu and in its tab, with no reload, and a name
//   set from a phone shows on the TV's row;
// - with a PIN, Save asks for it, and on a child's profile Settings asks
//   for it before there's a row to open.

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createRequire } from "node:module";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { phoneOfPage } from "../unit/phone-client.mts";
import { rest, startBox } from "./box.mts";
import { shortfalls } from "./legible.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
const PHONE = { width: 375, height: 812 };
const PIN = "2468";

let browser: Browser;
const boxes: Daemon[] = [];
const errors: string[] = [];

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  for (const daemon of boxes) await daemon.close();
  assert.deepEqual(errors, []);
});

// A box with the announce switch on or off, and the looks.
async function box(announce: boolean): Promise<{ daemon: Daemon; url: string; lan: string }> {
  const { daemon, url } = await startBox(0, undefined, { features: { looks: true, announce } });
  boxes.push(daemon);
  return { daemon, url, lan: `http://127.0.0.1:${daemon.lanPort}` };
}

async function tv(url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector("html[data-look] #page .focused");
  await rest(page);
  return page;
}

// A paired phone on the remote, through the QR code's address.
async function phone(b: { daemon: Daemon; url: string; lan: string }): Promise<Page> {
  await fetch(`${b.url}/api/phones/pair`, { method: "POST" });
  const page = await browser.newPage({ viewport: PHONE, hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${b.lan}/#pair=${b.daemon.phones.secret()}`);
  await page.waitForSelector(".r2");
  return page;
}

function sender(url: string) {
  return async (method: string, path: string, body?: unknown, grant?: string): Promise<Record<string, any>> => {
    const response = await fetch(`${url}${path}`, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-OrigaiTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return (await response.json()) as Record<string, any>;
  };
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go(r), route);
const rows = (page: Page) => page.locator(".settings-panel [data-focus]").evaluateAll((els) => els.filter((el) => !el.classList.contains("hidden")).map((el) => (el as HTMLElement).dataset.action));
const focused = (page: Page) => page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action"));
const rowValue = (page: Page) => page.locator('.settings-panel [data-action="name"] .button-value').innerText();
const toast = (page: Page, text: string) => page.waitForFunction((want) => [...document.querySelectorAll("#toasts .toast")].some((one) => one.textContent === want), text);
const padUp = (page: Page, up: boolean) => page.waitForFunction((want) => document.getElementById("pin")?.classList.contains("on") === want, up);

// Until nothing on the page is still moving in, as a page slides in.
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  await page.waitForFunction(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5000 });
}

// Rows past the panel's side or wider than themselves.
function off(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const panel = document.querySelector(".settings-panel")!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(".settings-panel .button:not(.hidden)")].filter((row) => row.getBoundingClientRect().right > panel.right + 1 || row.scrollWidth > row.clientWidth + 2).map((row) => row.dataset.action ?? "");
  });
}

// Settings' System, with its Name row drawn.
async function system(page: Page): Promise<void> {
  await go(page, "settings/tv");
  await page.waitForSelector('.settings-panel[data-page="tv"] [data-action="name"]');
  await settled(page);
}

// Name this TV, opened with OK on the row.
async function namePage(page: Page): Promise<void> {
  await system(page);
  await page.locator('.settings-panel [data-action="name"]').hover();
  await page.keyboard.press("Enter");
  await page.waitForSelector('.page.profile [data-action="name-field"].focused');
  await settled(page);
}

async function shot(page: Page, name: string): Promise<void> {
  if (process.env.ORIGAITV_UI_SHOTS) await page.screenshot({ path: join(process.env.ORIGAITV_UI_SHOTS, `success-T28.5-${name}.png`) }).catch(() => {});
}

test("T28.5 with announce off, System has no Name row, there's no page to name the TV on, and the phone's remote says nothing of a name", async () => {
  const b = await box(false);
  const page = await tv(b.url);
  const hand = await phone(b);
  try {
    await go(page, "settings/tv");
    await page.waitForSelector('.settings-panel[data-page="tv"] [data-action="about"]');
    await settled(page);
    assert.equal((await rows(page)).join(" "), "country updates power desktop about");
    await go(page, "name");
    await settled(page);
    assert.equal(await page.locator('[data-action="name-field"]').count(), 0, "the route isn't a page");
    assert.equal(await page.title(), "OrigaiTV");

    assert.equal(await hand.title(), "OrigaiTV");
    await hand.locator('[data-action="menu"]').tap();
    await hand.waitForSelector("#r2-sheet .r2-label");
    assert.equal(await hand.locator(".r2-name").count(), 0);
    assert.equal((await hand.locator("#r2-sheet .r2-sheet > p").first().innerText()).trim(), "Who's watching", "the menu starts as it did");
  } finally {
    await page.close();
    await hand.close();
  }
});

test("T28.5 System's first row is Name, with OrigaiTV beside it, and OK opens Name this TV, with Living room as its example, in each look", async () => {
  const b = await box(true);
  const send = sender(b.url);
  const problems: string[] = [];
  for (const look of LOOKS) {
    await fetch(`${b.url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
    const page = await tv(b.url);
    try {
      await system(page);
      const system_ = await rows(page);
      if (system_.join(" ") !== "name country updates power desktop about") problems.push(`${look}: System's rows are ${system_.join(", ")}`);
      const row = (await page.locator('.settings-panel [data-action="name"]').innerText()).trim();
      if (!/^name\s+OrigaiTV$/i.test(row)) problems.push(`${look}: the row reads "${row}"`);
      // The name keeps its capitals in every look, Terminal's too.
      if ((await rowValue(page)).trim() !== "OrigaiTV") problems.push(`${look}: the name is drawn as "${await rowValue(page)}"`);
      for (const one of await off(page)) problems.push(`${look}, System: ${one} doesn't fit`);
      for (const one of await shortfalls(page)) problems.push(`${look}, System: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
      await shot(page, `${look}-system`);

      await page.locator('.settings-panel [data-action="name"]').hover();
      await page.keyboard.press("Enter");
      await page.waitForSelector('.page.profile [data-action="name-field"].focused');
      await settled(page);
      const shown = await page.evaluate(() => {
        const field = document.querySelector<HTMLInputElement>('[data-action="name-field"]')!;
        const save = document.querySelector<HTMLElement>('.page.profile [data-action="save"]')!;
        const box = field.getBoundingClientRect();
        return {
          headline: document.querySelector(".page.profile .headline")?.textContent,
          value: field.value,
          example: field.placeholder,
          label: field.getAttribute("aria-label"),
          save: save.textContent,
          controls: [...document.querySelectorAll(".page.profile [data-focus]")].map((el) => (el as HTMLElement).dataset.action),
          lines: document.querySelectorAll(".page.profile .panel-note").length,
          inside: box.left >= 80 && box.right <= innerWidth - 80 && box.top >= 60 && save.getBoundingClientRect().bottom <= innerHeight - 60,
        };
      });
      if (shown.headline !== "Name this TV") problems.push(`${look}: the headline is "${shown.headline}"`);
      if (shown.value !== "" || shown.example !== "Living room") problems.push(`${look}: the field has "${shown.value}", and "${shown.example}" as its example`);
      if (shown.save !== "Save" || shown.controls.join(" ") !== "name-field save") problems.push(`${look}: the page has ${shown.controls.join(", ")}, and "${shown.save}"`);
      if (shown.lines !== 0) problems.push(`${look}: there's a line of text under the field`);
      if (!shown.inside) problems.push(`${look}: the field or Save is outside the safe area`);
      for (const one of await shortfalls(page)) problems.push(`${look}, Name this TV: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
      await shot(page, `${look}-name-this-tv`);
      // Back is System, on Name.
      await page.keyboard.press("Escape");
      await page.waitForSelector('.settings-panel[data-page="tv"]');
      if ((await focused(page)) !== "name") problems.push(`${look}: Back landed on ${await focused(page)}`);

      // The longest name a TV can have stays on its row's one line, inside
      // the row, and the row is as tall as it was.
      const tall = (await page.locator('.settings-panel [data-action="name"]').boundingBox())!.height;
      const longest = "W".repeat(30);
      await send("PUT", "/api/name", { name: longest });
      await page.waitForFunction((want) => document.querySelector('.settings-panel [data-action="name"] .button-value')?.textContent === want, longest);
      for (const one of await off(page)) problems.push(`${look}, System with a long name: ${one} doesn't fit`);
      const long = await page.locator('.settings-panel [data-action="name"]').evaluate((row) => {
        const value = row.querySelector(".button-value")!.getBoundingClientRect();
        const label = row.querySelector("span")!.getBoundingClientRect();
        const box = row.getBoundingClientRect();
        return { height: box.height, inside: value.right <= box.right && value.left >= label.right + 16 };
      });
      if (long.height !== tall) problems.push(`${look}: a long name makes the row ${long.height} tall, from ${tall}`);
      if (!long.inside) problems.push(`${look}: a long name runs out of its row, or into the word before it`);
      await send("PUT", "/api/name", { name: "OrigaiTV" });
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("T28.5 a name saved on Name this TV shows on its row, in the state, and in the phone's menu and tab with no reload, and one set from a phone shows on the TV", async () => {
  const b = await box(true);
  const page = await tv(b.url);
  const hand = await phone(b);
  const paired = await phoneOfPage(hand, b.lan);
  const state = () => paired.json("GET", "/api/phone/state");
  try {
    // Before anybody names it: the phone's tab and its menu say OrigaiTV.
    await hand.waitForFunction(() => document.title === "OrigaiTV");
    assert.equal((await state()).boxName, "OrigaiTV");
    await hand.locator('[data-action="menu"]').tap();
    await hand.waitForSelector("#r2-sheet .r2-name");
    assert.equal(await hand.locator("#r2-sheet .r2-sheet > p").first().innerText(), "OrigaiTV", "the menu's first line");
    await hand.locator('[data-action="close-sheet"]').tap({ position: { x: 10, y: 10 } });

    // The field has the focus, and the phone's keyboard comes up for it.
    await namePage(page);
    await hand.waitForSelector(".r2 input, .r2 textarea");
    const typing = (await state()).tv;
    assert.deepEqual([typing.view, typing.field?.kind, typing.field?.label], ["keyboard", "text", "Name"]);

    // Typed and saved: the toast, then System again, on the row.
    await page.keyboard.type("Dnevna soba");
    await page.keyboard.press("ArrowDown");
    assert.equal(await focused(page), "save");
    await page.keyboard.press("Enter");
    await toast(page, "Saved");
    await page.waitForSelector('.settings-panel[data-page="tv"] [data-action="name"]');
    assert.equal(await rowValue(page), "Dnevna soba", "as typed, capital and all");
    assert.equal(await focused(page), "name");
    assert.equal((await state()).boxName, "Dnevna soba");
    assert.equal((await (await fetch(`${b.url}/api/name`)).json()).name, "Dnevna soba");

    // The phone that was open the whole time: its tab, and its menu's
    // first line, without a reload.
    await hand.waitForFunction(() => document.title === "Dnevna soba");
    await hand.waitForSelector(".r2-top");
    await hand.locator('[data-action="menu"]').tap();
    await hand.waitForFunction(() => document.querySelector("#r2-sheet .r2-name")?.textContent === "Dnevna soba");

    // Named again from a phone, with the menu still open: the menu, the
    // tab and the TV's row all follow.
    assert.equal((await paired.json("POST", "/api/phone/name", { name: "Küche 📺" })).name, "Küche 📺");
    await hand.waitForFunction(() => document.querySelector("#r2-sheet .r2-name")?.textContent === "Küche 📺" && document.title === "Küche 📺");
    await page.waitForFunction(() => document.querySelector('.settings-panel [data-action="name"] .button-value')?.textContent === "Küche 📺");
    assert.equal(await focused(page), "name", "and the focus stays where it was");

    // The page opens on the name it has, to change a letter of it, and a
    // name that's too long is cut to what the TV keeps.
    await page.keyboard.press("Enter");
    await page.waitForSelector('.page.profile [data-action="name-field"].focused');
    assert.equal(await page.locator('[data-action="name-field"]').inputValue(), "Küche 📺");
    await page.locator('[data-action="name-field"]').fill(`   ${"Dnevna soba ".repeat(5)}`);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.settings-panel[data-page="tv"] [data-action="name"]');
    const kept = await rowValue(page);
    assert.equal(kept, "Dnevna soba Dnevna soba Dnevna", "30 characters, with no space left at the end");
    await hand.waitForFunction((want) => document.title === want, kept);

    // Nothing typed isn't a name: the page says so and stays.
    await page.keyboard.press("Enter");
    await page.waitForSelector('.page.profile [data-action="name-field"].focused');
    await page.locator('[data-action="name-field"]').fill("   ");
    await page.locator('.page.profile [data-action="save"]').click();
    await toast(page, "Names can be up to 30 characters");
    assert.equal(await page.locator('[data-action="name-field"]').count(), 1);
    assert.equal((await state()).boxName, kept);
  } finally {
    await page.close();
    await hand.close();
  }
});

test("T28.5 with a PIN, Save asks for it before the TV is named, and on a child's profile Settings asks before the row can be reached", async () => {
  const b = await box(true);
  const send = sender(b.url);
  await send("PUT", "/api/pin", { pin: PIN });
  const grant = (await send("POST", "/api/pin/check", { pin: PIN })).grant as string;
  const page = await tv(b.url);
  const type = async (digits: string) => {
    for (const digit of digits) await page.keyboard.press(digit);
  };
  try {
    await namePage(page);
    await page.keyboard.type("Bedroom");
    await page.locator('.page.profile [data-action="save"]').click();
    await padUp(page, true);
    assert.match(await page.locator(".pin-pad").innerText(), /for changing the name/i);
    assert.equal((await send("GET", "/api/name")).name, "OrigaiTV", "nothing is saved while the pad is up");
    // Back from the pad saves nothing.
    await page.keyboard.press("Escape");
    await padUp(page, false);
    assert.equal((await send("GET", "/api/name")).name, "OrigaiTV");
    // A wrong PIN keeps the pad up and saves nothing. The right one saves.
    await page.locator('.page.profile [data-action="save"]').click();
    await padUp(page, true);
    await type("1111");
    await page.waitForFunction(() => /wrong pin/i.test(document.querySelector(".pin-pad")?.textContent ?? ""));
    assert.equal((await send("GET", "/api/name")).name, "OrigaiTV");
    await type(PIN);
    await padUp(page, false);
    await toast(page, "Saved");
    assert.equal((await send("GET", "/api/name")).name, "Bedroom");

    // On a child's profile Settings itself asks for the PIN, as it does for
    // everything in it. Without it there's no way to the row. With it, the
    // grown-up who typed it names the TV, and isn't asked twice.
    const child = (await send("POST", "/api/viewers", { name: "mia", role: "child" }, grant)).profile;
    await send("POST", "/api/viewer", { id: child.id }, grant);
    await page.close();
    const again = await tv(b.url);
    const digits = async (pin: string) => {
      for (const digit of pin) await again.keyboard.press(digit);
    };
    try {
      await go(again, "settings/tv");
      await padUp(again, true);
      await again.keyboard.press("Escape");
      await padUp(again, false);
      assert.equal(await again.locator('[data-action="name"]').count(), 0, "without the PIN, a child's profile never reaches the row");
      await go(again, "settings/tv");
      await padUp(again, true);
      await digits(PIN);
      await padUp(again, false);
      await again.waitForSelector('.settings-panel[data-page="tv"] [data-action="name"]');
      await settled(again);
      await again.locator('.settings-panel [data-action="name"]').hover();
      await again.keyboard.press("Enter");
      await again.waitForSelector('.page.profile [data-action="name-field"].focused');
      assert.equal(await again.locator('[data-action="name-field"]').inputValue(), "Bedroom");
      await again.locator('[data-action="name-field"]').fill("Kitchen");
      await again.locator('.page.profile [data-action="save"]').click();
      await toast(again, "Saved");
      assert.equal((await send("GET", "/api/name")).name, "Kitchen");
    } finally {
      await again.close();
    }
  } finally {
    await page.close().catch(() => {});
  }
});
