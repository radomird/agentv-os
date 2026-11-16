// The building screen in each look, in a real Chromium (ADR-103, T19.1),
// while an app is made, with six steps, at each size, dark and light:
//
// - Glass and Cinema draw it in their own design, centred as the update
//   screen is: the app's logo, "Making Blocks", a slim bar, the time left
//   from when it started, the steps with the look's own marks, and Stop;
// - Terminal's stays as it was: its page, its bracketed marks;
// - in every look it's all on the screen, nothing is cut off, and its words
//   read clearly.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
const SIZES = { larger: 1600, standard: 1920, more: 2400 } as const;
const THEMES = ["tokyo-night", "catppuccin-latte"];

let browser: Browser;
let daemon: Daemon;
let url = "";
let build = "";
const errors: string[] = [];

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  let state = "";
  let builds = "";
  ({ daemon, url, state, builds } = await startBox(0, FIXTURES.filter((app) => app.tier !== "local"), { features: { looks: true } }));
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
  // Claude with a key, its terms accepted on a paired phone, as a build needs.
  writeFileSync(join(state, "..", "key.json"), JSON.stringify({ set: true, provider: "claude", at: new Date().toISOString() }));
  await send("POST", "/api/ai", { provider: "claude", path: "key" });
  const code = (await (await send("POST", "/api/phones/pair", {})).json()).pairing.code;
  const phone = await pairPhone(`http://127.0.0.1:${daemon.lanPort}`, code, "pixel");
  assert.equal((await phone.fetch("/api/phone/terms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "claude", path: "key" }) })).status, 200);
  // A game, four minutes into its recipe's twenty, on its third of six steps.
  const made = (await (await send("POST", "/api/builds", { sentence: "a game like tetris" })).json()).build;
  build = made.build;
  rmSync(join(state, "build-drop", "start.json"));
  mkdirSync(join(state, "..", "build-run"), { recursive: true });
  writeFileSync(join(state, "..", "build-run", "answer.json"), JSON.stringify({ action: "start", build, started: true, at: new Date().toISOString() }));
  const dir = join(builds, made.id, "1.0.0");
  mkdirSync(dir, { recursive: true });
  const steps = ["plan-the-game", "draw-the-board", "write-the-rules", "add-sounds", "add-scores", "test-it"].map((id, i) => ({ id, state: i < 2 ? "done" : i === 2 ? "running" : "waiting" }));
  writeFileSync(join(dir, "status.json"), JSON.stringify({ build, id: made.id, version: "1.0.0", phase: "build", state: "running", steps, understood: { name: "Blocks", recipe: "game", says: "A falling-block game" }, started: new Date(Date.now() - 4 * 60_000).toISOString(), at: new Date(Date.now() + 5).toISOString() }));
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

async function building(size: keyof typeof SIZES): Promise<Page> {
  const width = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height: Math.round((width * 9) / 16) } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/?size=${size}`);
  await page.waitForSelector("html[data-look] #page .focused");
  await page.evaluate((r) => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go(r), `build/${build}`);
  await page.waitForSelector('.build-page[data-state="running"]');
  await rest(page);
  await page.waitForTimeout(300);
  await page.waitForFunction(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5000 });
  return page;
}

for (const look of LOOKS) {
  test(`T19.1 ${look}: the building screen at each size, dark and light, ${look === "terminal" ? "as it was" : "centred in the look's own design"}, all on the screen and clear`, async () => {
    await send("PUT", "/api/look", { look });
    const problems: string[] = [];
    for (const theme of THEMES) {
      assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200);
      for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
        const page = await building(size);
        const at = `${theme}, ${size}`;
        try {
          const seen = await page.evaluate(() => {
            const shown = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
            const page = document.querySelector(".build-page")!;
            const parts = [...page.querySelectorAll<HTMLElement>(".logo, .updating-title, .headline, .updating-bar, .building-time, .updating-step, .panel-note, .check-actions .button")].filter((el) => el.offsetParent !== null);
            const off = parts.filter((el) => {
              const box = el.getBoundingClientRect();
              return box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1 || el.scrollWidth > el.clientWidth + 2;
            });
            const box = shown(page.querySelector(".building-box"));
            const marks = [...page.querySelectorAll(".updating-step > b")].map((b) => getComputedStyle(b).display !== "none" && (b.textContent ?? "").trim());
            return {
              centred: box ? Math.abs((box.left + box.right) / 2 - innerWidth / 2) <= 4 : false,
              box: Boolean(box),
              logo: Boolean(page.querySelector(".building-box .logo")),
              title: (page.querySelector(".building-box .updating-title, .headline") as HTMLElement | null)?.textContent ?? "",
              time: page.querySelector(".building-time")?.textContent ?? "",
              steps: page.querySelectorAll(".updating-step").length,
              marks,
              off: off.map((el) => el.className || el.tagName),
            };
          });
          if (look === "terminal") {
            if (seen.box) problems.push(`${at}: Terminal has the centred box`);
            if (seen.marks.join(" ") !== "[x] [x] [~] [ ] [ ] [ ]") problems.push(`${at}: Terminal's marks are ${seen.marks.join(" ")}`);
          } else {
            if (!seen.box || !seen.centred) problems.push(`${at}: the box isn't centred`);
            if (!seen.logo) problems.push(`${at}: no logo`);
            if (seen.title !== "Making Blocks") problems.push(`${at}: the title is "${seen.title}"`);
            if (!/^About 1[56] minutes left\. You can keep watching\.$/.test(seen.time)) problems.push(`${at}: the time says "${seen.time}"`);
            if (seen.marks.some(Boolean)) problems.push(`${at}: the steps show Terminal's marks`);
          }
          if (seen.steps !== 6) problems.push(`${at}: ${seen.steps} steps`);
          for (const one of seen.off) problems.push(`${at}: ${one} is cut off`);
          for (const one of await shortfalls(page)) problems.push(`${at}: "${one.text}" reads at ${one.ratio} of ${one.needs}`);
        } finally {
          await page.close();
        }
      }
    }
    assert.deepEqual(problems, [], `${look}:\n${problems.join("\n")}`);
  });
}
