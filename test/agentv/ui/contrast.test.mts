// Every theme Omarchy ships stays legible on the TV (ADR-048, S5.8): home,
// Apps and Settings, in each of them, light ones included. Each theme's
// colours are resolved by Omarchy's own omarchy-theme-color and rendered
// into AgenTV's template, as Omarchy does when it sets the theme. Then every
// piece of text on each page is measured against what's behind it, opacity
// included, with WCAG's bar: 4.5 : 1, or 3 : 1 for large text (24 px, or
// 19 px bold).

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { ROOT, startBox } from "./box.mts";
import { rendered, shortfalls, THEMES } from "./legible.mts";

const require = createRequire(join(process.env.AGENTV_UI_MODULES ?? join(ROOT, "node_modules"), "x.js"));
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";

before(async () => {
  ({ daemon, url } = await startBox());
  await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "field" }) });
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

test("S5.8 home, Apps and Settings read clearly in every theme Omarchy ships, light ones included", async () => {
  const page = await tv();
  const short: string[] = [];
  try {
    for (const theme of THEMES) {
      assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200, `the theme ${theme} took`);
      for (const [where, go] of [
        ["home", async () => page.keyboard.press("Home")],
        ["apps", async () => page.locator('.bar-link:has-text("apps")').click()],
        ["settings", async () => page.locator('.bar-link:has-text("settings")').click()],
        ["settings → look", async () => page.locator('.menu-item[data-key="look"]').click()],
      ] as const) {
        await go();
        await page.waitForTimeout(150);
        await page.evaluate(async () => {
          const link = document.getElementById("theme") as HTMLLinkElement;
          link.href = `/api/theme.css?at=${Date.now()}`;
          await new Promise((resolve) => link.addEventListener("load", resolve, { once: true }));
        });
        for (const one of await shortfalls(page)) short.push(`${theme}, ${where}: "${one.text}" ${one.ratio} of ${one.needs} (${one.color} on ${one.behind})`);
      }
      await page.keyboard.press("Home");
    }
  } finally {
    await page.close();
  }
  assert.deepEqual(short, [], `text that's hard to read:\n${short.join("\n")}`);
});
