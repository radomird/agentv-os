// Every game platform Omarchy has (ADR-103, T23.1), in a real Chromium on
// the daemon itself. Settings, Home and apps has a Games row, and its page
// lists every game in the index in each look: Steam first, each with what OK
// does, and a line for the ones that need a mouse and keyboard. OK adds one
// past the PIN, a second added while the first installs waits its turn, and
// OK on one that's in removes it. Home's Games row gets each one that lands.
// Phones and controllers has the Xbox controller row, which adds the driver.
// Setup's apps step has a games group, with Steam ticked for gaming on a box
// that runs games. A child's profile only sees the list. Root's side is the
// harness's stand-in (box.mts), as for the other app tests.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { IndexEntry } from "../../../daemon/apps/index.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { APPS_MOVER, machine, OFFICIAL, rest, startBox } from "./box.mts";
import { cutOff } from "./fits.mts";
import { rendered } from "./legible.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
type Look = (typeof LOOKS)[number];
// A dark theme and a light one: Omarchy's default and its lightest.
const THEMES = ["tokyo-night", "catppuccin-latte"];
const SHOTS = process.env.ORIGAITV_SHOTS;

// The game platforms as the index lists them, by the descriptions their
// manifests have.
const game = (id: string, name: string, description: string): IndexEntry => ({
  ...OFFICIAL[0],
  id,
  name,
  description,
  category: "games",
  path: `apps/${id.split(".")[1]}`,
});
const GAMES: IndexEntry[] = [
  { ...OFFICIAL.find((app) => app.id === "origaitv.steam")!, description: "Your Steam games, full screen", category: "games" },
  game("origaitv.retroarch", "RetroArch", "Classic consoles, from your own games"),
  game("origaitv.moonlight", "Moonlight", "Games streamed from your own PC"),
  game("origaitv.xboxcloud", "Xbox Cloud Gaming", "Xbox games streamed from the cloud"),
  game("origaitv.geforcenow", "GeForce NOW", "PC games from the cloud"),
  game("origaitv.minecraft", "Minecraft", "Minecraft's own launcher. Needs a mouse and keyboard."),
  game("origaitv.lutris", "Lutris", "Windows games from other stores. Needs a mouse and keyboard."),
  game("origaitv.heroic", "Heroic", "Your Epic, GOG and Amazon games. Needs a mouse and keyboard."),
  game("origaitv.battlenet", "Battle.net", "Blizzard's games. Needs a mouse and keyboard."),
];
const CATALOG = [...OFFICIAL.filter((app) => app.id !== "origaitv.steam"), ...GAMES];

let browser: Browser;
let daemon: Daemon;
let url = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url } = await startBox(0, undefined, { catalog: CATALOG }));
  await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "field" }) });
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

const put = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function useLook(look: Look, theme = THEMES[0]): Promise<void> {
  assert.equal((await put("/api/look", { look })).status, 200);
  assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200);
}

async function tv(role: "adult" | "child" = "adult"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  // A child's profile, as the daemon would say who's watching.
  if (role === "child") {
    await page.route(`${url}/api/home`, async (route) => {
      const reply = await route.fetch();
      const state = await reply.json();
      await route.fulfill({ response: reply, json: { ...state, viewer: { ...state.viewer, role: "child" } } });
    });
  }
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/?size=standard`);
  await page.waitForSelector("html[data-look] #page .focused");
  await rest(page);
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go(r), route);
const focused = (page: Page) => page.evaluate(() => document.querySelector(".focused")?.getAttribute("data-action") ?? document.querySelector(".focused")?.getAttribute("data-key"));
const panel = (page: Page) => page.locator(".panel").innerText();
const row = (id: string) => `.panel [data-action="game-${id}"]`;
const value = (page: Page, id: string) => page.locator(`${row(id)} .button-value`).innerText();
const toast = (page: Page, text: string) =>
  page.waitForFunction((want) => [...document.querySelectorAll("#toasts .toast")].some((one) => one.textContent === want), text, { timeout: 5000 });

async function openGames(page: Page): Promise<void> {
  await go(page, "settings/games");
  await page.waitForSelector('.settings-panel[data-page="games"]');
  await page.waitForSelector(row("origaitv.steam"));
}

async function moveTo(page: Page, id: string): Promise<void> {
  for (let presses = 0; (await focused(page)) !== `game-${id}`; presses++) {
    assert.ok(presses < 12, `the focus reaches ${id}, from ${await focused(page)}`);
    await page.keyboard.press("ArrowDown");
  }
}

for (const look of LOOKS) {
  const said = (text: string) => (look === "terminal" ? text.toLowerCase() : text);

  test(`T23.1 Settings' Games page in ${look}: every game, Steam first, what OK does, and which need a mouse and keyboard, with nothing cut off`, async () => {
    for (const theme of THEMES) {
      await useLook(look, theme);
      const page = await tv();
      try {
        await go(page, "settings/home");
        await page.waitForSelector('.panel [data-action="games"]');
        await page.waitForFunction((want) => new RegExp(want).test(document.querySelector<HTMLElement>('.panel [data-action="games"]')?.innerText ?? ""), `${said("Games")}\\s+${said("None yet")}`);
        await openGames(page);
        const names = await page.locator('.panel [data-action^="game-"] [data-own-case]').allInnerTexts();
        assert.deepEqual(names, ["Steam", "Battle.net", "GeForce NOW", "Heroic", "Lutris", "Minecraft", "Moonlight", "RetroArch", "Xbox Cloud Gaming"], "Steam, then by name, as written in every look");
        assert.equal(await value(page, "origaitv.retroarch"), said("Add"));
        assert.ok((await panel(page)).includes(said("Battle.net, Heroic, Lutris and Minecraft need a mouse and keyboard")), await panel(page));
        assert.deepEqual(await cutOff(page, ".panel"), [], "nothing is cut off");
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `games-${look}-${theme}.png`) });
        // The line over the list is in view, and down to the last game the
        // list scrolls to it.
        const inView = (selector: string) =>
          page.evaluate((which) => {
            const box = document.querySelector(".settings-panel")!.getBoundingClientRect();
            const one = document.querySelector(which)!.getBoundingClientRect();
            return one.top >= box.top - 1 && one.bottom <= box.bottom + 1;
          }, selector);
        assert.ok(await inView('.panel [data-note="games"]'), "the mouse and keyboard line is in view");
        await page.keyboard.press("Enter");
        await moveTo(page, "origaitv.xboxcloud");
        await page.waitForTimeout(400);
        assert.ok(await inView(row("origaitv.xboxcloud")), "the last game scrolls into view");
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `games-${look}-${theme}-end.png`) });
      } finally {
        await page.close();
      }
    }
  });
}

test("T23.1 adding two games: the second waits its turn, both land on home's Games row, and removing one takes it off and leaves the other", async () => {
  await useLook("glass");
  APPS_MOVER.ms = 900;
  const page = await tv();
  try {
    await openGames(page);
    await page.keyboard.press("Enter");
    await moveTo(page, "origaitv.retroarch");
    await page.keyboard.press("Enter");
    await toast(page, "Adding RetroArch…");
    await page.keyboard.press("ArrowDown");
    assert.equal(await focused(page), "game-origaitv.xboxcloud");
    await page.keyboard.press("Enter");
    await toast(page, "Adding Xbox Cloud Gaming…");
    // Both are going: one installing, the one after it waiting or already on.
    await page.waitForFunction(() => /Installing…|Waiting…/.test(document.querySelector('.panel [data-action="game-origaitv.xboxcloud"] .button-value')?.textContent ?? ""));
    await page.waitForFunction(() => ["origaitv.retroarch", "origaitv.xboxcloud"].every((id) => document.querySelector(`.panel [data-action="game-${id}"] .button-value`)?.textContent === "Remove"), undefined, { timeout: 8000 });
    assert.equal(await focused(page), "game-origaitv.xboxcloud", "the focus stays where it was as the page is drawn again");
    const home = await (await fetch(`${url}/api/home`)).json();
    const games = (home.apps as { id: string; category: string }[]).filter((app) => app.category === "games" && GAMES.some((one) => one.id === app.id)).map((app) => app.id);
    assert.deepEqual(games.sort(), ["origaitv.retroarch", "origaitv.xboxcloud"], "home's Games row has both, as games");

    // OK on one that's in asks first, OK again removes it, and it can be
    // added again.
    await page.keyboard.press("ArrowUp");
    assert.equal(await focused(page), "game-origaitv.retroarch");
    await page.keyboard.press("Enter");
    assert.equal(await value(page, "origaitv.retroarch"), "Press OK again to remove");
    await page.keyboard.press("Enter");
    await toast(page, "Removing RetroArch. Your games and saves stay.");
    await page.waitForFunction(() => document.querySelector('.panel [data-action="game-origaitv.retroarch"] .button-value')?.textContent === "Add", undefined, { timeout: 8000 });
    assert.equal(await value(page, "origaitv.xboxcloud"), "Remove");
    // A removal that didn't work says so, and the game stays.
    APPS_MOVER.removeFails = true;
    await page.keyboard.press("ArrowDown");
    assert.equal(await focused(page), "game-origaitv.xboxcloud");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    // Root's step, the daemon's next look and the page drawn again come
    // first, so the row's words are waited for as an install's are. The
    // notice goes up in the same moment.
    await page.waitForFunction(() => document.querySelector('.panel [data-action="game-origaitv.xboxcloud"] .button-value')?.textContent === "Couldn't remove · Try again", undefined, { timeout: 10000 });
    await toast(page, "Couldn't remove Xbox Cloud Gaming. Try again.");
    const after = await (await fetch(`${url}/api/home`)).json();
    assert.deepEqual((after.apps as { id: string }[]).filter((app) => app.id.startsWith("origaitv.") && GAMES.some((one) => one.id === app.id)).map((app) => app.id), ["origaitv.xboxcloud"]);
    // Home and apps says how many are on the TV.
    await page.keyboard.press("Escape");
    await page.waitForSelector('.settings-panel[data-page="home"]');
    await page.waitForFunction(() => /Games\s+1 on this TV/.test(document.querySelector<HTMLElement>('.panel [data-action="games"]')?.innerText ?? ""));
  } finally {
    APPS_MOVER.ms = 400;
    APPS_MOVER.removeFails = false;
    await page.close();
  }
});

test("T23.1 a game that needs a mouse and keyboard says so on its home tile, in every look, with nothing cut off", async () => {
  for (const look of ["terminal", "glass", "cinema"] as const) {
    await useLook(look);
    const page = await tv();
    try {
      if (look === "terminal") {
        await openGames(page);
        await page.keyboard.press("Enter");
        await moveTo(page, "origaitv.minecraft");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector('.panel [data-action="game-origaitv.minecraft"] .button-value')?.textContent === "Remove", undefined, { timeout: 8000 });
      }
      await go(page, "home");
      // The remote's arrows to its tile: down to its row, then along it.
      // Glass and Cinema show a tile's words with the focus on it.
      const selector = '.tile[data-id="origaitv.minecraft"]';
      await page.waitForSelector(selector, { state: "attached" });
      await rest(page);
      for (let presses = 0; presses < 30; presses++) {
        const key = await page.evaluate((one) => {
          const at = document.querySelector<HTMLElement>(".focused");
          const target = document.querySelector<HTMLElement>(one)!;
          if (!at || at === target) return null;
          const a = at.getBoundingClientRect();
          const t = target.getBoundingClientRect();
          if (a.bottom <= t.top) return "ArrowDown";
          if (a.top >= t.bottom) return "ArrowUp";
          return a.left < t.left ? "ArrowRight" : "ArrowLeft";
        }, selector);
        if (!key) break;
        await page.keyboard.press(key);
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(500);
      // Terminal writes it in lower case, as it does every word.
      assert.match(await page.locator(selector).first().innerText(), /needs a mouse and keyboard/i, look);
      const cut = await page.evaluate((one) => {
        const tile = document.querySelector<HTMLElement>(one)!;
        const line = [...tile.querySelectorAll<HTMLElement>("*")].find((el) => el.children.length === 0 && el.textContent === "Needs a mouse and keyboard")!;
        const at = line.getBoundingClientRect();
        // And the room it takes doesn't push the name into the logo.
        const name = [...tile.querySelectorAll<HTMLElement>("*")].find((el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim().toLowerCase() === "minecraft"));
        const logo = tile.querySelector<HTMLElement>(".logo");
        const n = name?.getBoundingClientRect();
        const l = logo?.getBoundingClientRect();
        const overlap = !!n && !!l && n.top < l.bottom - 1 && n.bottom > l.top + 1 && n.left < l.right - 1 && n.right > l.left + 1;
        return overlap || at.left < 0 || at.right > innerWidth || at.top < 0 || at.bottom > innerHeight || line.scrollWidth > line.clientWidth + 1 || line.scrollHeight > line.clientHeight + 1;
      }, selector);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `games-needs-keyboard-${look}.png`) });
      assert.equal(cut, false, `${look}: the line is whole and on the screen`);
    } finally {
      await page.close();
    }
  }
});

test("T23.1 the Xbox controller row adds the driver past the PIN, and says when a restart finishes it", async () => {
  await useLook("cinema");
  assert.equal((await put("/api/pin", { pin: "2468" })).status, 200);
  APPS_MOVER.restart = true;
  const page = await tv();
  try {
    await go(page, "settings/phones");
    await page.waitForSelector('.panel [data-action="xbox-driver"]');
    assert.match(await page.locator('.panel [data-action="xbox-driver"]').innerText(), /Xbox controllers\s+Add/);
    await page.locator('.panel [data-action="xbox-driver"]').click();
    await page.waitForSelector(".pin-pad");
    for (const digit of "2468") await page.keyboard.press(digit);
    await toast(page, "Adding Xbox controller support…");
    await page.waitForFunction(() => /Restart to finish/.test(document.querySelector('.panel [data-action="xbox-driver"]')?.textContent ?? ""), undefined, { timeout: 8000 });
    const driver = (await (await fetch(`${url}/api/games/driver`)).json()).driver;
    assert.deepEqual(driver, { installed: true, state: "installed", restart: true });
  } finally {
    APPS_MOVER.restart = false;
    await page.close();
  }
});

test("T23.1 a child's profile sees the games and can't add or remove one", async () => {
  await useLook("terminal");
  const page = await tv("child");
  try {
    // Settings on a child's profile is past the PIN, when the test before
    // set one.
    await go(page, "settings/games");
    if (await (await page.waitForSelector('.pin-pad, .settings-panel[data-page="games"]')).evaluate((el) => el.classList.contains("pin-pad"))) {
      for (const digit of "2468") await page.keyboard.press(digit);
    }
    await page.waitForSelector('.settings-panel[data-page="games"]');
    await page.waitForSelector(row("origaitv.steam"));
    assert.equal(await page.locator('.panel [data-action^="game-"][data-focus]').count(), 0, "nothing to press");
    assert.doesNotMatch(await panel(page), /\b(add|remove)\b/i, "and no row offers to");
    assert.equal(await page.locator('.panel [data-action="xbox-driver"][data-focus]').count(), 0);
  } finally {
    await page.close();
  }
});

// --- Setup's games group ----------------------------------------------------------

// A fresh box at setup's apps step, for a goal, on a machine the box check
// reads.
async function atApps(goal: string, box: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const started = await startBox(0, undefined, { catalog: CATALOG, box: { machine: machine(box) } });
  const post = (path: string, body: unknown) => fetch(`${started.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await post("/api/setup", { done: false });
  await post("/api/setup/finish", { step: "welcome", keyboard: true });
  await post("/api/setup/ready", { update: "none" });
  for (const step of ["ready", "box", "country", "ai", "people"]) await post("/api/setup/finish", { step });
  await post("/api/setup/goal", { goal });
  await post("/api/setup/finish", { step: "goal" });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    (window as unknown as { origaitvScreen: (json: string) => void }).origaitvScreen = () => {};
  });
  await page.goto(`${started.url}/`);
  await page.waitForSelector(".apps-page .app-pick");
  return {
    page,
    close: async () => {
      await page.close();
      await started.daemon.close();
    },
  };
}

const groups = (page: Page) => page.locator(".app-group:not(.hidden) .app-head").allInnerTexts();
const group = (page: Page, head: string) => page.locator(".app-group", { has: page.locator(".app-head", { hasText: head }) });

test("T23.1 setup's games group: for gaming on a NUC, Steam is ticked, and every other platform is offered with its one line", async () => {
  const { page, close } = await atApps("gaming", "nuc8i5beh");
  try {
    assert.deepEqual(await groups(page), ["# for gaming", "# games", "# more"]);
    assert.deepEqual(await group(page, "# for gaming").locator(".app-pick .app-name").allInnerTexts(), ["steam"]);
    assert.match(await page.locator('[data-app="origaitv.steam"]').innerText(), /\[x\]/, "Steam starts ticked on a box that runs light games");
    assert.deepEqual(await group(page, "# games").locator(".app-pick .app-name").allInnerTexts(), ["battle.net", "geforce now", "heroic", "lutris", "minecraft", "moonlight", "retroarch", "xbox cloud gaming"]);
    assert.match(await page.locator('[data-app="origaitv.minecraft"]').innerText(), /\[ \][\s\S]*needs a mouse and keyboard/);
    assert.match(await page.locator('[data-app="origaitv.retroarch"]').innerText(), /classic consoles, from your own games/);
    assert.deepEqual(await cutOff(page, ".apps-page"), [], "nothing is cut off");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "setup-games-gaming-nuc.png") });
    // The groups scroll with the focus, down to the last card, Build your
    // own, which is in view and above the soundtrack's card.
    for (let presses = 0; (await page.locator(".focused").getAttribute("data-action")) !== "add"; presses++) {
      assert.ok(presses < 16, `the focus reaches Build your own, from ${await page.locator(".focused").getAttribute("data-app")}`);
      const before = await page.locator(".focused").getAttribute("data-app");
      await page.keyboard.press("ArrowDown");
      // On the last row, it's to the right.
      if ((await page.locator(".focused").getAttribute("data-app")) === before) await page.keyboard.press("ArrowRight");
    }
    await page.waitForTimeout(400);
    const seen = await page.evaluate(() => {
      const list = document.querySelector(".app-groups")!.getBoundingClientRect();
      const last = document.querySelector(".app-add")!.getBoundingClientRect();
      return last.top >= list.top - 1 && last.bottom <= list.bottom + 1;
    });
    assert.ok(seen, "Build your own scrolled into view");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "setup-games-gaming-nuc-end.png") });
  } finally {
    await close();
  }
});

test("T23.1 setup's games group: for streaming nothing is ticked, and a box that isn't for games is offered the streamed ones only", async () => {
  const streaming = await atApps("streaming", "nuc8i5beh");
  try {
    assert.ok((await groups(streaming.page)).includes("# games"));
    assert.equal(await streaming.page.locator(".app-group .app-pick.on").count(), 0, "no game starts ticked for streaming");
    assert.equal((await group(streaming.page, "# games").locator(".app-pick .app-name").allInnerTexts())[0], "steam", "Steam first");
  } finally {
    await streaming.close();
  }
  const qemu = await atApps("gaming", "qemu");
  try {
    assert.deepEqual(await groups(qemu.page), ["# games", "# more"], "no Steam for gaming on a box that isn't for games");
    assert.deepEqual(await group(qemu.page, "# games").locator(".app-pick .app-name").allInnerTexts(), ["geforce now", "moonlight", "xbox cloud gaming"]);
    assert.equal(await qemu.page.locator('[data-app="origaitv.steam"]').count(), 0);
  } finally {
    await qemu.close();
  }
});
