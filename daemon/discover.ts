// Servers and shares on the home network (ADR-067), so the TV can list them
// wherever an address used to be typed. The box only hears what they
// announce, each in its own way:
//
// - Jellyfin and Emby answer "who is JellyfinServer?" or "who is
//   EmbyServer?", sent to UDP 7359, with their address and their name;
// - Plex answers GDM's M-SEARCH on UDP 32414;
// - Avahi, which Omarchy runs, hears SMB and NFS shares over mDNS;
// - Windows PCs and NASes like Synology's answer WS-Discovery's Probe on
//   UDP 3702, and then their name when asked at the address they gave.
//
// Immich announces nothing, so its port is asked (/api/server/ping on 2283)
// only on a machine that already announced something else in the same look,
// never anywhere nobody announced (Q183). There's never a sweep of the
// network.
//
// A look starts when a list on the TV or a phone asks, lasts 45 s from the
// last ask, and asks each question a few times in that while. The answers
// come back to fixed ports, 3006 to 3009, which the box's firewall opens to
// the home network only, and which are closed again when the look is over.
// What answered in the last look shows at once in the next, and goes if it
// doesn't answer again.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, isIPv4, Socket as TcpSocket } from "node:net";
import { networkInterfaces } from "node:os";
import { HOTSPOT_ADDRESS } from "./hotspot.ts";

export const KINDS = ["jellyfin", "emby", "plex", "immich", "smb", "nfs"] as const;
export type Kind = (typeof KINDS)[number];
// How the box heard of it.
export type Via = "udp-7359" | "gdm" | "mdns" | "wsd" | "immich-ping";

export interface Found {
  kind: Kind;
  name: string; // the name it gave itself: "living room"
  url: string; // where an app or a share reaches it: "http://192.168.50.10:8096", "smb://nas.local/"
  host: string; // the machine: its mDNS name, "nas.local", or its address
  via: Via;
}

// A NAS's folder, from its own list of shares.
export interface ShareFound {
  kind: "smb" | "nfs";
  name: string; // "music"
  uri: string; // "smb://nas.local/music", what Music and the backgrounds add
  note?: string; // the share's own comment
}

export type SharesAnswer = { ok: true; host: string; shares: ShareFound[]; login?: true } | { ok: false; error: string };

// The ports the answers come back to, which the firewall opens to the home
// network (install/tv/firewall.sh), and the servers' own.
export const PORTS = { jellyfin: 3006, emby: 3007, plex: 3008, wsd: 3009 } as const;
const SERVER_PORTS = { discovery: 7359, gdm: 32414, wsd: 3702, immich: 2283, rpcbind: 111 };
const GDM_GROUP = "239.0.0.250";
const WSD_GROUP = "239.255.255.250";
const LOOK_MS = 45_000;
// When each question goes in a look, from its start, once the ports are
// open: answers sent by UDP can get lost, so each is asked more than once.
const ROUNDS = [300, 2_000, 8_000, 20_000];
const ASK_MS = 3_000; // Immich's ping, WS-Discovery's name, NFS's list
const SMB_MS = 10_000; // smbclient's list of shares
const MDNS_TYPES = ["_smb._tcp", "_nfs._tcp"];

// --- What each one says ------------------------------------------------------

// A name as the TV can show it: no control characters, and not too long.
function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 60);
}

// An http or https address with nothing in it but where it is: its origin
// and a path, as a server under one has.
function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

// Jellyfin's and Emby's answer on 7359: {"Address": "http://…:8096",
// "Id": "…", "Name": "living room"}. Both answer the same way, so which one
// it is comes from the question it answers.
export function serverAnswer(text: string): { url: string; name: string; id: string } | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { Address: address, Name: name, Id: id } = data as Record<string, unknown>;
  const url = httpUrl(address);
  if (!url) return null;
  return { url, name: cleanName(name), id: typeof id === "string" && id ? id.slice(0, 100) : url };
}

// A name's IPv4 addresses, as the box resolves it.
export type Lookup = (name: string) => Promise<string[]>;

const lookup: Lookup = async (name) => (await dnsLookup(name, { all: true, family: 4 })).map((one) => one.address);

// Where a Jellyfin or Emby that answered really is. Its answer names an
// address, but any device at home can send an answer, so that address only
// counts when it's the sender's own: the address the answer came from, or a
// name that leads to it, as a server set up with a name of its own gives.
// Anything else becomes the sender's address, on the port the answer gave
// when it's plain http and on 8096 otherwise, which both listen on unless
// they're told not to. That keeps a server whose answer names an address
// the box can't use, such as a container's inside address.
export async function senderUrl(answer: string, from: string, resolve: Lookup = lookup): Promise<string | null> {
  if (!isIPv4(from)) return null;
  const url = new URL(answer);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === from) return answer;
  if (!isIP(host)) {
    const found = await Promise.race([resolve(host), new Promise<string[]>((done) => setTimeout(() => done([]), ASK_MS).unref())]).catch((): string[] => []);
    if (found.includes(from)) return answer;
  }
  const port = url.protocol === "http:" ? url.port || "80" : "8096";
  return `http://${from}${port === "80" ? "" : `:${port}`}${url.pathname.replace(/\/+$/, "")}`;
}

// Plex's answer to GDM's M-SEARCH, from the address it came from:
// "HTTP/1.0 200 OK", then headers, with Content-Type plex/media-server, its
// Name and the Port it serves on.
export function gdmAnswer(text: string, from: string): { url: string; name: string; id: string } | null {
  const [status, ...lines] = text.split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200\b/.test(status ?? "") || !isIPv4(from)) return null;
  const headers = new Map<string, string>();
  for (const line of lines) {
    const found = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (found) headers.set(found[1].toLowerCase(), found[2].trim());
  }
  if (!(headers.get("content-type") ?? "").startsWith("plex/media-server")) return null;
  const port = Number(headers.get("port") ?? 32400);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { url: `http://${from}:${port}`, name: cleanName(headers.get("name")), id: headers.get("resource-identifier") || `${from}:${port}` };
}

// A label as avahi-browse prints it with --parsable: a dot or a backslash
// after a backslash, and any other byte that isn't a letter, a digit, "-" or
// "_" as a backslash and three decimal digits, so "living room" comes as
// "living\032room". The bytes are UTF-8.
export function avahiLabel(text: string): string {
  const bytes: number[] = [];
  for (let at = 0; at < text.length; at++) {
    const escaped = text[at] === "\\" ? /^\\(\d{3}|.)/.exec(text.slice(at)) : null;
    if (escaped) {
      if (escaped[1].length === 3) bytes.push(Number(escaped[1]) & 0xff);
      else bytes.push(...Buffer.from(escaped[1]));
      at += escaped[0].length - 1;
    } else {
      bytes.push(...Buffer.from(text[at]));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export interface MdnsService {
  event: "+" | "=" | "-";
  name: string;
  type: string;
  host?: string;
  address?: string;
  port?: number;
  txt: Record<string, string>;
}

// One line of avahi-browse --parsable --resolve: "=", the interface, the
// protocol, the name, the type and the domain, then for a resolved one its
// host, address, port and TXT, each TXT string in quotes. "+" is a new one
// and "-" one that went. IPv4 only, since the address goes in an address
// typed the usual way.
export function avahiLine(line: string): MdnsService | null {
  const fields = line.split(";");
  const event = fields[0];
  if ((event !== "+" && event !== "=" && event !== "-") || fields.length < 6) return null;
  if (fields[2] !== "IPv4") return null;
  const service: MdnsService = { event, name: avahiLabel(fields[3]), type: fields[4], txt: {} };
  if (event !== "=") return service;
  if (fields.length < 9) return null;
  const port = Number(fields[8]);
  if (!isIPv4(fields[7]) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  service.host = fields[6].toLowerCase();
  service.address = fields[7];
  service.port = port;
  for (const found of fields.slice(9).join(";").matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const pair = found[1].replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(Number(code))).replace(/\\(.)/g, "$1");
    const equals = pair.indexOf("=");
    if (equals > 0) service.txt[pair.slice(0, equals).toLowerCase()] = pair.slice(equals + 1);
  }
  return service;
}

// A share's address from its mDNS name: smb://nas.local/ for the machine,
// whose shares it lists when picked, or nfs://nas.local/export/music for an
// NFS export, which says its path in its TXT.
export function mdnsFound(service: MdnsService): (Found & { address: string }) | null {
  if (service.event !== "=" || !service.host || !service.address) return null;
  const host = /^[a-z0-9.-]+$/.test(service.host) ? service.host : service.address;
  if (service.type === "_smb._tcp") return { kind: "smb", name: cleanName(service.name) || host, url: `smb://${host}/`, host, via: "mdns", address: service.address };
  if (service.type === "_nfs._tcp") {
    const path = (service.txt.path ?? "").startsWith("/") ? service.txt.path : "/";
    return { kind: "nfs", name: cleanName(service.name) || host, url: `nfs://${host}${encodeURI(path)}`, host, via: "mdns", address: service.address };
  }
  return null;
}

// WS-Discovery's messages (SOAP 1.2 over UDP, the 2005/04 draft Windows
// speaks), asking for any device. A device that shares files says it's a
// pub:Computer.
const WSD_NS = 'xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:wsdp="http://schemas.xmlsoap.org/ws/2006/02/devprof"';
const WSD_TO = "urn:schemas-xmlsoap-org:ws:2005:04:discovery";
const WSD_ACTION = "http://schemas.xmlsoap.org/ws/2005/04/discovery";

export function wsdProbe(id: string = randomUUID()): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope ${WSD_NS}><soap:Header><wsa:To>${WSD_TO}</wsa:To><wsa:Action>${WSD_ACTION}/Probe</wsa:Action><wsa:MessageID>urn:uuid:${id}</wsa:MessageID></soap:Header><soap:Body><wsd:Probe><wsd:Types>wsdp:Device</wsd:Types></wsd:Probe></soap:Body></soap:Envelope>`;
}

// Where a device that answered without its address is: wsdd, which Linux
// NASes run, answers a Probe that way and a Resolve with it.
export function wsdResolve(endpoint: string, id: string = randomUUID()): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope ${WSD_NS}><soap:Header><wsa:To>${WSD_TO}</wsa:To><wsa:Action>${WSD_ACTION}/Resolve</wsa:Action><wsa:MessageID>urn:uuid:${id}</wsa:MessageID></soap:Header><soap:Body><wsd:Resolve><wsa:EndpointReference><wsa:Address>${xmlText(endpoint)}</wsa:Address></wsa:EndpointReference></wsd:Resolve></soap:Body></soap:Envelope>`;
}

// The device's description, asked at the address it gave, with its name.
export function wsdGet(endpoint: string, id: string = randomUUID()): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope ${WSD_NS}><soap:Header><wsa:To>${xmlText(endpoint)}</wsa:To><wsa:Action>http://schemas.xmlsoap.org/ws/2004/09/transfer/Get</wsa:Action><wsa:MessageID>urn:uuid:${id}</wsa:MessageID><wsa:ReplyTo><wsa:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address></wsa:ReplyTo></soap:Header><soap:Body/></soap:Envelope>`;
}

function xmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

// An element's text, with any namespace prefix.
function element(xml: string, name: string): string | null {
  const found = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z0-9_-]+:)?${name}>`).exec(xml);
  return found ? xmlUnescape(found[1]).trim() : null;
}

export interface WsdMatch {
  endpoint: string; // "urn:uuid:…"
  types: string[]; // ["wsdp:Device", "pub:Computer"]
  xaddrs: string[]; // ["http://192.168.50.10:5357/…"], when it said
}

// The ProbeMatch or ResolveMatch elements of an answer.
export function wsdMatches(xml: string): WsdMatch[] {
  const matches: WsdMatch[] = [];
  for (const found of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?(ProbeMatch|ResolveMatch)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?\1>/g)) {
    const endpoint = element(found[2], "Address");
    if (!endpoint) continue;
    matches.push({
      endpoint,
      types: (element(found[2], "Types") ?? "").split(/\s+/).filter(Boolean),
      xaddrs: (element(found[2], "XAddrs") ?? "").split(/\s+/).filter((one) => httpUrl(one) !== null),
    });
  }
  return matches;
}

// Whether a device shares files: Windows and wsdd call that a Computer.
export function wsdComputer(match: WsdMatch): boolean {
  return match.types.some((type) => /(^|:)Computer$/.test(type));
}

// The device's name from its description: pub:Computer is "NAS/Workgroup:
// WORKGROUP" or "PC/Domain:…", so the part before the slash, and its
// FriendlyName otherwise.
export function wsdName(xml: string): string {
  const computer = element(xml, "Computer");
  if (computer) return cleanName(computer.split("/")[0]);
  return cleanName(element(xml, "FriendlyName") ?? "");
}

// Immich's answer to /api/server/ping.
export function immichPong(text: string): boolean {
  try {
    return (JSON.parse(text) as { res?: unknown })?.res === "pong";
  } catch {
    return false;
  }
}

// What smbclient -L -g lists: "Disk|music|Music library" for each folder,
// with printers, IPC$ and hidden shares (a name that ends in $) left out.
export function smbShares(text: string): { name: string; note?: string }[] {
  const shares: { name: string; note?: string }[] = [];
  for (const line of text.split("\n")) {
    const [type, name, ...note] = line.trim().split("|");
    if (type !== "Disk" || !name || name.endsWith("$") || /[\x00-\x1f/\\]/.test(name)) continue;
    const comment = cleanName(note.join("|"));
    shares.push(comment ? { name, note: comment } : { name });
  }
  return shares;
}

// --- NFS's list of exports, over ONC RPC ----------------------------------------

// A call, as a TCP record: the transaction id, CALL, RPC version 2, the
// program, its version and procedure, no credentials, then the arguments.
export function rpcCall(xid: number, program: number, version: number, procedure: number, args: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(40);
  [xid, 0, 2, program, version, procedure, 0, 0, 0, 0].forEach((value, at) => head.writeUInt32BE(value >>> 0, at * 4));
  const body = Buffer.concat([head, args]);
  const mark = Buffer.alloc(4);
  mark.writeUInt32BE((0x80000000 | body.length) >>> 0);
  return Buffer.concat([mark, body]);
}

// The procedure's result in a reply, or null when it isn't the answer to
// that call or the server turned it down.
export function rpcResult(reply: Buffer, xid: number): Buffer | null {
  if (reply.length < 24 || reply.readUInt32BE(0) !== xid || reply.readUInt32BE(4) !== 1 || reply.readUInt32BE(8) !== 0) return null;
  const verifier = reply.readUInt32BE(16);
  const at = 20 + Math.ceil(verifier / 4) * 4;
  if (reply.length < at + 4 || reply.readUInt32BE(at) !== 0) return null;
  return reply.subarray(at + 4);
}

// MOUNT version 3's EXPORT: a list of exports, each its path and the groups
// it's for, each list as "one more follows" and the item.
export function nfsExports(result: Buffer): string[] {
  const paths: string[] = [];
  let at = 0;
  const word = (): number => {
    if (at + 4 > result.length) throw new Error("short");
    const value = result.readUInt32BE(at);
    at += 4;
    return value;
  };
  const text = (): string => {
    const length = word();
    if (length > 1024 || at + length > result.length) throw new Error("short");
    const value = result.toString("utf8", at, at + length);
    at += Math.ceil(length / 4) * 4;
    return value;
  };
  try {
    while (word() === 1) {
      const path = text();
      while (word() === 1) text();
      if (path.startsWith("/") && !/[\x00-\x1f]/.test(path)) paths.push(path);
    }
  } catch {
    // A list cut short keeps what came.
  }
  return paths;
}

// One call over TCP, and its reply's record, put together from its
// fragments.
function tcpRpc(host: string, port: number, call: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = new TcpSocket();
    let data = Buffer.alloc(0);
    const parts: Buffer[] = [];
    const done = (error: Error | null, reply?: Buffer) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(reply!);
    };
    socket.setTimeout(timeoutMs, () => done(new Error("no answer")));
    socket.on("error", (error) => done(error));
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4) {
        const mark = data.readUInt32BE(0);
        const length = mark & 0x7fffffff;
        if (length > 1024 * 1024) return done(new Error("too long"));
        if (data.length < 4 + length) return;
        parts.push(data.subarray(4, 4 + length));
        data = data.subarray(4 + length);
        if (mark & 0x80000000) return done(null, Buffer.concat(parts));
      }
    });
    socket.connect(port, host, () => socket.write(call));
  });
}

// An NFS server's exports: rpcbind says where its MOUNT service is, which
// lists them.
export async function nfsList(address: string, options: { rpcbind?: number; timeoutMs?: number } = {}): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? ASK_MS;
  const xid = (Math.random() * 0xffffffff) >>> 0;
  const args = Buffer.alloc(16);
  [100005, 3, 6, 0].forEach((value, at) => args.writeUInt32BE(value, at * 4));
  const port = rpcResult(await tcpRpc(address, options.rpcbind ?? SERVER_PORTS.rpcbind, rpcCall(xid, 100000, 2, 3, args), timeoutMs), xid);
  const mountd = port && port.length >= 4 ? port.readUInt32BE(0) : 0;
  if (!mountd || mountd > 65535) throw new Error("Couldn't list that drive's folders");
  const result = rpcResult(await tcpRpc(address, mountd, rpcCall(xid + 1, 100005, 3, 5), timeoutMs), xid + 1);
  if (!result) throw new Error("Couldn't list that drive's folders");
  return nfsExports(result);
}

// --- The look -----------------------------------------------------------------

interface Entry extends Found {
  key: string;
  address: string; // the machine's IPv4 address
  look: number; // the last look it answered in
}

export type Run = (command: string, args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<{ stdout: string; stderr: string; code: number }>;

const run: Run = (command, args, timeoutMs, env = {}) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: "C", ...env } }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr) || (error && !stdout ? error.message : ""), code });
    });
  });

export interface DiscoverOptions {
  // The box's network interfaces: where the questions go.
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  // Tests: the addresses every question goes to instead of the home
  // network's broadcast and multicast addresses.
  targets?: string[];
  // The ports the answers come back to (PORTS), and 0 for any in tests.
  ports?: Partial<Record<keyof typeof PORTS, number>>;
  // Tests: the servers' own ports, where their stand-ins listen.
  serverPorts?: Partial<typeof SERVER_PORTS>;
  // avahi-browse, or null for no mDNS.
  avahi?: string | null;
  smbclient?: string;
  // Tests: how a name in a server's answer is resolved.
  lookup?: Lookup;
  run?: Run;
  fetch?: typeof fetch;
  lookMs?: number;
  rounds?: number[];
  // Something was found, or the look is over.
  changed?: (state: { found: Found[]; looking: boolean }) => void;
  // The list on the TV changed, for the phones to follow.
  screen?: () => void;
  // A phone picked from the TV's list: the key of the row it picked, for
  // the TV's page to pick as if it was picked there.
  picked?: (key: string) => void;
  log?: (line: string) => void;
}

// The list on the TV, for the phones: the kinds of server it shows (one row
// a machine for the NASes), or a NAS's folders.
export type TvList = { kinds: Kind[]; machines: boolean } | { host: string };

// How long the TV's word about its list lasts. Its page says it again every
// 20 s while the list is on screen, and says when it's gone.
const SCREEN_MS = 45_000;

const ORDER: Kind[] = [...KINDS];

export class Discover {
  private options: DiscoverOptions;
  private entries = new Map<string, Entry>();
  // Each address's mDNS name, "nas.local", and what WS-Discovery called it.
  private names = new Map<string, string>();
  private computers = new Map<string, string>();
  private looks = 0;
  private looking = false;
  private wantImmich = false;
  private pinged = new Set<string>();
  private sockets: Partial<Record<keyof typeof PORTS, Socket>> = {};
  private browsers: ChildProcess[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private end?: ReturnType<typeof setTimeout>;
  private asked = new Set<string>(); // WS-Discovery's endpoints asked for their name in this look
  private avahiMissing = false;
  private tv: { list: TvList; until: number } | null = null;

  constructor(options: DiscoverOptions = {}) {
    this.options = options;
  }

  private log(line: string): void {
    (this.options.log ?? ((text: string) => console.log(text)))(`discover: ${line}`);
  }

  // What's been found, of the kinds asked for, and whether it's still
  // looking. It starts a look, or makes the one going last longer.
  look(kinds: readonly Kind[] = KINDS): { found: Found[]; looking: boolean } {
    if (kinds.includes("immich")) this.wantImmich = true;
    if (this.looking) {
      this.later();
      if (kinds.includes("immich")) for (const entry of this.entries.values()) if (entry.look === this.looks) this.ping(entry.address, entry.host);
    } else {
      this.start();
    }
    return { found: this.found(kinds), looking: this.looking };
  }

  found(kinds: readonly Kind[] = KINDS): Found[] {
    return [...this.entries.values()]
      .filter((entry) => kinds.includes(entry.kind))
      .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.name.localeCompare(b.name) || a.url.localeCompare(b.url))
      .map(({ kind, name, url, address, via }) => ({ kind, name, url, host: this.names.get(address) ?? address, via }));
  }

  get isLooking(): boolean {
    return this.looking;
  }

  private start(): void {
    this.looks++;
    this.looking = true;
    this.asked.clear();
    this.pinged.clear();
    for (const name of Object.keys(PORTS) as (keyof typeof PORTS)[]) this.listen(name);
    for (const type of MDNS_TYPES) this.browse(type);
    for (const at of this.options.rounds ?? ROUNDS) this.timers.push(setTimeout(() => this.ask(), at));
    this.later();
    this.changed();
  }

  private later(): void {
    if (this.end) clearTimeout(this.end);
    this.end = setTimeout(() => this.stop(), this.options.lookMs ?? LOOK_MS);
  }

  // The look is over: nothing listens, and what didn't answer in it goes.
  // Closing the daemon stops it without a word.
  private stop(say = true): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.end) clearTimeout(this.end);
    this.end = undefined;
    for (const socket of Object.values(this.sockets)) socket?.close();
    this.sockets = {};
    for (const browser of this.browsers) browser.kill();
    this.browsers = [];
    for (const [key, entry] of this.entries) if (entry.look !== this.looks) this.entries.delete(key);
    this.looking = false;
    this.wantImmich = false;
    if (say) this.changed();
  }

  close(): void {
    if (this.looking) this.stop(false);
  }

  // The TV's page shows a list, or none any more. The phones hear only a
  // change.
  showing(list: TvList | null): void {
    const before = JSON.stringify(this.onScreen());
    this.tv = list ? { list, until: Date.now() + SCREEN_MS } : null;
    if (JSON.stringify(list) !== before) this.options.screen?.();
  }

  // The list on the TV, while its page keeps saying so.
  onScreen(): TvList | null {
    if (this.tv && this.tv.until <= Date.now()) this.tv = null;
    return this.tv?.list ?? null;
  }

  // A phone's pick, for the list on the TV. False with no list there.
  pick(key: string): boolean {
    if (!this.onScreen()) return false;
    this.options.picked?.(key);
    return true;
  }

  private changed(): void {
    this.options.changed?.({ found: this.found(), looking: this.looking });
  }

  private add(found: Found, address: string, key: string): void {
    const known = this.entries.get(key);
    const entry: Entry = { ...found, key, address, look: this.looks };
    this.entries.set(key, entry);
    if (!known || known.name !== entry.name || known.url !== entry.url || known.look !== this.looks) this.changed();
    // Immich, on the machine that just announced something.
    if (this.wantImmich && found.kind !== "immich") this.ping(address, this.names.get(address) ?? address);
  }

  // --- Asking ---

  // Where the questions go: the home network's broadcast address on each of
  // the box's interfaces, never a container's, a VM's or the setup
  // hotspot's, and the multicast groups through each of them. Not
  // 255.255.255.255, which only goes where the default route does.
  private lan(): { address: string; broadcast: string }[] {
    const lan: { address: string; broadcast: string }[] = [];
    for (const [name, addresses] of Object.entries((this.options.interfaces ?? networkInterfaces)())) {
      if (/^(lo|docker|br-|veth|virbr|vnet|tun|tap|wg)/.test(name)) continue;
      for (const one of addresses ?? []) {
        if (one.family !== "IPv4" || one.internal || one.address === HOTSPOT_ADDRESS) continue;
        const address = one.address.split(".").map(Number);
        const mask = one.netmask.split(".").map(Number);
        lan.push({ address: one.address, broadcast: address.map((part, at) => (part | (~mask[at] & 255)) & 255).join(".") });
      }
    }
    return lan;
  }

  private listen(name: keyof typeof PORTS): void {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", (error) => {
      this.log(`port ${this.options.ports?.[name] ?? PORTS[name]} for ${name}: ${error.message}`);
      if (this.sockets[name] === socket) delete this.sockets[name];
      try {
        socket.close();
      } catch {
        // It never opened.
      }
    });
    socket.on("message", (message, from) => this.heard(name, message, from));
    socket.bind(this.options.ports?.[name] ?? PORTS[name], () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(1);
      } catch {
        // A socket closed as it bound.
      }
    });
    this.sockets[name] = socket;
  }

  private send(name: keyof typeof PORTS, message: string, port: number, group: string | null): void {
    const socket = this.sockets[name];
    if (!socket) return;
    const body = Buffer.from(message);
    const quietly = (error: Error | null) => {
      if (error) this.log(`${name}: ${error.message}`);
    };
    try {
      if (this.options.targets) {
        for (const target of this.options.targets) socket.send(body, port, target, quietly);
        return;
      }
      const lan = this.lan();
      if (group) {
        for (const one of lan) {
          socket.setMulticastInterface(one.address);
          socket.send(body, port, group, quietly);
        }
      }
      if (name !== "wsd") for (const target of new Set(lan.map((one) => one.broadcast))) socket.send(body, port, target, quietly);
    } catch (error) {
      // Not bound yet, or gone: the next round asks again.
      this.log(`${name}: ${(error as Error).message}`);
    }
  }

  private ask(): void {
    const ports = { ...SERVER_PORTS, ...this.options.serverPorts };
    this.send("jellyfin", "who is JellyfinServer?", ports.discovery, null);
    this.send("emby", "who is EmbyServer?", ports.discovery, null);
    this.send("plex", "M-SEARCH * HTTP/1.1\r\n\r\n", ports.gdm, GDM_GROUP);
    this.send("wsd", wsdProbe(), ports.wsd, WSD_GROUP);
  }

  private heard(name: keyof typeof PORTS, message: Buffer, from: RemoteInfo): void {
    if (!this.looking || message.length > 64 * 1024) return;
    const text = message.toString("utf8");
    if (name === "jellyfin" || name === "emby") {
      const answer = serverAnswer(text);
      if (answer) void this.serverHeard(name, answer, from.address);
    } else if (name === "plex") {
      const answer = gdmAnswer(text, from.address);
      if (answer) this.add({ kind: "plex", name: answer.name || "plex", url: answer.url, host: from.address, via: "gdm" }, from.address, `plex:${answer.id}`);
    } else {
      for (const match of wsdMatches(text)) void this.wsdHeard(match, from);
    }
  }

  // A Jellyfin or an Emby, at the address its answer came from. Its row is
  // its own id and that address together, so an answer from somewhere else
  // with the same id is a row of its own and never takes this one's place.
  private async serverHeard(kind: "jellyfin" | "emby", answer: { url: string; name: string; id: string }, from: string): Promise<void> {
    const look = this.looks;
    const url = await senderUrl(answer.url, from, this.options.lookup);
    if (!url || !this.looking || look !== this.looks) return;
    this.add({ kind, name: answer.name || kind, url, host: from, via: "udp-7359" }, from, `${kind}:${answer.id === answer.url ? url : answer.id}@${from}`);
  }

  // A device that shares files, by its address. Its name comes from its
  // description, at the address it gave, or a Resolve asks for that first.
  private async wsdHeard(match: WsdMatch, from: RemoteInfo): Promise<void> {
    if (!wsdComputer(match) || !isIPv4(from.address)) return;
    const key = `smb:${from.address}`;
    const name = this.computers.get(from.address);
    const known = this.entries.get(key);
    // mDNS's name for it wins, once it has answered in this look.
    if (!known || known.via === "wsd" || known.look !== this.looks) {
      const host = this.names.get(from.address) ?? from.address;
      this.add({ kind: "smb", name: name ?? host, url: `smb://${host}/`, host, via: "wsd" }, from.address, key);
    }
    if (this.asked.has(match.endpoint) && !match.xaddrs.length) return;
    this.asked.add(match.endpoint);
    const xaddr = match.xaddrs.find((one) => new URL(one).hostname === from.address);
    if (!xaddr) {
      const ports = { ...SERVER_PORTS, ...this.options.serverPorts };
      this.sockets.wsd?.send(Buffer.from(wsdResolve(match.endpoint)), ports.wsd, from.address, () => {});
      return;
    }
    if (name) return;
    try {
      const response = await (this.options.fetch ?? fetch)(xaddr, {
        method: "POST",
        headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
        body: wsdGet(match.endpoint),
        signal: AbortSignal.timeout(ASK_MS),
        redirect: "error",
      });
      const named = wsdName((await response.text()).slice(0, 256 * 1024));
      if (!named || !this.looking) return;
      this.computers.set(from.address, named);
      const entry = this.entries.get(key);
      if (entry?.via === "wsd") this.add({ ...entry, name: named }, from.address, key);
    } catch {
      // Its address stands in for its name.
    }
  }

  // mDNS, through Avahi: the shares on the network, and each machine's name.
  private browse(type: string): void {
    const command = this.options.avahi === undefined ? "avahi-browse" : this.options.avahi;
    if (command === null || this.avahiMissing) return;
    const browser = spawn(command, ["--parsable", "--resolve", "--no-db-lookup", "--ignore-local", type], { stdio: ["ignore", "pipe", "ignore"] });
    let rest = "";
    browser.stdout?.setEncoding("utf8");
    browser.stdout?.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) this.mdnsHeard(line);
    });
    browser.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        this.avahiMissing = true;
        this.log(`${command} isn't here, so shares over mDNS won't show`);
      }
    });
    this.browsers.push(browser);
  }

  private mdnsHeard(line: string): void {
    const service = avahiLine(line);
    if (!service || !this.looking) return;
    const found = mdnsFound(service);
    if (!found) return;
    if (found.host !== found.address) this.names.set(found.address, found.host);
    const { address, ...shown } = found;
    // A machine WS-Discovery found first takes its mDNS name.
    const key = found.kind === "smb" ? `smb:${address}` : `nfs:${address}:${found.url}`;
    this.add(shown, address, key);
  }

  // Immich's port, on a machine that announced something in this look and
  // nowhere else.
  private ping(address: string, host: string): void {
    if (!isIPv4(address) || this.pinged.has(address)) return;
    this.pinged.add(address);
    const port = this.options.serverPorts?.immich ?? SERVER_PORTS.immich;
    const url = `http://${address}:${port}`;
    void (this.options.fetch ?? fetch)(`${url}/api/server/ping`, { signal: AbortSignal.timeout(ASK_MS), redirect: "error" })
      .then(async (response) => {
        if (!response.ok || !immichPong((await response.text()).slice(0, 4096)) || !this.looking) return;
        this.add({ kind: "immich", name: "immich", url, host, via: "immich-ping" }, address, `immich:${address}:${port}`);
      })
      .catch(() => {});
  }

  // --- A NAS's shares ---

  // The folders a NAS shares, for a machine the box found and no other:
  // SMB's own list and NFS's exports. A NAS that lists its shares only for
  // a user says so (login), and then they're asked for again with the user
  // name and password typed on the phone. smbclient gets the password in
  // its environment, never on its command line, and nothing keeps it: the
  // share picked keeps it as Music's sources do.
  async shares(host: string, login?: { user: string; password: string }): Promise<SharesAnswer> {
    const machine = [...this.entries.values()].filter((entry) => (entry.kind === "smb" || entry.kind === "nfs") && (entry.address === host || this.names.get(entry.address) === host));
    if (!machine.length) return { ok: false, error: `Couldn't find ${host.slice(0, 60)}` };
    const address = machine[0].address;
    const name = this.names.get(address) ?? address;
    const shares: ShareFound[] = [];
    let wantsLogin = false;
    const errors: string[] = [];
    if (machine.some((entry) => entry.kind === "smb")) {
      const listed = await this.smbList(address, name, login);
      if ("shares" in listed) shares.push(...listed.shares);
      else if (listed.login) wantsLogin = true;
      else errors.push(listed.error);
    }
    const exports = machine.filter((entry) => entry.kind === "nfs");
    if (exports.length) {
      const paths = new Set(exports.map((entry) => decodeURI(new URL(entry.url).pathname)).filter((path) => path !== "/"));
      try {
        for (const path of await nfsList(address, { rpcbind: this.options.serverPorts?.rpcbind })) paths.add(path);
      } catch (error) {
        if (!paths.size) errors.push((error as Error).message);
      }
      for (const path of paths) shares.push({ kind: "nfs", name: path.split("/").filter(Boolean).pop() ?? path, uri: `nfs://${name}${encodeURI(path)}` });
    }
    if (!shares.length && !wantsLogin && errors.length) return { ok: false, error: errors[0] };
    return wantsLogin ? { ok: true, host: name, shares, login: true } : { ok: true, host: name, shares };
  }

  private async smbList(address: string, name: string, login?: { user: string; password: string }): Promise<{ shares: ShareFound[] } | { login: true } | { login?: false; error: string }> {
    const command = this.options.smbclient ?? "smbclient";
    const who = login ? ["-U", login.user] : ["-N"];
    const result = await (this.options.run ?? run)(command, ["-L", `//${name}`, "-I", address, ...who, "-g"], SMB_MS, login ? { PASSWD: login.password } : {});
    const listed = smbShares(result.stdout);
    const user = login ? `${encodeURIComponent(login.user)}@` : "";
    if (listed.length) return { shares: listed.map((one) => ({ kind: "smb" as const, name: one.name, uri: `smb://${user}${name}/${encodeURIComponent(one.name)}`, ...(one.note ? { note: one.note } : {}) })) };
    const said = `${result.stdout}\n${result.stderr}`;
    if (/NT_STATUS_(ACCESS_DENIED|LOGON_FAILURE|ACCOUNT_RESTRICTION|WRONG_PASSWORD)/.test(said)) return { login: true };
    if (/ENOENT|not found/.test(result.stderr) && result.code !== 0 && !result.stdout) return { error: "Couldn't list that drive's folders" };
    return { error: `Couldn't list ${name}'s folders` };
  }
}
