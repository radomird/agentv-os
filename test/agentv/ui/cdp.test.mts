// The screen daemon's bridge to home (daemon/cdp.ts bind) in a real Chromium,
// over a DevTools pipe. Home's page reloads as setup is marked done, from the
// welcome page to the launcher, and the launcher still has to reach the
// screen daemon after it: a key on the ambient screen, an app to open.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { after, before, test } from "node:test";
import { CdpPipe } from "../../../daemon/cdp.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let page = "";
let server: Server;
let browser: ChildProcess;
let cdp: CdpPipe;

before(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>home</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  page = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = spawn(
    process.env.AGENTV_UI_BROWSER!,
    ["--headless=new", "--no-sandbox", "--remote-debugging-pipe", "--no-first-run", `--user-data-dir=${mkdtempSync(join(tmpdir(), "agentv-cdp-"))}`, "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  cdp = new CdpPipe(browser.stdio[3] as Writable, browser.stdio[4] as Readable);
});

after(() => {
  browser?.kill();
  server?.close();
});

test("S2.17 home can still ask the screen daemon after its page reloads", async () => {
  await cdp.open(page);
  const asked: string[] = [];
  await cdp.bind(page, "agentvScreen", async (request) => {
    asked.push(request.cmd);
    return { ok: true };
  });
  // What the launcher does: a request, and the answer through the reply.
  const ask = (cmd: string) =>
    cdp.evaluate(
      page,
      `new Promise((resolve) => {
        window.agentvScreenReply = (id, reply) => resolve(JSON.parse(reply).ok);
        window.agentvScreen(JSON.stringify({ cmd: ${JSON.stringify(cmd)}, id: 1 }));
      })`,
    );
  assert.equal(await ask("running"), true);

  await cdp.evaluate(page, "setTimeout(() => location.reload(), 0), true");
  let bound = "";
  for (let tries = 0; tries < 50 && bound !== "function"; tries++) {
    await sleep(100);
    bound = await cdp.evaluate(page, "document.readyState === 'complete' ? typeof window.agentvScreen : ''").catch(() => "");
    if (bound === "undefined") break;
  }
  assert.equal(bound, "function", "the reloaded page has the binding");
  assert.equal(await ask("wake"), true);
  assert.deepEqual(asked, ["running", "wake"]);
});
