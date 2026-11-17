// Game mode's two connections (ADR-113), behind the `phonepad` switch:
// - GET /api/phone/pad, on the phone's port: a paired phone opens game
//   mode. It's a signed request like any other, asking for a WebSocket.
//   The TV makes the phone a controller, answers 101, and from then on
//   takes the controller's state as sealed messages (daemon/pad-wire.ts,
//   docs/phone-api.md);
// - GET /api/pads, on the TV's own port: the input helper (daemon/input.py)
//   holds this one open, and makes the controllers the daemon asks for.
//   Like the stream of the phone's keys, it needs the screen's header,
//   which no page can send.
//
// Node hands a request that asks to change protocol to a listener of its
// own, and only when there is one. So the listeners are only there while
// the switch is on: with it off, both addresses are answered by the
// daemon's ordinary routes, as any address that isn't there. With it on, a
// request that asks for some other change of protocol is still answered
// by those routes, the way it was.

import { type IncomingMessage, type Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { acceptKey, CLOSED, closeFrame, frame, Frames, OP } from "../pad-wire.ts";
import type { Pad, PadLink, Pads, PadWire } from "../pads.ts";
import type { Stream } from "../phone-channel.ts";

export const PAD_PATH = "/api/phone/pad";
export const PADS_PATH = "/api/pads";
// What the helper asks to speak: a line of JSON each way.
export const PADS_PROTOCOL = "origaitv-pads";

// The most the TV holds for a phone that isn't reading, and for a helper
// that isn't.
const PHONE_HELD = 64 * 1024;
const LINK_HELD = 256 * 1024;
// How often the switch is read again. A change through the daemon is heard
// at once, but a box that goes from edge back to stable turns a switch off
// without one.
const FOLLOW_MS = 15_000;

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

// What these routes need of the daemon.
export interface PadRoutesKit<P extends { id: string; name: string }> {
  pads: Pads;
  // Whether the switch is on.
  on: () => Promise<boolean>;
  // Checks a phone's signed request. With null it has answered 401 itself.
  open: (request: IncomingMessage, response: ServerResponse) => Promise<{ phone: P; stream: () => Stream<P> } | null>;
  // The daemon's own answers on each port, for a request that isn't one of
  // these two.
  phone: Handler;
  local: Handler;
  // Whether a request on the TV's own port names this box.
  allowed: (request: IncomingMessage) => boolean;
  json: (response: ServerResponse, status: number, data: unknown) => void;
  log: (line: string) => void;
  // How often to read the switch again, for tests.
  followMs?: number;
}

const header = (request: IncomingMessage, name: string): string => {
  const value = request.headers[name];
  return typeof value === "string" ? value : "";
};

// Whether a request is a WebSocket's opening one, with nothing after it.
function asksWebSocket(request: IncomingMessage): boolean {
  return (
    request.method === "GET" &&
    header(request, "upgrade").toLowerCase() === "websocket" &&
    header(request, "sec-websocket-version") === "13" &&
    /^[A-Za-z0-9+/]{22}==$/.test(header(request, "sec-websocket-key")) &&
    !hasBody(request)
  );
}

function hasBody(request: IncomingMessage): boolean {
  const length = request.headers["content-length"];
  return request.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
}

export class PadRoutes<P extends { id: string; name: string }> {
  private kit: PadRoutesKit<P>;
  private listeners: { server: Server; listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void }[] = [];
  private listening = false;
  private following?: NodeJS.Timeout;
  // Every connection these routes hold, which the servers no longer count
  // as theirs.
  private sockets = new Set<Duplex>();

  constructor(kit: PadRoutesKit<P>) {
    this.kit = kit;
  }

  // The two servers these routes are on: the phone's, when there is one,
  // and the TV's own.
  watch(lan: Server | undefined, local: Server): void {
    const guard = (run: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>) => (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => {});
      run(request, socket, head).catch((error: Error) => {
        this.kit.log(`error: ${request.method} ${new URL(request.url ?? "/", "http://tv").pathname}: ${error.message}`);
        socket.destroy();
      });
    };
    if (lan) this.listeners.push({ server: lan, listener: guard((request, socket, head) => this.fromPhone(request, socket, head)) });
    this.listeners.push({ server: local, listener: guard((request, socket) => this.fromHelper(request, socket)) });
    this.following = setInterval(() => void this.kit.on().then((on) => this.switched(on), () => {}), this.kit.followMs ?? FOLLOW_MS);
    this.following.unref();
  }

  // The switch, as the daemon starts and each time it changes.
  switched(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    for (const { server, listener } of this.listeners) {
      if (on) server.on("upgrade", listener);
      else server.off("upgrade", listener);
    }
    if (!on) this.kit.pads.close("game mode was turned off");
  }

  // GET /api/phone/pad as a plain request, with the switch on: game mode is
  // a connection, so it says to ask for one. True when it answered.
  async plain(method: string | undefined, path: string, response: ServerResponse): Promise<boolean> {
    if (path !== PAD_PATH || !(await this.kit.on())) return false;
    this.kit.json(response, method === "GET" ? 426 : 405, { ok: false, error: "Game mode is a WebSocket. Ask for one." });
    return true;
  }

  close(): void {
    clearInterval(this.following);
    this.kit.pads.close();
    for (const socket of this.sockets) socket.destroy();
  }

  // An answer written to a connection Node handed over, for a request
  // that's answered as an ordinary one after all.
  private answerOn(request: IncomingMessage, socket: Duplex): ServerResponse {
    const response = new ServerResponse(request);
    response.assignSocket(socket as Socket);
    response.setHeader("Connection", "close");
    response.on("finish", () => {
      response.detachSocket(socket as Socket);
      socket.end();
      // Nobody keeps one of these open by not hanging up: the servers'
      // own time limits don't cover a connection they've handed over.
      setTimeout(() => socket.destroy(), 1000).unref();
    });
    return response;
  }

  // A request these routes don't take, answered by the daemon's own routes
  // as it was before they were here. One with a body can't be, since Node
  // has stopped reading it: nothing sends that, and it's refused.
  private async pass(request: IncomingMessage, socket: Duplex, handler: Handler): Promise<void> {
    if ((request.method !== "GET" && request.method !== "HEAD") || hasBody(request)) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    await handler(request, this.answerOn(request, socket));
  }

  private async fromPhone(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const { kit } = this;
    const path = new URL(request.url ?? "/", "http://phone").pathname;
    if (path !== PAD_PATH || !asksWebSocket(request) || !(await kit.on())) return this.pass(request, socket, kit.phone);

    const response = this.answerOn(request, socket);
    // The phone's page doesn't have game mode, and no other page may open
    // it: a browser names the page a WebSocket is opened from.
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${request.headers.host}`) {
      kit.json(response, 403, { ok: false, error: "not from the phone companion's page" });
      return;
    }
    const opened = await kit.open(request, response);
    if (!opened) return;
    const stream = opened.stream();

    // What goes to the phone waits until the 101 has gone.
    let waiting: Buffer[] | null = [];
    let ended = false;
    const write = (bytes: Buffer) => {
      if (waiting) waiting.push(bytes);
      else if (socket.writable) socket.write(bytes);
    };
    const wire: PadWire = {
      give: (plain) => {
        if (ended) return;
        write(frame(OP.binary, stream.give(plain)));
        if (socket.writableLength > PHONE_HELD) wire.end(CLOSED.refused, "the phone isn't reading");
      },
      end: (code, why) => {
        if (ended) return;
        ended = true;
        if (waiting) {
          socket.destroy();
          return;
        }
        if (socket.writable) socket.end(closeFrame(code, why));
        setTimeout(() => socket.destroy(), 1000).unref();
      },
    };

    const pad = await kit.pads.open(opened.phone, wire);
    if ("ok" in pad) {
      // Sealed like any other answer, and tied to its status.
      kit.json(response, pad.status, { ok: false, error: pad.error });
      return;
    }
    if (socket.destroyed || ended) {
      pad.gone();
      return;
    }

    response.detachSocket(socket as Socket);
    (socket as Socket).setNoDelay?.(true);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(header(request, "sec-websocket-key"))}\r\n\r\n`);
    for (const bytes of waiting) socket.write(bytes);
    waiting = null;
    this.take(socket, head, stream, pad, () => ended);
  }

  // The phone's frames, as they come, until the connection is over.
  private take(socket: Duplex, head: Buffer, stream: Stream<P>, pad: Pad, over: () => boolean): void {
    const frames = new Frames(true);
    const data = (chunk: Buffer) => {
      if (over()) return;
      for (const got of frames.push(chunk)) {
        if (over()) return;
        if ("broken" in got) {
          pad.gone(CLOSED.broken, got.broken);
          return;
        }
        if (got.opcode === OP.binary) {
          const message = stream.take(got.payload);
          if (message) pad.took(message.n, message.plain);
          else if (!stream.alive()) pad.gone(CLOSED.ended, "the session ended");
          else pad.bad();
        } else if (got.opcode === OP.text) {
          // Nothing here is text: it isn't sealed.
          pad.bad();
        } else if (got.opcode === OP.ping) {
          if (socket.writable) socket.write(frame(OP.pong, got.payload));
        } else if (got.opcode === OP.close) {
          pad.gone();
          return;
        }
      }
    };
    socket.on("data", data);
    // The server keeps a connection half open when the other end is done
    // with it. Here that's the phone gone.
    socket.on("end", () => pad.gone());
    socket.on("close", () => pad.gone());
    if (head.length) data(head);
  }

  private async fromHelper(request: IncomingMessage, socket: Duplex): Promise<void> {
    const { kit } = this;
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== PADS_PATH || header(request, "upgrade").toLowerCase() !== PADS_PROTOCOL || !(await kit.on())) return this.pass(request, socket, kit.local);
    if (request.method !== "GET" || hasBody(request) || !kit.allowed(request) || header(request, "x-origaitv-screen") !== "1") {
      kit.json(this.answerOn(request, socket), 403, { ok: false, error: "only the input helper makes controllers" });
      return;
    }
    (socket as Socket).setNoDelay?.(true);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${PADS_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`);
    const link: PadLink = {
      send: (line) => {
        if (!socket.writable) return;
        socket.write(`${JSON.stringify(line)}\n`);
        if (socket.writableLength > LINK_HELD) socket.destroy();
      },
      close: () => socket.destroy(),
    };
    const { line, closed } = kit.pads.attach(link);
    let held: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      held = held.length ? Buffer.concat([held, chunk]) : chunk;
      let end;
      while ((end = held.indexOf(0x0a)) >= 0) {
        const text = held.subarray(0, end).toString("utf8");
        held = held.subarray(end + 1);
        try {
          line(JSON.parse(text));
        } catch {
          // Not a line of the helper's.
        }
      }
      if (held.length > LINK_HELD) socket.destroy();
    });
    socket.on("end", () => socket.destroy());
    socket.on("close", closed);
  }
}
