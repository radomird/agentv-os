// The TV shows a sentence as it's said (daemon/listening.ts, ADR-054): a
// paired phone's box opens, its words change and it closes, and each goes
// straight on to the TV's pages and the TV session. The daemon keeps none
// of the words: not in its state, its logs, the phone's state or what it
// says about the last sentence. Then a sentence sent from the box: the bar
// over an app says it's thinking and what came of it, in place of a toast.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AskWatch } from "../../../daemon/asks.ts";
import { Listening, type Heard } from "../../../daemon/listening.ts";
import { installLocal } from "../../../daemon/apps/install.ts";
import { NONE, type Route } from "../../../daemon/router.ts";
import type { SayAnswer, SayAsk } from "../../../daemon/say.ts";
import { Daemon } from "../../../daemon/server.ts";
import { pairPhone, type TestPhone } from "./phone-client.mts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "agentv-listening-"));
// Words no file, log or answer of the daemon's may hold.
const MARK = "zebra quartz nineteen";

test("ADR-054 a box opens, its words change, and it closes, each as the bar shows it", () => {
  const heard: Heard[] = [];
  const listening = new Listening({ changed: (h) => heard.push(h), idleMs: 60_000 });
  assert.equal(listening.change("iphone", { open: true }), null);
  assert.equal(listening.up, true);
  assert.equal(listening.change("iphone", { text: "  play\tfro " }), null);
  assert.equal(listening.change("iphone", { text: "" }), null);
  assert.equal(listening.change("iphone", { text: 42 }), "open, or the words so far");
  assert.equal(listening.change("iphone", { open: false }), null);
  assert.equal(listening.up, false);
  assert.deepEqual(heard, [
    { state: "open", text: "", from: "iphone" },
    { state: "words", text: "play fro", from: "iphone" },
    { state: "open", text: "", from: "iphone" },
    { state: "closed", text: "", from: "iphone" },
  ]);
  // At most a sentence's worth of words, as the router takes them.
  listening.change("iphone", { text: "a".repeat(400) });
  assert.equal(heard.at(-1)!.text.length, 300);
  listening.close();
});

test("ADR-054 a while with no new words takes the bar away, and a sent sentence keeps it for what comes of it", async () => {
  const heard: Heard[] = [];
  const listening = new Listening({ changed: (h) => heard.push(h), idleMs: 50 });
  listening.change("iphone", { text: "play" });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(heard.at(-1)!.state, "closed");
  assert.equal(listening.up, false);
  listening.change("iphone", { text: "play frozen" });
  assert.equal(listening.sent("iphone"), true, "the bar was up, so what comes of it takes it over");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(heard.at(-1)!.state, "words", "no timer takes it away while the sentence is thought about");
  assert.equal(listening.sent("iphone"), false, "and a second sentence with no box open has no bar");
});

// The phone sends its words a moment after each change, and the sentence on
// a connection of its own, so the last words can come after the sentence.
test("words that come after their sentence went don't bring the bar back, until the box opens again", () => {
  const heard: Heard[] = [];
  const listening = new Listening({ changed: (h) => heard.push(h), idleMs: 60_000 });
  listening.change("iphone", { open: true });
  assert.equal(listening.sent("iphone"), true);
  const before = heard.length;
  assert.equal(listening.change("iphone", { text: "play frozen" }), null, "late words aren't an error");
  assert.equal(heard.length, before, "and the TV doesn't hear them");
  assert.equal(listening.up, false);
  // A box closed late after its sentence doesn't hide another phone's bar.
  listening.change("pixel", { open: true });
  listening.change("iphone", { open: false });
  assert.equal(listening.up, true, "the pixel's bar stays");
  assert.equal(heard.at(-1)!.from, "pixel");
  listening.change("pixel", { open: false });
  assert.equal(listening.up, false, "and goes when the pixel closes its own box");
  // The iphone's box opened again: its words count again.
  listening.change("iphone", { open: true });
  listening.change("iphone", { text: "play moana" });
  assert.deepEqual(heard.at(-1), { state: "words", text: "play moana", from: "iphone" });
  listening.close();
});

// --- Through the daemon --------------------------------------------------------

const base = join(scratch, "daemon");
let daemon: Daemon;
let url = "";
let lan = "";
let token: TestPhone;
const logs: string[] = [];
const asks: SayAsk[] = [];
const events: { event: string; data: any }[] = [];
let watch: AskWatch<SayAsk, SayAnswer>;
let stopEvents = () => {};

before(async () => {
  const apps = join(base, "apps");
  const kino = join(scratch, "kino");
  cpSync(join(ROOT, "test/agentv/fixtures/apps/pager"), kino, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(kino, "manifest.json"), "utf8"));
  writeFileSync(join(kino, "manifest.json"), JSON.stringify({ ...manifest, id: "local.kino", name: "Kino", author: "your agent" }));
  await installLocal(kino, apps, async () => true);
  const routes: Record<string, Route> = { "play frozen": { ...NONE, intent: "play", query: "Frozen", kind: "film" } };
  daemon = new Daemon({
    root: join(base, "root"),
    state: join(base, "state"),
    apps,
    builtins: null,
    port: 0,
    log: (line) => logs.push(line),
    lanPort: 0,
    lanHost: "127.0.0.1",
    address: () => "127.0.0.1",
    keyStatus: join(base, "key.json"),
    listenIdleMs: 300,
    router: async (sentence) => {
      // One the router takes a while over, as a real one can.
      if (sentence === "dim the lights") await new Promise((resolve) => setTimeout(resolve, 300));
      return { sentence, route: routes[sentence] ?? { ...NONE }, ...(routes[sentence] ? {} : { none: "unroutable" as const }), provider: "claude", via: "api", model: "test", ms: 1 };
    },
  });
  url = `http://127.0.0.1:${await daemon.listen()}`;
  lan = `http://127.0.0.1:${daemon.lanPort}`;
  const code = (await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json()).pairing.code;
  token = await pairPhone(lan, code, "iphone");
  // The TV session: Kino finds Frozen, and anything opens.
  watch = new AskWatch<SayAsk, SayAnswer>({
    url: `${url}/`,
    path: "api/say/ask",
    what: "a sentence",
    handle: async (ask) => {
      asks.push(ask);
      if (ask.kind === "search") return { ok: true, found: [{ app: "local.kino", items: [{ id: "f1", kind: "film" as const, title: "Frozen" }] }] };
      return { ok: true };
    },
    failed: (error) => ({ ok: false, error: error.message }),
    log: () => {},
    retryMs: 50,
  });
  watch.start();
  // The TV's pages, as home hears the daemon.
  const controller = new AbortController();
  stopEvents = () => controller.abort();
  const stream = await fetch(`${url}/api/events`, { signal: controller.signal });
  void (async () => {
    let buffer = "";
    for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk);
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
});

after(async () => {
  stopEvents();
  watch.stop();
  await daemon.close();
  rmSync(scratch, { recursive: true, force: true });
});

const phone = (path: string, body?: unknown) =>
  token.fetch(`${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("it didn't happen in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const heardOnTv = () => events.filter((e) => e.event === "listening").map((e) => e.data as Heard);
const live = () => asks.filter((a) => a.kind === "live") as Extract<SayAsk, { kind: "live" }>[];

// Every file in the daemon's state, read whole.
function stateFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? stateFiles(path) : [readFileSync(path, "latin1")];
  });
}

test("ADR-054 a box's words take setup done, like a sentence", async () => {
  const early = await phone("/api/phone/say/live", { open: true });
  assert.equal(early.status, 409);
  assert.equal((await early.json()).error, "the tv takes requests once setup is done");
  writeFileSync(join(base, "state", "setup.json"), JSON.stringify({ done: true, at: "2026-11-01T18:00:00Z" }));
});

test("ADR-054 the box's words go to the TV's pages and the TV session as they change, and the daemon keeps none of them", async () => {
  assert.equal((await phone("/api/phone/say/live", { open: true })).status, 200);
  assert.equal((await phone("/api/phone/say/live", { text: `play ${MARK}` })).status, 200);
  await until(() => heardOnTv().some((h) => h.state === "words"));
  assert.deepEqual(heardOnTv().slice(-2), [
    { state: "open", text: "", from: "iphone" },
    { state: "words", text: `play ${MARK}`, from: "iphone" },
  ]);
  await until(() => live().some((a) => a.state === "words"));
  assert.deepEqual(live().slice(-2).map(({ state, text }) => ({ state, text })), [
    { state: "open", text: "" },
    { state: "words", text: `play ${MARK}` },
  ]);
  // Kept nowhere: the daemon's files, its log, the phone's state and what
  // it says about the last sentence.
  assert.ok(!stateFiles(join(base, "state")).some((text) => text.includes(MARK)), "a file in the daemon's state holds the words");
  assert.ok(!logs.some((line) => line.includes(MARK)), "the log holds the words");
  assert.doesNotMatch(JSON.stringify(await (await phone("/api/phone/state")).json()), new RegExp(MARK));
  assert.doesNotMatch(JSON.stringify(await (await fetch(`${url}/api/say`)).json()), new RegExp(MARK));
  // Closed on the phone: the bar goes.
  await phone("/api/phone/say/live", { open: false });
  await until(() => heardOnTv().at(-1)?.state === "closed");
  await until(() => live().at(-1)?.state === "closed");
});

test("ADR-054 Back on the TV and a while with no new words each take the bar away", async () => {
  await phone("/api/phone/say/live", { open: true });
  await phone("/api/phone/say/live", { text: "play" });
  await until(() => heardOnTv().at(-1)?.state === "words");
  await fetch(`${url}/api/say/live/close`, { method: "POST" });
  await until(() => heardOnTv().at(-1)?.state === "closed");
  await phone("/api/phone/say/live", { text: "play" });
  await until(() => heardOnTv().at(-1)?.state === "words");
  await until(() => heardOnTv().at(-1)?.state === "closed", 2000);
});

test("ADR-054 a sentence sent from the box: the bar over an app says it's thinking, then what came of it, in place of a toast", async () => {
  await phone("/api/phone/say/live", { open: true });
  await phone("/api/phone/say/live", { text: "play frozen" });
  await until(() => heardOnTv().at(-1)?.state === "words");
  asks.length = 0;
  const said = await (await phone("/api/phone/say", { sentence: "play frozen" })).json();
  assert.equal(said.said.outcome.say, "frozen, on kino");
  await until(() => live().some((a) => a.state === "said"));
  assert.deepEqual(live().map(({ state, text }) => ({ state, text })), [
    { state: "thinking", text: "play frozen" },
    { state: "said", text: "frozen, on kino" },
  ]);
  assert.ok(!asks.some((a) => a.kind === "tell"), "no toast while the bar is up");
  assert.ok(!heardOnTv().slice(-1).some((h) => h.state === "closed"), "the bar wasn't taken away under it");
  // A sentence with no box open has no bar, so its outcome is a toast.
  asks.length = 0;
  await phone("/api/phone/say", { sentence: "turn the lights off" });
  await until(() => asks.some((a) => a.kind === "tell"));
  assert.deepEqual(live(), []);
});

test("ADR-054 a box opened again while a sentence is thought about keeps the bar for its words, and what came of the sentence is a toast", async () => {
  await phone("/api/phone/say/live", { open: true });
  await phone("/api/phone/say/live", { text: "dim the lights" });
  await until(() => live().some((a) => a.text === "dim the lights"));
  asks.length = 0;
  const said = phone("/api/phone/say", { sentence: "dim the lights" });
  await until(() => live().some((a) => a.state === "thinking"));
  // The box opens again on the phone, as it does when it takes the focus.
  await phone("/api/phone/say/live", { open: true });
  await phone("/api/phone/say/live", { text: "continue my show" });
  assert.equal((await (await said).json()).said.outcome.say, "i didn't get that");
  await until(() => asks.some((a) => a.kind === "tell"));
  assert.deepEqual(asks.filter((a) => a.kind === "tell").map((a) => a.text), ["i didn't get that"]);
  assert.deepEqual(live().map(({ state, text }) => ({ state, text })), [
    { state: "thinking", text: "dim the lights" },
    { state: "open", text: "" },
    { state: "words", text: "continue my show" },
  ]);
});

test("ADR-054 a locked TV takes no words, as it takes no sentences, and locking it takes the bar away", async () => {
  await phone("/api/phone/say/live", { open: true });
  await until(() => heardOnTv().at(-1)?.state === "open");
  assert.equal((await fetch(`${url}/api/pin`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "2468" }) })).status, 200);
  await fetch(`${url}/api/pin/lock`, { method: "POST" });
  await until(() => heardOnTv().at(-1)?.state === "closed");
  const refused = await phone("/api/phone/say/live", { text: "play frozen" });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "the tv is locked: unlock it first");
  assert.equal(heardOnTv().at(-1)!.state, "closed");
  assert.equal((await fetch(`${url}/api/pin/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "2468" }) })).status, 200);
  assert.equal((await phone("/api/phone/say/live", { open: true })).status, 200);
  await until(() => heardOnTv().at(-1)?.state === "open");
  await phone("/api/phone/say/live", { open: false });
});

test("ADR-054 on a child's profile the bar is the same, and the sentence is routed for the child", async () => {
  const grant = (await (await fetch(`${url}/api/pin/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "2468" }) })).json()).grant;
  const child = (await (await fetch(`${url}/api/viewers`, { method: "POST", headers: { "Content-Type": "application/json", "X-AgenTV-Grant": grant }, body: JSON.stringify({ name: "mila", role: "child" }) })).json()).profile;
  await fetch(`${url}/api/viewer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: child.id }) });
  await phone("/api/phone/say/live", { open: true });
  await phone("/api/phone/say/live", { text: "play frozen" });
  await until(() => live().some((a) => a.state === "words" && a.text === "play frozen"));
  asks.length = 0;
  const said = (await (await phone("/api/phone/say", { sentence: "play frozen" })).json()).said;
  assert.equal(said.viewer, child.id);
  await until(() => live().some((a) => a.state === "said"));
  assert.deepEqual(live().map(({ state, text }) => ({ state, text })), [
    { state: "thinking", text: "play frozen" },
    { state: "said", text: said.outcome.kind === "choose" ? "which one? your phone has them" : said.outcome.say },
  ]);
});
