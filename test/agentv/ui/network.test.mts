// The servers and shares on your network on the TV (launcher/pages/
// network.ts), each screen with the discover switch off and then on: an
// app's setup, Music → sources and a NAS's folders, and setup's shared
// folder. The box hears stand-ins on this machine: a Jellyfin answering on
// UDP, a NAS announced over mDNS (as avahi-browse prints it) and its list
// of shares (as smbclient prints it).

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createSocket, type Socket } from "node:dgram";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { DiscoverOptions, Run } from "../../../daemon/discover.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { bothWays, FIXTURES, startBox, type BoxOptions } from "./box.mts";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const FIXTURE = join(import.meta.dirname, "../fixtures/discover");
const scratch = mkdtempSync(join(tmpdir(), "agentv-network-"));
let browser: Browser;
let jellyfin: Socket;
const errors: string[] = [];
// What smbclient was asked, and what it prints: the NAS's list, or that it
// wants a user first.
let smbAsked: string[][] = [];
let smbWantsLogin = false;

function standIns(): DiscoverOptions {
  const avahi = join(scratch, "avahi-browse");
  return {
    targets: ["127.0.0.1"],
    ports: { jellyfin: 0, emby: 0, plex: 0, wsd: 0 },
    serverPorts: { discovery: jellyfin.address().port, gdm: 9, wsd: 9, immich: 9, rpcbind: 9 },
    avahi,
    run: (async (command, args, _timeoutMs, env) => {
      smbAsked.push([command, ...args]);
      const login = smbWantsLogin && !env?.PASSWD;
      return login ? { stdout: readFileSync(join(FIXTURE, "smbclient-login.txt"), "utf8"), stderr: "", code: 1 } : { stdout: readFileSync(join(FIXTURE, "smbclient-list.txt"), "utf8"), stderr: "", code: 0 };
    }) as Run,
    rounds: [50, 500],
  };
}

before(async () => {
  jellyfin = createSocket("udp4");
  jellyfin.on("message", (message, from) => {
    if (message.toString() === "who is JellyfinServer?") jellyfin.send(JSON.stringify({ Address: "http://127.0.0.1:8096", Id: "a5b0", Name: "living room" }), from.port, from.address);
  });
  await new Promise<void>((resolve) => jellyfin.bind(0, "127.0.0.1", resolve));
  // The NAS's SMB share, announced as nas.local on this machine.
  writeFileSync(join(scratch, "smb.txt"), readFileSync(join(FIXTURE, "avahi-smb.txt"), "utf8").replaceAll("192.168.77.10", "127.0.0.1"));
  writeFileSync(join(scratch, "nfs.txt"), "");
  writeFileSync(join(scratch, "avahi-browse"), `#!/bin/bash\ntype=\${!#}\ncat "${scratch}/\${type:1:3}.txt"\nexec sleep 60\n`);
  chmodSync(join(scratch, "avahi-browse"), 0o755);
  browser = await chromium.launch({ executablePath: process.env.AGENTV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  jellyfin?.close();
  rmSync(scratch, { recursive: true, force: true });
});

// A TV at 1080p with a stand-in for the screen daemon, which takes Music's
// requests as the TV session does.
async function tv(at: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: Record<string, unknown>[]; agentvScreen: (json: string) => void; agentvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.agentvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      let reply: object = { ok: true };
      if (request.cmd === "music" && request.op === "sources") reply = { ok: true, sources: [] };
      if (request.cmd === "music" && request.op === "add-share") {
        const uri = String(request.uri);
        const name = uri.replace(/^smb:\/\/([^@]*@)?/, "");
        reply = { ok: true, source: { id: `share:${uri}`, kind: "share", name, path: "/run/media/share", available: true } };
      }
      if (request.cmd === "background-folder") reply = { ok: true, count: 1 };
      setTimeout(() => w.agentvScreenReply?.(request.id, JSON.stringify(reply)), 0);
    };
  });
  await page.goto(`${at}/`);
  return page;
}

function screenRequests(page: Page, cmd: string, op?: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(
    ({ cmd, op }) => (window as unknown as { screenRequests: Record<string, unknown>[] }).screenRequests.filter((r) => r.cmd === cmd && (op === undefined || r.op === op)),
    { cmd, op },
  );
}

const box = (options: Pick<BoxOptions, "features">) => startBox(0, FIXTURES, { ...options, builtins: true, discover: standIns() });

// A row's name and what's on its right.
const rows = (page: Page, selector: string) => page.$$eval(selector, (all) => all.map((row) => [row.querySelector("b")?.textContent, row.querySelector(".button-value")?.textContent]));

// Music → sources, from Music's tile on home.
async function sources(url: string): Promise<Page> {
  const layout = [{ id: "agentv.music", x: 0, y: 0, size: "s" }, { id: "apps", x: 3, y: 2, size: "s" }];
  assert.equal((await fetch(`${url}/api/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout }) })).status, 200);
  const page = await tv(url);
  await page.waitForSelector(".grid .tile.focused");
  await page.locator('.tile[data-id="agentv.music"]').click();
  await page.locator('[data-action="sources"]').click();
  await page.waitForSelector(".page.music .share-form");
  return page;
}

bothWays("discover", "an app's setup lists the servers on your network first, and typing an address second", async (on, options) => {
  const { daemon, url } = await box(options);
  try {
    const page = await tv(url);
    await page.locator('.tile[data-id="someone.radio"] .tile-state:has-text("set up")').waitFor();
    await page.locator('.tile[data-id="someone.radio"]').click();
    await page.locator('input[data-field="serverUrl"]').waitFor({ state: "attached" });
    if (!on) {
      // As before: the address, typed, and nothing found asked for.
      assert.equal(await page.locator(".page h1.headline").innerText(), "set up radio");
      await page.waitForTimeout(800);
      assert.equal(await page.locator("[data-found]").count(), 0);
      assert.equal(daemon.discover.isLooking, false);
      await page.close();
      return;
    }
    await page.waitForFunction(() => document.querySelector(".page h1.headline")?.textContent === "pick your radio.");
    await page.waitForSelector("[data-found]");
    assert.deepEqual(await rows(page, "[data-found]"), [["living room", "nas.local"]]);
    // The first server found has the focus, and typing is the row after it.
    await page.waitForSelector('.focused[data-found="jellyfin http://127.0.0.1:8096"]');
    assert.equal(await page.locator('[data-action="type-address"]').innerText(), "type an address on your phone");
    assert.equal(await page.locator('input[data-field="serverUrl"]').isVisible(), false);
    // Typing instead shows the field, with the focus, for the phone's keyboard.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (document.activeElement as HTMLInputElement | null)?.dataset.field === "serverUrl");
    assert.equal(await page.locator(".page h1.headline").innerText(), "set up radio");
    assert.equal(await page.locator("[data-found]").isVisible(), false);

    // Back, and in again: OK on the server fills the address, saves it and
    // goes on to the sign-in.
    await page.keyboard.press("Escape");
    await page.waitForSelector(".grid .tile.focused");
    await page.locator('.tile[data-id="someone.radio"]').click();
    await page.waitForSelector('.focused[data-found="jellyfin http://127.0.0.1:8096"]');
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as { screenRequests: { cmd: string; app?: string }[] }).screenRequests.some((r) => r.cmd === "sign-in" && r.app === "someone.radio"));
    const saved = await (await fetch(`${url}/api/apps/someone.radio/setup`)).json();
    assert.equal(saved.setup.fields[0].value, "http://127.0.0.1:8096");
    await page.close();
  } finally {
    await daemon.close();
  }
});

bothWays("discover", "Music → sources lists the NASes on your network, and a NAS's folders become sources", async (on, options) => {
  const { daemon, url } = await box(options);
  smbAsked = [];
  smbWantsLogin = false;
  try {
    const page = await sources(url);
    if (!on) {
      await page.waitForTimeout(800);
      assert.equal(await page.locator(".section", { hasText: "# on your network" }).count(), 0);
      assert.equal(await page.locator("[data-found]").count(), 0);
      await page.close();
      return;
    }
    await page.waitForSelector("[data-found]");
    assert.deepEqual(await rows(page, "[data-found]"), [["living room nas", "nas.local"]]);
    assert.equal(await page.locator(".focused").getAttribute("data-found"), "nas nas.local");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".page.music h1.headline")?.textContent === "nas.local.");
    await page.waitForSelector("[data-share]");
    assert.deepEqual(await page.locator("[data-share] b").allInnerTexts(), ["▶ music", "▶ photos", "▶ films"]);
    assert.deepEqual(smbAsked, [["smbclient", "-L", "//nas.local", "-I", "127.0.0.1", "-N", "-g"]]);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as { screenRequests: { op?: string }[] }).screenRequests.some((r) => r.op === "add-share"));
    const [added] = await screenRequests(page, "music", "add-share");
    assert.deepEqual([added.uri, added.password], ["smb://nas.local/music", undefined]);
    await page.locator('.toast:has-text("music is a music source now")').waitFor();
    await page.close();
  } finally {
    await daemon.close();
  }
});

test("a NAS that shows its folders only after a sign-in asks for it, and the share keeps the password", async () => {
  const { daemon, url } = await box({ features: { discover: true } });
  smbAsked = [];
  smbWantsLogin = true;
  try {
    const page = await sources(url);
    await page.waitForSelector("[data-found]");
    await page.locator("[data-found]").click();
    // The sign-in, typed on the phone: these are the TV's fields it fills.
    await page.waitForFunction(() => (document.activeElement as HTMLInputElement | null)?.dataset.field === "user");
    assert.match(await page.locator(".page.music .panel-note").last().innerText(), /nas\.local shows its folders after you sign in/);
    await page.keyboard.type("radomir");
    await page.locator('input[data-field="password"]').fill("tunes, at 9 = fine");
    await page.locator('[data-action="list"]').click();
    await page.waitForSelector("[data-share]");
    // The password went with the ask, never in smbclient's arguments, and
    // isn't left on the page.
    assert.equal(await page.locator('input[data-field="password"]').inputValue(), "");
    assert.ok(!smbAsked.flat().some((arg) => arg.includes("tunes")));
    assert.deepEqual(smbAsked.at(-1), ["smbclient", "-L", "//nas.local", "-I", "127.0.0.1", "-U", "radomir", "-g"]);
    await page.locator('[data-share="smb://radomir@nas.local/photos"]').click();
    await page.waitForFunction(() => (window as unknown as { screenRequests: { op?: string }[] }).screenRequests.some((r) => r.op === "add-share"));
    const [added] = await screenRequests(page, "music", "add-share");
    assert.deepEqual([added.uri, added.password], ["smb://radomir@nas.local/photos", "tunes, at 9 = fine"]);
    await page.close();
  } finally {
    await daemon.close();
  }
});

bothWays("discover", "setup's shared folder lists the NASes on your network, and a NAS's folder becomes the background", async (on, options) => {
  const { daemon, url, state } = await box(options);
  smbAsked = [];
  smbWantsLogin = false;
  const at = "2026-11-05T08:00:00Z";
  const finished = Object.fromEntries(["welcome", "ready", "country", "ai", "people", "goal", "apps", "theme"].map((step) => [step, at]));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "background", finished, keyboard: true, goal: "media" }));
  try {
    const page = await tv(url);
    // Setup's theme and background, with a shared folder among its
    // backgrounds.
    await page.waitForSelector('.tb-back[data-background="folder"]');
    await page.locator('.tb-back[data-background="folder"]').click();
    await page.waitForFunction(() => document.querySelector(".setup-headline")?.getAttribute("aria-label") === "Pick a folder");
    if (!on) {
      await page.waitForTimeout(800);
      assert.equal(await page.locator("[data-found]").count(), 0);
      await page.close();
      return;
    }
    await page.waitForSelector("[data-found]");
    await page.waitForSelector('.focused[data-found="nas nas.local"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-share]");
    // Back goes back to the NASes, not out of the page.
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-found]");
    assert.equal(await page.locator(".setup-headline").getAttribute("aria-label"), "Pick a folder");
    await page.keyboard.press("Enter");
    await page.locator('[data-share="smb://nas.local/photos"]').click();
    await page.waitForFunction(() => (window as unknown as { screenRequests: { cmd: string; source?: string }[] }).screenRequests.some((r) => r.cmd === "background-folder" && r.source === "share:smb://nas.local/photos"));
    const [added] = await screenRequests(page, "music", "add-share");
    assert.equal(added.uri, "smb://nas.local/photos");
    await page.close();
  } finally {
    await daemon.close();
  }
});

// Setup at its apps step, with what the TV is for.
function atApps(state: string, goal: string): void {
  const at = "2026-11-08T08:00:00Z";
  const finished = Object.fromEntries(["welcome", "ready", "country", "ai", "people", "goal"].map((step) => [step, at]));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "apps", finished, keyboard: true, goal }));
}

const headline = (page: Page, text: string) => page.waitForFunction((text) => document.querySelector(".setup-headline")?.getAttribute("aria-label") === text, text);

bothWays("discover", "setup's apps step opens the servers on your network for each app it installs that asks for one, and a pick sets it up once it's in", async (on, options) => {
  const { daemon, url, state } = await box(options);
  atApps(state, "media");
  try {
    const page = await tv(url);
    await page.waitForSelector(".apps-page .app-pick.focused");
    // Jellyfin and Immich ticked, then continue.
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-app="agentv.immich"].on');
    await page.locator('[data-action="continue"]').click();
    if (!on) {
      // As before: on to the look, and nothing on the network asked.
      await page.waitForSelector(".setup-look-list", { timeout: 10_000 });
      assert.equal(await page.locator("[data-found]").count(), 0);
      assert.equal(daemon.discover.isLooking, false);
      await page.close();
      return;
    }
    await headline(page, "Pick your Jellyfin");
    assert.match(await page.locator(".setup-page .prompt").innerText(), /agentv app setup jellyfin/);
    await page.waitForSelector('.focused[data-found="jellyfin http://127.0.0.1:8096"]');
    assert.deepEqual(await rows(page, "[data-found]"), [["living room", "nas.local"]]);
    assert.deepEqual(await page.locator(".found > .button").allInnerTexts(), ["type its address", "later"]);
    assert.match(await page.locator(".bar").innerText(), /apps/);
    assert.doesNotMatch(await page.locator(".bar").innerText(), /move|pick|↵|esc/, "no key hints in the bar");
    // OK on it: Jellyfin will use it, and Immich's page is next.
    await page.keyboard.press("Enter");
    await page.locator('.toast:has-text("jellyfin will use living room")').waitFor();
    await headline(page, "Pick your Immich");
    // Nothing answers as Immich here. Later goes on to the look.
    await page.locator('[data-action="later"]').click();
    await page.waitForSelector(".setup-look-list", { timeout: 10_000 });
    assert.equal((await (await fetch(`${url}/api/setup`)).json()).setup.step, "look");
    // Jellyfin landed with its address in, and Immich still says "set up".
    const setupOf = async (id: string) => (await (await fetch(`${url}/api/apps/${id}/setup`)).json()).setup?.fields?.[0]?.value;
    for (let i = 0; i < 100 && (await setupOf("agentv.jellyfin")) !== "http://127.0.0.1:8096"; i++) await new Promise((done) => setTimeout(done, 50));
    assert.equal(await setupOf("agentv.jellyfin"), "http://127.0.0.1:8096");
    assert.equal(await setupOf("agentv.immich"), "");
    assert.deepEqual(await daemon.serverPicks.waiting(), []);
    await page.close();
  } finally {
    await daemon.close();
  }
});

test("setup's apps step on music lists the NASes on your network, and a NAS's folder becomes a music source", async () => {
  const { daemon, url, state } = await box({ features: { discover: true } });
  smbAsked = [];
  smbWantsLogin = false;
  atApps(state, "music");
  try {
    const page = await tv(url);
    await page.waitForSelector(".apps-page .app-pick");
    await page.locator('[data-action="continue"]').click();
    await headline(page, "Pick your drive");
    await page.waitForSelector('.focused[data-found="nas nas.local"]');
    assert.deepEqual(await rows(page, "[data-found]"), [["living room nas", "nas.local"]]);
    await page.keyboard.press("Enter");
    await headline(page, "nas.local");
    assert.match(await page.locator(".setup-page .prompt").innerText(), /agentv music sources nas\.local/);
    await page.waitForSelector("[data-share]");
    // Back goes back to the NASes, and in again.
    await page.keyboard.press("Escape");
    await headline(page, "Pick your drive");
    await page.waitForSelector('.focused[data-found="nas nas.local"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector('.focused[data-share="smb://nas.local/music"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector(".setup-look-list", { timeout: 10_000 });
    const [added] = await screenRequests(page, "music", "add-share");
    assert.deepEqual([added.uri, added.password], ["smb://nas.local/music", undefined]);
    await page.locator('.toast:has-text("added music to your music")').waitFor();
    await page.close();
  } finally {
    await daemon.close();
  }
});

// A phone paired with the box, on its remote.
async function phoneOn(daemon: Daemon, url: string): Promise<Page> {
  await fetch(`${url}/api/phones/pair`, { method: "POST" });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${daemon.lanPort}/#pair=${daemon.phones.secret()}`);
  await page.waitForSelector(".r2");
  return page;
}

bothWays("discover", "the phone shows what's on your network while the TV does, and a tap there picks it on the TV", async (on, options) => {
  const { daemon, url } = await box({ features: { ...options.features, remote2: true } });
  try {
    const page = await tv(url);
    const phone = await phoneOn(daemon, url);
    await page.locator('.tile[data-id="someone.radio"]').click();
    await page.locator('input[data-field="serverUrl"]').waitFor({ state: "attached" });
    if (!on) {
      await page.waitForTimeout(1500);
      assert.equal(await phone.locator(".r2-network").count(), 0);
      await phone.close();
      await page.close();
      return;
    }
    // One line a find, and typing under them, with the remote on one screen.
    await phone.waitForSelector('.r2-network [data-found="jellyfin http://127.0.0.1:8096"]');
    assert.equal(await phone.locator(".r2-network-head span").first().innerText(), "on your network");
    assert.deepEqual(await phone.locator(".r2-network-row").allInnerTexts(), ["living room · nas.local", "type an address"]);
    assert.ok(await phone.evaluate(() => document.documentElement.scrollHeight <= innerHeight), "nothing scrolls");
    // "Type an address" opens the TV's field, and the phone's keyboard comes.
    await phone.locator('.r2-network [data-found="typed"]').tap();
    await page.waitForFunction(() => (document.activeElement as HTMLInputElement | null)?.dataset.field === "serverUrl");
    await phone.waitForSelector(".r2-field");
    // Back on the TV, and in again: a tap on the find picks it there.
    await page.keyboard.press("Escape");
    await page.waitForSelector(".grid .tile.focused");
    await phone.waitForSelector(".r2-network", { state: "detached" });
    await page.locator('.tile[data-id="someone.radio"]').click();
    await phone.locator('.r2-network [data-found="jellyfin http://127.0.0.1:8096"]').tap();
    await page.waitForFunction(() => (window as unknown as { screenRequests: { cmd: string; app?: string }[] }).screenRequests.some((r) => r.cmd === "sign-in" && r.app === "someone.radio"));
    const saved = await (await fetch(`${url}/api/apps/someone.radio/setup`)).json();
    assert.equal(saved.setup.fields[0].value, "http://127.0.0.1:8096");
    // Gone from the TV, gone from the phone, and a pick then has nowhere to go.
    await phone.waitForSelector(".r2-network", { state: "detached" });
    await phone.close();
    await page.close();
  } finally {
    await daemon.close();
  }
});

test("the network pages keep to the content policy, with nothing in the console", () => {
  assert.deepEqual(errors, []);
});
