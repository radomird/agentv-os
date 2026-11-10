// The phone's d-pad in a web app made for a desktop (ADR-008,
// daemon/remote-page.ts), in a real Chromium started the way the screen daemon
// starts the services' one, and the page given the ring and Back over a
// DevTools pipe the way it gives them. The keys come as key events, as the
// virtual input device's do. The pages are stand-ins in
// test/agentv/fixtures/apps/desk/, which layer 3 runs too.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { after, before, test } from "node:test";
import { validatePackage, type Manifest } from "../../../apps/contract/manifest.ts";
import { cdpCheckPage, checkApp } from "../../../builder/contract-run.ts";
import { HARNESS } from "../harness.mts";
import { type Contract, Fixtures } from "../../../builder/fixtures.ts";
import { CdpPipe } from "../../../daemon/cdp.ts";
import { BACK_TAP, REMOTE_PAGE, REMOTE_WORLD, SHARED_PAGE, SPATIAL_NAVIGATION } from "../../../daemon/remote-page.ts";

const DESK = resolve(import.meta.dirname, "../fixtures/apps/desk");
const PAGES = join(DESK, "fixtures/pages");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// The key codes Chromium wants with each key.
const CODES: Record<string, number> = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 };

let server: Server;
let site = "";
let browser: ChildProcess;
let cdp: CdpPipe;

before(async () => {
  server = createServer((request, response) => {
    const name = new URL(request.url ?? "/", "http://x").pathname.slice(1);
    if (!/^[a-z-]+\.html$/.test(name)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(readFileSync(join(PAGES, name)));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = spawn(
    process.env.AGENTV_UI_BROWSER!,
    ["--headless=new", "--no-sandbox", "--remote-debugging-pipe", "--no-first-run", "--window-size=1920,1080", SPATIAL_NAVIGATION, `--user-data-dir=${mkdtempSync(join(tmpdir(), "agentv-remote-"))}`, "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  cdp = new CdpPipe(browser.stdio[3] as Writable, browser.stdio[4] as Readable);
});

after(() => {
  browser?.kill();
  server?.close();
});

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface State {
  focused: string;
  title: string;
  page: string;
  dialog: boolean;
  ring: Box | null;
  box: Box | null;
}

// A page opened as the screen daemon opens an app, with the ring and Back.
async function app(name: string, source = REMOTE_PAGE) {
  const target = await cdp.open(`${site}${name}`);
  await cdp.addScriptIn(target, source, REMOTE_WORLD);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true });
  await cdp.send("Page.bringToFront", {}, sessionId);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  const state = async (): Promise<State> =>
    cdp.evaluateIn(
      target,
      `(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
        const ring = document.querySelector("agentv-focus");
        const el = document.activeElement;
        return {
          focused: el && el !== document.body ? el.id : "",
          title: document.title,
          page: location.pathname.slice(1) + location.search,
          dialog: !!document.querySelector("dialog[open]"),
          ring: ring && getComputedStyle(ring).display !== "none" ? box(ring) : null,
          box: el && el !== document.body ? box(el) : null,
        };
      })()`,
    );
  const until = async (ok: (s: State) => boolean, what: string): Promise<State> => {
    let last: State | undefined;
    for (let tries = 0; tries < 50; tries++) {
      last = await state().catch(() => undefined);
      if (last && ok(last)) return last;
      await sleep(100);
    }
    assert.fail(`${what}: ${JSON.stringify(last)}`);
  };
  const press = async (key: string, holdMs = 0) => {
    const base = { key, code: key, windowsVirtualKeyCode: CODES[key], nativeVirtualKeyCode: CODES[key] };
    await cdp.send("Input.dispatchKeyEvent", key === "Enter" ? { type: "keyDown", text: "\r", unmodifiedText: "\r", ...base } : { type: "rawKeyDown", ...base }, sessionId);
    if (holdMs) await sleep(holdMs);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
    await sleep(150);
  };
  const point = (x: number, y: number) => cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  // The screen daemon's word that Back was a tap, as it gives it on the box
  // once Hyprland has seen the press and the release.
  const tapped = async () => {
    await cdp.evaluateInWorld(target, REMOTE_WORLD, BACK_TAP);
    await sleep(150);
  };
  await until((s) => s.title !== "", `${name} loaded`);
  return { target, state, until, press, point, tapped };
}

// The title stand-in, reached from the first page, so there's a page to go
// back to from it, and Play pressed with OK.
async function playing(query = "") {
  const page = await app("desktop.html");
  await cdp.evaluateIn(page.target, `location.href = "title.html${query}"`);
  await page.until((s) => s.page === `title.html${query}`, "the title's page");
  // The address changes as soon as the new page starts, before Play is
  // drawn, so wait for Play, then for it to have the focus.
  for (let tries = 0; tries < 50 && !(await cdp.evaluateIn(page.target, `!!document.getElementById("play")`).catch(() => false)); tries++) await sleep(100);
  await cdp.evaluateIn(page.target, `document.getElementById("play").focus()`);
  await page.until((s) => s.focused === "play", "Play has the focus");
  await page.press("Enter");
  await page.until((s) => s.title === "Playing" && s.page.startsWith("title.html?play"), "Play puts the player on the page's own history");
  return page;
}

// The ring is drawn around what has focus, a little outside it.
function ringAround(s: State): boolean {
  return !!s.ring && !!s.box && s.ring.left < s.box.left && s.ring.top < s.box.top && s.ring.right > s.box.right && s.ring.bottom > s.box.bottom;
}

test("the d-pad moves through a page made for a desktop, with a ring on what has focus (ADR-008)", async () => {
  const page = await app("desktop.html");
  assert.equal((await page.state()).focused, "", "nothing has focus at first");
  for (let tries = 0; tries < 4 && !(await page.state()).focused.startsWith("tile-"); tries++) await page.press("ArrowDown");
  const first = await page.state();
  assert.equal(first.focused, "tile-1", "down reaches the row of tiles");
  assert.ok(ringAround(first), `the ring is around the tile: ${JSON.stringify(first)}`);
  for (let n = 2; n <= 8; n++) await page.press("ArrowRight");
  const last = await page.until((s) => s.focused === "tile-8" && ringAround(s), "right goes along the row to its last tile, past the edge of the screen");
  assert.ok(last.box!.right <= 1920 && last.box!.left >= 0, `the row scrolled the last tile into view: ${JSON.stringify(last.box)}`);
  await page.press("Enter");
  await page.until((s) => s.title === "picked 8", "OK presses the tile");
  await page.press("ArrowDown");
  await page.until((s) => s.focused === "search" || s.focused === "more", "down leaves the row");
  await page.point(500, 500);
  await page.point(520, 520);
  await page.until((s) => s.ring === null, "the pointer moving hides the ring");
  await cdp.close(page.target);
});

test("OK on a link opens it, Back goes back, and the ring is there on the page Back brings (ADR-008)", async () => {
  const page = await app("desktop.html");
  await page.press("ArrowDown");
  for (let tries = 0; tries < 4 && !(await page.state()).focused.startsWith("tile-"); tries++) await page.press("ArrowDown");
  await page.press("ArrowUp");
  const link = await page.until((s) => ["home", "films", "series"].includes(s.focused), "up from the row reaches the links along the top");
  if (link.focused === "home") await page.press("ArrowRight");
  await page.until((s) => s.focused === "films" || s.focused === "series", "a link to another page");
  await page.press("Enter");
  await page.until((s) => s.page.startsWith("next.html"), "OK opens the link");
  await page.press("Escape");
  await page.until((s) => s.page === "desktop.html", "a tap on Back goes back a page");
  await page.press("ArrowDown");
  await page.until((s) => s.focused !== "" && ringAround(s), "the page Back brought has the ring too");
  await cdp.close(page.target);
});

test("Back stays when there's nowhere to go back to, when it's held for a second, and when a dialog is open (ADR-008, ADR-031)", async () => {
  const page = await app("desktop.html");
  await page.press("Escape");
  await sleep(300);
  assert.equal((await page.state()).page, "desktop.html", "nowhere to go back to");

  await cdp.evaluateIn(page.target, `location.href = "next.html?films"`);
  await page.until((s) => s.page === "next.html?films", "the next page");
  await page.press("Escape", 1200);
  await sleep(300);
  assert.equal((await page.state()).page, "next.html?films", "a second's hold is the screen daemon's Home, not a page back");

  await cdp.evaluateIn(page.target, `location.href = "desktop.html"`);
  await page.until((s) => s.page === "desktop.html", "back on the first page, with a page behind it");
  await cdp.evaluateIn(page.target, `document.getElementById("more").click()`);
  await page.until((s) => s.dialog, "the dialog opened");
  await page.press("Escape");
  await sleep(300);
  const after = await page.state();
  assert.equal(after.dialog, false, "Back closes the page's dialog");
  assert.equal(after.page, "desktop.html", "and stays on the page");
  await cdp.close(page.target);
});

test("T8.4 Back leaves a player that takes Escape itself, then goes on back from the title's page", async () => {
  const page = await playing();
  await page.press("Escape");
  await page.until((s) => s.page === "title.html", "Back leaves the player for the title's page");
  await page.press("Escape");
  await page.until((s) => s.page === "desktop.html", "and Back goes on back from there, not into the player");
  await cdp.close(page.target);
});

test("T8.4 after the player's own Back arrow, Back goes on back past the player, not into it", async () => {
  const page = await playing();
  await cdp.evaluateIn(page.target, `document.getElementById("controls").shadowRoot.getElementById("back").click()`);
  await page.until((s) => s.page === "title.html", "the player's own Back arrow puts the title's page on the history again");
  await page.press("Escape");
  await page.until((s) => s.page === "desktop.html", "Back goes back from the title's page, past the player");
  await cdp.close(page.target);
});

test("T8.4 in the player, Back closes the player's own settings and stays", async () => {
  const page = await playing();
  const settings = `document.getElementById("controls").shadowRoot.getElementById("dialog").open`;
  await cdp.evaluateIn(page.target, `document.getElementById("controls").shadowRoot.getElementById("settings").click()`);
  assert.equal(await cdp.evaluateIn(page.target, settings), true, "the settings opened");
  await page.press("Escape");
  await page.tapped();
  await sleep(300);
  assert.equal(await cdp.evaluateIn(page.target, settings), false, "Back closes them");
  assert.equal((await page.state()).page, "title.html?play", "and the player stays");
  await cdp.close(page.target);
});

test("T8.4 a full-screen player: Chromium takes Escape to leave full screen, and the screen daemon's tap leaves the player", async () => {
  const page = await playing("?full");
  const full = () => cdp.evaluateIn(page.target, "!!document.fullscreenElement");
  for (let tries = 0; tries < 30 && !(await full()); tries++) await sleep(100);
  assert.equal(await full(), true, "the player went full screen");
  await page.press("Escape");
  for (let tries = 0; tries < 30 && (await full()); tries++) await sleep(100);
  assert.equal(await full(), false, "Chromium left full screen on Escape");
  assert.equal((await page.state()).page, "title.html?play&full", "and the page never saw the key");
  await page.tapped();
  await page.until((s) => s.page === "title.html?full", "the tap the screen daemon heard leaves the player");
  await cdp.close(page.target);
});

test("T8.4 a title's page with a trailer over the screen is no player: Back comes back to it", async () => {
  const page = await app("desktop.html");
  await cdp.evaluateIn(page.target, `location.href = "title.html?trailer"`);
  await page.until((s) => s.page === "title.html?trailer", "the title's page, its trailer playing");
  // Another part of the same page app, such as its extras.
  await cdp.evaluateIn(page.target, `history.pushState(null, "", "title.html?trailer&extras")`);
  await page.press("Escape");
  await page.until((s) => s.page === "title.html?trailer", "Back comes back to the title's page, not past it");
  await cdp.close(page.target);
});

test("T8.4 a full-screen player left after the screen daemon's word on the tap arrived still leaves", async () => {
  // On the box the screen daemon can hear the tap before Chromium has ended
  // full screen in the page.
  const page = await playing("?full");
  const full = () => cdp.evaluateIn(page.target, "!!document.fullscreenElement");
  for (let tries = 0; tries < 30 && !(await full()); tries++) await sleep(100);
  assert.equal(await full(), true, "the player went full screen");
  await page.tapped();
  await page.press("Escape");
  await page.until((s) => s.page === "title.html?full", "the player leaves once full screen ends");
  await page.press("Escape");
  await page.until((s) => s.page === "desktop.html", "and Back goes on back from there");
  await cdp.close(page.target);
});

test("a tap the page took for a hold still goes back once the screen daemon says it was a tap", async () => {
  // On a busy box the page can see a second between the key's press and
  // its release while Hyprland saw a tap. The screen daemon's word counts.
  const page = await app("desktop.html");
  await cdp.evaluateIn(page.target, `location.href = "next.html?films"`);
  await page.until((s) => s.page === "next.html?films", "the next page");
  await page.press("Escape", 1100);
  await sleep(200);
  assert.equal((await page.state()).page, "next.html?films", "by itself, the page takes it for a hold");
  await page.tapped();
  await page.until((s) => s.page === "desktop.html", "the screen daemon's tap goes back a page");
  await cdp.close(page.target);
});

test("a page that moves its own focus with the arrows keeps them, with no ring over it (ADR-008)", async () => {
  const page = await app("own-keys.html");
  await page.press("ArrowRight");
  await page.press("ArrowRight");
  const s = await page.until((s) => s.title === "on 3", "the page's own highlight moved");
  assert.equal(s.focused, "", "Chromium didn't move the focus as well");
  assert.equal(s.ring, null, "no ring over the page's own");
  await cdp.close(page.target);
});

test("the builder's contract tests on the box press the d-pad as the TV does (ADR-008, ADR-046)", async () => {
  const contract = JSON.parse(readFileSync(join(DESK, "fixtures/contract.json"), "utf8")) as Contract;
  const { manifest } = validatePackage(DESK, "official");
  assert.ok(manifest);
  const served = new Fixtures(join(DESK, "fixtures"), contract);
  // The builder starts Chromium itself; here it runs without its sandbox, as
  // every browser in these tests does.
  const chromium = join(mkdtempSync(join(tmpdir(), "agentv-remote-builder-")), "chromium");
  writeFileSync(chromium, `#!/bin/sh\nexec "${process.env.AGENTV_UI_BROWSER}" --no-sandbox "$@"\n`);
  chmodSync(chromium, 0o755);
  const results = await checkApp({ dir: DESK, manifest: manifest as Manifest, contract, served, openPage: () => cdpCheckPage(chromium, served), harness: HARNESS });
  const failed = results.filter((result) => !result.ok);
  assert.deepEqual(failed, [], "every one of the stand-in's checks passes");
  assert.ok(results.some((result) => /OK presses/.test(result.name)));
});

test("a shared link's page gets the ring, and Back is left to the screen daemon, which closes it (ADR-050, Q164)", async () => {
  const page = await app("desktop.html", SHARED_PAGE);
  for (let tries = 0; tries < 4 && !(await page.state()).focused.startsWith("tile-"); tries++) await page.press("ArrowDown");
  await page.press("ArrowRight");
  await page.until((s) => s.focused === "tile-2" && ringAround(s), "the arrows move the focus, with the ring around it");
  await cdp.evaluateIn(page.target, `location.href = "next.html?films"`);
  await page.until((s) => s.page === "next.html?films", "a second page, so there's one to go back to");
  await page.press("Escape");
  await sleep(300);
  assert.equal((await page.state()).page, "next.html?films", "a tap on Back doesn't go back a page");
  await cdp.close(page.target);
});
