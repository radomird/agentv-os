// The phone's typing on the TV (ADR-065, track 8): keystrokes for a native
// app, a difference at a time and plain ASCII only; the typing bar's text,
// with dots for a password; what a field's report may carry; where the
// screen daemon types and draws the bar; and the daemon's route, which keeps
// only the newest change waiting and never logs or keeps the text.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { RemoteInput } from "../../../daemon/remote.ts";
import { barText, cleanField, NativeTyping, PhoneTyping, typeIn, type Bar, type TypingFront } from "../../../daemon/remote-text.ts";
import { PhoneRemote } from "../../../daemon/routes/remote.ts";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("T8.1 a native app gets keystrokes: only the difference, with Backspace back to where the text parts", async () => {
  const sent: Record<string, unknown>[] = [];
  const send = async (request: Record<string, unknown>) => void sent.push(request);
  const native = new NativeTyping();
  assert.deepEqual(await native.type("Ren", "0xa", send), { ok: true, by: "key" });
  assert.deepEqual(await native.type("Rent", "0xa", send), { ok: true, by: "key" });
  assert.deepEqual(await native.type("Re", "0xa", send), { ok: true, by: "key" });
  assert.deepEqual(sent, [{ text: "Ren" }, { text: "t" }, { key: "backspace" }, { key: "backspace" }]);
  // A new window starts afresh.
  sent.length = 0;
  await native.type("ok", "0xb", send);
  assert.deepEqual(sent, [{ text: "ok" }]);
});

test("T8.1 a native app takes plain ASCII only, and the phone hears what couldn't go and what did", async () => {
  const sent: Record<string, unknown>[] = [];
  const native = new NativeTyping();
  const answer = await native.type("René 🎬", "0xa", async (request) => void sent.push(request));
  assert.deepEqual(answer, { ok: false, by: "key", value: "Ren ", why: "This app can't take é" });
  assert.deepEqual(sent, [{ text: "Ren " }]);
  native.reset();
  const none: Record<string, unknown>[] = [];
  await native.type("ж", "0xa", async (request) => void none.push(request));
  assert.deepEqual(none, [], "nothing to type");
});

test("T8.1 the typing bar shows the newest text, or a dot for each character of a password", () => {
  assert.equal(barText("sintel", false), "sintel");
  assert.equal(barText("hunter2é🎬", true), "•".repeat(9));
  const long = "a".repeat(40) + "жé";
  assert.equal(barText(long, false), `…${"a".repeat(31)}жé`);
  assert.equal([...barText(long, false)].length, 34);
  assert.equal(barText("x".repeat(80), true), "•".repeat(34));
});

test("T8.1 a field's report carries its kind, a short name and its text, never a password's", () => {
  assert.deepEqual(cleanField({ kind: "search", label: "  Search  the   site ", value: "sin" }), { kind: "search", label: "Search the site", value: "sin" });
  assert.deepEqual(cleanField({ kind: "password", label: "password", value: "hunter2" }), { kind: "password", label: "password" });
  assert.deepEqual(cleanField({ kind: "weird", value: 4 }), { kind: "text", label: "" });
  assert.equal(cleanField(null), null);
  assert.equal(cleanField("text"), null);
  assert.equal(cleanField({ kind: "text", label: "x".repeat(80) })!.label.length, 40);
});

test("T8.1 what's typed goes into the page as a string, so no text can run as code", () => {
  const expression = typeIn(`"); alert(1); ("`, 3);
  assert.ok(expression.endsWith(`)(${JSON.stringify(`"); alert(1); ("`)}, 3)`));
  assert.ok(typeIn("x", null).endsWith(`)("x", null)`));
});

test("T8.1 the screen daemon types into the page in front, or as keys into a native app, and the overlay's bar follows an app", async () => {
  const evaluated: string[] = [];
  const keys: Record<string, unknown>[] = [];
  const bars: (Bar | null)[] = [];
  let front: TypingFront = { kind: "page", id: "home", overlay: false, evaluate: async (expression) => (evaluated.push(expression), { ok: true, by: "page" }) };
  const typing = new PhoneTyping({ front: () => front, keys: async (request) => void keys.push(request), bar: async (bar) => void bars.push(bar) });
  const bar: Bar = { from: "Radomir's phone", text: "si", password: false };
  assert.deepEqual(await typing.text("si", 2, bar), { ok: true, by: "page" });
  assert.equal(evaluated.length, 1);
  assert.deepEqual(bars, [], "home draws its own bar");
  // An app's page: the overlay's bar.
  front = { kind: "page", id: "agentv.tube", overlay: true, evaluate: async () => ({ ok: true, by: "page" }) };
  await typing.text("sin", 3, { ...bar, text: "sin" });
  assert.deepEqual(bars, [{ ...bar, text: "sin" }]);
  // A native app: keystrokes.
  front = { kind: "native", id: "0xc", overlay: true };
  assert.deepEqual(await typing.text("ab", 2, { ...bar, text: "ab" }), { ok: true, by: "key" });
  assert.deepEqual(keys, [{ text: "ab" }]);
  // Home again: the overlay's bar goes.
  front = { kind: "page", id: "home", overlay: false, evaluate: async () => ({ ok: true, by: "page" }) };
  await typing.text("abc", 3, { ...bar, text: "abc" });
  assert.equal(bars.at(-1), null);
  // Enter.
  front = { kind: "page", id: "agentv.tube", overlay: true, evaluate: async () => ({ ok: true }) };
  await typing.text("x", 1, { ...bar, text: "x" });
  assert.deepEqual(await typing.done(), { ok: true, by: "page" });
  assert.deepEqual(keys.at(-1), { key: "enter" });
  assert.equal(bars.at(-1), null, "the bar goes on Enter");
});

test("T8.1 a page that doesn't answer, or nothing to type in, says so", async () => {
  let front: TypingFront = { kind: "page", id: "x", overlay: true, evaluate: () => new Promise(() => {}) };
  const typing = new PhoneTyping({ front: () => front, keys: async () => {}, bar: async () => {}, ms: 50 });
  assert.deepEqual(await typing.text("a", 1, null), { ok: false, why: "Your TV isn't ready yet" });
  front = null;
  assert.deepEqual(await typing.text("a", 1, null), { ok: false, why: "Nothing to type into right now" });
  front = { kind: "page", id: "x", overlay: true, evaluate: async () => ({ ok: false, by: "page", why: "That field is full", kept: 3, extra: "no" }) };
  assert.deepEqual(await typing.text("abcd", 4, null), { ok: false, by: "page", why: "That field is full", kept: 3 });
});

// The route on a server of its own, with a stand-in for the screen
// daemon's stream that answers each ask as told.
async function route(options: { front?: "home" | "app"; field?: { kind: string } | null; session?: boolean; answer?: (ask: any) => object | null; viewer?: string } = {}) {
  const asks: any[] = [];
  const pages: { event: string; data: unknown }[] = [];
  let remote: PhoneRemote;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    void remote.phone(request.method!, path, request, response).then(async (done) => {
      if (!done && !(await remote.local(request.method!, path, request, response))) response.writeHead(404).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  remote = new PhoneRemote({
    send: (event) => {
      if (options.session === false) return false;
      const ask = (event as { ask: any }).ask;
      asks.push(ask);
      const said = options.answer ? options.answer(ask) : { ok: true, by: "page" };
      if (said) setTimeout(() => void fetch(`${base}/api/remote/answer/${ask.n}`, { method: "POST", headers: { "Content-Type": "application/json", "X-AgenTV-Screen": "1" }, body: JSON.stringify(said) }), 30);
      return true;
    },
    tv: () => ({ field: options.field === undefined ? { kind: "search" } : options.field, front: options.front ?? "home" }),
    viewer: async () => ({ name: options.viewer ?? "Radomir" }),
    toPages: (event, data) => void pages.push({ event, data }),
    json: (response: ServerResponse, status: number, data: unknown) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data)),
    body: async (request: IncomingMessage) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    },
    answerMs: 300,
  });
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { asks, pages, post, close: () => server.close() };
}

test("T8.1 each change goes to the screen daemon, and home's bar hears it with whose phone it is", async () => {
  const r = await route();
  assert.deepEqual(await r.post("/api/phone/text", { value: "sinté", caret: 5 }), { status: 200, body: { ok: true, by: "page" } });
  assert.deepEqual(r.asks, [{ n: 1, kind: "text", value: "sinté", caret: 5, bar: { from: "Radomir's phone", text: "sinté", password: false } }]);
  assert.deepEqual(r.pages, [{ event: "typing", data: { from: "Radomir's phone", text: "sinté", password: false } }]);
  // A caret past the end, or none, is no caret.
  await r.post("/api/phone/text", { value: "ab", caret: 9 });
  assert.equal(r.asks.at(-1)!.caret, null);
  // Enter: the bar goes, and the screen daemon presses it.
  assert.deepEqual(await r.post("/api/phone/text", { done: true }), { status: 200, body: { ok: true, by: "page" } });
  assert.deepEqual(r.asks.at(-1), { n: 3, kind: "done" });
  assert.deepEqual(r.pages.at(-1), { event: "typing", data: null });
  r.close();
});

test("T8.1 a password reaches home's bar as dots only, and over an app the overlay draws it, not home", async () => {
  const r = await route({ field: { kind: "password" }, front: "app", viewer: "you" });
  await r.post("/api/phone/text", { value: "hunter2", caret: 7 });
  assert.deepEqual(r.asks[0].bar, { from: "Your phone", text: "•••••••", password: true });
  assert.deepEqual(r.pages, [{ event: "typing", data: null }]);
  r.close();
});

test("T8.1 only the newest change waits: ones it overtook are answered as done, and nothing is asked twice", async () => {
  // Each answer takes 30 ms, and the changes come 2 ms apart.
  const r = await route();
  const all = await Promise.all(["s", "si", "sin", "sint"].map(async (value, i) => (await sleep(i * 2), r.post("/api/phone/text", { value, caret: value.length }))));
  assert.ok(all.every((a) => a.status === 200 && a.body.ok === true));
  assert.equal(r.asks[0].value, "s", "the first went at once");
  assert.equal(r.asks.at(-1).value, "sint", "the newest always goes");
  assert.ok(r.asks.length < 4, `the ones in between were skipped: ${r.asks.map((a) => a.value).join(", ")}`);
  r.close();
});

test("T8.1 the route says when there's no TV session, refuses a bad change, and takes answers only from the screen daemon", async () => {
  const off = await route({ session: false });
  assert.deepEqual(await off.post("/api/phone/text", { value: "a", caret: 1 }), { status: 503, body: { ok: false, why: "Your TV isn't ready yet" } });
  off.close();
  const r = await route({ answer: () => null });
  assert.equal((await r.post("/api/phone/text", { value: 5 })).status, 400);
  assert.equal((await r.post("/api/phone/text", { value: "é".repeat(501) })).status, 400);
  assert.equal((await r.post("/api/remote/answer/1", { ok: true })).status, 403);
  assert.deepEqual(await r.post("/api/phone/text", { value: "a", caret: 1 }), { status: 200, body: { ok: false, why: "Your TV isn't ready yet" } });
  assert.equal((await r.post("/api/remote/answer/99", { ok: true }, { "X-AgenTV-Screen": "1" })).status, 404);
  r.close();
});

test("T8.1 the screen daemon takes an ask in order with the keys and answers it on the daemon's port, with its header", async () => {
  const answers: { path: string; who: string; body: string }[] = [];
  let stream: ServerResponse | null = null;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": agentv remote\n\n");
      stream = response;
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    answers.push({ path: request.url!, who: String(request.headers["x-agentv-screen"]), body });
    response.writeHead(200).end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const sent: Record<string, unknown>[] = [];
  const order: string[] = [];
  const input = new RemoteInput({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/remote`,
    send: async (request) => void (sent.push(request), order.push("key")),
    ask: async (ask) => (order.push(ask.kind), { ok: true, by: "page" }),
    log: () => {},
    retryMs: 50,
  });
  input.start();
  while (!stream) await sleep(10);
  const say = (event: object) => (stream as ServerResponse).write(`data: ${JSON.stringify(event)}\n\n`);
  say({ key: "down" });
  say({ ask: { n: 7, kind: "text", value: "é", caret: 1, bar: null } });
  say({ key: "up" });
  while (answers.length < 1) await sleep(10);
  await input.idle();
  assert.deepEqual(order, ["key", "text", "key"]);
  assert.deepEqual(answers, [{ path: "/api/remote/answer/7", who: "1", body: JSON.stringify({ ok: true, by: "page" }) }]);
  input.stop();
  (stream as ServerResponse).destroy();
  server.close();
});

test("T8.1 on Omarchy's desktop, with no screen daemon to type through Chromium, text goes as keystrokes and play and pause as the media key", async () => {
  const answers: string[] = [];
  let stream: ServerResponse | null = null;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": agentv remote\n\n");
      stream = response;
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    answers.push(body);
    response.writeHead(200).end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const sent: Record<string, unknown>[] = [];
  const input = new RemoteInput({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/remote`, as: "desktop", send: async (request) => void sent.push(request), log: () => {} });
  input.start();
  while (!stream) await sleep(10);
  const say = (event: object) => (stream as ServerResponse).write(`data: ${JSON.stringify(event)}\n\n`);
  say({ ask: { n: 1, kind: "text", value: "hé", caret: 2, bar: null } });
  say({ ask: { n: 2, kind: "done" } });
  say({ ask: { n: 3, kind: "playback", action: "toggle" } });
  while (answers.length < 3) await sleep(10);
  assert.deepEqual(sent, [{ text: "h" }, { key: "enter" }, { key: "playpause" }]);
  assert.deepEqual(JSON.parse(answers[0]), { ok: false, by: "key", value: "h", why: "This app can't take é" });
  input.stop();
  (stream as ServerResponse).destroy();
  server.close();
});
