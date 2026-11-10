// Where a build may go (ADR-045): out on the internet, over https on its own
// port, and nowhere on the home network or this box. A page app on home may
// reach a NAS; a build has no reason to, so its filter is stricter than a
// page app's (daemon/net-filter.ts), and declare_origin says no up front.

import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { pageOriginProblem } from "../apps/contract/page.ts";

// An IPv6 address as its eight groups, whatever way it's written, or null.
function groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase().replace(/%.*$/, "");
  // A dotted IPv4 tail, as in ::ffff:192.168.1.1, is the last two groups.
  const tail = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) text = `${tail[1]}${((Number(tail[2]) << 8) | Number(tail[3])).toString(16)}:${((Number(tail[4]) << 8) | Number(tail[5])).toString(16)}`;
  const [head, rest] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = rest ? rest.split(":") : [];
  const filled = rest === undefined ? front : [...front, ...new Array(8 - front.length - back.length).fill("0"), ...back];
  const parsed = filled.map((part) => parseInt(part, 16));
  return parsed.length === 8 && parsed.every((n) => n >= 0 && n <= 0xffff) ? parsed : null;
}

// An address the same way every time, so two spellings of one compare equal.
export function canonical(address: string): string {
  if (isIP(address) === 4) return address;
  const g = groups(address);
  return g ? g.map((n) => n.toString(16)).join(":") : address.toLowerCase();
}

function privateV4(a: number, b: number): boolean {
  return (
    a === 0 || // nowhere
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier NAT, and Tailscale
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast and reserved
  );
}

// Whether an address is on the home network, this box or nowhere: private,
// loopback, link-local, carrier NAT, unique local, multicast, and an IPv4
// one of those written as IPv6. Anything that isn't an address counts too.
export function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return privateV4(a, b);
  }
  const g = groups(address);
  if (!g) return true;
  const zeros = (count: number) => g.slice(0, count).every((n) => n === 0);
  // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d, which
  // covers :: and ::1) and NAT64 (64:ff9b::a.b.c.d).
  if ((zeros(5) && g[5] === 0xffff) || zeros(6) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0))) return privateV4(g[6] >> 8, g[6] & 0xff);
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || g[0] >> 8 === 0xff;
}

// This box's own addresses, on every interface, as they are now.
export function ownAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): Set<string> {
  const own = new Set<string>();
  for (const list of Object.values(interfaces)) for (const one of list ?? []) own.add(canonical(one.address));
  return own;
}

// Whether the build's filter refuses to connect to an address: the home
// network, and this box by any of its addresses, a public one too.
export function buildForbidden(address: string, own: () => Set<string> = ownAddresses): boolean {
  return privateAddress(address) || own().has(canonical(address));
}

const HOME_NAMES = /(^|\.)(local|lan|internal|localdomain|home\.arpa)$/i;

// Whether a build may declare this origin, or why not: an origin as a page
// app lists one, and for https, which is all a build reaches, a name out on
// the internet with no port of its own.
export function buildOriginProblem(origin: string): string | null {
  const why = pageOriginProblem(origin);
  if (why) return why;
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const home = `'${origin}' is on the home network or this box: a build reaches only the internet`;
  if (isIP(host)) return privateAddress(host) ? home : null;
  if (!host.includes(".") || HOME_NAMES.test(host)) return home;
  if (url.protocol === "https:" && url.port) return `'${origin}' names a port: a build reaches https on its usual port only, so leave the port out`;
  return null;
}
