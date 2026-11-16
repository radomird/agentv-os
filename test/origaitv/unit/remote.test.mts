// The phone's keys and text on the TV (daemon/remote.ts): the screen daemon
// holds the daemon's stream open, hands each one to the virtual input
// device in order, comes back after the daemon restarts, and never logs
// what was typed.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as http, type ServerResponse } from "node:http";
import { createServer as net } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { RemoteInput, sendInput, wheelTurn } from "../../../daemon/remote.ts";

const dir = mkdtempSync(join(tmpdir(), "origaitv-remote-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The daemon's stream, which the test writes to.
async function daemon(port = 0) {
  const streams = new Set<ServerResponse>();
  const headers: string[] = [];
  const server = http((request, response) => {
    headers.push(String(request.headers["x-origaitv-screen"]));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(": origaitv remote\n\n");
    streams.add(response);
    request.on("close", () => streams.delete(response));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/api/remote`,
    port: address.port,
    headers,
    connected: () => streams.size,
    say: (event: object) => {
      for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of streams) stream.destroy();
        server.close(() => resolve());
      }),
  };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("it didn't happen in time");
    await sleep(10);
  }
}

test("each key and text from the phone goes to the virtual input device, in order", async () => {
  const fake = await daemon();
  const sent: unknown[] = [];
  const lines: string[] = [];
  const remote = new RemoteInput({
    url: fake.url,
    send: async (request) => {
      // A slow one first, so the order is the stream's and not the speed's.
      if ((request as { key?: string }).key === "down") await sleep(50);
      sent.push(request);
    },
    log: (line) => lines.push(line),
    retryMs: 20,
  });
  remote.start();
  await until(() => fake.connected() === 1);
  assert.deepEqual(fake.headers, ["1"], "it says it's the screen daemon");
  fake.say({ key: "down" });
  fake.say({ text: "hunter2" });
  fake.say({ key: "enter" });
  await until(() => sent.length === 3);
  assert.deepEqual(sent, [{ key: "down" }, { text: "hunter2" }, { key: "enter" }]);

  // The daemon restarts, as after an update: it connects again.
  const port = fake.port;
  await fake.close();
  await sleep(50);
  const back = await daemon(port);
  await until(() => back.connected() === 1);
  back.say({ key: "up" });
  await until(() => sent.length === 4);
  assert.ok(lines.length >= 1, "it said it lost the daemon");
  remote.stop();
  await back.close();
});

test("a command from the daemon, such as Install now from a phone, goes to the TV session, not the input device", async () => {
  const fake = await daemon();
  const sent: unknown[] = [];
  const commands: string[] = [];
  const remote = new RemoteInput({ url: fake.url, send: async (request) => void sent.push(request), command: async (cmd) => void commands.push(cmd), retryMs: 20 });
  remote.start();
  await until(() => fake.connected() === 1);
  fake.say({ cmd: "update-install" });
  fake.say({ key: "up" });
  await until(() => sent.length === 1 && commands.length === 1);
  assert.deepEqual(commands, ["update-install"]);
  assert.deepEqual(sent, [{ key: "up" }]);
  remote.stop();
  await fake.close();
});

test("T21.1 two fingers' scroll goes to the screen daemon's wheel, from the page or the pointer, in order with the keys; without one it's the input device's wheel", async () => {
  const fake = await daemon();
  const sent: unknown[] = [];
  const wheels: unknown[] = [];
  const remote = new RemoteInput({ url: fake.url, send: async (request) => void sent.push(request), wheel: async (dx, dy, at) => void wheels.push([dx, dy, at]), retryMs: 20 });
  remote.start();
  await until(() => fake.connected() === 1);
  fake.say({ wheel: [0, 240] });
  fake.say({ wheel: [-90, 0], at: "pointer" });
  fake.say({ key: "down" });
  await until(() => wheels.length === 2 && sent.length === 1);
  assert.deepEqual(wheels, [
    [0, 240, "page"],
    [-90, 0, "pointer"],
  ]);
  remote.stop();
  await fake.close();

  // On Omarchy's desktop, which has no screen daemon's wheel: the input
  // device's, in 120ths of a notch, right and up.
  const desk = await daemon();
  const keys: unknown[] = [];
  const relay = new RemoteInput({ url: desk.url, as: "desktop", send: async (request) => void keys.push(request), retryMs: 20 });
  relay.start();
  await until(() => desk.connected() === 1);
  desk.say({ wheel: [0, 53] });
  desk.say({ wheel: [-106, 0] });
  desk.say({ wheel: [0, 0.1] });
  desk.say({ key: "up" });
  await until(() => keys.length === 3);
  assert.deepEqual(keys, [{ wheel: [0, -120] }, { wheel: [-240, 0] }, { key: "up" }], "a page's 53 pixels down is a notch down, and a turn too small sends nothing");
  relay.stop();
  await desk.close();
  assert.equal(wheelTurn(0, 0), null);
});

test("ADR-037 on Omarchy's desktop it says it's the desktop's relay, and the trackpad's moves and clicks go to the input device", async () => {
  const fake = await daemon();
  const sent: unknown[] = [];
  const remote = new RemoteInput({ url: fake.url, as: "desktop", send: async (request) => void sent.push(request), retryMs: 20 });
  remote.start();
  await until(() => fake.connected() === 1);
  assert.deepEqual(fake.headers, ["desktop"]);
  fake.say({ move: [12, -7] });
  fake.say({ click: "left" });
  await until(() => sent.length === 2);
  assert.deepEqual(sent, [{ move: [12, -7] }, { click: "left" }]);
  remote.stop();
  await fake.close();
});

test("a key the virtual input device refuses is logged, and typed text never is", async () => {
  const fake = await daemon();
  const lines: string[] = [];
  const remote = new RemoteInput({
    url: fake.url,
    send: async () => {
      throw new Error("the virtual input device isn't there (ENOENT)");
    },
    log: (line) => lines.push(line),
    retryMs: 20,
  });
  remote.start();
  await until(() => fake.connected() === 1);
  fake.say({ text: "my password" });
  await sleep(50);
  await remote.idle();
  assert.deepEqual(lines, ["phone input: the virtual input device isn't there (ENOENT)"]);
  remote.stop();
  await fake.close();
});

test("sendInput writes one JSON line to input.py's socket and takes its answer", async () => {
  const socket = join(dir, "input.sock");
  const got: string[] = [];
  const server = net((connection) => {
    connection.setEncoding("utf8");
    connection.on("data", (line: string) => {
      got.push(line);
      connection.write(line.includes("nope") ? "no such key\n" : "ok\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  await sendInput({ key: "up" }, socket);
  await assert.rejects(sendInput({ key: "nope" }, socket), /no such key/);
  assert.deepEqual(got, ['{"key":"up"}\n', '{"key":"nope"}\n']);
  await assert.rejects(sendInput({ key: "up" }, join(dir, "gone.sock")), /the virtual input device isn't there/);
  server.close();
});
