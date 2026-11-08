// What the box check found, in words, the same on setup's box step, in
// Settings → About → this box and on the phone (ADR-061). One line a
// finding, lower case like the rest of the TV. No DOM here, so the daemon
// says the phone's line with it too.

// The shape of GET /api/box (PHASE-2-PLAN.md, "Shared interfaces").
export interface BoxReport {
  model: string;
  cpu: { name: string; threads: number };
  memoryGb: number;
  storage: { totalGb: number; freeGb: number };
  gpu: { vendor: "intel" | "amd" | "nvidia" | "other"; name: string; decode: string[] };
  tv: { name: string; modes: string[]; hdr: boolean; audio: string[] };
  network: { kind: "wifi" | "ethernet" | "none"; mbps: number };
  bluetooth: boolean;
  gamepads: number;
  widevine: boolean;
  verdicts: { fourK: boolean; fourKSmooth: boolean; games: "good" | "light" | "none"; spaceLow: boolean };
}

// Where the 4K test is: running now, done (and passed or not), or not run
// on this GPU yet.
export type SmoothState = "checking" | "passed" | "failed" | "unchecked";

// How a name is written: in lower case, as Terminal and setup write
// everything, unless a look keeps names' own capitals.
export type Named = (name: string) => string;
const lower: Named = (name) => name.toLowerCase();

export interface BoxLine {
  key: "tv" | "box" | "games" | "space" | "network";
  label: string;
  value: string;
}

function mode(name: string): { width: number; height: number; refresh: number } | null {
  const m = /^(\d+)x(\d+)@(\d+)$/.exec(name);
  return m ? { width: Number(m[1]), height: Number(m[2]), refresh: Number(m[3]) } : null;
}

// "4k tv", "1080p tv", or the screen's own size.
export function tvKind(box: BoxReport): string {
  const best = mode(box.tv.modes[0] ?? "");
  if (!best) return "";
  if (best.width >= 3840) return box.tv.hdr ? "4k hdr tv" : "4k tv";
  if (best.width === 1920 && best.height === 1080) return "1080p tv";
  if (best.width === 1280 && best.height === 720) return "720p tv";
  return `${best.width} × ${best.height} screen`;
}

// The TV's maker, from the name it gives: TVs start it with their brand
// ("Panasonic-TV" is "panasonic", "LG TV SSCR2" is "lg").
function tvMaker(name: string): string {
  const first = name.trim().split(/[-_ ]+/)[0];
  return first.toLowerCase() === "tv" ? name.trim() : first;
}

export function tvLine(box: BoxReport, named: Named = lower): string {
  const kind = tvKind(box);
  if (!kind) return "couldn't read the tv";
  const best = mode(box.tv.modes[0])!;
  return [kind, named(tvMaker(box.tv.name)), `${best.refresh} hz`].filter(Boolean).join(" · ");
}

function gb(n: number): string {
  if (n >= 1000) return `${Math.round((n / 1024) * 10) / 10} tb`;
  return `${n} gb`;
}

export function spaceLine(box: BoxReport): string {
  if (!box.storage.totalGb) return "couldn't read the disk";
  return box.verdicts.spaceLow ? `only ${gb(box.storage.freeGb)} free` : `${gb(box.storage.freeGb)} free`;
}

const MAKERS: Record<string, string> = { intel: "Intel", amd: "AMD", nvidia: "NVIDIA" };

function gpu(box: BoxReport, named: Named): string {
  return named([MAKERS[box.gpu.vendor] ?? "", box.gpu.name].filter(Boolean).join(" "));
}

export function gamesLine(box: BoxReport, named: Named = lower): string {
  const what = box.verdicts.games === "good" ? "good for games" : box.verdicts.games === "light" ? "light games" : "not for games";
  return [what, gpu(box, named)].filter(Boolean).join(" · ");
}

// What the box itself does with the TV: on a 4K TV, whether 4K stays
// smooth; on any other, its CPU and memory.
export function boxLine(box: BoxReport, smooth: SmoothState, named: Named = lower): string {
  if (box.verdicts.fourK) {
    if (smooth === "checking") return "checking 4k…";
    if (box.verdicts.fourKSmooth || smooth === "passed") return "keeps 4k smooth";
    if (smooth === "failed") return "smoother at 1080p";
    return "4k not checked yet";
  }
  return [named(box.cpu.name), box.memoryGb ? `${box.memoryGb} gb` : ""].filter(Boolean).join(" · ");
}

function speed(mbps: number): string {
  if (!mbps) return "";
  if (mbps >= 1000 && mbps % 100 === 0) return `${mbps / 1000} gbps`;
  return `${mbps} mbps`;
}

export function networkLine(box: BoxReport): string {
  if (box.network.kind === "none") return "not connected";
  return [box.network.kind === "wifi" ? "wi-fi" : "ethernet", speed(box.network.mbps)].filter(Boolean).join(" · ");
}

export function boxLines(box: BoxReport, smooth: SmoothState, named: Named = lower): BoxLine[] {
  return [
    { key: "tv", label: "tv", value: tvLine(box, named) },
    { key: "box", label: "box", value: boxLine(box, smooth, named) },
    { key: "games", label: "games", value: gamesLine(box, named) },
    { key: "space", label: "space", value: spaceLine(box) },
    { key: "network", label: "network", value: networkLine(box) },
  ];
}

// The units as they're written outside Terminal's lower case: 4K, Hz, GB,
// TB, Mbps and Gbps.
export function properUnits(text: string): string {
  return text
    .replace(/\b4k\b/g, "4K")
    .replace(/(\d) hz\b/g, "$1 Hz")
    .replace(/(\d) (g|t)b\b/g, (_, n: string, unit: string) => `${n} ${unit.toUpperCase()}B`)
    .replace(/(\d) (m|g)bps\b/g, (_, n: string, unit: string) => `${n} ${unit.toUpperCase()}bps`);
}

// The box in one line, for the phone's menu: "4k tv · light games · 1.6 tb
// free · wi-fi".
export function summary(box: BoxReport): string {
  const kind = tvKind(box);
  const games = box.verdicts.games === "good" ? "good for games" : box.verdicts.games === "light" ? "light games" : "not for games";
  const network = box.network.kind === "none" ? "" : box.network.kind === "wifi" ? "wi-fi" : "ethernet";
  return [kind, games, box.storage.totalGb ? spaceLine(box) : "", network].filter(Boolean).join(" · ");
}
