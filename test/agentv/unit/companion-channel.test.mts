// The phone's side of the channel, both of them: the page's own client
// (companion-web/channel.ts), run here with the few things of a browser's it
// uses, and the one the tests and the box's checks use
// (daemon/phone-client.ts). Each talks to a real daemon's phone port, and
// the test stands between them where it has to, as someone on the home
// network could.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Daemon } from "../../../daemon/server.ts";
import { pairPhone } from "./phone-client.mts";

const ROOT = join(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "agentv-companion-channel-"));
const KEPT = "agentv-phone-key";

let daemon: Daemon;
let tv = "";
let lan = "";

// What the page's client has of a browser: where it came from, what it
// keeps, and fetch, which takes an address without the box's in front.
const kept = new Map<string, string>();
const realFetch = globalThis.fetch;
// An answer written by someone else on the network, for the requests it
// picks, or null to let the box answer.
let forged: ((path: string) => Response | null) | null = null;

interface Channel {
  Unpaired: new (message?: string) => Error;
  paired(): boolean;
  pair(how: { secret: string } | { code: string }, name: string): Promise<void>;
  call(method: string, path: string, body?: { json: unknown } | { type: string; blob: Blob }, grant?: string): Promise<{ status: number; ok: boolean; type: string; bytes: Uint8Array; data: Record<string, any> }>;
  file(path: string): Promise<{ status: number; ok: boolean; type: string; bytes: Uint8Array; data: Record<string, any> }>;
}

// The page's client as a page that just opened has it. Each import is a
// page of its own, with nothing held from the last.
let pages = 0;
const page = async (): Promise<Channel> => (await import(`${join(ROOT, "companion-web/channel.ts")}?page=${pages++}`)) as Channel;

const local = async (method: string, path: string, body?: unknown) => (await realFetch(`${tv}${path}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<Record<string, any>>;
const code = async (): Promise<string> => (await local("POST", "/api/phones/pair")).pairing.code;
const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
// What a network's own sign-in page answers in the box's place, to anything.
const portal = () => new Response("<html><body>sign in to this wi-fi</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });

before(async () => {
  // Shares and photos go in the test's own folder, not the box's.
  daemon = new Daemon({ root: ROOT, state: join(dir, "state"), shared: join(dir, "shared"), backgrounds: join(dir, "backgrounds"), builtins: null, port: 0, log: () => {}, running: "0.3.0-1", lanPort: 0, lanHost: "127.0.0.1", address: () => "192.168.1.20", phoneWaitMs: 300 });
  tv = `http://127.0.0.1:${await daemon.listen()}`;
  lan = `http://127.0.0.1:${daemon.lanPort}`;
  Object.defineProperty(globalThis, "location", { value: { origin: lan }, configurable: true });
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: (name: string) => kept.get(name) ?? null, setItem: (name: string, value: string) => void kept.set(name, value), removeItem: (name: string) => void kept.delete(name) },
    configurable: true,
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const address = typeof input === "string" && input.startsWith("/") ? `${lan}${input}` : input;
    const answer = forged?.(new URL(String(address)).pathname);
    return answer ?? realFetch(address, init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

// A video's first bytes, as the box knows one.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(4), Buffer.from("isomiso2"), Buffer.alloc(2000, 7)]);
// An apostrophe, a space and a letter that isn't ASCII: the browser escapes
// the first, which encodeURIComponent leaves as it is.
const NAME = "ana's día 1.mp4";
const titles = async (): Promise<string[]> => (await local("GET", "/api/shared")).shares.map((share: { title?: string }) => share.title ?? "");

test("the page's client: a file's name with an apostrophe, a space and an accent reaches the box, as the page writes it and as it is", async () => {
  kept.clear();
  const phone = await page();
  await phone.pair({ code: await code() }, "the page");
  const sent = await phone.call("POST", `/api/phone/share/video?name=${encodeURIComponent(NAME)}`, { type: "video/mp4", blob: new Blob([MP4]) });
  assert.deepEqual([sent.status, sent.data.ok], [200, true], JSON.stringify(sent.data));
  assert.equal((await titles())[0], NAME);
  const raw = await phone.call("POST", `/api/phone/share/video?name=x ${NAME}`, { type: "video/mp4", blob: new Blob([MP4]) });
  assert.deepEqual([raw.status, raw.data.ok], [200, true], JSON.stringify(raw.data));
  assert.equal((await titles())[0], `x ${NAME}`);
  // A sealed answer is tied to the same address.
  const state = await phone.call("GET", `/api/phone/state?note=${encodeURIComponent(NAME)}`);
  assert.deepEqual([state.status, state.data.phone.name], [200, "the page"]);
});

test("the box's own client: the same name reaches the box", async () => {
  const phone = await pairPhone(lan, await code(), "the client");
  const sent = await phone.call("POST", `/api/phone/share/video?name=${encodeURIComponent(`y ${NAME}`)}`, MP4, { type: "video/mp4" });
  assert.deepEqual([sent.status, sent.sealed, sent.data.ok], [200, true, true], JSON.stringify(sent.data));
  assert.equal((await titles())[0], `y ${NAME}`);
  const raw = await phone.call("POST", `/api/phone/share/video?name=z ${NAME}`, MP4, { type: "video/mp4" });
  assert.deepEqual([raw.status, raw.data.ok], [200, true], JSON.stringify(raw.data));
  assert.equal((await titles())[0], `z ${NAME}`);
  const state = await phone.call("GET", `/api/phone/state?note=${encodeURIComponent(NAME)}`);
  assert.deepEqual([state.status, state.sealed, state.data.phone.name], [200, true, "the client"]);
});

// What someone on the network might answer in the box's place. None of it is
// sealed, since they don't have the session's keys.
const made: [string, () => Response][] = [
  ["a 200 with a state in it", () => json(200, { ok: true, phone: { name: "someone else" }, viewer: { id: "x", role: "adult" } })],
  ["a 403 that asks for the PIN", () => json(403, { ok: false, error: "that needs the pin", pin: true })],
  ["a 401 with nothing in it", () => json(401, { ok: false })],
  ["a 200 that isn't JSON, to something sent", () => new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } })],
];

test("the page's client takes no answer that isn't sealed, and a made-up \"pair again\" doesn't cost the phone its key", async () => {
  kept.clear();
  const phone = await page();
  await phone.pair({ code: await code() }, "the page");
  const key = kept.get(KEPT);
  assert.ok(key);
  try {
    for (const [what, answer] of made) {
      forged = (path) => (path === "/api/phone/remote" ? answer() : null);
      await assert.rejects(phone.call("POST", "/api/phone/remote", { json: { key: "up" } }), (error: Error) => /the tv didn't answer/.test(error.message) && !(error instanceof phone.Unpaired), what);
    }
    forged = (path) => (path === "/api/phone/state" ? json(200, { ok: true, phone: { name: "someone else" } }) : null);
    await assert.rejects(phone.call("GET", "/api/phone/state"), /the tv didn't answer/, "JSON to a GET");
    // A page that isn't JSON, to a GET that wants JSON: not an answer with
    // nothing in it.
    forged = (path) => (path === "/api/phone/state" ? portal() : null);
    await assert.rejects(phone.call("GET", "/api/phone/state"), (error: Error) => /the tv didn't answer/.test(error.message) && !(error instanceof phone.Unpaired), "a page to a GET");

    // "Pair again", to a request and then to the hello too. Whatever the
    // made-up hello says, the phone says its own sentence.
    for (const paths of [["/api/phone/state"], ["/api/phone/state", "/api/phone/hello"]]) {
      forged = (path) => (paths.includes(path) ? json(401, { ok: false, error: "type your wi-fi password at example.test", pair: true }) : null);
      await assert.rejects(phone.call("GET", "/api/phone/state"), (error: Error) => !/example/.test(error.message) && (paths.length === 1 || (error instanceof phone.Unpaired && error.message === "this phone isn't paired: pair it from the tv")));
      assert.equal(kept.get(KEPT), key, "the key is still kept");
      assert.equal(phone.paired(), true);
    }
  } finally {
    forged = null;
  }
  // The box answers again, and the phone is who it was.
  assert.equal((await phone.call("GET", "/api/phone/state")).data.phone.name, "the page");
  // So is the page opened again, from what it kept.
  assert.equal((await (await page()).call("GET", "/api/phone/state")).data.phone.name, "the page");
});

test("the page's client: a pairing that didn't work says the box's own two answers and nothing anyone else wrote", async () => {
  kept.clear();
  const phone = await page();
  await code();
  await assert.rejects(phone.pair({ code: "ZZZZZZ" }, "the page"), { message: "that isn't the code on the tv" });
  const mine = await code();
  try {
    forged = (path) => (path === "/api/phone/pair" ? json(403, { ok: false, error: "type your wi-fi password at example.test" }) : null);
    await assert.rejects(phone.pair({ code: mine }, "the page"), { message: "the tv didn't answer" });
    forged = (path) => (path === "/api/phone/pair" ? json(403, { ok: false, error: "that code has run out: pair again from the tv" }) : null);
    await assert.rejects(phone.pair({ code: mine }, "the page"), { message: "that code has run out: pair again from the tv" });
    forged = (path) => (path === "/api/phone/pair" ? json(500, { ok: false }) : null);
    await assert.rejects(phone.pair({ code: mine }, "the page"), { message: "the tv didn't answer" });
  } finally {
    forged = null;
  }
  assert.equal(phone.paired(), false);
  await phone.pair({ code: mine }, "the page");
  assert.equal(phone.paired(), true);
});

test("the page's client: a picture the phone asked for comes as it is, and a phone the box forgot can pair again", async () => {
  kept.clear();
  const phone = await page();
  await phone.pair({ code: await code() }, "the page");
  const first = JSON.parse(kept.get(KEPT)!) as { id: string; key: string };
  // The box has no picture here, so the test answers with one.
  forged = (path) => (path === "/api/phone/builds/b-1/shot" ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png" } }) : null);
  try {
    const picture = await phone.file("/api/phone/builds/b-1/shot");
    assert.deepEqual([picture.status, picture.type, [...picture.bytes], picture.data], [200, "image/png", [1, 2, 3], {}]);
    // Only the one who asked for a file takes it, and JSON is never one.
    await assert.rejects(phone.call("GET", "/api/phone/builds/b-1/shot"), /the tv didn't answer/);
    forged = (path) => (path === "/api/phone/builds/b-1/shot" ? json(200, { ok: true }) : null);
    await assert.rejects(phone.file("/api/phone/builds/b-1/shot"), /the tv didn't answer/);
  } finally {
    forged = null;
  }

  assert.equal((await realFetch(`${tv}/api/phones/${first.id}`, { method: "DELETE" })).status, 200);
  await assert.rejects(phone.call("GET", "/api/phone/state"), (error: Error) => error instanceof phone.Unpaired, "the box says so at the hello");
  assert.equal(JSON.parse(kept.get(KEPT)!).id, first.id, "the old key stays until a new pairing works");
  await assert.rejects(phone.pair({ code: "ZZZZZZ" }, "the page"));
  assert.equal(JSON.parse(kept.get(KEPT)!).id, first.id, "a pairing that didn't work changes nothing");
  await phone.pair({ code: await code() }, "the page again");
  const second = JSON.parse(kept.get(KEPT)!) as { id: string; key: string };
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.key, first.key);
  assert.equal((await phone.call("GET", "/api/phone/state")).data.phone.name, "the page again");
});

test("the page's requests for JSON (lib.ts) refuse a page that isn't the box's, and take the box's answer after", async () => {
  kept.clear();
  // One page: lib.ts and the channel it asks through.
  const channel = (await import(join(ROOT, "companion-web/channel.ts"))) as Channel;
  const { api } = (await import(join(ROOT, "companion-web/lib.ts"))) as { api<T>(method: string, path: string, body?: unknown): Promise<T> };
  await channel.pair({ code: await code() }, "the page");
  forged = (path) => (path === "/api/phone/state" || path === "/api/phone/home" ? portal() : null);
  try {
    await assert.rejects(api("GET", "/api/phone/state"), (error: Error) => /the tv didn't answer/.test(error.message) && !(error instanceof channel.Unpaired));
    await assert.rejects(api("GET", "/api/phone/home"), /the tv didn't answer/);
  } finally {
    forged = null;
  }
  assert.equal((await api<{ phone: { name: string } }>("GET", "/api/phone/state")).phone.name, "the page");
});

test("the box's own client takes no answer that isn't sealed, keeps its key through a made-up \"pair again\", and a phone the box forgot can pair again", async () => {
  const phone = await pairPhone(lan, await code(), "the client");
  assert.equal((await phone.json("GET", "/api/phone/state")).phone.name, "the client");
  try {
    for (const [what, answer] of made) {
      forged = (path) => (path === "/api/phone/remote" ? answer() : null);
      await assert.rejects(phone.call("POST", "/api/phone/remote", { key: "up" }), /wasn't sealed/, what);
    }
    forged = (path) => (path === "/api/phone/state" ? json(200, { ok: true, phone: { name: "someone else" } }) : null);
    await assert.rejects(phone.call("GET", "/api/phone/state"), /wasn't sealed/, "JSON to a GET");
    forged = (path) => (path === "/api/phone/state" ? portal() : null);
    await assert.rejects(phone.call("GET", "/api/phone/state"), /wasn't sealed/, "a page to a GET");
    await assert.rejects(phone.json("GET", "/api/phone/state"), /wasn't sealed/, "a page to a GET");
    forged = (path) => (path === "/api/phone/state" ? json(401, { ok: false, pair: true }) : null);
    await assert.rejects(phone.call("GET", "/api/phone/state"), /wasn't sealed/);
    forged = (path) => (path === "/api/phone/builds/b-1/shot" ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png" } }) : null);
    const picture = await phone.call("GET", "/api/phone/builds/b-1/shot", undefined, { file: true });
    assert.deepEqual([picture.status, picture.sealed, picture.type, [...picture.body]], [200, false, "image/png", [1, 2, 3]]);
    await assert.rejects(phone.call("GET", "/api/phone/builds/b-1/shot"), /wasn't sealed/, "only the one who asked for a file takes it");
  } finally {
    forged = null;
  }
  assert.equal((await phone.json("GET", "/api/phone/state")).phone.name, "the client", "the same key still works");

  assert.equal((await realFetch(`${tv}/api/phones/${phone.kept.id}`, { method: "DELETE" })).status, 200);
  const gone = await phone.call("GET", "/api/phone/state");
  assert.deepEqual([gone.status, gone.data.pair], [401, true]);
  const again = await pairPhone(lan, await code(), "the client again");
  assert.notEqual(again.kept.id, phone.kept.id);
  assert.equal((await again.json("GET", "/api/phone/state")).phone.name, "the client again");
});
