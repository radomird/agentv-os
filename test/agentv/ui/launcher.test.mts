// The launcher in a real Chromium (ADR-019, layer 4), on the daemon with the
// sample apps in box.mts: every tile within reach of the keyboard (S2.3),
// tiles that show no tier and details that say who made each app (S2.7), the
// motion rules (S2.10 checks the frames on the NUC), the sound rules (S2.11's
// timing is the NUC's), and what the launcher asks the TV session for.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, startBox } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";

before(async () => {
  ({ daemon, url } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER, args: ["--autoplay-policy=no-user-gesture-required"] });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

// A TV at 1080p, with the screen daemon's binding stood in for: each request
// the launcher sends it lands in window.screenRequests.
async function tv(options: { reducedMotion?: "reduce" | "no-preference" } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: options.reducedMotion ?? "no-preference" });
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: unknown[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".focused");
    return el?.dataset.id ?? el?.dataset.key ?? el?.dataset.action ?? el?.textContent ?? "";
  });
}

// The keyboard's map of the page: for each focusable element, where each
// arrow goes from it.
async function arrows(page: Page): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const ids = await page.$$eval(".grid [data-focus], .bar [data-focus]", (els) => els.map((el, i) => (el as HTMLElement).dataset.id ?? `bar-${i}`));
  for (const [i, id] of ids.entries()) {
    const next: string[] = [];
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      await page.evaluate((index) => {
        const els = document.querySelectorAll<HTMLElement>(".grid [data-focus], .bar [data-focus]");
        (window as unknown as { agentvLauncher: { focus: { set(el: HTMLElement, announce: boolean): void } } }).agentvLauncher.focus.set(els[index], false);
      }, i);
      await page.keyboard.press(key);
      next.push(await page.evaluate(() => {
        const els = [...document.querySelectorAll<HTMLElement>(".grid [data-focus], .bar [data-focus]")];
        const at = els.findIndex((el) => el.classList.contains("focused"));
        return els[at]?.dataset.id ?? `bar-${at}`;
      }));
    }
    map.set(id, next);
  }
  return map;
}

test("S2.3 every tile can be reached with the keyboard alone", async () => {
  const page = await tv();
  // A layout with every size in it.
  await page.evaluate(async () => {
    await fetch("/api/layout", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        layout: [
          { id: "agentv.sample", x: 0, y: 0, size: "l" },
          { id: "agentv.tube", x: 2, y: 0, size: "s" },
          { id: "someone.radio", x: 3, y: 0, size: "s" },
          { id: "local.mytv", x: 2, y: 1, size: "m" },
          { id: "agentv.games", x: 1, y: 2, size: "s" },
          { id: "apps", x: 3, y: 2, size: "s" },
        ],
      }),
    });
  });
  await page.reload();
  await page.waitForSelector(".grid .tile.focused");
  const start = await focused(page);
  const map = await arrows(page);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) for (const next of map.get(queue.shift()!) ?? []) if (!seen.has(next)) (seen.add(next), queue.push(next));
  const tiles = await page.$$eval(".grid .tile", (els) => els.map((el) => (el as HTMLElement).dataset.id));
  for (const tile of tiles) assert.ok(seen.has(tile!), `${tile} can't be reached from ${start} with the arrows`);
  assert.ok(tiles.length >= 6);
  await page.close();
});

test("S2.7 no tile shows a tier, on home or in Apps", async () => {
  const page = await tv();
  const tiers = /official|community|built in|made by|your agent|on this tv only/i;
  assert.doesNotMatch(await page.locator(".grid").innerText(), tiers);
  await page.keyboard.press("ArrowDown");
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  await page.locator('.bar-link:has-text("apps")').click();
  await page.waitForSelector(".row .tile");
  for (const text of await page.locator(".row .tile").allInnerTexts()) assert.doesNotMatch(text, tiers);
  await page.close();
});

test("S2.7 every app's details say who made it", async () => {
  const page = await tv();
  const makers: Record<string, RegExp> = {
    official: /official · made by agentv/,
    community: /community · made by someone/,
    local: /made by your agent · on this tv only/,
  };
  for (const fixture of FIXTURES) {
    await page.goto(`${url}/`);
    await page.waitForSelector(".grid .tile.focused");
    await page.locator(`.grid [data-id="${fixture.id}"]`).hover();
    await page.keyboard.press("i");
    await page.waitForSelector(".details-head");
    assert.match(await page.locator(".maker").innerText(), makers[fixture.tier], fixture.id);
    assert.match(await page.locator(".owner").innerText(), /belong to their owner, who didn't make or endorse this app/);
  }
  await page.close();
});

test("motion only moves transform and opacity, everywhere (ADR-024)", async () => {
  const page = await tv();
  const check = () =>
    page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll("*")) {
        for (const property of getComputedStyle(el).transitionProperty.split(",").map((p) => p.trim())) {
          if (!["transform", "opacity", "none", "all"].includes(property) || property === "all") {
            const duration = getComputedStyle(el).transitionDuration;
            if (duration.split(",").some((d) => parseFloat(d) > 0)) bad.push(`${el.tagName}.${el.className}: ${property}`);
          }
        }
      }
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSKeyframesRule) {
            for (const frame of rule.cssRules) {
              const style = (frame as CSSKeyframeRule).style;
              for (let i = 0; i < style.length; i++) if (!["transform", "opacity"].includes(style[i])) bad.push(`@keyframes ${rule.name}: ${style[i]}`);
            }
          }
        }
      }
      return bad;
    });
  assert.deepEqual(await check(), []);
  await page.locator('.bar-link:has-text("settings")').click();
  await page.waitForSelector(".settings");
  assert.deepEqual(await check(), []);
  await page.locator('.bar-link:has-text("apps")').click();
  await page.waitForSelector(".row");
  assert.deepEqual(await check(), []);
  await page.close();
});

test("motion: focus lifts and glides, and pages slide in (ADR-024)", async () => {
  const page = await tv();
  await page.waitForTimeout(250);
  assert.match(await page.evaluate(() => getComputedStyle(document.querySelector(".tile.focused")!).transform), /matrix\(1\.03/);
  assert.match(await page.evaluate(() => getComputedStyle(document.getElementById("ring")!).transitionDuration), /0\.12s/);
  await page.keyboard.press("i");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".screen")!).animationName), "page-forward");
  await page.close();
});

test("reduce motion turns movement into fades, from the system or Settings", async () => {
  const page = await tv({ reducedMotion: "reduce" });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".tile.focused")!).transform), "none");
  await page.keyboard.press("i");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".screen")!).animationName), "fade-in");
  await page.close();

  const set = await tv();
  await set.evaluate(() => fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reduceMotion: true }) }));
  await set.reload();
  await set.waitForSelector(".grid .tile.focused");
  assert.equal(await set.evaluate(() => getComputedStyle(document.querySelector(".tile.focused")!).transform), "none");
  await set.evaluate(() => fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reduceMotion: false }) }));
  await set.close();
});

test("S2.11 a held arrow plays at most one move sound every 60 ms, and Settings → Sound silences them", async () => {
  const page = await tv();
  const log = () => page.evaluate(() => (window as unknown as { agentvLauncher: { sounds: { log: { sound: string; at: number }[] } } }).agentvLauncher.sounds.log.slice());
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("ArrowRight", { delay: 0 });
    await page.keyboard.press("ArrowLeft", { delay: 0 });
  }
  const moves = (await log()).filter((entry) => entry.sound === "move");
  assert.ok(moves.length >= 1);
  for (let i = 1; i < moves.length; i++) assert.ok(moves[i].at - moves[i - 1].at >= 59, `two move sounds ${moves[i].at - moves[i - 1].at} ms apart`);

  await page.keyboard.press("i");
  await page.waitForTimeout(250);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  const names = (await log()).map((entry) => entry.sound);
  assert.ok(names.includes("forward") && names.includes("back"), names.join(" "));

  await page.evaluate(() => fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sound: { on: false } }) }));
  await page.reload();
  await page.waitForSelector(".grid .tile.focused");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("i");
  assert.deepEqual(await log(), []);
  await page.evaluate(() => fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sound: { on: true } }) }));
  await page.close();
});

test("the seven sounds are there, as Ogg Opus", async () => {
  for (const sound of ["move", "select", "forward", "back", "confirm", "success", "failure"]) {
    const response = await fetch(`${url}/launcher/sounds/${sound}.ogg`);
    assert.equal(response.status, 200, sound);
    assert.equal(response.headers.get("content-type"), "audio/ogg");
    const body = new Uint8Array(await response.arrayBuffer());
    assert.equal(String.fromCharCode(...body.slice(0, 4)), "OggS");
    assert.ok(String.fromCharCode(...body.slice(28, 36)) === "OpusHead", `${sound} is Opus`);
  }
});

test("Enter on a tile asks the TV session to open its app, and Settings asks for Omarchy's desktop", async () => {
  const page = await tv();
  await page.locator('.grid [data-id="agentv.tube"]').hover();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as unknown as { screenRequests: unknown[] }).screenRequests.length > 0);
  const [open] = await page.evaluate(() => (window as unknown as { screenRequests: { cmd: string; app?: string }[] }).screenRequests);
  assert.deepEqual({ cmd: open.cmd, app: open.app }, { cmd: "open-app", app: "agentv.tube" });

  await page.locator('.bar-link:has-text("settings")').click();
  await page.locator('.menu-item[data-key="desktop"]').click();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as unknown as { screenRequests: { cmd: string }[] }).screenRequests.some((r) => r.cmd === "desktop"));
  await page.close();
});

test("details put an app on home and take it off", async () => {
  const page = await tv();
  await page.locator('.grid [data-id="agentv.games"]').hover();
  await page.keyboard.press("i");
  await page.waitForSelector(".details-head");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(page), "home");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-action="home"] .button-value')?.textContent === "[ ]");
  const layout = await page.evaluate(async () => (await (await fetch("/api/home")).json()).layout.map((t: { id: string }) => t.id));
  assert.ok(!layout.includes("agentv.games"));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-action="home"] .button-value')?.textContent === "[x]");
  await page.close();
});

test("a 720p TV shows the same page, smaller, with the ring on the focused tile", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  const rect = (selector: string) =>
    page.evaluate((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom };
    }, selector);
  const tile = await rect(".tile.focused");
  const ring = await rect("#ring");
  // A small tile is 452 × 308 at 1080p, and two thirds of that here, lifted 3%.
  assert.ok(Math.abs(tile.w - 452 * (2 / 3) * 1.03) < 3, `tile ${tile.w} wide`);
  for (const key of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(tile[key] - ring[key]) < 2, `ring ${key}: ${ring[key]} vs ${tile[key]}`);
  assert.equal((await rect(".bar")).bottom, 720);
  // All apps fits on one line, as at 1080p.
  const name = await rect('.tile-apps .tile-name');
  assert.ok(name.h < 60, `"all apps" is ${name.h} px tall`);
  await page.close();
});

test("the launcher has no errors in its console", async () => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  for (const key of ["ArrowRight", "ArrowDown", "i", "Escape", "ArrowDown", "ArrowDown", "Enter"]) await page.keyboard.press(key);
  await page.waitForTimeout(300);
  assert.deepEqual(errors, []);
  await page.close();
});
