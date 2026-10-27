// A request from inside the builder's sandbox, through its filter: a tunnel
// with CONNECT, then TLS to the site itself, its certificate checked as
// any other. The sandbox has no other way out (builder/sandbox/net.ts).

import { once } from "node:events";
import { request as plainRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export interface Answer {
  status: number;
  text: string;
}

export interface FetchOptions {
  method?: string;
  body?: string;
  timeout?: number;
  ca?: string | Buffer; // for the tests' own sites
  port?: number; // the site's, 443 unless a test says
}

// The tunnel to host:port, through the proxy at proxy.
function tunnel(proxy: URL, host: string, port: number, timeout: number): Promise<Socket> {
  return new Promise((done, fail) => {
    const ask = plainRequest({ host: proxy.hostname, port: proxy.port || 80, method: "CONNECT", path: `${host}:${port}`, headers: { host: `${host}:${port}` }, agent: false });
    ask.on("connect", (res, socket) => {
      if (res.statusCode === 200) done(socket);
      else {
        socket.destroy();
        fail(new Error(`the builder's filter doesn't let it reach ${host}`));
      }
    });
    ask.on("error", fail);
    ask.setTimeout(timeout, () => ask.destroy(new Error(`${host} didn't answer in time`)));
    ask.end();
  });
}

export async function fetchVia(proxy: string, url: string, options: FetchOptions = {}): Promise<Answer> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("the builder reaches https sites only");
  const timeout = options.timeout ?? 60_000;
  const port = options.port ?? Number(target.port || 443);
  const raw = await tunnel(new URL(proxy), target.hostname, port, timeout);
  const secure = tlsConnect({ socket: raw, servername: target.hostname, ca: options.ca });
  try {
    await once(secure, "secureConnect");
  } catch (error) {
    raw.destroy();
    throw error;
  }
  // One request a tunnel: it closes when the answer's in, or the request fails.
  const close = () => {
    secure.destroy();
    raw.destroy();
  };
  return new Promise<Answer>((done, fail) => {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "agentv-builder" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const req = httpsRequest(
      { host: target.hostname, port, path: `${target.pathname}${target.search}`, method: options.method ?? "GET", headers, createConnection: () => secure },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > 64 * 1024 * 1024) req.destroy(new Error("that answer is too big"));
        });
        res.on("end", () => {
          close();
          done({ status: res.statusCode ?? 0, text });
        });
      },
    );
    req.on("error", (error) => {
      close();
      fail(error);
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`${target.hostname} didn't answer in time`)));
    req.end(options.body);
  });
}

// --- The registry and OSV.dev, as the package tools ask them --------------

export function registryFor(proxy: string, options: FetchOptions = {}, base = "https://registry.npmjs.org/") {
  return async (name: string) => {
    const answer = await fetchVia(proxy, `${base}${name.replace("/", "%2f")}`, options);
    if (answer.status === 404) return null;
    if (answer.status !== 200) throw new Error(`the npm registry answered ${answer.status}`);
    return JSON.parse(answer.text);
  };
}

export function osvFor(proxy: string, options: FetchOptions = {}, base = "https://api.osv.dev/v1/") {
  return {
    async batch(packages: { name: string; version: string }[]): Promise<string[][]> {
      const ids: string[][] = [];
      // OSV.dev takes up to 1000 queries at a time.
      for (let start = 0; start < packages.length; start += 1000) {
        const queries = packages.slice(start, start + 1000).map((p) => ({ package: { ecosystem: "npm", name: p.name }, version: p.version }));
        const answer = await fetchVia(proxy, `${base}querybatch`, { ...options, method: "POST", body: JSON.stringify({ queries }) });
        if (answer.status !== 200) throw new Error(`OSV.dev answered ${answer.status}`);
        const results = (JSON.parse(answer.text).results ?? []) as { vulns?: { id: string }[] }[];
        for (let i = 0; i < queries.length; i++) ids.push((results[i]?.vulns ?? []).map((v) => v.id));
      }
      return ids;
    },
    async vuln(id: string) {
      const answer = await fetchVia(proxy, `${base}vulns/${encodeURIComponent(id)}`, options);
      return answer.status === 200 ? JSON.parse(answer.text) : null;
    },
  };
}
