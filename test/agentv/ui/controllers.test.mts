// Settings, controllers in a real Chromium (ADR-019, layer 4; ADR-084,
// T16.1), in each look. The daemon's routes, its asks and the code that
// drives BlueZ are the real ones, the last run here the way the screen
// daemon runs it in the TV session, on a stand-in BlueZ
// (fixtures/controllers/bluez.mts): the controllers nearby show as they're
// found and a keyboard nearby doesn't, OK pairs one and it shows as
// connected, OK again removes it, a TV with Bluetooth off or with none says
// so, and the looking stops when the page closes. With a PIN set the pad
// comes first, without one it never does, and a child's profile can't pair.
// A real controller and a real radio are the NUC's.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { AskWatch } from "../../../daemon/asks.ts";
import { Controllers, type ControllerAnswer, type ControllerAsk } from "../../../daemon/controllers.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { DUALSENSE, HEADPHONES, KEYBOARD, StandInBluez, XBOX } from "../fixtures/controllers/bluez.mts";
import { machine, rest, startBox } from "./box.mts";
import { rendered, shortfalls } from "./legible.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
type Look = (typeof LOOKS)[number];
const SIZES = { larger: 1600, standard: 1920, more: 2400 } as const;
type Size = keyof typeof SIZES;
// A dark theme and a light one: Omarchy's default and its lightest.
const THEMES = ["tokyo-night", "catppuccin-latte"];
const PIN = "4826";
const WIRED = "8BitDo Pro 2 Wired Controller";
// Where to keep pictures of the page, for looking at: nowhere unless set.
const SHOTS = process.env.AGENTV_SHOTS;

let browser: Browser;
let daemon: Daemon;
let url = "";
let bluez: StandInBluez;
let driver: Controllers;
let watch: AskWatch<ControllerAsk, ControllerAnswer>;
const errors: string[] = [];

// The devices around the TV: two controllers and a keyboard in pairing
// mode, headphones paired from the desktop, and a controller on a cable.
function around(): void {
  driver?.stop();
  bluez.adapter = true;
  bluez.powered = true;
  bluez.blocked = false;
  bluez.seen.clear();
  bluez.devices = [XBOX, DUALSENSE, KEYBOARD, HEADPHONES].map((device) => ({ ...device }));
  bluez.calls.length = 0;
}

before(async () => {
  ({ daemon, url } = await startBox(0, undefined, { box: { machine: { ...machine("nuc8i5beh"), gamepads: [WIRED] } } }));
  await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "field" }) });
  bluez = new StandInBluez();
  around();
  driver = new Controllers({ run: bluez.run, look: bluez.look, inputs: bluez.inputs, log: () => {}, settleMs: 60 });
  watch = new AskWatch<ControllerAsk, ControllerAnswer>({
    url: `${url}/`,
    path: "api/controllers/ask",
    what: "controllers",
    handle: (ask) => driver.handle(ask),
    failed: (error) => ({ ok: false, bluetooth: "none", looking: false, controllers: [], why: "failed", error: error.message }),
    log: () => {},
    retryMs: 50,
  });
  watch.start();
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  watch?.stop();
  driver?.stop();
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

async function useLook(look: Look): Promise<void> {
  const response = await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
  assert.equal(response.status, 200);
}

async function useTheme(theme: string): Promise<void> {
  await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) });
}

async function tv(size: Size = "standard"): Promise<Page> {
  const width = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height: Math.round((width * 9) / 16) } });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/?size=${size}`);
  await page.waitForSelector("html[data-look] #page .focused");
  await rest(page);
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const focused = (page: Page) => page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action") ?? document.querySelector(".focused")?.getAttribute("data-key"));
const padUp = (page: Page) => page.evaluate(() => document.getElementById("pin")?.classList.contains("on") === true);
const panel = (page: Page) => page.locator(".panel").innerText();
const row = (id: string) => `.panel [data-action="controller-${id}"]`;
const did = (what: RegExp) => bluez.calls.filter((call) => what.test(call));
const until = async (check: () => boolean, what: string) => {
  for (let waited = 0; !check(); waited += 25) {
    assert.ok(waited < 5000, what);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

// Opens Settings at controllers, and waits for the list.
async function open(page: Page): Promise<void> {
  await go(page, "settings/controllers");
  await page.waitForSelector('.menu-item.open[data-key="controllers"]');
  await page.waitForSelector(".panel [data-note='controllers'], .panel [data-action='bluetooth-on']");
}

// Moves down the panel to a row, or up to it.
async function moveTo(page: Page, id: string, key = "ArrowDown"): Promise<void> {
  for (let presses = 0; (await focused(page)) !== `controller-${id}`; presses++) {
    assert.ok(presses < 8, `the focus reaches ${id}, from ${await focused(page)}`);
    await page.keyboard.press(key);
  }
}

// What's cut off or off the screen, as the looks' own check has it
// (looks.test.mts), for this page.
function overflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : ""} "${(el.textContent ?? "").trim().slice(0, 30)}"`;
    for (const el of document.querySelectorAll<HTMLElement>("#page *")) {
      if (el.closest("svg, [aria-hidden='true']") || el.matches("svg")) continue;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || style.visibility !== "visible" || Number(style.opacity) === 0) continue;
      const scrolls = el.parentElement?.closest("[data-scroll]");
      if (!scrolls && (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1)) {
        found.push(`${name(el)} is off the screen`);
        continue;
      }
      const clips = style.overflowX !== "visible" || style.overflowY !== "visible";
      const clamped = style.textOverflow === "ellipsis" || (style.webkitLineClamp !== "none" && style.webkitLineClamp !== "");
      if (!clips || el.hasAttribute("data-scroll") || clamped || el instanceof HTMLImageElement) continue;
      if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) found.push(`${name(el)} cuts off what's in it`);
    }
    return found;
  });
}

for (const look of LOOKS) {
  // Terminal's words are lower case, and a controller's own name never is.
  const said = (text: string) => (look === "terminal" ? text.toLowerCase() : text);

  test(`T16.1 controllers in ${look}: the ones nearby show and a keyboard doesn't, OK pairs one, OK again removes it, and it says so with Bluetooth off or none`, async () => {
    around();
    await useLook(look);
    await useTheme(THEMES[0]);
    const page = await tv();
    try {
      assert.equal(bluez.scanning, false, "nothing looks before the page opens");
      await open(page);
      await page.waitForSelector(row(XBOX.address));
      await page.waitForSelector(row(DUALSENSE.address));
      assert.equal(bluez.scanning, true, "the TV looks while the page is open");
      let text = await panel(page);
      assert.ok(text.includes(said("To add one, hold its pairing button until it blinks")), text);
      assert.match(text, new RegExp(`DualSense Wireless Controller\\s+${said("Pair")}\\s+Xbox Wireless Controller\\s+${said("Pair")}`));
      assert.match(text, new RegExp(`${WIRED}\\s+${said("Plugged in")}`), "the one on a cable needs nothing");
      assert.doesNotMatch(text, /keychron|wh-1000/i, "a keyboard and headphones are never listed");
      assert.equal(await page.locator(".panel [data-controller]").count(), 3);
      // Settings' own list: the section, and how many are connected, which
      // the looks keep out of sight.
      assert.equal(await page.locator('.menu-item[data-key="controllers"] span').first().innerText(), said("Controllers"));
      assert.equal(await page.locator('.menu-item[data-key="controllers"] .menu-value').textContent(), "1");

      // OK on the section goes into it, and OK on a controller pairs it,
      // with no PIN pad when no PIN is set.
      await page.keyboard.press("Enter");
      await moveTo(page, XBOX.address);
      await page.keyboard.press("Enter");
      await page.waitForSelector(`${row(XBOX.address)}[data-controller="paired"]`);
      assert.equal(await padUp(page), false);
      await page.waitForFunction((want) => [...document.querySelectorAll("#toasts .toast")].some((toast) => toast.textContent === want), `${said("Paired")} Xbox Wireless Controller`);
      assert.match(await page.locator(row(XBOX.address)).innerText(), new RegExp(`Xbox Wireless Controller\\s+${said("Connected · Remove")}`));
      assert.equal(await focused(page), `controller-${XBOX.address}`, "the focus stays on it");
      assert.deepEqual(did(/ (Pair|Connect)$|Trusted/).map((call) => call.split(" ").slice(4).join(" ")), ["org.bluez.Device1 Pair", "org.bluez.Device1 Trusted b true", "org.bluez.Device1 Connect"]);
      assert.equal(await page.locator('.menu-item[data-key="controllers"] .menu-value').textContent(), "2");
      // Paired ones come first.
      assert.equal(await page.locator(".panel [data-controller]").first().getAttribute("data-action"), `controller-${XBOX.address}`);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${look}-dark-paired.png`) });

      // OK on a paired one removes it, and it's nearby again.
      await page.keyboard.press("Enter");
      await page.waitForSelector(`${row(XBOX.address)}[data-controller="nearby"]`);
      await page.waitForFunction((want) => [...document.querySelectorAll("#toasts .toast")].some((toast) => toast.textContent === want), `${said("Removed")} Xbox Wireless Controller`);
      assert.equal(did(/RemoveDevice/).length, 1);
      assert.equal(await focused(page), `controller-${XBOX.address}`);

      // A keyboard asked for past the page is refused by the TV itself.
      const forced = await (await fetch(`${url}/api/controllers/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: KEYBOARD.address }) })).json();
      assert.deepEqual([forced.ok, forced.why], [false, "not-a-controller"]);
      assert.notEqual(bluez.devices.find((device) => device.address === KEYBOARD.address)?.paired, true);

      // A controller that wants a code: one plain line, and it isn't paired.
      bluez.devices.find((device) => device.address === DUALSENSE.address)!.wantsCode = true;
      await page.waitForSelector(row(DUALSENSE.address));
      await moveTo(page, DUALSENSE.address, "ArrowUp");
      await page.keyboard.press("Enter");
      await page.waitForFunction((want) => [...document.querySelectorAll("#toasts .toast.fail")].some((toast) => toast.textContent === want), said("Couldn't pair {name}. If it asks for a code, use a cable instead.").replace("{name}", "DualSense Wireless Controller"));
      assert.notEqual(bluez.devices.find((device) => device.address === DUALSENSE.address)?.paired, true);

      // Bluetooth switched off: one button, which turns it on.
      bluez.powered = false;
      bluez.blocked = true;
      await page.waitForSelector('.panel [data-action="bluetooth-on"]');
      text = await panel(page);
      assert.ok(text.includes(said("Turn on Bluetooth")), text);
      assert.equal(await page.locator(".panel [data-controller]:not([data-controller='usb'])").count(), 0);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${look}-dark-off.png`) });
      await page.locator('.panel [data-action="bluetooth-on"]').click();
      await page.waitForSelector(row(XBOX.address));
      assert.equal(bluez.powered, true);

      // No Bluetooth at all: one plain line, and the cable still works.
      bluez.adapter = false;
      await page.waitForFunction((want) => document.querySelector(".panel [data-note='controllers']")?.textContent === want, said("Your TV has no Bluetooth. Plug a controller in with a cable."));
      text = await panel(page);
      assert.match(text, new RegExp(`${WIRED}\\s+${said("Plugged in")}`));
      assert.equal(await page.locator(".panel [data-focus]").count(), 0, "nothing to pair");
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${look}-dark-none.png`) });
      bluez.adapter = true;
      await page.waitForSelector(row(XBOX.address));

      // One that says it's a game controller and turns out to type is
      // removed again, with one plain line. Its name is shown as it is.
      const odd = { address: "C8:3F:26:0A:0B:0C", name: "Pad $& Pro", icon: "input-gaming", appearance: 0x03c4, nearby: true, presents: "keyboard" as const };
      bluez.devices.push(odd);
      bluez.seen.add(odd.address);
      await page.waitForSelector(row(odd.address));
      await page.locator(row(odd.address)).click();
      await page.waitForFunction((want) => [...document.querySelectorAll("#toasts .toast.fail")].some((toast) => toast.textContent === want), said("Couldn't pair {name}. Only game controllers pair here.").replace("{name}", () => odd.name));
      assert.equal(bluez.devices.find((device) => device.address === odd.address)?.paired, false, "it isn't left paired");
      assert.equal(bluez.devices.find((device) => device.address === odd.address)?.trusted, false);
      bluez.devices = bluez.devices.filter((device) => device.address !== odd.address);

      // An app opened in front of home, as from a phone: the looking rests
      // until home is in front again.
      const front = (app: boolean) => page.evaluate((on) => (window as unknown as { agentvFront: (app: boolean) => void }).agentvFront(on), app);
      assert.equal(bluez.scanning, true);
      await front(true);
      await until(() => !bluez.scanning, "the looking stops while an app is in front");
      await front(false);
      await until(() => bluez.scanning, "and starts again when home is back");

      // The looking stops when the page closes.
      assert.equal(bluez.scanning, true);
      await go(page, "home");
      await until(() => !bluez.scanning, "the looking stops once Settings is closed");
    } finally {
      await page.close();
    }
  });

  test(`T16.1 controllers in ${look} fit and read clearly, dark and light, at each size`, async () => {
    around();
    Object.assign(bluez.devices.find((device) => device.address === XBOX.address)!, { paired: true, trusted: true, connected: true });
    await useLook(look);
    const problems: string[] = [];
    for (const theme of THEMES) {
      await useTheme(theme);
      for (const size of Object.keys(SIZES) as Size[]) {
        const page = await tv(size);
        try {
          await open(page);
          await page.waitForSelector(row(DUALSENSE.address));
          await page.keyboard.press("Enter");
          await page.waitForTimeout(400);
          await page.waitForFunction(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5000 });
          for (const one of await overflows(page)) problems.push(`${theme} at ${size}: ${one}`);
          for (const one of await shortfalls(page)) problems.push(`${theme} at ${size}: "${one.text}" reads at ${one.ratio} of ${one.needs} (${one.color} on ${one.behind})`);
          if (SHOTS) await page.screenshot({ path: join(SHOTS, `${look}-${theme === THEMES[0] ? "dark" : "light"}-${size}.png`) });
          await go(page, "home");
        } finally {
          await page.close();
        }
      }
    }
    assert.deepEqual(problems, []);
  });
}

test("T16.1 with a PIN set the pad comes before pairing, and a child's profile sees the list but can't pair", async () => {
  around();
  await useLook("glass");
  await useTheme(THEMES[0]);
  assert.equal(daemon.pin.set(PIN, undefined), null);
  const page = await tv();
  try {
    await open(page);
    await page.waitForSelector(row(XBOX.address));
    await page.keyboard.press("Enter");
    await moveTo(page, XBOX.address);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("pin")?.classList.contains("on") === true);
    assert.deepEqual(did(/ Pair$/), [], "nothing pairs before the PIN");
    // Back from the pad: still not paired.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("pin")?.classList.contains("on") === false);
    await page.waitForTimeout(300);
    assert.deepEqual(did(/ Pair$/), []);
    // With the PIN, it pairs.
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("pin")?.classList.contains("on") === true);
    for (const digit of PIN) await page.keyboard.press(digit);
    await page.waitForSelector(`${row(XBOX.address)}[data-controller="paired"]`);
    assert.equal(did(/ Pair$/).length, 1);
  } finally {
    await page.close();
  }

  // A child's profile: the list, and no pairing or removing without the PIN.
  const checked = daemon.pin.check(PIN);
  assert.ok(checked.ok);
  const send = (method: string, path: string, body?: unknown, grant?: string) =>
    fetch(`${url}${path}`, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const child = (await (await send("POST", "/api/viewers", { name: "mila", role: "child" }, checked.grant)).json()).profile;
  assert.equal((await send("POST", "/api/viewer", { id: child.id })).status, 200);
  await send("POST", "/api/controllers/look", { on: true });
  const seen = await (await send("GET", "/api/controllers")).json();
  assert.deepEqual(seen.controllers.map((one: { name: string }) => one.name), ["Xbox Wireless Controller", "DualSense Wireless Controller"]);
  bluez.calls.length = 0;
  assert.equal((await send("POST", "/api/controllers/pair", { id: DUALSENSE.address })).status, 403);
  assert.equal((await send("DELETE", `/api/controllers/${XBOX.address}`)).status, 403);
  assert.deepEqual(did(/ Pair$|RemoveDevice/), []);
  // On the TV, a child's Settings is behind the pad to begin with.
  const kid = await tv();
  try {
    await go(kid, "settings/controllers");
    await kid.waitForFunction(() => document.getElementById("pin")?.classList.contains("on") === true);
    assert.equal(await kid.locator('.menu-item[data-key="controllers"]').count(), 0);
  } finally {
    await kid.close();
    await send("POST", "/api/controllers/look", { on: false });
  }
});
