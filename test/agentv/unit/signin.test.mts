// Signing in on the TV (ADR-032, board 15) and logos on every tile: the
// screen daemon's sign-in watch (daemon/signin.ts) asking an app whether
// it's signed in, the daemon keeping what it said for the app's tile, and a
// site's own icon fetched on the box for an app with none (daemon/site-icon.ts).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AppHost, PageBroker, Viewer } from "../../../daemon/apps/loader.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { SignInWatch, type SignInDeps } from "../../../daemon/signin.ts";
import { iconLinks, siteIcon } from "../../../daemon/site-icon.ts";
import { FIXTURES, startBox } from "../ui/box.mts";

const viewer: Viewer = { id: "radomir", role: "adult" };
const page = { url: async () => "https://tube.example/", call: async () => null } as PageBroker;

// A stand-in for an app's worker: answers isSignedIn from signedIn(), and
// signIn.open from open().
function fakeHost(app: { signedIn: () => boolean | Error; open?: () => void | Error }) {
  const calls: string[] = [];
  let stopped = 0;
  const host = {
    setPage() {},
    async call(_viewer: Viewer, path: string) {
      calls.push(path);
      const answer = path === "signIn.open" ? (app.open ? app.open() : new Error("the app has no signIn.open")) : app.signedIn();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    stop() {
      stopped++;
    },
  } as unknown as AppHost;
  return { host, calls, stopped: () => stopped };
}

function watch(host: AppHost | null, extra: Partial<SignInDeps> = {}) {
  const reports: [string, boolean][] = [];
  const deps: SignInDeps = {
    host: async () => host,
    viewer: async () => viewer,
    report: async (app, signedIn) => void reports.push([app, signedIn]),
    every: 20,
    retry: 10,
    settle: 0,
    pageWithin: 200,
    ...extra,
  };
  return { watch: new SignInWatch(deps), reports };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("as an app opens, it's asked once whether it's signed in, while its page comes up, and its tile is told", async () => {
  let ready = false;
  const app = fakeHost({ signedIn: () => (ready ? false : new Error("the page isn't there yet")) });
  const { watch: w, reports } = watch(app.host);
  setTimeout(() => (ready = true), 30);
  assert.equal(await w.check("agentv.tube", page), false);
  assert.deepEqual(reports, [["agentv.tube", false]]);
  assert.equal(app.stopped(), 1, "its worker goes after");
  // An app with no signIn says nothing.
  assert.equal(await watch(null).watch.check("agentv.tube", page), null);
});

test("the sign-in screen has the app show its form, then asks every 2 s until it's signed in, and says so once", async () => {
  let signedIn = false;
  let tries = 0;
  const app = fakeHost({ signedIn: () => signedIn, open: () => (++tries < 3 ? new Error("the page isn't there yet") : undefined) });
  const { watch: w, reports } = watch(app.host);
  const done: boolean[] = [];
  assert.equal(await w.start("agentv.tube", page, (ok) => done.push(ok)), true);
  await sleep(120);
  assert.equal(tries, 3, "signIn.open is tried until the page is up");
  assert.ok(app.calls.filter((c) => c === "signIn.isSignedIn").length >= 2);
  assert.deepEqual(reports, [], "not signed in yet isn't news while the screen is up");
  assert.deepEqual(w.signingIn(), ["agentv.tube"]);
  signedIn = true;
  await sleep(60);
  assert.deepEqual(done, [true]);
  assert.deepEqual(reports, [["agentv.tube", true]]);
  assert.deepEqual(w.signingIn(), []);
  assert.equal(app.stopped(), 1);
});

test("an app without signIn.open stays where it opened; i'm signed in asks now; Home stops it; and it gives up in the end", async () => {
  let signedIn = false;
  const app = fakeHost({ signedIn: () => signedIn });
  const { watch: w } = watch(app.host, { every: 1000 });
  const done: boolean[] = [];
  await w.start("agentv.tube", page, (ok) => done.push(ok));
  assert.equal(await w.now("agentv.tube"), false);
  signedIn = true;
  assert.equal(await w.now("agentv.tube"), true);
  assert.deepEqual(done, [true]);
  assert.ok(!app.calls.includes("signIn.open") || app.calls.indexOf("signIn.open") === 0);
  assert.equal(await w.now("agentv.tube"), null, "nothing is signing in now");

  const stopped = fakeHost({ signedIn: () => false });
  const second = watch(stopped.host);
  const ended: boolean[] = [];
  await second.watch.start("agentv.tube", page, (ok) => ended.push(ok));
  second.watch.stop("agentv.tube");
  await sleep(60);
  assert.deepEqual(ended, [], "Home isn't a sign-in, and isn't a giving up either");
  assert.equal(stopped.stopped(), 1);

  const slow = watch(fakeHost({ signedIn: () => false }).host, { within: 50 });
  const gave: boolean[] = [];
  await slow.watch.start("agentv.tube", page, (ok) => gave.push(ok));
  await sleep(150);
  assert.deepEqual(gave, [false]);
});

// --- Site icons -----------------------------------------------------------------

test("a page's icons, best first: its apple-touch-icon, then the largest", () => {
  const html = `<html><head>
    <link rel="icon" href="/favicon-16.png" sizes="16x16">
    <link rel="stylesheet" href="/site.css">
    <link href="https://cdn.example/icon-192.png" rel="icon" sizes="192x192" type="image/png">
    <link rel='apple-touch-icon' href='touch.png'>
    <link rel="mask-icon" href="/mask.svg">
    <link rel="icon" href="javascript:alert(1)">
  </head></html>`;
  assert.deepEqual(iconLinks(html, "https://tube.example/watch/"), [
    "https://tube.example/watch/touch.png",
    "https://cdn.example/icon-192.png",
    "https://tube.example/favicon-16.png",
  ]);
});

let server: Server;
let base = "";
const served: string[] = [];
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

before(async () => {
  server = createServer((request, response) => {
    served.push(`${request.url} ${request.headers["user-agent"]}`);
    if (request.url === "/" || request.url === "/web/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<link rel="apple-touch-icon" href="/missing.png"><link rel="icon" href="/notes.txt" sizes="128x128"><link rel="icon" href="/logo.png" sizes="64x64">');
    } else if (request.url === "/logo.png") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(PNG);
    } else if (request.url === "/notes.txt") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("not an image");
    } else if (request.url === "/plain/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<p>no icons named</p>");
    } else if (request.url === "/favicon.ico") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(Buffer.from([0, 0, 1, 0]));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server?.close());

test("a site's icon: the best one its page names that's an image, else its favicon.ico, asked for as AgenTV", async () => {
  const icon = await siteIcon(`${base}/`, { userAgent: "AgenTV/0.1 local.notes" });
  assert.deepEqual([icon?.type, icon?.body.equals(PNG)], ["image/png", true]);
  assert.ok(served.includes("/missing.png AgenTV/0.1 local.notes"), "the best first, which isn't there");
  assert.ok(served.includes("/notes.txt AgenTV/0.1 local.notes"), "then one that isn't an image");
  const ico = await siteIcon(`${base}/plain/`, { userAgent: "AgenTV/0.1 local.notes" });
  assert.equal(ico?.type, "image/x-icon");
  assert.equal(await siteIcon("http://127.0.0.1:1/", { userAgent: "AgenTV" }), null);
});

// --- The daemon -------------------------------------------------------------------

let daemon: Daemon;
let url = "";
let state = "";
const events: string[] = [];
const listening = new AbortController();

after(async () => {
  listening.abort();
  await daemon?.close();
});

test("the daemon keeps what each app said, a tile says Sign in until its app is signed in, and home is told", async () => {
  ({ daemon, url, state } = await startBox(0, [
    ...FIXTURES,
    // A web app with a sign-in step that hasn't been asked yet, and no icon
    // of its own: its site's comes.
    {
      id: "local.notes",
      name: "Notes",
      tier: "local",
      category: "streaming",
      edit: (m) => {
        m.tv.homeUrl = `${base}/web/`;
        m.tv.origins = [base];
        m.tv.setup = [{ type: "signIn" }];
        m.tv.capabilities = ["launch", "signIn"];
        delete m.tv.icon;
        delete m.tv.tiles;
      },
    },
  ]));
  void fetch(`${url}/api/events`, { signal: listening.signal })
    .then(async (response) => {
      const reader = response.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        for (const match of new TextDecoder().decode(value).matchAll(/^event: (\w+)$/gm)) events.push(match[1]);
      }
    })
    .catch(() => {});
  await sleep(50);
  const get = async (path: string) => (await fetch(`${url}${path}`)).json();
  const post = (id: string, body: unknown) => fetch(`${url}/api/apps/${id}/signed-in`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const signIns = async () => Object.fromEntries((await get("/api/home")).apps.map((app: { id: string; signIn?: string }) => [app.id, app.signIn ?? "-"]));

  assert.deepEqual(await signIns(), { "agentv.sample": "-", "agentv.tube": "-", "someone.radio": "-", "local.mytv": "-", "agentv.games": "-", "local.notes": "needed" });
  const before = events.filter((event) => event === "apps").length;
  assert.equal((await post("local.notes", { signedIn: true })).status, 200);
  assert.equal((await signIns())["local.notes"], "-");
  assert.equal((await post("agentv.sample", { signedIn: false })).status, 200);
  assert.equal((await signIns())["agentv.sample"], "needed", "signed out since");
  assert.equal(JSON.parse(readFileSync(join(state, "signins.json"), "utf8"))["agentv.sample"].signedIn, false);
  await sleep(50);
  assert.ok(events.filter((event) => event === "apps").length >= before + 2, "home hears of each change");
  // Saying the same again changes nothing.
  assert.equal((await post("agentv.sample", { signedIn: false })).status, 200);
  // Only an app here with signIn, and only true or false.
  assert.equal((await post("agentv.tube", { signedIn: true })).status, 404);
  assert.equal((await post("agentv.nothing", { signedIn: true })).status, 404);
  assert.equal((await post("local.notes", { signedIn: "yes" })).status, 400);
  // The screen daemon gets the name for the sign-in bar with the address.
  assert.deepEqual(await get("/api/apps/local.notes/launch"), { ok: true, runtime: "web", url: `${base}/web/`, name: "Notes" });
});

test("an app with no icon of its own gets its site's, kept on the box", async () => {
  const notes = async () => (await (await fetch(`${url}/api/home`)).json()).apps.find((app: { id: string }) => app.id === "local.notes");
  let found = await notes();
  for (let i = 0; i < 50 && !found.icon; i++) {
    await sleep(100);
    found = await notes();
  }
  assert.equal(found.icon, "/api/apps/local.notes/icon");
  const icon = await fetch(`${url}${found.icon}`);
  assert.equal(icon.headers.get("content-type"), "image/png");
  assert.ok(Buffer.from(await icon.arrayBuffer()).equals(PNG));
  assert.match(icon.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(JSON.parse(readFileSync(join(state, "icons", "local.notes.json"), "utf8")).type, "image/png");
  assert.ok(served.some((line) => line.startsWith("/web/ AgenTV")), "asked for as AgenTV");
  // An app with an icon of its own keeps it.
  const sample = (await (await fetch(`${url}/api/home`)).json()).apps.find((app: { id: string }) => app.id === "agentv.sample");
  assert.equal((await fetch(`${url}${sample.icon}`)).headers.get("content-type"), "image/svg+xml");
});
