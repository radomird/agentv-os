// The connect screens (ADR-103, T19.1), in a real Chromium, with the
// sign-in's link from a stand-in for the CLI's sign-in:
//
// - setup's AI step, in Terminal's style as all of setup is (Q314): the code
//   to scan and the steps side by side in the middle, not pushed to the
//   right, clear of the soundtrack's card and the bar, at 1080p and 720p,
//   with the code field, or the code to enter, in the last step;
// - Settings' sign-in page in each look, dark and light, laid out as
//   pairing a phone: the code on the left and the steps on the right, every
//   part on the screen and reading clearly, with the code field focused.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";
import { rendered, shortfalls } from "./legible.mts";
import { pairPhone } from "../unit/phone-client.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
const THEMES = ["tokyo-night", "catppuccin-latte"];

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
let run = "";
const errors: string[] = [];
const tools = mkdtempSync(join(tmpdir(), "origaitv-connect-"));
const path = process.env.PATH;

const send = (method: string, at: string, body?: unknown) =>
  fetch(`${url}${at}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  // A QR code as qrencode draws one.
  writeFileSync(join(tools, "qrencode"), `#!/bin/bash\necho '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 21 21"><rect width="7" height="7"/><rect x="14" width="7" height="7"/><rect y="14" width="7" height="7"/></svg>'\n`);
  chmodSync(join(tools, "qrencode"), 0o755);
  process.env.PATH = `${tools}:${path}`;
  let builds = "";
  ({ daemon, url, state, builds } = await startBox(0, FIXTURES, { features: { looks: true, setup2: true } }));
  run = join(builds, "..", "build-run");
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
  // Claude's plan, its terms accepted on a paired phone.
  assert.equal((await send("POST", "/api/ai", { provider: "claude", path: "plan" })).status, 200);
  const code = (await (await send("POST", "/api/phones/pair", {})).json()).pairing.code;
  const phone = await pairPhone(`http://127.0.0.1:${daemon.lanPort}`, code, "pixel");
  assert.equal((await phone.fetch("/api/phone/terms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "claude", path: "plan" }) })).status, 200);
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  process.env.PATH = path;
  rmSync(tools, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

// The CLI's sign-in, as it writes how it stands.
function signInSays(status: Record<string, unknown>): void {
  mkdirSync(join(run, "sign-in"), { recursive: true });
  writeFileSync(join(run, "sign-in", "status.json"), JSON.stringify({ provider: "claude", at: new Date(Date.now() + 1000).toISOString(), ...status }));
}

async function open(width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  return page;
}

// Until nothing on the page is still moving in, as a page slides in.
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  await page.waitForFunction(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5000 });
}

// Where each part is on the screen, in the screen's own pixels.
function boxes(page: Page, selectors: Record<string, string>): Promise<Record<string, { left: number; right: number; top: number; bottom: number } | null>> {
  return page.evaluate((all) => {
    const found: Record<string, { left: number; right: number; top: number; bottom: number } | null> = {};
    for (const [name, selector] of Object.entries(all)) {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      found[name] = box && box.width > 0 ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null;
    }
    return found;
  }, selectors);
}

for (const [width, height] of [
  [1920, 1080],
  [1280, 720],
] as const) {
  test(`T19.1 setup's connect screen at ${height}p: the code to scan and the steps together in the middle, clear of the card and the bar`, async () => {
    writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "ai", finished: { welcome: "2026-11-05T10:00:00Z", ready: "2026-11-05T10:01:00Z", country: "2026-11-05T10:02:00Z" } }));
    rmSync(join(state, "plan-sign-in.json"), { force: true });
    rmSync(run, { recursive: true, force: true });
    const page = await open(width, height);
    try {
      await page.waitForSelector(".ai-options");
      signInSays({ state: "waiting", url: "https://claude.ai/oauth/authorize?code=true&state=s7Q", pastes: true });
      await page.waitForSelector(".ai-qr:not(.hidden) .qr[src]");
      await page.waitForSelector('[data-action="sign-in-code"].focused');
      await page.waitForTimeout(300);
      const at = await boxes(page, { qr: ".ai-qr .qr-box", steps: ".ai-steps", field: ".ai-steps .ai-paste", ways: ".ai-connect .ai-options", line: '[data-line="sign-in"]', card: ".soundtrack, .music-card, [data-soundtrack]", bar: ".bar" });
      const problems: string[] = [];
      for (const [name, box] of Object.entries(at)) {
        if (!box) {
          if (name !== "card") problems.push(`${name} isn't there`);
          continue;
        }
        if (box.left < 0 || box.top < 0 || box.right > width + 1 || box.bottom > height + 1) problems.push(`${name} is cut off`);
      }
      const { qr, steps, field, ways, line, card, bar } = at;
      if (qr && steps) {
        if (!(steps.left > qr.right)) problems.push("the steps aren't beside the code");
        if (steps.top > qr.bottom || steps.bottom < qr.top) problems.push("the steps and the code aren't side by side");
        const middle = (qr.left + Math.max(steps.right, field?.right ?? 0)) / 2;
        if (Math.abs(middle - width / 2) > width * 0.08) problems.push(`the two sit at ${Math.round(middle)} px, not in the middle of ${width}`);
        if (qr.left > width / 2) problems.push("the code is pushed to the right");
      }
      if (qr && line && qr.top < line.bottom) problems.push("the code runs into the line under the headline");
      for (const part of [qr, steps, ways]) {
        if (part && bar && part.bottom > bar.top) problems.push("something runs into the bar");
        if (part && card && part.bottom > card.top && part.left < card.right) problems.push("something runs into the soundtrack's card");
      }
      assert.deepEqual(problems, []);
      // A provider whose page asks for a code the TV shows: it's the last
      // step, with nothing to paste.
      signInSays({ state: "waiting", url: "https://example.invalid/device", code: "ABCD-EFGH", pastes: false });
      await page.waitForFunction(() => document.querySelector('.ai-steps [data-step="code"] span')?.textContent === "Enter ABCD-EFGH when it asks");
      assert.equal(await page.locator(".ai-steps .ai-paste").isVisible(), false);
    } finally {
      await page.close();
    }
  });
}

for (const look of LOOKS) {
  test(`T19.1 ${look}: Settings' sign-in page is laid out as pairing a phone, the code on the left and the steps on the right, on the screen and clear, dark and light`, async () => {
    writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true }));
    await send("PUT", "/api/look", { look });
    const problems: string[] = [];
    for (const theme of THEMES) {
      assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200);
      rmSync(join(state, "plan-sign-in.json"), { force: true });
      rmSync(run, { recursive: true, force: true });
      const page = await open(1920, 1080);
      try {
        await page.waitForSelector("html[data-look] #page .focused");
        await page.evaluate(() => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go("plan-sign-in"));
        await page.waitForSelector(".page.plan-sign-in");
        signInSays({ state: "waiting", url: "https://claude.ai/oauth/authorize?code=true&state=s7Q", pastes: true });
        await page.waitForSelector(".sign-in-qr:not(.hidden) img[src]");
        await page.waitForSelector('[data-action="sign-in-code"].focused');
        await rest(page);
        await settled(page);
        const at = await boxes(page, { qr: ".sign-in-qr", text: ".plan-sign-in .pair-text", headline: ".plan-sign-in .pair-text h1, .plan-sign-in .pair-text .page-title, .plan-sign-in .pair-text [aria-level]", steps: ".sign-in-steps", field: ".sign-in-paste", again: '[data-action="again"]' });
        for (const [name, box] of Object.entries(at)) {
          if (!box) {
            if (name !== "headline") problems.push(`${theme}: ${name} isn't there`);
            continue;
          }
          if (box.left < 0 || box.top < 0 || box.right > 1921 || box.bottom > 1081) problems.push(`${theme}: ${name} is cut off`);
        }
        if (at.qr && at.text && !(at.text.left > at.qr.right)) problems.push(`${theme}: the steps aren't to the right of the code`);
        for (const one of await shortfalls(page)) problems.push(`${theme}: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
      } finally {
        await page.close();
      }
    }
    assert.deepEqual(problems, [], `${look}:\n${problems.join("\n")}`);
  });
}
