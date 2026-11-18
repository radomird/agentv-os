// A page drawn again keeps what's typed on it (T28.9, layer 4), in a real
// Chromium. The launcher draws the page in front again when a look is picked
// on a phone, when the display's size changes, when someone else is
// watching, when home changes and when a switch turns. On each page with a
// field, text is typed, the caret is put in the middle of it, and each of
// those happens from outside, as from a phone. The text, the caret and the
// focus are as they were every time, and Save sends the text. A stand-in
// answers each Save with a no, so the test needs no root helper and the page
// stays put.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { typeIn } from "../../../daemon/remote-text.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let adults: string[] = [];
const errors: string[] = [];

type Sent = { id: number; cmd: string; op?: string; q?: string; uri?: string; password?: string };
type Launcher = { go(route: string): void; focus: { set(el: HTMLElement): void; get(): HTMLElement | undefined } };
type Tv = { origaitvLauncher: Launcher; screenRequests: Sent[]; origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void; was?: Element | null };

const send = async (method: string, path: string, body?: unknown) =>
  (await fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json();

before(async () => {
  ({ daemon, url } = await startBox(0, undefined, { builtins: true, zone: "Europe/Amsterdam" }));
  // A second adult, for someone else to be watching.
  await send("POST", "/api/viewers", { name: "Ana", role: "adult", avatar: "green" });
  adults = ((await send("GET", "/api/viewers")).viewers as { id: string; role: string }[]).filter((v) => v.role === "adult").map((v) => v.id);
  assert.equal(adults.length, 2);
  await send("PUT", "/api/look", { look: "terminal" });
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  await send("PUT", "/api/features", { looks: true });
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

// --- What draws the page in front again ---------------------------------------

let turn = 0;
let calm = false;
let big = false;
let who = 0;
const LOOKS = ["glass", "cinema", "terminal"];
const CAUSES: [string, () => Promise<unknown>][] = [
  ["a look is picked", () => send("PUT", "/api/look", { look: LOOKS[turn++ % LOOKS.length] })],
  ["the display's size changes", () => send("POST", "/api/display/tv", { output: "HDMI-A-1", modes: ["3840x2160@60.00Hz", "1920x1080@60.00Hz"], live: { mode: (big = !big) ? "3840x2160@60" : "1920x1080@60", scale: 1 } })],
  ["someone else is watching", () => send("POST", "/api/viewer", { id: adults[(who = 1 - who)] })],
  ["home changes", () => send("POST", "/api/settings", { reduceMotion: (calm = !calm) })],
  ["a switch turns off", () => send("PUT", "/api/features", { looks: false })],
  ["a switch turns on", () => send("PUT", "/api/features", { looks: true })],
];

// --- The TV ---------------------------------------------------------------------

// The TV, with a screen daemon that answers Music and remembers what it was
// asked, and stand-ins for what a page asks the TV before it shows a field.
async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    const w = window as unknown as Tv;
    w.screenRequests = [];
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json) as Sent;
      w.screenRequests.push(request);
      const answer = request.op === "add-share" ? { ok: false, error: "A stand-in said no" } : { ok: true, apps: [], albums: [], playlists: [], results: [], sources: [] };
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify(answer)), 0);
    };
  });
  // An app's setup comes a moment after its page, as on the TV: the field
  // isn't there yet when the page is drawn.
  await page.route(/\/api\/apps\/someone\.radio\/setup$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await new Promise((done) => setTimeout(done, 150));
    await route.fulfill({ json: { ok: true, setup: { id: "someone.radio", name: "Radio", fields: [{ key: "station", label: "Station", value: "", address: false }], signIn: false } } });
  });
  // A network drive that lists its folders only for a user.
  await page.route(/\/api\/discover\/shares\?/, (route) => route.fulfill({ json: { ok: true, shares: [], login: true } }));
  // A plan's sign-in that waits for the code it gave.
  await page.route(/\/api\/ai\/sign-in$/, (route) => route.fulfill({ json: { ok: true, signIn: { provider: "", signedIn: false, now: { state: "waiting", url: "https://sign-in.example/", pastes: true } } } }));
  await page.route(/\/api\/ai\/sign-in\/qr/, (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto(`${url}/`);
  await page.waitForSelector(".focused");
  await page.waitForFunction(() => (window as unknown as Partial<Tv>).origaitvLauncher !== undefined);
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as Tv).origaitvLauncher.go(r), route);

// Types into a field as a keyboard does, with the TV's focus on it.
async function type(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForSelector(selector);
  await page.evaluate((sel) => (window as unknown as Tv).origaitvLauncher.focus.set(document.querySelector<HTMLElement>(sel)!), selector);
  await page.keyboard.type(text);
}

interface Seen {
  value: string;
  start: number | null;
  end: number | null;
  active: boolean;
  focused: boolean;
  kind: string;
}

const seen = (page: Page, selector: string): Promise<Seen> =>
  page.evaluate((sel) => {
    const el = document.querySelector<HTMLInputElement>(sel)!;
    return { value: el.value, start: el.selectionStart, end: el.selectionEnd, active: document.activeElement === el, focused: (window as unknown as Tv).origaitvLauncher.focus.get() === el, kind: el.type };
  }, selector);

// Waits until the page has been drawn again: the field is a new one.
async function drawnAgain(page: Page, selector: string, cause: () => Promise<unknown>): Promise<void> {
  await page.evaluate((sel) => ((window as unknown as Tv).was = document.querySelector(sel)), selector);
  await cause();
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el !== null && el !== (window as unknown as Tv).was;
  }, selector);
}

interface Case {
  name: string;
  route: string;
  // What has to be on the TV before the page opens.
  first?: (page: Page) => Promise<unknown>;
  // The fields, in the order they're typed. The last one has the focus and
  // the caret when the page is drawn again.
  fields: [selector: string, text: string][];
  // The last field is out of sight until the TV has answered the page.
  late?: boolean;
  // Save: what's pressed (or Enter, in the field), the request it sends, and
  // where the text is in it.
  save: { press: string; method: string; path: RegExp; sent: (body: any) => unknown[] } | { press: string | null; screen: (asked: Sent[]) => unknown[] };
}

// A stand-in for a key: long, and nothing a secrets check would take for one.
const KEY = `stand-in-${"k".repeat(40)}`;
const SECRET = `typed ${process.pid} here`;

const PAGES: Case[] = [
  { name: "the TMDB key", route: "tmdb-key", fields: [['[data-action="tmdb-key-field"]', KEY]], save: { press: '[data-action="save"]', method: "PUT", path: /\/api\/tmdb-key$/, sent: (b) => [b.key] } },
  {
    name: "the Wi-Fi's name and password",
    route: "wifi",
    fields: [
      ['.wifi-join [data-field="name"]', "attic net"],
      ['.wifi-join [data-field="password"]', SECRET],
    ],
    save: { press: '[data-action="join"]', method: "POST", path: /\/api\/network\/join$/, sent: (b) => [b.ssid, b.password] },
  },
  {
    name: "the desktop's password, twice",
    route: "desktop-password",
    fields: [
      ['[data-action="password"]', SECRET],
      ['[data-action="password-again"]', SECRET],
    ],
    save: { press: '[data-action="set-password"]', method: "PUT", path: /\/api\/desktop\/password$/, sent: (b) => [b.password, b.password] },
  },
  { name: "a new profile's name", route: "profile/new", fields: [['[data-action="name"]', "Mira Lind"]], save: { press: '[data-action="save"]', method: "POST", path: /\/api\/viewers$/, sent: (b) => [b.name] } },
  { name: "the AI's key", route: "key", fields: [['[data-action="key"]', KEY]], save: { press: '[data-action="save"]', method: "PUT", path: /\/api\/key$/, sent: (b) => [b.key] } },
  { name: "what's asked in the Ask box", route: "ask", fields: [['[data-field="ask"]', "play something calm tonight"]], save: { press: "Enter", method: "POST", path: /\/api\/say$/, sent: (b) => [b.sentence] } },
  { name: "what to build", route: "build", fields: [['[data-field="sentence"]', "a clock with big numbers"]], save: { press: '[data-action="ask"]', method: "POST", path: /\/api\/builds$/, sent: (b) => [b.sentence] } },
  { name: "what a theme looks like", route: "describe", fields: [['[data-field="sentence"]', "a theme of wet slate"]], save: { press: '[data-action="ask"]', method: "POST", path: /\/api\/builds$/, sent: (b) => [b.sentence] } },
  { name: "what to change in an app", route: "change/local.mytv", fields: [['[data-field="change"]', "bigger letters please"]], save: { press: '[data-action="ask"]', method: "POST", path: /\/api\/builds\/apps\/local\.mytv\/change$/, sent: (b) => [b.text] } },
  { name: "an app's setup", route: "app-setup/someone.radio", fields: [['[data-field="station"]', "Radio Stand-in 99.9"]], save: { press: '[data-action="save"]', method: "POST", path: /\/api\/apps\/someone\.radio\/setup$/, sent: (b) => [b.values.station] } },
  {
    name: "the location's search",
    route: "country",
    // Settings asks which countries there are.
    first: async (page) => {
      await go(page, "settings");
      await page.waitForFunction(async () => ((await (await fetch("/api/country")).json()).countries ?? []).length > 0);
      await page.waitForTimeout(200);
    },
    fields: [[".country-picker .country-field", "norw"]],
    save: { press: '.country-list [data-code="NO"]', method: "PUT", path: /\/api\/country$/, sent: (b) => [b.code === "NO" ? "norw" : b.code] },
  },
  { name: "Music's search", route: "music", fields: [['.music-search[type="search"]', "night shift"]], save: { press: null, screen: (asked) => [asked.filter((r) => r.op === "search").pop()?.q] } },
  {
    name: "a music folder's address and password",
    route: "music/sources",
    fields: [
      ['input[aria-label="Folder address"]', "smb://ana@attic/music"],
      ['input[aria-label="Password"]', SECRET],
    ],
    save: { press: '[data-action="add-share"]', screen: (asked) => [asked.find((r) => r.op === "add-share")?.uri, asked.find((r) => r.op === "add-share")?.password] },
  },
  {
    name: "a network drive's sign-in",
    route: "music/nas:attic.local",
    fields: [
      ['.share-form [data-field="user"]', "ana"],
      ['.share-form [data-field="password"]', SECRET],
    ],
    save: { press: '[data-action="list"]', method: "POST", path: /\/api\/discover\/shares$/, sent: (b) => [b.user, b.password] },
  },
  { name: "the code a plan's sign-in gave", route: "plan-sign-in", late: true, fields: [['[data-action="sign-in-code"]', "stand-in code 4821"]], save: { press: '[data-action="send-code"]', method: "POST", path: /\/api\/ai\/sign-in\/code$/, sent: (b) => [b.code] } },
];

for (const one of PAGES) {
  test(`T28.9 ${one.name}: drawn again, the page keeps the text, the caret and the focus, and Save takes the text`, async () => {
    const page = await tv();
    try {
      await one.first?.(page);
      await go(page, one.route);
      for (const [selector, text] of one.fields) await type(page, selector, text);
      const [last] = one.fields[one.fields.length - 1];
      // The caret in the middle, with two characters picked, so the end of
      // the text isn't mistaken for it.
      const caret = { start: 2, end: 4 };
      await page.evaluate(({ sel, at }) => document.querySelector<HTMLInputElement>(sel)!.setSelectionRange(at.start, at.end), { sel: last, at: caret });
      const kinds = await Promise.all(one.fields.map(async ([selector]) => (await seen(page, selector)).kind));

      for (const [cause, happen] of CAUSES) {
        await drawnAgain(page, last, happen).catch(() => assert.fail(`when ${cause}, the page wasn't drawn again`));
        for (const [i, [selector, text]] of one.fields.entries()) {
          const now = await seen(page, selector);
          assert.equal(now.value, text, `when ${cause}, ${selector} keeps its text`);
          assert.equal(now.kind, kinds[i], `when ${cause}, ${selector} is the kind of field it was`);
        }
        // A field the page shows only once the TV has answered gets the
        // focus then, a moment after the page is drawn.
        if (one.late) await page.waitForFunction((sel) => (window as unknown as Tv).origaitvLauncher.focus.get() === document.querySelector(sel), last).catch(() => {});
        const now = await seen(page, last);
        assert.deepEqual({ start: now.start, end: now.end }, caret, `when ${cause}, the caret is where it was`);
        assert.ok(now.active && now.focused, `when ${cause}, the field has the focus`);
        // Nothing was typed twice or into another field.
        const all = await page.locator("#page input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value).filter(Boolean));
        assert.deepEqual(all.sort(), one.fields.map(([, text]) => text).sort(), `when ${cause}, no other field has text`);
      }

      // Save takes the text.
      const want = one.fields.map(([, text]) => text);
      if ("screen" in one.save) {
        const { press, screen } = one.save;
        if (press) await page.click(press);
        await page.waitForFunction((n) => (window as unknown as Tv).screenRequests.length >= n, 1);
        const until = Date.now() + 5000;
        let got: unknown[] = [];
        while (Date.now() < until) {
          got = screen(await page.evaluate(() => (window as unknown as Tv).screenRequests));
          if (JSON.stringify(got) === JSON.stringify(want)) break;
          await page.waitForTimeout(50);
        }
        assert.deepEqual(got, want, "what the TV is asked has the text");
      } else {
        const { press, method, path, sent } = one.save;
        let body: unknown;
        await page.route(path, async (route) => {
          if (route.request().method() !== method) return route.fallback();
          body = route.request().postDataJSON();
          await route.fulfill({ status: 400, json: { ok: false, error: "A stand-in said no" } });
        });
        if (press === "Enter") await page.keyboard.press("Enter");
        else await page.click(press);
        for (let i = 0; i < 100 && body === undefined; i++) await page.waitForTimeout(50);
        assert.deepEqual(sent(body), want, "the request has the text");
      }
    } finally {
      await page.close();
    }
  });
}

// What a row shows as its value, by the row's name on the page.
// In lower case, since a look may show it that way.
const shows = async (page: Page, action: string) => ((await page.locator(`[data-action="${action}"] .button-value`).textContent()) ?? "").toLowerCase();

// Presses Save, and gives what it sent. A stand-in says no, so the page stays.
async function saved(page: Page, method: string, path: RegExp): Promise<any> {
  let body: unknown;
  await page.route(path, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    body = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { ok: false, error: "A stand-in said no" } });
  });
  await page.click('[data-action="save"]');
  for (let i = 0; i < 100 && body === undefined; i++) await page.waitForTimeout(50);
  return body;
}

for (const who of ["new", "saved"]) {
  test(`T28.9 a ${who} profile's role, colour and what phones may send stay as picked when the page is drawn again, and Save sends what the page shows`, async () => {
    const page = await tv();
    try {
      // The saved one is the adult nobody is watching as at the start.
      const id = who === "new" ? "new" : adults[1];
      await send("POST", "/api/viewer", { id: adults[0] });
      await go(page, `profile/${id}`);
      const name = '[data-action="name"]';
      await page.waitForSelector(name);
      await page.evaluate((sel) => (window as unknown as Tv).origaitvLauncher.focus.set(document.querySelector<HTMLElement>(sel)!), name);
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("Mira Lind");
      const before = { role: await shows(page, "role"), colour: await shows(page, "avatar") };
      // The other role, two colours on, and phones may send to it.
      await page.click('[data-action="role"]');
      await page.click('[data-action="avatar"]');
      await page.click('[data-action="avatar"]');
      await page.click('[data-action="shares"]');
      const picked = { role: await shows(page, "role"), colour: await shows(page, "avatar"), shares: await shows(page, "shares") };
      assert.equal(picked.role, "child");
      assert.notEqual(picked.role, before.role);
      assert.notEqual(picked.colour, before.colour);
      assert.equal(picked.shares, "on");

      for (const [cause, happen] of CAUSES) {
        await drawnAgain(page, name, happen).catch(() => assert.fail(`when ${cause}, the page wasn't drawn again`));
        assert.equal((await seen(page, name)).value, "Mira Lind", `when ${cause}, the name is kept`);
        assert.deepEqual({ role: await shows(page, "role"), colour: await shows(page, "avatar"), shares: await shows(page, "shares") }, picked, `when ${cause}, the role, the colour and what phones may send are as picked`);
      }

      const body = await saved(page, who === "new" ? "POST" : "PUT", who === "new" ? /\/api\/viewers$/ : /\/api\/viewers\/[^/]+$/);
      assert.ok(body, "Save sent the profile");
      // What went is what the page showed, whatever was picked.
      assert.equal(body.name, "Mira Lind");
      assert.equal(body.role, await shows(page, "role"), "the role sent is the one on the page");
      assert.equal(body.avatar, await shows(page, "avatar"), "the colour sent is the one on the page");
      assert.deepEqual({ role: body.role, shares: body.shares, locked: body.locked }, { role: "child", shares: true, locked: false });
    } finally {
      await page.close();
    }
  });
}

test("T28.9 a profile nobody changed takes what's saved when its page is drawn again", async () => {
  const page = await tv();
  try {
    await send("POST", "/api/viewer", { id: adults[0] });
    await go(page, `profile/${adults[1]}`);
    const name = '[data-action="name"]';
    await page.waitForSelector(name);
    const colour = await shows(page, "avatar");
    // Somebody changes it from elsewhere, as from a phone: the page is drawn
    // again with the new colour and the new name, since nothing was picked or typed here.
    const other = colour === "red" ? "cyan" : "red";
    await send("PUT", `/api/viewers/${adults[1]}`, { name: "Ana B", avatar: other });
    await page.waitForFunction((want) => document.querySelector('[data-action="avatar"] .button-value')?.textContent?.toLowerCase() === want, other);
    assert.equal((await seen(page, name)).value, "Ana B");
    await send("PUT", `/api/viewers/${adults[1]}`, { name: "Ana", avatar: colour });
  } finally {
    await page.close();
  }
});

test("T28.9 the AI picked for a key stays when the page is drawn again, so the key is saved for the AI the page shows", async () => {
  const page = await tv();
  try {
    await go(page, "key");
    const field = '[data-action="key"]';
    const first = await shows(page, "provider");
    await page.click('[data-action="provider"]');
    await page.click('[data-action="provider"]');
    const picked = await shows(page, "provider");
    assert.notEqual(picked, first);
    await type(page, field, KEY);
    for (const [cause, happen] of CAUSES) {
      await drawnAgain(page, field, happen).catch(() => assert.fail(`when ${cause}, the page wasn't drawn again`));
      assert.equal(await shows(page, "provider"), picked, `when ${cause}, the AI is the one picked`);
      assert.equal((await seen(page, field)).value, KEY, `when ${cause}, the key is kept`);
    }
    // The third AI in the page's list, which is what two presses picked.
    const body = await saved(page, "PUT", /\/api\/key$/);
    assert.equal(body.key, KEY);
    assert.equal(body.provider, "gemini", "the key goes to the AI the page shows");
    assert.match(picked, /gemini/i);
  } finally {
    await page.close();
  }
});

test("T28.9 a phone typing into a field goes on in the same field after the page is drawn again, with nothing lost or typed twice", async () => {
  const page = await tv();
  try {
    await go(page, "wifi");
    const name = '.wifi-join [data-field="name"]';
    const password = '.wifi-join [data-field="password"]';
    await type(page, name, "attic net");
    await page.evaluate((sel) => (window as unknown as Tv).origaitvLauncher.focus.set(document.querySelector<HTMLElement>(sel)!), password);
    // The phone sends its whole field each time, and the screen daemon makes
    // the field in front hold it (daemon/remote-text.ts).
    const phone = (value: string) => page.evaluate(typeIn(value, value.length)) as Promise<{ ok: boolean }>;
    let typed = "";
    for (const [, happen] of CAUSES) {
      for (const letter of "ab") assert.equal((await phone((typed += letter))).ok, true);
      await drawnAgain(page, password, happen);
      assert.equal((await seen(page, password)).value, typed, "the password is there before the phone's next letter");
      assert.equal((await phone((typed += "c"))).ok, true);
      assert.equal((await seen(page, password)).value, typed);
      assert.equal((await seen(page, name)).value, "attic net", "and none of it went into the name");
    }
    assert.equal((await seen(page, password)).kind, "password");
  } finally {
    await page.close();
  }
});

test("T28.9 a page opened again starts empty: only a page drawn again in place keeps its text", async () => {
  const page = await tv();
  try {
    await go(page, "tmdb-key");
    await type(page, '[data-action="tmdb-key-field"]', KEY);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector('[data-action="tmdb-key-field"]') === null);
    await go(page, "tmdb-key");
    await page.waitForSelector('[data-action="tmdb-key-field"]');
    assert.equal((await seen(page, '[data-action="tmdb-key-field"]')).value, "", "the page opened again is empty");
  } finally {
    await page.close();
  }
});
