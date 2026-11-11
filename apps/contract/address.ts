// Which addresses are this box itself. An app never reaches the box: the
// daemon answers there, and it trusts what comes from the box. The manifest
// checks (manifest.ts, page.ts), the loader that carries out an app's
// requests (daemon/apps/reach.ts) and the net filter (daemon/net-filter.ts)
// all ask here, so they can't disagree.
//
// Addresses are compared as bytes, not as text, so every way of writing one
// counts: ::ffff:7f00:1 is 127.0.0.1 as much as ::ffff:127.0.0.1 is. Servers
// on the home network, such as 192.168.1.20, are not the box and stay
// reachable.

import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";

// Loopback, unspecified and link-local: this box and nowhere, on any box.
const FIXED = new BlockList();
FIXED.addSubnet("127.0.0.0", 8, "ipv4");
FIXED.addSubnet("0.0.0.0", 8, "ipv4");
FIXED.addSubnet("169.254.0.0", 16, "ipv4");
FIXED.addAddress("::1", "ipv6");
FIXED.addAddress("::", "ipv6");
FIXED.addSubnet("fe80::", 10, "ipv6");

// Link-local alone. Every box has addresses here, so one of them is this
// box only when the box has it (linkLocalElsewhere).
const LINK_LOCAL = new BlockList();
LINK_LOCAL.addSubnet("169.254.0.0", 16, "ipv4");
LINK_LOCAL.addSubnet("fe80::", 10, "ipv6");

// An address as net.isIP takes it: no brackets, no zone such as %eth0.
function bare(address: string): string {
  return address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
}

// The addresses this box has on its networks right now.
export function ownAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const found: string[] = [];
  for (const list of Object.values(interfaces)) for (const one of list ?? []) found.push(one.address);
  return found;
}

// Whether an IP address is this box: loopback, unspecified, link-local, or
// one of own, the box's addresses on its networks. An IPv4 address written
// as IPv6 (::ffff:a.b.c.d, or the same in hex) counts as the IPv4 address
// it is. Anything that isn't an IP address isn't.
export function boxAddress(address: string, own: Iterable<string> = []): boolean {
  const value = bare(address);
  const family = isIP(value);
  if (!family) return false;
  const kind = family === 4 ? "ipv4" : "ipv6";
  if (FIXED.check(value, kind)) return true;
  return listed(own).check(value, kind);
}

// Whether an IP address is link-local on some other machine: in the
// link-local ranges, and not one of own, the box's addresses on its
// networks. A server on the home network can answer by such an address
// beside its usual one (nas.local often does). boxAddress still counts it
// as the box, since by itself it says nothing about whose it is. This is
// for a caller that leaves the address out and goes to the server's others
// (daemon/apps/reach.ts). Zones are dropped and bytes compared, as above.
export function linkLocalElsewhere(address: string, own: Iterable<string> = []): boolean {
  const value = bare(address);
  const family = isIP(value);
  if (!family) return false;
  const kind = family === 4 ? "ipv4" : "ipv6";
  return LINK_LOCAL.check(value, kind) && !listed(own).check(value, kind);
}

// own as a list to check an address against.
function listed(own: Iterable<string>): BlockList {
  const mine = new BlockList();
  for (const one of own) {
    const its = bare(one);
    const is = isIP(its);
    if (is) mine.addAddress(its, is === 4 ? "ipv4" : "ipv6");
  }
  return mine;
}

// Whether a URL's host is this box by how it's written: localhost, a name
// under it, or an address that's the box. A name that only resolves to the
// box is caught where the connection is made.
export function boxHost(hostname: string, own: Iterable<string> = []): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return boxAddress(host, own);
}
