// How an app's request goes out (loader.ts). The loader has already held it
// to the app's declared origins. Here its host is looked up once, refused if
// any of its addresses is this box, and the connection goes to the very
// addresses that were checked, so a name can't point somewhere else between
// the check and the connection. The net filter does the same for home's
// Chromium (daemon/net-filter.ts).
//
// A server on the home network can answer by a link-local address beside its
// usual one, as nas.local often does. That address isn't this box's, so it's
// left out and never connected to, and the request goes to the others.
//
// It answers like fetch with redirect "manual": a redirect comes back as it
// is, so the address it names is checked too when the app follows it.

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate, inflateRaw } from "node:zlib";
import { boxAddress, linkLocalElsewhere, ownAddresses } from "../../apps/contract/address.ts";

export interface ReachOptions {
  // A name's addresses, and which addresses are this box. The defaults are
  // the system's resolver and the box's own addresses. own is the box's
  // addresses on its networks, which tell its own link-local address from a
  // neighbour's.
  resolve?: (host: string) => Promise<string[]>;
  forbid?: (address: string) => boolean;
  own?: () => Iterable<string>;
  maxBytes?: number;
}

// What only the loader says, never the app: who the request is from at the
// connection's level, and anything in AgenTV's own name. The daemon reads
// x-agentv-* as coming from the box's own screens.
const NOT_THE_APPS = ["host", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "expect", "content-length"];

export function appHeaders(pairs: Iterable<[string, string]>): Headers {
  const headers = new Headers();
  for (const [name, value] of pairs) {
    const lower = String(name).toLowerCase();
    if (NOT_THE_APPS.includes(lower) || lower.startsWith("x-agentv-")) continue;
    headers.append(name, value);
  }
  return headers;
}

const decoders: Record<string, (body: Buffer, options: { maxOutputLength: number }) => Promise<Buffer>> = {
  gzip: promisify(gunzip),
  "x-gzip": promisify(gunzip),
  br: promisify(brotliDecompress),
  // Some servers send deflate with no zlib header.
  deflate: (body, options) => promisify(inflate)(body, options).catch(() => promisify(inflateRaw)(body, options)),
};

// The addresses to connect to for host, each checked, or an error that says
// why not. The tests read it too.
export async function checked(host: string, options: ReachOptions = {}): Promise<{ address: string; family: number }[]> {
  const own = [...(options.own ?? ownAddresses)()];
  const forbid = options.forbid ?? ((address: string) => boxAddress(address, own));
  const resolve = options.resolve ?? (async (name: string) => (await dnsLookup(name, { all: true })).map((found) => found.address));
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (!addresses.length) throw new Error(`${host} doesn't resolve`);
  const refused = new Error(`${host} is this tv itself, which an app never reaches`);
  // An address typed as the host is taken as it is.
  if (isIP(host)) {
    if (forbid(host)) throw refused;
    return [{ address: host, family: isIP(host) }];
  }
  // A name: any address that's this box refuses the whole name. A link-local
  // address that isn't the box's own is some other machine's, so only that
  // address goes, and the name is refused when nothing else is left.
  const kept: string[] = [];
  for (const address of addresses) {
    if (!forbid(address)) kept.push(address);
    else if (!linkLocalElsewhere(address, own)) throw refused;
  }
  if (!kept.length) throw refused;
  return kept.map((address) => ({ address, family: isIP(address) }));
}

// A fetch that goes only where reach allows. It takes what the loader gives
// it: an address, a method, headers, a body in bytes and a signal.
export function reach(options: ReachOptions = {}): typeof fetch {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${url.protocol} isn't http or https`);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await checked(host, options);
    // Node asks this instead of the resolver, so it connects to what was
    // checked. It isn't asked at all when the host is an address already.
    const lookup = ((_name: string, asked: { all?: boolean }, done: (...answer: unknown[]) => void) => {
      if (asked.all) done(null, addresses);
      else done(null, addresses[0].address, addresses[0].family);
    }) as unknown as LookupFunction;

    const method = String(init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [name, value] of new Headers(init.headers)) headers[name] = value;
    headers.accept ??= "*/*";
    headers["accept-encoding"] ??= "gzip, deflate, br";
    const body = init.body ? Buffer.from(init.body as Uint8Array) : undefined;
    if (body) headers["content-length"] = String(body.byteLength);

    const answer = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        { host, port: url.port || (url.protocol === "https:" ? 443 : 80), method, path: `${url.pathname}${url.search}`, headers, lookup, agent: false, signal: init.signal ?? undefined },
        resolve,
      );
      request.on("error", reject);
      request.end(body);
    });

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of answer as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        answer.destroy();
        throw new Error("the answer is too big");
      }
      chunks.push(chunk);
    }
    let bytes: Buffer = Buffer.concat(chunks);

    const back = new Headers();
    for (let i = 0; i + 1 < answer.rawHeaders.length; i += 2) {
      try {
        back.append(answer.rawHeaders[i], answer.rawHeaders[i + 1]);
      } catch {
        // a header fetch wouldn't have passed on either
      }
    }
    // Unpacked for the app, as fetch does.
    const packed = (back.get("content-encoding") ?? "").split(",").map((one) => one.trim().toLowerCase()).filter((one) => one && one !== "identity");
    if (bytes.byteLength && packed.length) {
      if (!packed.every((one) => one in decoders)) throw new Error(`the answer is packed as ${packed.join(", ")}, which isn't unpacked here`);
      for (const one of packed.reverse()) {
        bytes = await decoders[one](bytes, { maxOutputLength: maxBytes }).catch((error: NodeJS.ErrnoException) => {
          throw new Error(error.code === "ERR_BUFFER_TOO_LARGE" ? "the answer is too big" : "the answer didn't unpack");
        });
      }
      back.delete("content-encoding");
      back.delete("content-length");
    }

    const status = answer.statusCode ?? 502;
    const empty = method === "HEAD" || [204, 205, 304].includes(status);
    return new Response(empty ? null : new Uint8Array(bytes), { status, statusText: answer.statusMessage ?? "", headers: back });
  };
}
