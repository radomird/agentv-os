// No PIN, no PIN screen, in a real Chromium (ADR-019, layer 4; ADR-087): on
// a TV with no adult PIN, and again after one was set and taken off in
// Settings, the guarded actions go through on the TV and on the phone with
// no pad and no word about a PIN. Every page keeps a watch of its own, from
// its first draw to its last: the pad never comes up, and no text anyone can
// see says "pin", but for Settings' own row for setting one. With a PIN set,
// the pad still comes, here for what no other check covers: updates and the
// location.
//
// Every check runs twice. Once on phase 1's screens, with every switch off.
// And once on the screens that ship, with every switch on: home and Settings
// in each look, and the new phone remote.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import type { FeatureMap } from "../../../daemon/features.ts";
import { PHASE_1, startBox } from "./box.mts";
import { pairPhone, type TestPhone } from "../unit/phone-client.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
const errors: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "agentv-no-pin-ui-"));
const PIN = "4826";

before(async () => {
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  process.env.AGENTV_PASSWD = passwd;
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  delete process.env.AGENTV_PASSWD;
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

// The screens a walk goes through, and what tells that each has drawn.
interface Screens {
  name: string;
  features?: Partial<FeatureMap>; // none: every switch on, as a box ships
  ships: boolean;
  home: string; // on the TV's home
  remote: string; // on the phone's remote
  who: string; // the phone's who's watching, and each profile on it
  viewer: string;
}

const SCREENS: Screens[] = [
  // Phase 1's Settings rows and its phone remote, with every switch off.
  { name: "phase 1's screens", features: PHASE_1, ships: false, home: ".grid .tile.focused", remote: ".dpad", who: ".typing", viewer: ".viewer" },
  // Home and Settings in the looks, and the new phone remote.
  { name: "the screens that ship", ships: true, home: "html[data-look] #page .focused", remote: ".r2-surface", who: "#r2-sheet", viewer: ".r2-viewer" },
];

type Box = Awaited<ReturnType<typeof startBox>> & { lan: string; paired: TestPhone; screens: Screens };

async function box(screens: Screens): Promise<Box> {
  const started = await startBox(0, undefined, { zone: "Europe/Oslo", features: screens.features });
  const lan = `http://127.0.0.1:${started.daemon.lanPort}`;
  const code = ((await (await fetch(`${started.url}/api/phones/pair`, { method: "POST" })).json()) as any).pairing.code;
  return { ...started, lan, screens, paired: await pairPhone(lan, code, "another phone") };
}

async function send(b: Box, method: string, path: string, body?: unknown, options: { grant?: string; phone?: boolean } = {}): Promise<Record<string, any>> {
  // The phone's requests are signed and sealed, and its answers opened.
  const init = {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.grant ? { "X-AgenTV-Grant": options.grant } : {}),
    } as Record<string, string>,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const response = options.phone ? await b.paired.fetch(path, init) : await fetch(`${b.url}${path}`, init);
  return { status: response.status, ...((await response.json().catch(() => ({}))) as object) };
}

// --- The watch every page keeps -----------------------------------------------

// Runs in the page before anything of it: each time the page changes, it
// looks for the pad, and for text someone can see that says "pin". Two
// elements may say it: Settings' own row for setting a PIN, and that row's
// panel while it's open.
function keepWatch(kind: "tv" | "phone"): void {
  const seen = { on: true, texts: [] as string[], pads: [] as string[] };
  (window as unknown as { noPin: typeof seen }).noPin = seen;
  const own = (el: Element): boolean => {
    if (el.closest('.menu-item[data-key="pin"]')) return true;
    return Boolean(el.closest(".settings-panel") && document.querySelector('.menu-item.open[data-key="pin"]'));
  };
  const look = () => {
    if (!seen.on || !document.body) return;
    const pad = kind === "tv" ? (document.getElementById("pin")?.classList.contains("on") ? document.getElementById("pin") : document.querySelector(".pin-pad")) : document.querySelector(".pin-keys, .pin-boxes, #tv-pin");
    if (pad) {
      const said = (pad.textContent ?? "").slice(0, 120);
      if (!seen.pads.includes(said)) seen.pads.push(said);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const el = node.parentElement;
      if (!el || !/\bpin\b/i.test(text) || own(el)) continue;
      if (!el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) continue;
      if (!seen.texts.includes(text)) seen.texts.push(text);
    }
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
  document.addEventListener("DOMContentLoaded", look);
  (window as unknown as { noPinLook: () => void }).noPinLook = look;
}

// What the watch saw so far: nothing, or the check fails saying where.
async function clean(page: Page, where: string): Promise<void> {
  const seen = await page.evaluate(() => {
    const w = window as unknown as { noPin: { texts: string[]; pads: string[] }; noPinLook: () => void };
    w.noPinLook();
    return { texts: w.noPin.texts, pads: w.noPin.pads };
  });
  assert.deepEqual(seen, { texts: [], pads: [] }, `${where}: no pad, and nothing says pin`);
}

// The watch off while Settings sets a PIN or takes it off, and on again
// with nothing kept, once the toasts about it have gone.
async function watching(page: Page, on: boolean): Promise<void> {
  if (on) await page.waitForFunction(() => !/\bpin\b/i.test(document.getElementById("toasts")?.textContent ?? "") && !/\bpin\b/i.test(document.getElementById("toast")?.classList.contains("on") ? (document.getElementById("toast")?.textContent ?? "") : ""), undefined, { timeout: 15_000 });
  await page.evaluate((now) => {
    const seen = (window as unknown as { noPin: { on: boolean; texts: string[]; pads: string[] } }).noPin;
    seen.on = now;
    seen.texts.length = 0;
    seen.pads.length = 0;
  }, on);
}

type Request = { cmd: string };

// A TV whose screen daemon answers every request with ok and remembers it.
async function tv(b: Box): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(keepWatch, "tv" as const);
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: Request[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true, apps: [] })), 0);
    };
  });
  // Settings' previews of the looks are home itself, three more of it. The
  // walk sees home in each look by going there, so here they stay blank.
  await page.route(/\/\?preview/, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto(`${b.url}/`);
  await page.waitForSelector(b.screens.home);
  return page;
}

// A paired phone, through the QR code's address. With a PIN set, pairing
// takes its grant.
async function phone(b: Box, grant?: string): Promise<Page> {
  await send(b, "POST", "/api/phones/pair", {}, { grant });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(keepWatch, "phone" as const);
  await page.goto(`${b.lan}/#pair=${b.daemon.phones.secret()}`);
  await page.waitForSelector(b.screens.remote);
  return page;
}

// --- The phone's two remotes --------------------------------------------------

// The phone back on its remote. The new one follows the TV: it shows a
// keyboard while a field has the focus there, keeps its menu open until
// it's closed, and has a way back on each of its pages.
async function remote(b: Box, hand: Page): Promise<void> {
  if (!b.screens.ships) {
    await hand.waitForSelector(b.screens.remote);
    return;
  }
  // Whichever is in the way goes, and again if the TV moved meanwhile.
  const tap = (selector: string, position?: { x: number; y: number }) => hand.locator(selector).tap({ timeout: 1000, position }).catch(() => {});
  await until(async () => {
    if (await hand.locator("#r2-sheet").count()) await tap('[data-action="close-sheet"]', { x: 8, y: 8 });
    else if (await hand.locator('[data-action="to-remote"]').count()) await tap('[data-action="to-remote"]');
    else if (await hand.locator('[data-action="keyboard-done"]').count()) await tap('[data-action="keyboard-done"]');
    else return (await hand.locator(b.screens.remote).count()) > 0;
    return false;
  }, "the phone's remote");
}

// Who's watching: a page of its own on phase 1's remote, and the top of the
// menu on the new one.
async function openWho(b: Box, hand: Page): Promise<void> {
  await remote(b, hand);
  await hand.locator('[data-action="who"]').tap();
  await hand.waitForSelector(`${b.screens.who} ${b.screens.viewer}`);
}

// Opens what the TV has for the phone: a banner over phase 1's remote, and
// on the new one its notice line, or a row of its list when there's more
// than one thing to say.
async function openOffer(b: Box, hand: Page, action: string, says: RegExp): Promise<void> {
  if (!b.screens.ships) {
    await hand.waitForSelector(`[data-action="${action}"]`, { timeout: 10_000 });
    await hand.locator(`[data-action="${action}"]`).tap();
    return;
  }
  await remote(b, hand);
  await hand.waitForFunction((source) => new RegExp(source).test(document.querySelector(".r2-notice-text")?.textContent ?? "") || document.querySelector(".r2-notice-more") !== null, says.source, { timeout: 10_000 });
  const more = (await hand.locator(".r2-notice-more").count()) > 0;
  await hand.locator(".r2-notice").tap();
  if (more) await hand.locator('#r2-sheet [data-action="notice-row"]').filter({ hasText: says }).tap();
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { agentvLauncher: { go(route: string): void } }).agentvLauncher.go(r), route);
const requested = (page: Page, cmd: string) => page.waitForFunction((c) => (window as unknown as { screenRequests: Request[] }).screenRequests.some((r) => r.cmd === c), cmd);
const toasted = (page: Page, text: string) => page.waitForFunction((t) => (document.getElementById("toasts")?.textContent ?? "").includes(t), text, { timeout: 10_000 });
const focusOn = (page: Page, selector: string) => page.evaluate((s) => (window as unknown as { agentvLauncher: { focus: { set(el: Element): void } } }).agentvLauncher.focus.set(document.querySelector(s)!), selector);
const padUp = (page: Page, up: boolean) => page.waitForFunction((want) => document.getElementById("pin")?.classList.contains("on") === want, up);

async function until(check: () => Promise<boolean> | boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`${what} didn't happen in ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const STATUS = {
  checked_at: new Date().toISOString(),
  ok: true,
  channel: "stable",
  agentv: { installed: "0.2.1-1", available: "0.3.0-1" },
  omarchy: { installed: "4.0.6-1", available: "4.5.0-1" },
  packages: 46,
  security: false,
  notes: { agentv: ["tiles come in small, medium and large"], agentv_date: "2026-10-22", omarchy: [] },
};

function update(b: Box): void {
  writeFileSync(join(b.updates, "status.json.next"), JSON.stringify(STATUS));
  renameSync(join(b.updates, "status.json.next"), join(b.updates, "status.json"));
}

// Root's part in a build: it takes a start the daemon dropped and says so,
// then the build in its folder says how it stands.
function status(b: Box, id: string, build: string, change: Record<string, unknown>): void {
  const start = join(b.state, "build-drop", "start.json");
  if (existsSync(start)) {
    const taken = JSON.parse(readFileSync(start, "utf8"));
    rmSync(start);
    mkdirSync(join(b.state, "..", "build-run"), { recursive: true });
    writeFileSync(join(b.state, "..", "build-run", "answer.json"), JSON.stringify({ action: "start", build: taken.build, started: true, at: new Date().toISOString() }));
  }
  const folder = join(b.builds, id, "1.0.0");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "status.json"), JSON.stringify({ build, id, version: "1.0.0", phase: "understand", state: "running", steps: [], started: "", at: new Date(Date.now() + 5).toISOString(), ...change }));
}

const STEPS = ["design", "packages", "build", "tests"].map((id) => ({ id, state: "done" }));
const drop = (b: Box, name: string) => JSON.parse(readFileSync(join(b.state, "build-drop", `${name}.json`), "utf8"));

// The app a build made, as root's install leaves it.
function builtApp(b: Box, id: string, name: string): void {
  const folder = join(b.apps, id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({ schemaVersion: 1, id, name, version: "1.0.0", author: "your agent", license: "MIT", description: "Made here", kinds: ["tv-app"], entryPoints: { page: "index.html" }, tv: { contract: 2, category: "games", runtime: "page", capabilities: ["launch"] } }));
  writeFileSync(join(folder, "index.html"), "<!doctype html><p>made here</p>");
  const installed = JSON.parse(readFileSync(join(b.apps, "installed.json"), "utf8"));
  installed[id] = { id, name, version: "1.0.0", tier: "local", installedAt: new Date().toISOString() };
  writeFileSync(join(b.apps, "installed.json"), JSON.stringify(installed, null, 2));
}

// --- The walk -----------------------------------------------------------------

// The guarded actions, on a TV and a phone already open, with no PIN. With
// a child's profile on the box, the walk starts on it. wasLocked is an
// adult's profile that asked for the PIN to open while there was one.
async function walk(b: Box, screen: Page, hand: Page, who: { child?: string; wasLocked: string }): Promise<void> {
  const say = async (where: string) => {
    await clean(screen, `the tv, ${where}`);
    await clean(hand, `the phone, ${where}`);
  };
  await say("at the start");

  if (who.child) {
    // Settings on a child's profile opens, as nothing can keep it shut.
    assert.equal((await send(b, "POST", "/api/viewer", { id: who.child })).status, 200);
    await screen.waitForFunction(() => document.querySelector(".bar-right span")?.textContent === "mila");
    await screen.locator('.bar-link:has-text("settings")').click();
    await screen.waitForSelector(".menu-item");
    await say("settings on a child's profile");
    // From the child's profile to an adult's, on the TV.
    await go(screen, "profile/radomir");
    await screen.locator('[data-action="watch"]').click();
    await until(async () => (await send(b, "GET", "/api/viewer")).viewer.id === "radomir", "the switch on the tv");
    await say("from a child's profile to an adult's on the tv");
    // And on the phone.
    assert.equal((await send(b, "POST", "/api/viewer", { id: who.child })).status, 200);
    await hand.waitForFunction(() => /mila/.test(document.querySelector('[data-action="who"]')?.textContent ?? ""), undefined, { timeout: 5000 });
    await openWho(b, hand);
    assert.doesNotMatch(await hand.locator(b.screens.who).innerText(), /needs/);
    await say("who's watching on the phone");
    await hand.locator('[data-viewer="radomir"]').tap();
    await until(async () => (await send(b, "GET", "/api/viewer")).viewer.id === "radomir", "the switch from the phone");
    await say("from a child's profile to an adult's on the phone");
    await screen.keyboard.press("Escape");
  }

  // The profile that was locked: no lock on its row or on the phone, no row
  // to lock it on its page, and it opens.
  await go(screen, "settings/profiles");
  await screen.waitForSelector('.menu-item.open[data-key="profiles"]');
  assert.equal(await screen.locator(".profile-row svg.glyph-lock").count(), 0, "no lock on any row");
  assert.doesNotMatch(await screen.locator(".settings-panel").innerText(), /locked|asks/);
  await say("settings → profiles");
  await go(screen, `profile/${who.wasLocked}`);
  await screen.waitForSelector('[data-action="watch"]');
  assert.equal(await screen.locator('[data-action="lock"]').isVisible(), false, "no row for locking it");
  await say("a profile's page");
  await screen.locator('[data-action="watch"]').click();
  await until(async () => (await send(b, "GET", "/api/viewer")).viewer.id === who.wasLocked, "the switch to the profile that was locked");
  await say("opening the profile that was locked");
  // Saving it as it is works, and says nothing of a lock.
  await go(screen, `profile/${who.wasLocked}`);
  await screen.locator('[data-action="save"]').click();
  await toasted(screen, "ana is saved");
  await openWho(b, hand);
  assert.equal(await hand.locator(`${b.screens.who} svg.glyph-lock`).count(), 0, "no lock on the phone");
  await hand.locator('[data-viewer="radomir"]').tap();
  await until(async () => (await send(b, "GET", "/api/viewer")).viewer.id === "radomir", "the switch back from the phone");
  await say("back to the owner from the phone");

  // Every section of Settings, one after another.
  await go(screen, "settings");
  await screen.waitForSelector(".menu-item");
  const sections = await screen.locator(".menu-item").evaluateAll((els) => els.map((el) => el.getAttribute("data-key") ?? ""));
  assert.ok(sections.includes("pin") && sections.includes("desktop") && sections.includes("power"), sections.join(" "));
  for (const section of sections) {
    await go(screen, `settings/${section}`);
    await screen.waitForSelector(`.menu-item.open[data-key="${section}"]`);
    await screen.waitForTimeout(150);
    await clean(screen, `settings → ${section}`);
  }
  // In the looks a row says only its name, and its panel says the rest.
  if (b.screens.ships) {
    await go(screen, "settings/pin");
    await screen.waitForSelector('.menu-item.open[data-key="pin"]');
    assert.match(await screen.locator(".settings-panel").innerText(), /the adult pin\s+off/);
  } else {
    assert.match(await screen.locator('.menu-item[data-key="pin"]').innerText(), /adult pin\s+off/);
    assert.match(await screen.locator('.menu-item[data-key="desktop"]').innerText(), /omarchy desktop\s+switch/);
  }
  // Omarchy's desktop goes at once.
  await go(screen, "settings/desktop");
  await screen.locator('.settings-panel [data-action="desktop"]').click();
  await requested(screen, "desktop");
  await say("omarchy's desktop");

  // Updates: tonight on the phone, tonight and now on the TV.
  update(b);
  await openOffer(b, hand, "update", /Update ready/);
  await hand.waitForSelector('[data-action="tonight"]');
  assert.deepEqual(await hand.locator('[data-action="tonight"], [data-action="install"]').allInnerTexts(), ["Install tonight", "Install now"]);
  await hand.locator('[data-action="tonight"]').tap();
  await hand.waitForFunction(() => /It installs tonight between 2 and 5/.test(document.body.textContent ?? ""));
  assert.equal((await send(b, "GET", "/api/updates")).tonight?.version, "0.3.0-1");
  await say("install tonight on the phone");
  await hand.locator('[data-action="not-tonight"]').tap();
  await until(async () => (await send(b, "GET", "/api/updates")).tonight === null, "not tonight");
  await hand.locator('[data-action="later"]').tap();
  await remote(b, hand);
  rmSync(join(b.state, "update-seen.json"), { force: true });
  await go(screen, "settings/updates");
  await screen.waitForSelector('.settings-panel [data-action="tonight"]');
  await screen.locator('.settings-panel [data-action="tonight"]').click();
  await screen.waitForSelector(".tonight-note");
  assert.equal((await send(b, "GET", "/api/updates")).tonight?.version, "0.3.0-1");
  await say("install tonight on the tv");
  await screen.locator('.settings-panel [data-action="install"]').click();
  await requested(screen, "update-install");
  await say("install now on the tv");
  rmSync(join(b.updates, "status.json"), { force: true });

  // The AI key, kept from its page.
  await go(screen, "settings/ai");
  await screen.waitForSelector('.settings-panel [data-action="add-key"]');
  await screen.locator('.settings-panel [data-action="add-key"]').click();
  await screen.waitForSelector('.page [data-action="provider"]');
  await say("the ai key's page");
  await screen.locator('.page [data-action="key"]').fill(`sk-ant-${"e".repeat(40)}`);
  await screen.locator('.page [data-action="save"]').click();
  await toasted(screen, "the key for claude is kept");
  await say("keeping the ai key");

  // Adding an app.
  await go(screen, "add-app");
  await screen.waitForSelector('.add-tile[data-id="agentv.steam"]');
  await screen.locator('.add-tile[data-id="agentv.steam"]').click();
  await screen.waitForFunction(() => /installed/.test(document.querySelector('.add-tile[data-id="agentv.steam"] .add-state')?.textContent ?? ""), null, { timeout: 10_000 });
  await say("adding an app");

  // A build: the TV says to approve it on the phone, and the phone does.
  const asked = (await send(b, "POST", "/api/builds", { sentence: "a game of falling blocks" })).build;
  assert.ok(asked, "a build starts");
  const understood = { name: "Blocks", recipe: "game", says: "A falling-block puzzle" };
  status(b, asked.id, asked.build, { phase: "build", state: "approve", steps: STEPS, understood, approval: { reaches: { always: ["the remote and a gamepad"], declared: [] }, packages: [] } });
  await go(screen, `build/${asked.build}`);
  await screen.waitForSelector('.build-page[data-state="approve"]', { timeout: 10_000 });
  assert.match(await screen.locator(".build-page").innerText(), /blocks is ready$[\s\S]*tested and ready\. approve on your phone to add it to home\./m);
  await say("a build waiting for a yes");
  await openOffer(b, hand, "approve-build", /approve it/);
  await hand.waitForSelector(".build-approve h1");
  assert.equal(await hand.locator('[data-action="approve"]').innerText(), "Approve");
  await say("the phone's page for a finished build");
  rmSync(join(b.state, "build-drop", "install.json"), { force: true });
  await hand.locator('[data-action="approve"]').tap();
  await hand.waitForFunction(() => !document.querySelector(".build-approve"));
  assert.deepEqual(drop(b, "install"), { build: asked.build, id: asked.id, version: "1.0.0" });
  await say("approving a build on the phone");

  // The app it made, taken off the TV again.
  status(b, asked.id, asked.build, { phase: "build", state: "installed", steps: STEPS, understood });
  builtApp(b, asked.id, "Blocks");
  // Its details have the button once the TV has heard it's installed.
  await until(async () => {
    await go(screen, "home");
    await go(screen, `details/${asked.id}`);
    await screen.waitForTimeout(300);
    return (await screen.locator('[data-action="remove-built"]').count()) > 0;
  }, "the built app's details", 15_000);
  await say("a built app's details");
  await focusOn(screen, '[data-action="remove-built"]');
  await screen.keyboard.press("Enter");
  await toasted(screen, "Removed Blocks");
  assert.deepEqual(drop(b, "remove"), { id: asked.id });
  await say("removing a built app");
  rmSync(join(b.apps, asked.id), { recursive: true, force: true });
  const installed = JSON.parse(readFileSync(join(b.apps, "installed.json"), "utf8"));
  delete installed[asked.id];
  writeFileSync(join(b.apps, "installed.json"), JSON.stringify(installed, null, 2));
  rmSync(join(b.builds, asked.id), { recursive: true, force: true });

  // A plan, and its sign-in: the phone hands the code over.
  assert.equal((await send(b, "POST", "/api/ai", { provider: "claude", path: "plan" })).ok, true);
  assert.equal((await send(b, "POST", "/api/phone/terms", { provider: "claude", path: "plan" }, { phone: true })).status, 200);
  const planned = (await send(b, "POST", "/api/builds", { sentence: "a game like tetris" })).build;
  assert.ok(planned, "a build on the plan starts");
  status(b, planned.id, planned.build, { state: "plan-sign-in", reason: "sign in to your claude plan first" });
  const signIn = join(b.state, "build-drop", "sign-in.json");
  await until(() => existsSync(signIn), "the daemon asking root for the sign-in");
  rmSync(signIn);
  const run = join(b.state, "..", "build-run", "sign-in");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "status.json"), JSON.stringify({ provider: "claude", state: "waiting", url: "https://claude.ai/oauth/authorize?code=true&client_id=stand-in&state=s7Q", pastes: true, at: new Date(Date.now() + 50).toISOString() }));
  await go(screen, `build/${planned.build}`);
  await screen.waitForSelector('.build-page[data-state="plan-sign-in"]', { timeout: 10_000 });
  await say("the plan's sign-in on the tv");
  await openOffer(b, hand, "plan-sign-in", /Sign in to Claude/);
  await hand.waitForSelector('[data-action="open-sign-in"]');
  assert.equal(await hand.locator('[data-action="send-code"]').innerText(), "Send");
  await hand.locator('input[name="code"]').fill("good-code#s7Q");
  await hand.locator('[data-action="send-code"]').tap();
  await hand.waitForFunction(() => /^Signing in on your TV…$/.test(document.getElementById("toast")?.textContent ?? ""));
  assert.deepEqual(drop(b, "sign-in-code"), { code: "good-code#s7Q" });
  await say("the plan's sign-in on the phone");
  await send(b, "POST", `/api/builds/${planned.build}/forget`, {});
  await send(b, "POST", "/api/ai", { provider: "claude", path: "key" });

  // The location.
  await go(screen, "settings/country");
  await screen.waitForSelector('.settings-panel [data-action="country"]');
  await screen.locator('.settings-panel [data-action="country"]').click();
  await screen.waitForSelector(".country-picker");
  await screen.fill('[data-action="country-field"]', "port");
  await screen.click('.country-list [data-code="PT"]');
  await toasted(screen, "this tv is in portugal now");
  assert.equal((await send(b, "GET", "/api/country")).code, "PT");
  await screen.waitForSelector('.menu-item.open[data-key="country"]');
  await say("changing the location");

  if (b.screens.ships) await shipped(b, screen, hand, say);
}

// What the screens that ship add to the walk: a phone paired and one
// forgotten, Settings opened from the phone's menu, an app ticked for
// children, Apps and Ask, the desktop's first password, and a look picked,
// with home and every section of Settings in each look.
async function shipped(b: Box, screen: Page, hand: Page, say: (where: string) => Promise<void>): Promise<void> {
  const { pairing } = await send(b, "POST", "/api/phones/pair", {});
  await pairPhone(b.lan, pairing.code, "old phone");
  await go(screen, "home");
  await go(screen, "settings/phones");
  await screen.waitForSelector('.settings-panel .button:has-text("old phone")');
  await screen.locator('.settings-panel [data-action="pair"]').click();
  await screen.waitForFunction(() => /^[^·]+$/.test(document.querySelector(".pair-code")?.textContent ?? ""));
  await say("pairing a phone");
  await screen.keyboard.press("Escape");
  await screen.waitForSelector('.menu-item.open[data-key="phones"]');
  await screen.locator('.settings-panel .button:has-text("old phone")').click();
  await toasted(screen, "old phone is forgotten");
  await say("forgetting a phone");

  // Settings, from the phone's menu.
  await go(screen, "home");
  await remote(b, hand);
  await hand.locator('[data-action="menu"]').tap();
  await hand.locator('#r2-sheet [data-action="settings"]').tap();
  await screen.waitForSelector(".menu-item");
  await say("settings from the phone's menu");

  // An app ticked for children, in its details.
  await go(screen, "details/agentv.sample");
  await screen.waitForSelector('[data-action="children"]');
  const ticked = await screen.locator('[data-action="children"]').innerText();
  await screen.locator('[data-action="children"]').click();
  await screen.waitForFunction((was) => document.querySelector<HTMLElement>('[data-action="children"]')?.innerText !== was, ticked);
  await say("an app ticked for children");

  // Apps and Ask on the TV, and Ask on the phone.
  for (const page of ["apps", "ask"]) {
    await go(screen, page);
    await screen.waitForSelector(`#page .focused`);
    await screen.waitForTimeout(150);
    await say(`${page} on the tv`);
  }
  await go(screen, "home");
  await remote(b, hand);
  await hand.locator('[data-action="ask"]').tap();
  await hand.waitForSelector("#r2-sheet");
  await say("ask on the phone");
  await remote(b, hand);

  // The desktop's first password, on a box set up from the USB stick: root's
  // side of it is stood in for, and says the password is set.
  const marker = join(b.state, "..", "account.json");
  const known = (yes: boolean) => writeFileSync(marker, `${JSON.stringify({ name: "agentv", passwordKnown: yes })}\n`);
  const root = createServer((connection) => {
    connection.once("data", () => {
      known(true);
      connection.end('{"ok":true}\n');
    });
  });
  await new Promise<void>((done) => root.listen(join(b.state, "..", "password.sock"), done));
  try {
    known(false);
    await go(screen, "settings/desktop");
    await screen.waitForSelector('[data-note="desktop-password"]');
    const switches = () => screen.evaluate(() => (window as unknown as { screenRequests: Request[] }).screenRequests.filter((r) => r.cmd === "desktop").length);
    const before = await switches();
    await screen.locator('.settings-panel [data-action="desktop"]').click();
    await screen.waitForSelector(".desktop-password");
    await say("the desktop's first password");
    // A throwaway password, made up here.
    const password = `tv test ${process.pid}`;
    await screen.fill('[data-action="password"]', password);
    await screen.fill('[data-action="password-again"]', password);
    await screen.locator('[data-action="set-password"]').click();
    await toasted(screen, "the desktop's password is set");
    await until(async () => (await switches()) === before + 1, "the switch to the desktop");
    await say("setting the desktop's password");
  } finally {
    root.close();
    rmSync(marker, { force: true });
  }

  // A look picked in Settings, then home and Settings in it.
  for (const look of ["glass", "cinema", "terminal"]) {
    await go(screen, "settings/look");
    await screen.waitForSelector(`.settings-panel [data-action="look-${look}"]`);
    await screen.locator(`.settings-panel [data-action="look-${look}"]`).click();
    await screen.waitForSelector(`html[data-look="${look}"] .menu-item`);
    await until(async () => (await send(b, "GET", "/api/look")).look === look, `the ${look} look`);
    await say(`picking the ${look} look`);
    await go(screen, "home");
    await screen.waitForSelector(`html[data-look="${look}"] ${b.screens.home.replace("html[data-look] ", "")}`);
    await hand.waitForFunction((id) => document.body.dataset.look === id, look, { timeout: 10_000 });
    await say(`home in the ${look} look`);
    await go(screen, "settings");
    await screen.waitForSelector(".menu-item");
    for (const section of await screen.locator(".menu-item").evaluateAll((els) => els.map((el) => el.getAttribute("data-key") ?? ""))) {
      await go(screen, `settings/${section}`);
      await screen.waitForSelector(`.menu-item.open[data-key="${section}"]`);
      await screen.waitForTimeout(150);
      await clean(screen, `settings → ${section} in the ${look} look`);
    }
  }
}

for (const screens of SCREENS) {
  test(`ADR-087 a TV with no PIN, on ${screens.name}: the guarded actions go through on the TV and the phone, even from a child's profile, with no pad and no word about a PIN`, async () => {
    const b = await box(screens);
    try {
      // A child's profile and a locked one need a PIN to be made, so the box
      // gets one first and then loses it, as a box whose PIN file went would.
      assert.equal(b.daemon.pin.set(PIN, undefined), null);
      const grant = (await send(b, "POST", "/api/pin/check", { pin: PIN })).grant;
      const mila = (await send(b, "POST", "/api/viewers", { name: "mila", role: "child" }, { grant })).profile.id;
      const ana = (await send(b, "POST", "/api/viewers", { name: "ana", role: "adult", locked: true }, { grant })).profile.id;
      assert.equal((await send(b, "POST", "/api/ai", { provider: "claude", path: "key" }, { grant })).ok, true);
      const onPhone = (await send(b, "POST", "/api/phone/pin", { pin: PIN }, { phone: true })).grant;
      assert.equal((await send(b, "POST", "/api/phone/terms", { provider: "claude", path: "key" }, { phone: true, grant: onPhone })).status, 200);
      rmSync(join(b.state, "pin.json"));
      assert.equal(b.daemon.pin.status().set, false);

      const screen = await tv(b);
      const hand = await phone(b);
      await walk(b, screen, hand, { child: mila, wasLocked: ana });
      await screen.close();
      await hand.close();
    } finally {
      await b.daemon.close();
    }
  });

  test(`ADR-087 a PIN set in Settings and taken off there again, on ${screens.name}: the same walk, on the same pages, with no pad and no word about a PIN`, async () => {
    const b = await box(screens);
    try {
      const screen = await tv(b);
      const hand = await phone(b);
      assert.equal((await send(b, "POST", "/api/ai", { provider: "claude", path: "key" })).ok, true);
      assert.equal((await send(b, "POST", "/api/phone/terms", { provider: "claude", path: "key" }, { phone: true })).status, 200);
      await clean(screen, "the tv, before there's a pin");
      await clean(hand, "the phone, before there's a pin");

      // Settings → Adult PIN sets it, on its pad, twice.
      await watching(screen, false);
      await watching(hand, false);
      await go(screen, "settings/pin");
      await screen.waitForSelector('.menu-item.open[data-key="pin"]');
      await screen.locator('.settings-panel [data-action="set-pin"]').click();
      await padUp(screen, true);
      for (const digit of PIN) await screen.keyboard.press(digit);
      await screen.waitForFunction(() => /the same pin again/.test(document.getElementById("pin")?.textContent ?? ""));
      for (const digit of PIN) await screen.keyboard.press(digit);
      await padUp(screen, false);
      assert.equal(b.daemon.pin.status().set, true);
      // With it, a profile locks, and its page and the phone say so.
      const grant = (await send(b, "POST", "/api/pin/check", { pin: PIN })).grant;
      const ana = (await send(b, "POST", "/api/viewers", { name: "ana", role: "adult", locked: true }, { grant })).profile.id;
      await go(screen, `profile/${ana}`);
      await screen.waitForSelector('[data-action="lock"]');
      assert.match(await screen.locator('[data-action="lock"]').innerText(), /ask for the pin to open\s+‹ yes ›/);
      await screen.keyboard.press("Escape");
      await openWho(b, hand);
      if (screens.ships) {
        // The new remote's menu shows no lock. Its pad comes for the locked
        // profile once it's picked. The pad comes up under the menu today,
        // so the menu closes before Cancel can be tapped.
        await hand.locator(`[data-viewer="${ana}"]`).tap();
        await hand.waitForSelector(".pin-keys");
        assert.match(await hand.locator('.overlay:not(#tv-pin)[aria-label="Adult PIN"]').innerText(), /Enter the adult PIN\n+For watching as ana\n/);
        await hand.locator('[data-action="close-sheet"]').tap({ position: { x: 8, y: 8 } });
        await hand.locator('.overlay [data-action="cancel"]').tap();
      } else {
        await hand.waitForSelector(`[data-viewer="${ana}"] svg.glyph-lock`);
        assert.match(await hand.locator(".typing").innerText(), /An adult's or a locked profile needs the PIN/);
        await hand.locator('[data-viewer="radomir"]').tap();
      }
      await remote(b, hand);

      // Taking the PIN off waits for the lock to go first, and says so.
      await go(screen, "settings/pin");
      await screen.waitForSelector('.settings-panel [data-action="remove-pin"]');
      await screen.locator('.settings-panel [data-action="remove-pin"]').click();
      await padUp(screen, true);
      for (const digit of PIN) await screen.keyboard.press(digit);
      await padUp(screen, false);
      await toasted(screen, "a locked profile needs the pin. unlock it in settings → profiles first");
      assert.equal(b.daemon.pin.status().set, true);
      assert.equal((await send(b, "PUT", `/api/viewers/${ana}`, { locked: false }, { grant: (await send(b, "POST", "/api/pin/check", { pin: PIN })).grant })).status, 200);
      await screen.waitForSelector('.settings-panel [data-action="remove-pin"]');
      await screen.locator('.settings-panel [data-action="remove-pin"]').click();
      await toasted(screen, "the pin is off");
      assert.equal(b.daemon.pin.status().set, false);
      await screen.waitForFunction(() => /adult pin\s*off/.test(document.querySelector('.menu-item[data-key="pin"]')?.textContent ?? ""));

      // From here on, the same pages never show a pad or say pin again.
      await watching(screen, true);
      await remote(b, hand);
      await watching(hand, true);
      await walk(b, screen, hand, { wasLocked: ana });
      await screen.close();
      await hand.close();
    } finally {
      await b.daemon.close();
    }
  });

  test(`ADR-087 with a PIN set, on ${screens.name}: updates and the location still ask for it on the pad, and the phone's buttons still say so`, async () => {
    const b = await box(screens);
    try {
      assert.equal(b.daemon.pin.set(PIN, undefined), null);
      update(b);
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        const w = window as unknown as { screenRequests: Request[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
        w.screenRequests = [];
        w.agentvScreen = (json: string) => {
          const request = JSON.parse(json);
          w.screenRequests.push(request);
          setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify({ ok: true, apps: [] })), 0);
        };
      });
      await page.goto(`${b.url}/`);
      await page.waitForSelector(screens.home);
      const sent = (cmd: string) => page.evaluate((c) => (window as unknown as { screenRequests: Request[] }).screenRequests.filter((r) => r.cmd === c).length, cmd);

      // Tonight: Back leaves it unasked, and the PIN asks it.
      await go(page, "settings/updates");
      await page.waitForSelector('.settings-panel [data-action="tonight"]');
      await page.locator('.settings-panel [data-action="tonight"]').click();
      await padUp(page, true);
      assert.match(await page.locator("#pin").innerText(), /enter the adult pin/);
      await page.keyboard.press("Escape");
      await padUp(page, false);
      assert.equal((await send(b, "GET", "/api/updates")).tonight, null);
      // Install now: the same, and nothing is asked of the TV without it.
      await page.locator('.settings-panel [data-action="install"]').click();
      await padUp(page, true);
      await page.keyboard.press("Escape");
      await padUp(page, false);
      assert.equal(await sent("update-install"), 0);
      await page.locator('.settings-panel [data-action="install"]').click();
      await padUp(page, true);
      for (const digit of PIN) await page.keyboard.press(digit);
      await padUp(page, false);
      await requested(page, "update-install");
      rmSync(join(b.updates, "status.json"), { force: true });
      await page.reload();
      await page.waitForSelector(screens.home);

      // The location: the pad comes before anything changes.
      await go(page, "settings/country");
      await page.waitForSelector('.settings-panel [data-action="country"]');
      await page.locator('.settings-panel [data-action="country"]').click();
      await page.waitForSelector(".country-picker");
      await page.fill('[data-action="country-field"]', "port");
      await page.click('.country-list [data-code="PT"]');
      await padUp(page, true);
      assert.match(await page.locator("#pin").innerText(), /enter the adult pin[\s\S]*for the country\./);
      await page.keyboard.press("Escape");
      await padUp(page, false);
      assert.notEqual((await send(b, "GET", "/api/country")).code, "PT");
      await page.click('.country-list [data-code="PT"]');
      await padUp(page, true);
      for (const digit of PIN) await page.keyboard.press(digit);
      await toasted(page, "this tv is in portugal now");
      assert.equal((await send(b, "GET", "/api/country")).code, "PT");

      // Settings → Profiles says what the PIN is for, and a profile's page
      // has the row that locks it.
      // Back in Settings first, where the picker leaves it.
      await page.waitForSelector('.menu-item.open[data-key="country"]');
      await go(page, "settings/profiles");
      await page.waitForFunction(() => /who watches\?/.test(document.querySelector(".settings-panel")?.textContent ?? ""));
      assert.match(await page.locator(".settings-panel").innerText(), /a child's profile needs the adult pin, and sees only the apps ticked for children in their details\. a locked one asks for the pin to open\./);
      await go(page, "profile/radomir");
      await page.waitForSelector('[data-action="lock"]');
      assert.equal(await page.locator('[data-action="lock"]').isVisible(), true);
      await page.close();

      // The phone's update page says which button asks for the PIN, and its
      // pad comes for tonight's install.
      update(b);
      const hand = await phone(b, (await send(b, "POST", "/api/pin/check", { pin: PIN })).grant);
      await openOffer(b, hand, "update", /Update ready/);
      await hand.waitForSelector('[data-action="tonight"]');
      assert.deepEqual(await hand.locator('[data-action="tonight"], [data-action="install"]').allInnerTexts(), ["Install tonight", "Install now"]);
      await hand.locator('[data-action="tonight"]').tap();
      await hand.waitForSelector(".pin-keys");
      assert.match(await hand.locator('.overlay:not(#tv-pin)[aria-label="Adult PIN"]').innerText(), /Enter the adult PIN\n+For installing tonight\n/);
      await hand.locator('.overlay [data-action="cancel"]').tap();
      assert.equal((await send(b, "GET", "/api/updates")).tonight, null);
      await hand.close();
    } finally {
      await b.daemon.close();
    }
  });
}
