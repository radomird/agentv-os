// T14.2: every screen in the new words, in each look, dark and light, at
// each size. On each screen: nothing is cut off, there's one headline at
// most and it has no full stop, there's one line of explanation at most,
// and no word the TV never says is on it. The words people read come from
// the pages' code and from the daemon at run time, so this reads what's
// drawn, the rendered twin of the house rules' check on the code.
//
// Each look is walked at standard in a dark theme and a light one, and at
// larger and more on screen in the dark one: twelve walks of the TV's
// screens, and setup's steps four times. The headlines go to
// $AGENTV_UI_SHOTS/T14.2-headlines.txt, one "route, look, headline" a line,
// to compare with the copy sheet, which lives in another repo.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { STEPS } from "../../../daemon/setup.ts";
import { FIXTURES, rest, ROOT, startBox } from "./box.mts";
import { cutOff } from "./fits.mts";
import { rendered } from "./legible.mts";
import { startMet, type Met } from "./met.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
type Look = (typeof LOOKS)[number];
const SIZES = { larger: [1600, 900], standard: [1920, 1080], more: [2400, 1350] } as const;
type Size = keyof typeof SIZES;
// A dark theme and a light one.
const DARK = "tokyo-night";
const LIGHT = "catppuccin-latte";
const TV = { output: "HDMI-A-1", modes: ["3840x2160@60.00Hz", "1920x1080@60.00Hz"], live: { mode: "3840x2160@60", scale: 2 } };

// What the pages draw as a headline in each look: Terminal's and setup's
// h1, and Glass's featured title on home. Cinema's featured title on home
// is an h1 too.
const HEADLINE = "h1, .headline, .glass-title, .offline-title";
// A line of explanation under it. Rows, buttons, tiles, values, the status
// bar and toasts aren't lines.
const LINE = ".panel-note, .setup-note, .setup-line, .welcome-line, .note, .look-note, .page-line, .shared-line, .updating-note, .offline-line, .goal-note";

// What's left out, each one a question for Radomir, since making it pass
// would redraw a page he signed off: a screen, in a look and at a size or
// in all of them, and the one check it's left out of. Nothing else is.
interface Skip {
  route: string;
  check: "lines" | "cut off";
  look?: Look;
  size?: Size;
}
const SKIPS: Skip[] = [
  // About has the tagline and the credits it must show: Omarchy's maker,
  // MET Norway's licence, TMDB's notice and JustWatch's. Folding them into
  // one line, or into a list, redraws the page.
  { route: "settings/about", check: "lines" },
  // Pairing has how to pair over the code, and the code's countdown under
  // the code.
  { route: "pair", check: "lines" },
  // Edit home draws Terminal's grid in every look, and Glass's and
  // Cinema's bars are along the top, over its first row. Starting the grid
  // under them leaves the tiles too short for what's in them at larger.
  { route: "edit/agentv.sample", check: "cut off", look: "glass" },
  { route: "edit/agentv.sample", check: "cut off", look: "cinema" },
  // A build that failed says "Couldn't make it" over its tile's logo, and
  // at larger Apps' small tiles are too narrow for it.
  { route: "apps", check: "cut off", look: "terminal", size: "larger" },
];
const skipped = (route: string, check: Skip["check"], look: string, size: Size) =>
  SKIPS.some((skip) => skip.route === route && skip.check === check && (!skip.look || skip.look === look) && (!skip.size || skip.size === size));

// Words people on the couch never read, as the house rules have them: one
// pattern a line, "#" starts a comment, matched without case.
const POLICY = join(ROOT, "test/agentv/policy/ui-words");
const NEVER: RegExp[] = existsSync(POLICY)
  ? readFileSync(POLICY, "utf8")
      .split("\n")
      .map((line) => line.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim())
      .filter(Boolean)
      .map((pattern) => new RegExp(pattern.replace(/\\x\{([0-9a-fA-F]+)\}/g, "\\u{$1}"), "iu"))
  : [];

let browser: Browser;
let daemon: Daemon;
let met: Met;
let url = "";
let state = "";
let hotspot = "";
let builds = "";
let online = true;
let screenDaemon = true;
const errors: string[] = [];
// Each screen's headline, by route and look.
const headlines = new Map<string, string>();
const tools = mkdtempSync(join(tmpdir(), "agentv-words-ui-"));
const path = process.env.PATH;
const PIN = "4826";

// The screen daemon's side of a size change, as in sizes.test.mts.
async function standInScreen(): Promise<void> {
  while (screenDaemon) {
    const said = (await (await fetch(`${url}/api/display/ask`).catch(() => null))?.json().catch(() => null)) as { ask?: { n: number; target: { mode: string; scale: number } } | null } | null;
    const ask = said?.ask;
    if (!ask) continue;
    await fetch(`${url}/api/display/ask/${ask.n}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, live: { mode: ask.target.mode, scale: ask.target.scale } }) });
  }
}

// What agentv-hotspot writes: on and waiting while the TV is offline.
function hotspotSays(fields: Record<string, unknown>): void {
  writeFileSync(join(hotspot, "state.json"), JSON.stringify({ on: false, radio: true, ...fields }));
}

// Four builds, one in each state its page has: asked and waiting for an ok,
// making, ready for an adult's approval, and couldn't make it. Root's part,
// each build's status.json, is written here, as the daemon reads it.
function writeBuilds(): void {
  const at = new Date().toISOString();
  const steps = (running: number, failed = false) =>
    ["design", "packages", "build", "tests"].map((id, i) => ({ id, state: i < running ? "done" : i === running ? (failed ? "failed" : "running") : "waiting" }));
  const all = [
    { build: "b1", id: "local.quiz", status: { phase: "understand", state: "confirm", understood: { name: "Quiz", recipe: "game", says: "A quiz night for the remote" } } },
    { build: "b2", id: "local.blocks", status: { phase: "build", state: "running", step: "packages", steps: steps(1), understood: { name: "Blocks", recipe: "game", says: "A falling-block puzzle" } } },
    { build: "b3", id: "local.slides", status: { phase: "build", state: "approve", steps: steps(4), understood: { name: "Slides", recipe: "game", says: "A photo slideshow" } } },
    { build: "b4", id: "local.cards", status: { phase: "build", state: "failed", reason: "its tests didn't pass", steps: steps(3, true), understood: { name: "Cards", recipe: "game", says: "A card game" } } },
  ];
  writeFileSync(join(state, "builds.json"), JSON.stringify(all.map(({ build, id }) => ({ build, id, version: "1.0.0", sentence: `make me ${id.slice(6)}`, provider: "claude", path: "key", at }))));
  for (const { build, id, status } of all) {
    const dir = join(builds, id, "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ build, id, version: "1.0.0", started: at, at, ...status }));
  }
}

before(async () => {
  writeFileSync(join(tools, "qrencode"), `#!/bin/bash\necho '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21"><rect width="21" height="21"/></svg>'\n`);
  chmodSync(join(tools, "qrencode"), 0o755);
  process.env.PATH = `${tools}:${path}`;
  met = await startMet();
  const wifi = { wlan0: [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:01", internal: false, cidr: "192.168.1.20/24" }] };
  ({ daemon, url, state, hotspot, builds } = await startBox(0, FIXTURES, {
    builtins: true,
    zone: "Europe/Amsterdam",
    forecast: met.url,
    features: { looks: true, sizes: true },
    interfaces: () => (online ? wifi : {}),
  }));
  hotspotSays({ wifi: "Home" });
  writeFileSync(join(hotspot, "networks.json"), JSON.stringify([{ ssid: "Home", signal: 82, secure: true }, { ssid: "Cafe 5G", signal: 61, secure: true }]));
  writeBuilds();
  await fetch(`${url}/api/display/tv`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(TV) });
  void standInScreen();
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  screenDaemon = false;
  await browser?.close();
  await daemon?.close();
  met?.close();
  process.env.PATH = path;
  if (process.env.AGENTV_UI_SHOTS) {
    const lines = [...headlines].map(([key, headline]) => `${key}\t${headline}`).sort();
    writeFileSync(join(process.env.AGENTV_UI_SHOTS, "T14.2-headlines.txt"), `${lines.join("\n")}\n`);
  }
});

async function send(method: string, path: string, body?: unknown, grant?: string): Promise<{ status: number; data: Record<string, any> }> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as Record<string, any> };
}

async function put(path: string, body: unknown): Promise<void> {
  const { status, data } = await send("PUT", path, body);
  assert.equal(status, 200, `${path} ${JSON.stringify(body)}: ${JSON.stringify(data).slice(0, 200)}`);
}

async function dress(look: Look, theme: string, size: Size): Promise<void> {
  await put("/api/look", { look });
  await put("/api/display", { size });
  await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) });
}

async function open(size: Size, ready: string): Promise<Page> {
  const [width, height] = SIZES[size];
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 3840 / width, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  await page.addInitScript(() => {
    const w = window as unknown as { agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(ready);
  await rest(page);
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);

// Waits for a screen to settle: what it asks the daemon for has come, and
// its loading marks have gone, or two seconds have.
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(150);
  await page.waitForFunction(() => !document.querySelector("#page .loading-mark"), undefined, { timeout: 2000 }).catch(() => {});
  await rest(page);
}

interface Read {
  headlines: string[];
  lines: string[];
  never: string[];
}

// What a screen shows, within one part of it: its visible headlines and
// lines of explanation, and each visible piece of text that has a word the
// TV never says. A name, an address or anything typed keeps its own words.
function read(page: Page, within: string): Promise<Read> {
  return page.evaluate(
    ([within, headline, line, never]) => {
      const root = document.querySelector(within);
      if (!root) return { headlines: [], lines: [], never: [] };
      const shown = (el: Element) => {
        if (!(el as HTMLElement).getClientRects().length) return false;
        const style = getComputedStyle(el);
        if (style.visibility !== "visible") return false;
        let opacity = 1;
        for (let at: Element | null = el; at; at = at.parentElement) opacity *= Number(getComputedStyle(at).opacity);
        return opacity > 0.05;
      };
      const words = (el: Element) => (el.getAttribute("aria-label") && el.classList.contains("setup-headline") ? el.getAttribute("aria-label")! : (el as HTMLElement).innerText).trim().replace(/\s+/g, " ");
      // A headline as the code writes it, for the sheet: Terminal's lower
      // case is only its CSS.
      const source = (el: Element) => (el.getAttribute("aria-label") && el.classList.contains("setup-headline") ? el.getAttribute("aria-label")! : (el.querySelector(".glass-name") ?? el).textContent ?? "").trim().replace(/\s+/g, " ");
      const headlines = [...root.querySelectorAll(headline)].filter((el) => shown(el) && words(el)).map(source);
      const lines = [...root.querySelectorAll(line)].filter((el) => shown(el) && words(el)).map(words);
      const patterns = never.map((pattern) => new RegExp(pattern, "iu"));
      const found: string[] = [];
      const check = (text: string) => {
        for (const pattern of patterns) if (pattern.test(text)) found.push(`"${text.slice(0, 60)}" says ${pattern.source}`);
      };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        const text = node.textContent?.trim() ?? "";
        if (!text || !parent || parent.closest("[data-own-case], input, textarea, code, .pair-code, script, style") || !shown(parent)) continue;
        check(text);
      }
      for (const field of root.querySelectorAll<HTMLInputElement>("input[placeholder], textarea[placeholder]")) if (shown(field)) check(field.placeholder);
      return { headlines, lines, never: found };
    },
    [within, HEADLINE, LINE, NEVER.map((pattern) => pattern.source)] as const,
  );
}

// Checks one screen, and notes its headline for the sheet. Within is the
// part of the screen to read: the page, or something over it.
async function check(page: Page, problems: string[], where: string, key: { route: string; look: string; size: Size }, within = "#page", overlay = false): Promise<void> {
  if (!skipped(key.route, "cut off", key.look, key.size)) for (const problem of await cutOff(page, `${within} *`, overlay)) problems.push(`${where}: ${problem}`);
  const said = await read(page, within);
  if (said.headlines.length > 1) problems.push(`${where}: ${said.headlines.length} headlines (${said.headlines.map((h) => `"${h.slice(0, 40)}"`).join(", ")})`);
  for (const headline of said.headlines) if (/\.$/.test(headline) && !/\.\.\.$|…$/.test(headline)) problems.push(`${where}: the headline "${headline.slice(0, 40)}" ends with a full stop`);
  if (said.lines.length > 1 && !skipped(key.route, "lines", key.look, key.size)) problems.push(`${where}: ${said.lines.length} lines of text (${said.lines.map((l) => `"${l.slice(0, 40)}"`).join(", ")})`);
  for (const one of said.never) problems.push(`${where}: ${one}`);
  const id = `${key.route}\t${key.look}`;
  if (!headlines.has(id)) headlines.set(id, said.headlines[0] ?? "");
}

// Every screen the launcher has, as routes: home, Apps and the app
// library, an app's details and its setup, edit home, the built-ins, Ask
// and builds, and the pages Settings' rows open full screen. Settings'
// sections and pages come first, from its own menu.
function routes(profile: string): string[] {
  return [
    "home",
    "apps",
    "add-app",
    "details/agentv.sample",
    "details/local.mytv",
    "app-setup/agentv.sample",
    "edit/agentv.sample",
    "weather",
    "music",
    "new",
    "ask",
    "build",
    "describe",
    "build/b1",
    "build/b2",
    "build/b3",
    "build/b4",
    "change/local.mytv",
    "whats-new",
    `profile/${profile}`,
    "country",
    "key",
    "tmdb-key",
    "plan",
    "desktop-password",
    "pair",
    "wifi",
    "power/shutdown",
    "power/restart",
    "power/bootmenu",
  ];
}

const SETTINGS_PAGES = ["looks", "theme", "pictures", "weather", "tmdb", "pin", "controllers", "wifi", "your-ai", "usage", "updates", "desktop", "about"];

async function walk(look: Look, theme: string, size: Size, problems: string[]): Promise<void> {
  await dress(look, theme, size);
  const at = `${look}, ${theme === DARK ? "dark" : "light"}, ${size}`;
  const profile = (await send("GET", "/api/viewers")).data.active as string;
  const page = await open(size, "#page .focused");
  try {
    // Settings first, as you'd get there: each section, then each page a
    // row opens in the panel. What a section loads, a page it opens full
    // screen has then, as it would.
    await go(page, "settings");
    await settle(page);
    const sections = await page.$$eval(".menu [data-key]", (items) => items.map((item) => (item as HTMLElement).dataset.key!));
    assert.equal(sections.length, 8, "Settings has its eight sections");
    for (const key of [...sections, ...SETTINGS_PAGES]) {
      await go(page, `settings/${key}`);
      await settle(page);
      await check(page, problems, `${at}, settings/${key}`, { route: `settings/${key}`, look, size });
    }
    for (const route of routes(profile)) {
      await go(page, route);
      await settle(page);
      await check(page, problems, `${at}, ${route}`, { route, look, size });
    }

    // The PIN pad, over home, for Omarchy's desktop.
    await go(page, "home");
    await settle(page);
    await put("/api/pin", { pin: PIN });
    // Home hears of the PIN a moment later: until it has, the ask needs
    // no pad and is over at once.
    for (let tries = 0; tries < 20; tries++) {
      const opened = await page.evaluate(() => {
        const asked = (window as unknown as { agentvLauncher: { askPin(action: string): Promise<unknown> } }).agentvLauncher.askPin("desktop");
        return Promise.race([asked.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 300))]);
      });
      if (opened) break;
    }
    await page.waitForSelector("#pin.on .pin-keys");
    await settle(page);
    await check(page, problems, `${at}, the PIN pad`, { route: "pin", look, size }, "#pin", true);
    await page.keyboard.press("Escape");
    await page.waitForSelector("#pin.on", { state: "detached" });
    const grant = (await send("POST", "/api/pin/check", { pin: PIN })).data.grant as string;
    assert.equal((await send("DELETE", "/api/pin", {}, grant)).status, 200, "the PIN comes off again");

    // The screen saver.
    await page.evaluate(() => (window as unknown as { agentvAmbient: (on: boolean) => void }).agentvAmbient(true));
    await settle(page);
    await check(page, problems, `${at}, the screen saver`, { route: "screen saver", look, size }, "#ambient.on");
    await page.evaluate(() => (window as unknown as { agentvAmbient: (on: boolean) => void }).agentvAmbient(false));

    // The offline card on home: the TV lost its network, and the hotspot
    // is open for a phone to pick another.
    online = false;
    hotspotSays({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", wifi: null, watch: true });
    try {
      await page.waitForSelector("#offline", { timeout: 10_000 });
      await settle(page);
      await check(page, problems, `${at}, the offline card`, { route: "offline", look, size }, "#offline");
    } finally {
      online = true;
      hotspotSays({ on: false, wifi: "Home", joined: { ssid: "Home", address: "192.168.1.20" } });
    }
    await page.waitForSelector("#offline", { state: "detached", timeout: 10_000 });
    if (process.env.AGENTV_UI_SHOTS) await page.screenshot({ path: join(process.env.AGENTV_UI_SHOTS, `success-T14.2-${look}-${theme}-${size}.png`) }).catch(() => {});
  } finally {
    await page.close();
  }
}

for (const look of LOOKS) {
  test(`T14.2 every screen in ${look}, dark and light at standard and dark at larger and more on screen: nothing cut off, one headline, one line, no word the TV never says`, async (t) => {
    if (!NEVER.length) t.diagnostic(`${POLICY} isn't here, so the words aren't checked`);
    const problems: string[] = [];
    for (const [theme, size] of [[DARK, "standard"], [LIGHT, "standard"], [DARK, "larger"], [DARK, "more"]] as const) await walk(look, theme, size, problems);
    await put("/api/look", { look: "terminal" });
    await put("/api/display", { size: "standard" });
    if (process.env.AGENTV_UI_SHOTS) writeFileSync(join(process.env.AGENTV_UI_SHOTS, `T14.2-${look}-problems.txt`), problems.join("\n"));
    assert.deepEqual(problems, [], `what's wrong on the screens in ${look}`);
    assert.deepEqual(errors.splice(0), [], "no errors on the pages");
  });
}

test("T14.2 setup's steps, dark and light at standard and dark at larger and more on screen, in the new words", async (t) => {
  if (!NEVER.length) t.diagnostic(`${POLICY} isn't here, so the words aren't checked`);
  const problems: string[] = [];
  hotspotSays({ on: true, ssid: "AgenTV-3f9a", password: "k7m2xpqr4n", wifi: null });
  try {
    for (const [theme, size] of [[DARK, "standard"], [LIGHT, "standard"], [DARK, "larger"], [DARK, "more"]] as const) {
      await dress("terminal", theme, size);
      for (const [i, step] of STEPS.entries()) {
        const at = new Date().toISOString();
        const finished = Object.fromEntries(STEPS.slice(0, i).map((done) => [done, at]));
        writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step, finished, goal: "streaming", keyboard: true }));
        const page = await open(size, "#page > *");
        try {
          await settle(page);
          await check(page, problems, `setup, ${theme === DARK ? "dark" : "light"}, ${size}, ${step}`, { route: `setup/${step}`, look: "setup", size });
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    writeFileSync(join(state, "setup.json"), JSON.stringify({ done: true }));
    hotspotSays({ wifi: "Home" });
    await put("/api/display", { size: "standard" });
  }
  if (process.env.AGENTV_UI_SHOTS) writeFileSync(join(process.env.AGENTV_UI_SHOTS, "T14.2-setup-problems.txt"), problems.join("\n"));
  assert.deepEqual(problems, [], "what's wrong on setup's screens");
  assert.deepEqual(errors.splice(0), [], "no errors on the pages");
});
