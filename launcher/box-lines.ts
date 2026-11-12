// What the box check found, in words, the same on setup's box step, in
// Settings → About and on the phone (ADR-061). One line a finding, written
// in sentence case with names and units as they are: Terminal and setup show
// them in lower case themselves. No DOM here, so the daemon says the phone's
// line with it too.

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

export interface BoxLine {
  key: "tv" | "box" | "games" | "space" | "network";
  label: string;
  value: string;
}

function mode(name: string): { width: number; height: number; refresh: number } | null {
  const m = /^(\d+)x(\d+)@(\d+)$/.exec(name);
  return m ? { width: Number(m[1]), height: Number(m[2]), refresh: Number(m[3]) } : null;
}

// "4K TV", "1080p TV", or the screen's own size.
export function tvKind(box: BoxReport): string {
  const best = mode(box.tv.modes[0] ?? "");
  if (!best) return "";
  if (best.width >= 3840) return box.tv.hdr ? "4K HDR TV" : "4K TV";
  if (best.width === 1920 && best.height === 1080) return "1080p TV";
  if (best.width === 1280 && best.height === 720) return "720p TV";
  return `${best.width} × ${best.height} screen`;
}

// The TV's maker, from the name it gives: TVs start it with their brand
// ("Panasonic-TV" is "Panasonic", "LG TV SSCR2" is "LG").
function tvMaker(name: string): string {
  const first = name.trim().split(/[-_ ]+/)[0];
  return first.toLowerCase() === "tv" ? name.trim() : first;
}

export function tvLine(box: BoxReport): string {
  const kind = tvKind(box);
  if (!kind) return "Couldn't check the TV";
  const best = mode(box.tv.modes[0])!;
  return [kind, tvMaker(box.tv.name), `${best.refresh} Hz`].filter(Boolean).join(" · ");
}

function gb(n: number): string {
  if (n >= 1000) return `${Math.round((n / 1024) * 10) / 10} TB`;
  return `${n} GB`;
}

export function spaceLine(box: BoxReport): string {
  if (!box.storage.totalGb) return "Couldn't check the disk";
  return box.verdicts.spaceLow ? `Only ${gb(box.storage.freeGb)} free` : `${gb(box.storage.freeGb)} free`;
}

const MAKERS: Record<string, string> = { intel: "Intel", amd: "AMD", nvidia: "NVIDIA" };

function gpu(box: BoxReport): string {
  return [MAKERS[box.gpu.vendor] ?? "", box.gpu.name].filter(Boolean).join(" ");
}

// What to expect of games here, as a line's first words.
function gamesVerdict(box: BoxReport): string {
  return box.verdicts.games === "good" ? "Good for games" : box.verdicts.games === "light" ? "Light games" : "Not for games";
}

export function gamesLine(box: BoxReport): string {
  return [gamesVerdict(box), gpu(box)].filter(Boolean).join(" · ");
}

// What the box itself does with the TV: on a 4K TV, whether 4K stays
// smooth; on any other, its CPU and memory.
export function boxLine(box: BoxReport, smooth: SmoothState): string {
  if (box.verdicts.fourK) {
    if (smooth === "checking") return "Checking 4K…";
    if (box.verdicts.fourKSmooth || smooth === "passed") return "Smooth at 4K";
    if (smooth === "failed") return "Better at 1080p";
    return "4K not checked yet";
  }
  return [box.cpu.name, box.memoryGb ? `${box.memoryGb} GB` : ""].filter(Boolean).join(" · ");
}

function speed(mbps: number): string {
  if (!mbps) return "";
  if (mbps >= 1000 && mbps % 100 === 0) return `${mbps / 1000} Gbps`;
  return `${mbps} Mbps`;
}

export function networkLine(box: BoxReport): string {
  if (box.network.kind === "none") return "Not connected";
  return [box.network.kind === "wifi" ? "Wi-Fi" : "Cable", speed(box.network.mbps)].filter(Boolean).join(" · ");
}

export function boxLines(box: BoxReport, smooth: SmoothState): BoxLine[] {
  return [
    { key: "tv", label: "TV", value: tvLine(box) },
    { key: "box", label: "Computer", value: boxLine(box, smooth) },
    { key: "games", label: "Games", value: gamesLine(box) },
    { key: "space", label: "Space", value: spaceLine(box) },
    { key: "network", label: "Network", value: networkLine(box) },
  ];
}

// The units with their capitals, for a line written in lower case. The lines
// above are written with them now, so this changes nothing of theirs. It
// stays until Settings stops calling it.
export function properUnits(text: string): string {
  return text
    .replace(/\b4k\b/g, "4K")
    .replace(/(\d) hz\b/g, "$1 Hz")
    .replace(/(\d) (g|t)b\b/g, (_, n: string, unit: string) => `${n} ${unit.toUpperCase()}B`)
    .replace(/(\d) (m|g)bps\b/g, (_, n: string, unit: string) => `${n} ${unit.toUpperCase()}bps`);
}

// A line's first letter in lower case, for a line that follows another.
const after = (text: string) => text.slice(0, 1).toLowerCase() + text.slice(1);

// The box in one line, for the phone's menu: "4K TV · light games · 1.6 TB
// free · Wi-Fi".
export function summary(box: BoxReport): string {
  const kind = tvKind(box);
  const network = box.network.kind === "none" ? "" : box.network.kind === "wifi" ? "Wi-Fi" : "cable";
  const parts = [kind, after(gamesVerdict(box)), box.storage.totalGb ? after(spaceLine(box)) : "", network].filter(Boolean);
  return parts.join(" · ").replace(/^./, (first) => first.toUpperCase());
}
