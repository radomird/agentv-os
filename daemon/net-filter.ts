// A small forward proxy that lets a request through only to the hosts its
// policy names (ADR-043, ADR-045). Home's Chromium goes through one, so a
// page app reaches the origins it declared and nowhere else, even by sending
// its own frame somewhere: the policy in its frame covers its requests, and
// this covers where the frame goes. The builder's sandbox goes through
// another, with the AI provider, the npm registry, OSV.dev and the origins
// the app declares.
//
// It speaks CONNECT for https and plain forwarding for http, and never
// connects to this box itself, whatever a name resolves to, so a name that
// points at 127.0.0.1 can't reach the daemon through it.

import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";

// Whether a request may go to host:port, by scheme.
export type Policy = (host: string, port: number, scheme: "http" | "https") => boolean | Promise<boolean>;

export interface NetFilterOptions {
  policy: Policy;
  log?: (line: string) => void;
  // Name resolution, and which addresses count as this box, for the tests,
  // whose sites are on this box.
  resolve?: (host: string) => Promise<string>;
  forbid?: (address: string) => boolean;
}

// This box and nowhere: loopback, unspecified and link-local addresses.
export function forbiddenAddress(address: string): boolean {
  const v4 = address.replace(/^::ffff:/i, "");
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 127 || a === 0 || (a === 169 && b === 254);
  }
  const v6 = address.toLowerCase();
  return v6 === "::1" || v6 === "::" || /^fe[89ab][0-9a-f]:/.test(v6);
}

// host:port from a CONNECT's target, with [::1]:443 for IPv6.
export function target(value: string): { host: string; port: number } | null {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:/\s]+):(\d{1,5})$/.exec(value);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1].replace(/^\[|\]$/g, "").toLowerCase(), port };
}

const HOP = ["connection", "proxy-connection", "proxy-authorization", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"];

export class NetFilter {
  readonly server: Server;
  private options: NetFilterOptions;
  private log: (line: string) => void;

  constructor(options: NetFilterOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
    this.server = createServer((request, response) => void this.forward(request, response));
    this.server.on("connect", (request: IncomingMessage, socket: Duplex, head: Buffer) => void this.tunnel(request, socket, head));
  }

  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve) => this.server.listen(port, host, () => resolve((this.server.address() as { port: number }).port)));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // The address to connect to for host, or why not.
  private async address(host: string, port: number, scheme: "http" | "https"): Promise<{ address?: string; why?: string }> {
    if (!(await this.options.policy(host, port, scheme))) return { why: `${scheme}://${host}:${port} isn't on the list` };
    const address = isIP(host) ? host : await (this.options.resolve ?? (async (name: string) => (await lookup(name)).address))(host).catch(() => null);
    if (!address) return { why: `${host} doesn't resolve` };
    if ((this.options.forbid ?? forbiddenAddress)(address)) return { why: `${host} is this box (${address})` };
    return { address };
  }

  private async tunnel(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => {});
    const to = target(request.url ?? "");
    const found = to ? await this.address(to.host, to.port, "https") : { why: "that isn't host:port" };
    if (!to || !found.address) {
      this.log(`refused CONNECT ${request.url}: ${found.why}`);
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream: Socket = connect(to.port, found.address, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"));
    // Whichever side goes first takes the tunnel with it. When the site's
    // done, what it sent goes out first; the client side isn't read any
    // more, so it'd never be seen to close.
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.end(() => socket.destroy()));
  }

  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const fail = (status: number, body: string) => {
      if (!response.headersSent) response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(body);
    };
    let url: URL;
    try {
      url = new URL(request.url ?? "");
      if (url.protocol !== "http:") throw new Error("not http");
    } catch {
      fail(400, "this proxy forwards http:// addresses and CONNECT\n");
      return;
    }
    const port = Number(url.port || 80);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const found = await this.address(host, port, "http");
    if (!found.address) {
      this.log(`refused ${request.method} ${url.origin}: ${found.why}`);
      fail(403, "not allowed\n");
      return;
    }
    const headers = { ...request.headers };
    for (const name of HOP) delete headers[name];
    headers.host = url.host;
    const upstream = httpRequest({ host: found.address, port, method: request.method, path: `${url.pathname}${url.search}`, headers, setHost: false }, (answer) => {
      const back = { ...answer.headers };
      for (const name of HOP) delete back[name];
      response.writeHead(answer.statusCode ?? 502, back);
      answer.pipe(response);
    });
    upstream.on("error", () => fail(502, "the site didn't answer\n"));
    request.pipe(upstream);
  }
}
