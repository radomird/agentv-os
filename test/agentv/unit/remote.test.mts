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
import { RemoteInput, sendInput } from "../../../daemon/remote.ts";

const dir = mkdtempSync(join(tmpdir(), "agentv-remote-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The daemon's stream, which the test writes to.
async function daemon(port = 0) {
  const streams = new Set<ServerResponse>();
  const headers: string[] = [];
  const server = http((request, response) => {
    headers.push(String(request.headers["x-agentv-screen"]));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(": agentv remote\n\n");
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
