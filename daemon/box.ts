// The box check (ADR-061, PHASE-2-PLAN.md track 3): what this box is, and
// the four things setup and the box decide from it. GET /api/box answers
// with the shape the plan's "Shared interfaces" sets, which tracks 4, 6 and 7
// build against.
//
// It reads, as the daemon's own user:
// - the machine's model, from the firmware's DMI table;
// - the CPU and its threads, from /proc/cpuinfo, and the memory, from the
//   memory blocks the kernel has online (or MemTotal);
// - the free space where AgenTV keeps its things (/var/lib/agentv);
// - each GPU, from sysfs's PCI devices, never lspci, which wakes a sleeping
//   GPU. Its name comes from hwdata's pci.ids, the video it decodes in
//   hardware from vainfo, and whether it's integrated or discrete, with
//   Vulkan, from vulkaninfo;
// - the TV's modes, HDR and audio formats, from its EDID in sysfs;
// - the network the box is on and its link speed, from sysfs or nmcli;
// - Bluetooth adapters and gamepads, from sysfs and udev's database;
// - Widevine, which only the TV session can see in the services' Chromium,
//   so the screen daemon tells the daemon (WidevineWatch, below).
//
// The readers only gather text and bytes into Readings. Everything that
// makes sense of them is a plain function on Readings, so the unit tests run
// it on recorded readings: `agentv box readings` prints them on a real box.
//
// Whether the box keeps 4K smooth is measured, not guessed: the TV's own
// Chromium draws a home-like scene at the TV's full resolution for five
// seconds and counts its frames (launcher/box-smooth.ts). The result is kept
// with the GPU it ran on, so a new GPU is checked again.

import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, statfs, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import type { BoxReport } from "../launcher/box-lines.ts";
import { HOTSPOT_ADDRESS } from "./hotspot.ts";

// --- What GET /api/box answers --------------------------------------------

// The shape itself lives with the words that describe it, which the TV's
// pages share: launcher/box-lines.ts.
export type { BoxReport };
export type GpuVendor = BoxReport["gpu"]["vendor"];
export type Games = BoxReport["verdicts"]["games"];
export type NetworkKind = BoxReport["network"]["kind"];

// Under this much free space, space is short: Music's library or a big build
// could fill it.
export const SPACE_LOW_GB = 32;

// The 4K test passes at this many frames a second or more, with no more than
// this share of frames late (over 25 ms).
export const SMOOTH_FPS = 57;
export const SMOOTH_SLOW = 0.05;

// --- The readings ---------------------------------------------------------

export interface GpuReading {
  slot: string; // "0000:00:02.0"
  class: string; // "0x030000"
  vendor: string; // "0x8086"
  device: string; // "0x3ea5"
  vendorName: string; // from pci.ids, or ""
  deviceName: string; // from pci.ids, or ""
  bootVga: boolean;
  cards: string[]; // its DRM cards: ["card1"]
  render: string | null; // its render node: "renderD128"
  vainfo: string | null; // what vainfo printed for it, or null when it couldn't run
}

export interface Readings {
  dmi: { product: string; board: string; vendor: string };
  cpuinfo: string; // /proc/cpuinfo's processor and model name lines
  meminfo: string; // /proc/meminfo's MemTotal line
  memoryBlocks: { size: number; online: number } | null;
  gpus: GpuReading[];
  vulkaninfo: string | null; // vulkaninfo --summary, or null
  icds: string[]; // Vulkan's driver files: "intel_icd.x86_64.json"
  // Each display connector the kernel has, with its EDID in base64 (serial
  // numbers zeroed), or "" when nothing's connected.
  connectors: { name: string; status: string; edid: string }[];
  storage: { total: number; free: number } | null; // bytes
  // The network the box is on, and its speed as sysfs ("1000") or nmcli
  // ("433 Mb/s") says it.
  network: { kind: NetworkKind; speed: string | null };
  bluetooth: string[]; // "hci0"
  gamepads: string[]; // their names
  widevine: string | null; // the services' Chromium's Widevine version
}

// --- The TV's EDID --------------------------------------------------------

export interface Mode {
  width: number;
  height: number;
  refresh: number;
}

export interface Edid {
  maker: string; // the PNP id, "MEI"
  name: string; // the monitor name descriptor, "Panasonic-TV"
  modes: Mode[];
  hdr: boolean;
  audio: string[];
}

// CTA-861's video ids, progressive only: 64:27 ones have the same pixels as
// their 16:9 twins, and pixel-repeated and interlaced ones are left out.
const VICS = new Map<number, Mode>();
function vics(width: number, height: number, pairs: [number, number][]): void {
  for (const [vic, refresh] of pairs) VICS.set(vic, { width, height, refresh });
}
vics(640, 480, [[1, 60]]);
vics(720, 480, [[2, 60], [3, 60], [48, 120], [49, 120], [56, 240], [57, 240]]);
vics(720, 576, [[17, 50], [18, 50], [42, 100], [43, 100], [52, 200], [53, 200]]);
vics(1280, 720, [[4, 60], [19, 50], [41, 100], [47, 120], [60, 24], [61, 25], [62, 30], [65, 24], [66, 25], [67, 30], [68, 50], [69, 60], [70, 100], [71, 120], [108, 48], [109, 48]]);
vics(1680, 720, [[79, 24], [80, 25], [81, 30], [82, 50], [83, 60], [84, 100], [85, 120], [110, 48]]);
vics(1920, 1080, [[16, 60], [31, 50], [32, 24], [33, 25], [34, 30], [63, 120], [64, 100], [72, 24], [73, 25], [74, 30], [75, 50], [76, 60], [77, 100], [78, 120], [111, 48], [112, 48]]);
vics(2560, 1080, [[86, 24], [87, 25], [88, 30], [89, 50], [90, 60], [91, 100], [92, 120], [113, 48]]);
vics(3840, 2160, [[93, 24], [94, 25], [95, 30], [96, 50], [97, 60], [103, 24], [104, 25], [105, 30], [106, 50], [107, 60], [114, 48], [116, 48], [117, 100], [118, 120], [119, 100], [120, 120]]);
vics(4096, 2160, [[98, 24], [99, 25], [100, 30], [101, 50], [102, 60], [115, 48], [218, 100], [219, 120]]);
vics(5120, 2160, [[121, 24], [122, 25], [123, 30], [124, 48], [125, 50], [126, 60], [127, 100], [193, 120]]);
vics(7680, 4320, [[194, 24], [195, 25], [196, 30], [197, 48], [198, 50], [199, 60], [200, 100], [201, 120], [202, 24], [203, 25], [204, 30], [205, 48], [206, 50], [207, 60], [208, 100], [209, 120]]);
vics(10240, 4320, [[210, 24], [211, 25], [212, 30], [213, 48], [214, 50], [215, 60], [216, 100], [217, 120]]);

// HDMI 1.4's own video ids, in its vendor block.
const HDMI_VICS: Record<number, Mode> = {
  1: { width: 3840, height: 2160, refresh: 30 },
  2: { width: 3840, height: 2160, refresh: 25 },
  3: { width: 3840, height: 2160, refresh: 24 },
  4: { width: 4096, height: 2160, refresh: 24 },
};

// The base block's established timings, bit by bit from byte 35's top bit.
// 1024 × 768 at 87 Hz is interlaced, so it's null.
const ESTABLISHED: (Mode | null)[] = [
  { width: 720, height: 400, refresh: 70 },
  { width: 720, height: 400, refresh: 88 },
  { width: 640, height: 480, refresh: 60 },
  { width: 640, height: 480, refresh: 67 },
  { width: 640, height: 480, refresh: 72 },
  { width: 640, height: 480, refresh: 75 },
  { width: 800, height: 600, refresh: 56 },
  { width: 800, height: 600, refresh: 60 },
  { width: 800, height: 600, refresh: 72 },
  { width: 800, height: 600, refresh: 75 },
  { width: 832, height: 624, refresh: 75 },
  null,
  { width: 1024, height: 768, refresh: 60 },
  { width: 1024, height: 768, refresh: 70 },
  { width: 1024, height: 768, refresh: 75 },
  { width: 1280, height: 1024, refresh: 75 },
  { width: 1152, height: 870, refresh: 75 },
];

// Short audio descriptors' formats.
const AUDIO: Record<number, string> = {
  1: "pcm",
  2: "ac3",
  3: "mpeg1",
  4: "mp3",
  5: "mpeg2",
  6: "aac",
  7: "dts",
  8: "atrac",
  9: "dsd",
  10: "eac3",
  11: "dtshd",
  12: "truehd",
  13: "dst",
  14: "wmapro",
};

const HDMI_OUI = 0x000c03;

// A detailed timing descriptor's mode, or null for an interlaced or empty one.
function detailed(d: Uint8Array): Mode | null {
  const clock = (d[0] | (d[1] << 8)) * 10_000;
  const width = d[2] | ((d[4] & 0xf0) << 4);
  const hblank = d[3] | ((d[4] & 0x0f) << 8);
  const height = d[5] | ((d[7] & 0xf0) << 4);
  const vblank = d[6] | ((d[7] & 0x0f) << 8);
  if (!clock || !width || !height || d[17] & 0x80) return null;
  return { width, height, refresh: Math.round(clock / ((width + hblank) * (height + vblank))) };
}

// A short video descriptor's video id (CTA-861-F): 129 to 192 are 1 to 64
// marked native.
function svd(b: number): number {
  if (b >= 129 && b <= 192) return b - 128;
  return b;
}

function cta(block: Uint8Array, add: (mode: Mode | null | undefined) => void, audio: Set<number>): boolean {
  let hdr = false;
  const end = block[2];
  if (block[3] & 0x40) audio.add(1); // basic audio is PCM
  if (end >= 4) {
    for (let i = 4; i < end && i < 127; ) {
      const tag = block[i] >> 5;
      const length = block[i] & 0x1f;
      const p = block.subarray(i + 1, Math.min(i + 1 + length, 127));
      if (tag === 1) {
        for (let j = 0; j + 2 < p.length; j += 3) audio.add((p[j] >> 3) & 0x0f);
      } else if (tag === 2) {
        for (const b of p) add(VICS.get(svd(b)));
      } else if (tag === 3 && p.length >= 3 && (p[0] | (p[1] << 8) | (p[2] << 16)) === HDMI_OUI && p.length >= 8) {
        // HDMI 1.4's block: past the latency fields, when HDMI_Video_present
        // says so, comes a count of HDMI's own video ids, then the ids.
        let at = 8;
        if (p[7] & 0x80) at += 2;
        if (p[7] & 0x40) at += 2;
        if (p[7] & 0x20 && at + 1 < p.length) {
          const count = p[at + 1] >> 5;
          for (let k = 0; k < count && at + 2 + k < p.length; k++) add(HDMI_VICS[p[at + 2 + k]]);
        }
      } else if (tag === 7 && p.length >= 1) {
        // The HDR static metadata block: PQ (HDR10) or HLG.
        if (p[0] === 6 && p.length >= 2 && p[1] & 0x0c) hdr = true;
        // The YCbCr 4:2:0 video block: modes the TV takes in 4:2:0 only.
        if (p[0] === 14) for (const b of p.subarray(1)) add(VICS.get(svd(b)));
      }
      i += 1 + length;
    }
  }
  if (end >= 4) {
    for (let at = end; at + 18 <= 127; at += 18) {
      const d = block.subarray(at, at + 18);
      if (!d[0] && !d[1]) break;
      add(detailed(d));
    }
  }
  return hdr;
}

// The modes, the best first: the most lines, 16:9 before wider or narrower
// at the same lines, then the widest, then the fastest.
export function sortModes(modes: Mode[]): Mode[] {
  const off = (m: Mode) => Math.abs(m.width / m.height - 16 / 9);
  return [...modes].sort((a, b) => b.height - a.height || off(a) - off(b) || b.width - a.width || b.refresh - a.refresh);
}

export function modeName(m: Mode): string {
  return `${m.width}x${m.height}@${m.refresh}`;
}

export function parseEdid(bytes: Uint8Array): Edid | null {
  const header = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
  if (bytes.length < 128 || header.some((b, i) => bytes[i] !== b)) return null;
  const id = (bytes[8] << 8) | bytes[9];
  const maker = [10, 5, 0].map((shift) => String.fromCharCode(64 + ((id >> shift) & 0x1f))).join("");
  const seen = new Map<string, Mode>();
  const add = (mode: Mode | null | undefined) => {
    if (mode && mode.refresh > 0) seen.set(modeName(mode), mode);
  };
  const audio = new Set<number>();
  let name = "";
  let hdr = false;

  for (let bit = 0; bit < ESTABLISHED.length; bit++) {
    if (bytes[35 + (bit >> 3)] & (0x80 >> (bit & 7))) add(ESTABLISHED[bit]);
  }
  const revision = bytes[19];
  for (let at = 38; at < 54; at += 2) {
    const [b1, b2] = [bytes[at], bytes[at + 1]];
    if (!b1 || (b1 === 1 && b2 === 1)) continue;
    const width = (b1 + 31) * 8;
    const aspect = b2 >> 6;
    const ratio = aspect === 0 ? (revision >= 3 ? 10 / 16 : 1) : aspect === 1 ? 3 / 4 : aspect === 2 ? 4 / 5 : 9 / 16;
    add({ width, height: Math.round(width * ratio), refresh: (b2 & 0x3f) + 60 });
  }
  for (let at = 54; at < 126; at += 18) {
    const d = bytes.subarray(at, at + 18);
    if (d[0] || d[1]) add(detailed(d));
    else if (d[3] === 0xfc) {
      const text = String.fromCharCode(...d.subarray(5, 18));
      name = text.split("\n")[0].trim();
    }
  }
  for (let at = 128; at + 128 <= bytes.length; at += 128) {
    const block = bytes.subarray(at, at + 128);
    if (block[0] === 0x02 && cta(block, add, audio)) hdr = true;
  }
  return {
    maker,
    name,
    modes: sortModes([...seen.values()]),
    hdr,
    audio: [...audio].sort((a, b) => a - b).flatMap((code) => (AUDIO[code] ? [AUDIO[code]] : [])),
  };
}

// An EDID with its serial numbers zeroed, for readings that may be shared:
// the base block's serial and any serial number descriptor.
export function anonymousEdid(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  if (out.length < 128) return out;
  out.fill(0, 12, 16);
  for (let at = 54; at < 126; at += 18) {
    if (!out[at] && !out[at + 1] && out[at + 3] === 0xff) {
      out[at + 5] = 0x0a;
      out.fill(0x20, at + 6, at + 18);
    }
  }
  let sum = 0;
  for (let i = 0; i < 127; i++) sum += out[i];
  out[127] = (256 - (sum % 256)) % 256;
  return out;
}

// --- The CPU, the memory and the model -------------------------------------

export function cpuName(cpuinfo: string): string {
  const raw = /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1] ?? "";
  return raw
    .replace(/\((R|TM|tm|r)\)/g, "")
    .replace(/@\s*[\d.]+\s*GHz/i, "")
    .replace(/\bwith Radeon( Vega)? Graphics\b/i, "")
    .replace(/\b\d+-Core Processor\b/i, "")
    .replace(/\b(CPU|Processor)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function cpuThreads(cpuinfo: string): number {
  return (cpuinfo.match(/^processor\s*:/gm) ?? []).length;
}

// The memory in whole GB: the blocks the kernel has online, which count what
// the firmware keeps for itself too, or else MemTotal, which doesn't, rounded
// up to the next 2 GB from 4 GB on, as memory comes.
export function memoryGb(meminfo: string, blocks: Readings["memoryBlocks"]): number {
  if (blocks && blocks.size > 0 && blocks.online > 0) return Math.round((blocks.size * blocks.online) / 2 ** 30);
  const gb = Number(/^MemTotal:\s*(\d+)\s*kB/m.exec(meminfo)?.[1] ?? 0) / 2 ** 20;
  if (!gb) return 0;
  return gb > 3 ? Math.ceil(gb / 2) * 2 : Math.ceil(gb);
}

// What the firmware says the machine is, unless it's a board maker's filler.
const FILLER = /^(|to be filled by o\.?e\.?m\.?|system product name|system version|default string|not applicable|not specified|none|unknown|o\.?e\.?m\.?|x\.x|type1productconfigid|invalid)$/i;

export function modelName(dmi: Readings["dmi"]): string {
  for (const value of [dmi.product, dmi.board, dmi.vendor]) {
    const clean = value.trim();
    if (!FILLER.test(clean)) return clean;
  }
  return "";
}

// --- The GPU --------------------------------------------------------------

export function gpuVendor(id: string): GpuVendor {
  const vendor = id.toLowerCase().replace(/^0x/, "");
  if (vendor === "8086") return "intel";
  if (vendor === "1002" || vendor === "1022") return "amd";
  if (vendor === "10de") return "nvidia";
  return "other";
}

// The codecs that matter for the TV, in this order, from what vainfo lists
// with a decode (VLD) entrypoint.
const CODECS: [RegExp, string][] = [
  [/^VAProfileH264/, "h264"],
  [/^VAProfileHEVC/, "hevc"],
  [/^VAProfileVP9/, "vp9"],
  [/^VAProfileAV1/, "av1"],
];

export function parseVainfo(text: string | null): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const [, profile, entry] of text.matchAll(/^\s*(VAProfile\w+)\s*:\s*(VAEntrypoint\w+)/gm)) {
    if (entry !== "VAEntrypointVLD") continue;
    for (const [pattern, codec] of CODECS) if (pattern.test(profile)) found.add(codec);
  }
  return CODECS.map(([, codec]) => codec).filter((codec) => found.has(codec));
}

export interface VulkanDevice {
  vendor: number;
  device: number;
  type: "integrated" | "discrete" | "virtual" | "cpu" | "other";
  name: string;
}

export function parseVulkaninfo(text: string | null): VulkanDevice[] {
  if (!text) return [];
  const devices: VulkanDevice[] = [];
  for (const block of text.split(/^GPU\d+:\s*$/m).slice(1)) {
    const field = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(block)?.[1] ?? "";
    const type = field("deviceType");
    devices.push({
      vendor: Number.parseInt(field("vendorID"), 16) || 0,
      device: Number.parseInt(field("deviceID"), 16) || 0,
      type: /INTEGRATED/.test(type) ? "integrated" : /DISCRETE/.test(type) ? "discrete" : /VIRTUAL/.test(type) ? "virtual" : /CPU/.test(type) ? "cpu" : "other",
      name: field("deviceName"),
    });
  }
  return devices;
}

function vulkanFor(gpu: GpuReading, devices: VulkanDevice[]): VulkanDevice | undefined {
  const vendor = Number.parseInt(gpu.vendor, 16);
  const device = Number.parseInt(gpu.device, 16);
  return devices.find((d) => d.vendor === vendor && d.device === device && d.type !== "cpu");
}

// The GPU's name as people know it: Vulkan's ("Intel(R) Iris(R) Plus Graphics
// 655 (CFL GT3)" is "Iris Plus 655"), or the marketing name pci.ids puts in
// brackets ("CoffeeLake-U GT3e [Iris Plus Graphics 655]" is the same), or
// pci.ids' own, without "Graphics", the maker or its legal name.
export function gpuName(gpu: GpuReading, vulkan?: VulkanDevice): string {
  const tidy = (name: string) =>
    name
      .replace(/\((R|TM|tm)\)/g, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/^\s*(Intel|AMD|NVIDIA)\b/i, "")
      .replace(/\b(Graphics|Corporation|Corp\.|Inc\.)/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const brackets = [...gpu.deviceName.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]).filter((b) => b !== "AMD/ATI");
  for (const name of [vulkan?.name ?? "", brackets[brackets.length - 1] ?? "", gpu.deviceName]) {
    const clean = tidy(name);
    if (clean) return clean;
  }
  return `${gpu.vendor.replace(/^0x/, "")}:${gpu.device.replace(/^0x/, "")}`;
}

// The GPU's id, which the 4K test's result is kept with.
export function gpuId(gpu: GpuReading | undefined): string {
  if (!gpu) return "";
  return `${gpu.vendor.replace(/^0x/, "")}:${gpu.device.replace(/^0x/, "")}`.toLowerCase();
}

function discrete(gpu: GpuReading, devices: VulkanDevice[]): boolean {
  const vulkan = vulkanFor(gpu, devices);
  if (vulkan) return vulkan.type === "discrete";
  return gpuVendor(gpu.vendor) === "nvidia";
}

// Whether the GPU runs Vulkan: vulkaninfo lists it, or, without vulkaninfo,
// its maker's Vulkan driver is installed.
function hasVulkan(gpu: GpuReading, readings: Readings, devices: VulkanDevice[]): boolean {
  if (vulkanFor(gpu, devices)) return true;
  if (readings.vulkaninfo !== null) return false;
  const vendor = gpuVendor(gpu.vendor);
  const driver = vendor === "intel" ? /^intel(_hasvk)?_icd/ : vendor === "amd" ? /^radeon_icd/ : vendor === "nvidia" ? /^nvidia_icd/ : null;
  return Boolean(driver && readings.icds.some((file) => driver.test(file)));
}

// The GPU the box check talks about: a discrete one, which games run on, or
// the one the TV is plugged into, or the one the firmware started with.
export function mainGpu(readings: Readings): GpuReading | undefined {
  const devices = parseVulkaninfo(readings.vulkaninfo);
  const tvCard = readings.connectors.find((c) => c.status === "connected")?.name.split("-")[0];
  return (
    readings.gpus.find((gpu) => discrete(gpu, devices)) ??
    readings.gpus.find((gpu) => tvCard && gpu.cards.includes(tvCard)) ??
    readings.gpus.find((gpu) => gpu.bootVga) ??
    readings.gpus[0]
  );
}

// How well it games: "good" with a discrete GPU, "light" with an Intel or
// AMD integrated GPU that runs Vulkan, and "none" otherwise.
export function gamesVerdict(readings: Readings): Games {
  const devices = parseVulkaninfo(readings.vulkaninfo);
  if (readings.gpus.some((gpu) => discrete(gpu, devices))) return "good";
  const light = readings.gpus.some((gpu) => ["intel", "amd"].includes(gpuVendor(gpu.vendor)) && hasVulkan(gpu, readings, devices));
  return light ? "light" : "none";
}

// --- The TV, the network and the rest -------------------------------------

// Connectors built into the machine, such as a laptop's own screen, aren't
// the TV.
const BUILT_IN = /-(eDP|LVDS|DSI)-/;

export function tvConnector(readings: Readings): Readings["connectors"][number] | undefined {
  const connected = readings.connectors.filter((c) => c.status === "connected" && c.edid);
  return connected.find((c) => !BUILT_IN.test(c.name)) ?? connected[0];
}

export function parseSpeed(speed: string | null): number {
  if (!speed) return 0;
  const n = Number(/^\s*(\d+(?:\.\d+)?)/.exec(speed)?.[1] ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// --- The report -----------------------------------------------------------

export interface SmoothResult {
  gpu: string; // the GPU it ran on, "8086:3ea5"
  width: number; // the TV's output, in pixels, as the test drew it
  height: number;
  fps: number;
  slow: number; // the share of frames over 25 ms
  at: string;
}

export function smoothPassed(result: SmoothResult | null | undefined, gpu: string): boolean {
  return Boolean(result && gpu && result.gpu === gpu && result.width >= 3840 && result.fps >= SMOOTH_FPS && result.slow <= SMOOTH_SLOW);
}

export function report(readings: Readings, smooth: SmoothResult | null = null): BoxReport {
  const devices = parseVulkaninfo(readings.vulkaninfo);
  const gpu = mainGpu(readings);
  const connector = tvConnector(readings);
  const edid = connector ? parseEdid(Buffer.from(connector.edid, "base64")) : null;
  const totalGb = readings.storage ? Math.round(readings.storage.total / 2 ** 30) : 0;
  const freeGb = readings.storage ? Math.round(readings.storage.free / 2 ** 30) : 0;
  const modes = edid?.modes ?? [];
  return {
    model: modelName(readings.dmi),
    cpu: { name: cpuName(readings.cpuinfo), threads: cpuThreads(readings.cpuinfo) },
    memoryGb: memoryGb(readings.meminfo, readings.memoryBlocks),
    storage: { totalGb, freeGb },
    gpu: gpu ? { vendor: gpuVendor(gpu.vendor), name: gpuName(gpu, vulkanFor(gpu, devices)), decode: parseVainfo(gpu.vainfo) } : { vendor: "other", name: "", decode: [] },
    tv: { name: edid?.name ?? "", modes: modes.map(modeName), hdr: edid?.hdr ?? false, audio: edid?.audio ?? [] },
    network: { kind: readings.network.kind, mbps: readings.network.kind === "none" ? 0 : parseSpeed(readings.network.speed) },
    bluetooth: readings.bluetooth.length > 0,
    gamepads: readings.gamepads.length,
    widevine: Boolean(readings.widevine),
    verdicts: {
      fourK: modes.some((m) => m.width >= 3840),
      fourKSmooth: smoothPassed(smooth, gpuId(gpu)),
      games: gamesVerdict(readings),
      spaceLow: Boolean(readings.storage) && freeGb < SPACE_LOW_GB,
    },
  };
}

// --- Reading the box ------------------------------------------------------

export type Exec = (command: string, args: string[]) => Promise<string | null>;

// A command's output, or null when it isn't there, fails or takes too long.
export const exec: Exec = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => resolve(error ? null : stdout));
  });

export interface ReadOptions {
  root?: string; // "/", or a tree a test made
  exec?: Exec;
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  // The folder whose free space counts: where AgenTV keeps its things.
  disk?: string;
  widevine?: string | null;
  // A stand-in machine for the screen tests: recorded readings, read in
  // place of this one's.
  machine?: Omit<Readings, "widevine">;
}

async function text(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

async function list(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

// pci.ids' names for these vendor and device ids, in one pass over the file.
export function pciNames(ids: string, wanted: { vendor: string; device: string }[]): Map<string, { vendorName: string; deviceName: string }> {
  const want = new Set(wanted.map((w) => w.vendor.replace(/^0x/, "").toLowerCase()));
  const names = new Map<string, { vendorName: string; deviceName: string }>();
  let vendor = "";
  let vendorName = "";
  for (const line of ids.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const top = /^([0-9a-f]{4})\s+(.+)$/.exec(line);
    if (top) {
      vendor = top[1];
      vendorName = top[2];
      if (want.has(vendor)) names.set(vendor, { vendorName, deviceName: "" });
      continue;
    }
    if (line.startsWith("C ")) {
      vendor = ""; // the device classes at the end of the file
      continue;
    }
    const device = /^\t([0-9a-f]{4})\s+(.+)$/.exec(line);
    if (device && want.has(vendor)) names.set(`${vendor}:${device[1]}`, { vendorName, deviceName: device[2] });
  }
  return names;
}

const PCI_IDS = ["usr/share/hwdata/pci.ids", "usr/share/misc/pci.ids"];

async function readGpus(root: string, run: Exec): Promise<GpuReading[]> {
  const pci = join(root, "sys/bus/pci/devices");
  const gpus: GpuReading[] = [];
  for (const slot of await list(pci)) {
    const cls = await text(join(pci, slot, "class"));
    if (!cls.startsWith("0x03")) continue;
    const drm = await list(join(pci, slot, "drm"));
    gpus.push({
      slot,
      class: cls,
      vendor: await text(join(pci, slot, "vendor")),
      device: await text(join(pci, slot, "device")),
      vendorName: "",
      deviceName: "",
      bootVga: (await text(join(pci, slot, "boot_vga"))) === "1",
      cards: drm.filter((name) => /^card\d+$/.test(name)),
      render: drm.find((name) => /^renderD\d+$/.test(name)) ?? null,
      vainfo: null,
    });
  }
  if (!gpus.length) return gpus;
  let ids = "";
  for (const file of PCI_IDS) {
    ids = await text(join(root, file));
    if (ids) break;
  }
  const names = pciNames(ids, gpus);
  for (const gpu of gpus) {
    const vendor = gpu.vendor.replace(/^0x/, "").toLowerCase();
    const found = names.get(`${vendor}:${gpu.device.replace(/^0x/, "").toLowerCase()}`) ?? names.get(vendor);
    gpu.vendorName = found?.vendorName ?? "";
    gpu.deviceName = found?.deviceName ?? "";
    if (gpu.render) gpu.vainfo = await run("vainfo", ["--display", "drm", "--device", `/dev/dri/${gpu.render}`]);
  }
  return gpus;
}

async function readConnectors(root: string): Promise<Readings["connectors"]> {
  const drm = join(root, "sys/class/drm");
  const out: Readings["connectors"] = [];
  for (const name of await list(drm)) {
    if (!/^card\d+-/.test(name)) continue;
    const status = await text(join(drm, name, "status"));
    let edid = "";
    if (status === "connected") {
      try {
        const bytes = await readFile(join(drm, name, "edid"));
        if (bytes.length >= 128) edid = Buffer.from(anonymousEdid(bytes)).toString("base64");
      } catch {
        // No EDID to read.
      }
    }
    out.push({ name, status, edid });
  }
  return out;
}

// The network the box is on: a wired or Wi-Fi address that isn't its own
// setup hotspot's, wired first. Its speed: sysfs for a wire, nmcli for Wi-Fi.
async function readNetwork(root: string, run: Exec, interfaces: () => ReturnType<typeof networkInterfaces>): Promise<Readings["network"]> {
  const up = Object.entries(interfaces()).filter(
    ([name, addresses]) => /^(en|eth|wl)/.test(name) && addresses?.some((a) => a.family === "IPv4" && !a.internal && a.address !== HOTSPOT_ADDRESS),
  );
  const wired = up.find(([name]) => !name.startsWith("wl"));
  const [name] = wired ?? up[0] ?? [];
  if (!name) return { kind: "none", speed: null };
  if (wired) return { kind: "ethernet", speed: (await text(join(root, "sys/class/net", name, "speed"))) || null };
  const speed = await run("nmcli", ["-g", "CAPABILITIES.SPEED", "device", "show", name]);
  return { kind: "wifi", speed: speed?.trim() || null };
}

// Gamepads: the input devices udev marked as joysticks, each with how it's
// connected, which the kernel keeps as the device's bus (3 is USB, 5 is
// Bluetooth).
export interface Pad {
  name: string;
  bus: "usb" | "bluetooth" | "other";
}

export async function readPads(root: string): Promise<Pad[]> {
  const input = join(root, "sys/class/input");
  const pads: Pad[] = [];
  for (const event of await list(input)) {
    if (!/^event\d+$/.test(event)) continue;
    const dev = await text(join(input, event, "dev"));
    if (!dev) continue;
    const db = await text(join(root, "run/udev/data", `c${dev}`));
    if (!/^E:ID_INPUT_JOYSTICK=1$/m.test(db)) continue;
    const bus = Number.parseInt(await text(join(input, event, "device/id/bustype")), 16);
    pads.push({ name: (await text(join(input, event, "device/name"))) || event, bus: bus === 3 ? "usb" : bus === 5 ? "bluetooth" : "other" });
  }
  return pads;
}

async function readGamepads(root: string): Promise<string[]> {
  return (await readPads(root)).map((pad) => pad.name);
}

async function readMemoryBlocks(root: string): Promise<Readings["memoryBlocks"]> {
  const memory = join(root, "sys/devices/system/memory");
  const size = Number.parseInt(await text(join(memory, "block_size_bytes")), 16);
  if (!size) return null;
  let online = 0;
  for (const block of await list(memory)) {
    if (/^memory\d+$/.test(block) && (await text(join(memory, block, "online"))) === "1") online++;
  }
  return online ? { size, online } : null;
}

async function readStorage(path: string): Promise<Readings["storage"]> {
  for (const at of [path, "/"]) {
    try {
      const fs = await statfs(at);
      return { total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize };
    } catch {
      // Try the next.
    }
  }
  return null;
}

// What never changes while the box runs, read once.
async function readFixed(root: string): Promise<Pick<Readings, "dmi" | "cpuinfo" | "meminfo" | "memoryBlocks">> {
  const dmi = join(root, "sys/class/dmi/id");
  const cpuinfo = (await text(join(root, "proc/cpuinfo")))
    .split("\n")
    .filter((line) => /^(processor|model name)\s*:/.test(line))
    .join("\n");
  const meminfo = (await text(join(root, "proc/meminfo"))).split("\n").find((line) => line.startsWith("MemTotal:")) ?? "";
  return {
    dmi: { product: await text(join(dmi, "product_name")), board: await text(join(dmi, "board_name")), vendor: await text(join(dmi, "sys_vendor")) },
    cpuinfo,
    meminfo,
    memoryBlocks: await readMemoryBlocks(root),
  };
}

// --- The box, with what it remembers --------------------------------------

export interface BoxOptions extends ReadOptions {
  state: string; // the daemon's own state: box.json goes there
}

interface Saved {
  smooth: SmoothResult | null;
  widevine: string | null;
}

const VERSION = /^[0-9][0-9.]{0,31}$/;

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
}

export class Box {
  private options: BoxOptions;
  private path: string;
  private fixed?: Promise<Pick<Readings, "dmi" | "cpuinfo" | "meminfo" | "memoryBlocks">>;
  // The GPUs' slower readings (pci.ids, vainfo, vulkaninfo), kept until the
  // GPUs change.
  private gpuCache: { key: string; gpus: GpuReading[]; vulkaninfo: string | null; icds: string[] } | null = null;

  constructor(options: BoxOptions) {
    this.options = options;
    this.path = join(options.state, "box.json");
  }

  private get root(): string {
    return this.options.root ?? "/";
  }

  private async saved(): Promise<Saved> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
      const smooth = data.smooth as SmoothResult | null;
      return {
        smooth: smooth && typeof smooth.gpu === "string" && typeof smooth.fps === "number" ? smooth : null,
        widevine: typeof data.widevine === "string" && VERSION.test(data.widevine) ? data.widevine : null,
      };
    } catch {
      return { smooth: null, widevine: null };
    }
  }

  private async save(saved: Saved): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const next = join(dirname(this.path), ".box.json.next");
    await writeFile(next, `${JSON.stringify(saved, null, 2)}\n`);
    await rename(next, this.path);
  }

  private async gpuReadings(): Promise<{ gpus: GpuReading[]; vulkaninfo: string | null; icds: string[] }> {
    const root = this.root;
    const run = this.options.exec ?? exec;
    const pci = join(root, "sys/bus/pci/devices");
    const key: string[] = [];
    for (const slot of await list(pci)) {
      const cls = await text(join(pci, slot, "class"));
      if (cls.startsWith("0x03")) key.push(`${slot}=${await text(join(pci, slot, "vendor"))}:${await text(join(pci, slot, "device"))}`);
    }
    if (this.gpuCache?.key === key.join(",")) return this.gpuCache;
    const icds = [...(await list(join(root, "usr/share/vulkan/icd.d"))), ...(await list(join(root, "etc/vulkan/icd.d")))];
    const [gpus, vulkaninfo] = await Promise.all([readGpus(root, run), run("vulkaninfo", ["--summary"])]);
    this.gpuCache = { key: key.join(","), gpus, vulkaninfo, icds };
    return this.gpuCache;
  }

  // Everything the box check reads, as `agentv box readings` prints it.
  async readings(): Promise<Readings> {
    if (this.options.machine) return { ...structuredClone(this.options.machine), widevine: (await this.saved()).widevine };
    const root = this.root;
    this.fixed ??= readFixed(root);
    const run = this.options.exec ?? exec;
    const [fixed, gpu, connectors, storage, network, bluetooth, gamepads, saved] = await Promise.all([
      this.fixed,
      this.gpuReadings(),
      readConnectors(root),
      readStorage(this.options.disk ?? "/var/lib/agentv"),
      readNetwork(root, run, this.options.interfaces ?? networkInterfaces),
      list(join(root, "sys/class/bluetooth")).then((all) => all.filter((name) => /^hci\d+$/.test(name))),
      readGamepads(root),
      this.saved(),
    ]);
    return { ...fixed, gpus: gpu.gpus, vulkaninfo: gpu.vulkaninfo, icds: gpu.icds, connectors, storage, network, bluetooth, gamepads, widevine: saved.widevine };
  }

  // The game controllers the box has right now, for Settings, controllers.
  // Read each time, like the count in the report, so one that was just
  // paired or removed shows without a restart.
  async pads(): Promise<Pad[]> {
    if (this.options.machine) return this.options.machine.gamepads.map((name) => ({ name, bus: "usb" as const }));
    return readPads(this.root);
  }

  async report(): Promise<BoxReport> {
    const [readings, saved] = await Promise.all([this.readings(), this.saved()]);
    return report(readings, saved.smooth);
  }

  // The 4K test: whether it should run (the TV is 4K and there's no result
  // for this GPU yet), and the last result.
  async smooth(): Promise<{ gpu: string; needed: boolean; passed: boolean; result: SmoothResult | null }> {
    const [readings, saved] = await Promise.all([this.readings(), this.saved()]);
    const gpu = gpuId(mainGpu(readings));
    const fourK = report(readings, saved.smooth).verdicts.fourK;
    const current = saved.smooth?.gpu === gpu ? saved.smooth : null;
    return { gpu, needed: fourK && !current, passed: smoothPassed(current, gpu), result: current };
  }

  // A result from the TV's page, kept with the GPU it ran on.
  async saveSmooth(input: unknown): Promise<{ result?: SmoothResult; error?: string }> {
    const c = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const whole = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 16384;
    if (!whole(c.width) || !whole(c.height)) return { error: "width and height are the pixels the test drew" };
    if (typeof c.fps !== "number" || !(c.fps >= 0 && c.fps <= 1000)) return { error: "fps is the frames a second it counted" };
    if (typeof c.slow !== "number" || !(c.slow >= 0 && c.slow <= 1)) return { error: "slow is the share of late frames, 0 to 1" };
    const gpu = gpuId(mainGpu(await this.readings()));
    const result: SmoothResult = { gpu, width: c.width as number, height: c.height as number, fps: Math.round(c.fps * 10) / 10, slow: Math.round(c.slow * 1000) / 1000, at: now() };
    await this.save({ ...(await this.saved()), smooth: result });
    return { result };
  }

  // The services' Chromium's Widevine version, from the screen daemon.
  // True when it changed.
  async saveWidevine(version: unknown): Promise<{ changed?: boolean; error?: string }> {
    if (version !== null && !(typeof version === "string" && VERSION.test(version))) return { error: "a version, or null" };
    const saved = await this.saved();
    if (saved.widevine === version) return { changed: false };
    await this.save({ ...saved, widevine: version as string | null });
    return { changed: true };
  }
}

// --- Widevine, from the TV session ----------------------------------------

// The newest Widevine module in a Chromium profile, by its manifest.
export async function widevineVersion(profile: string): Promise<string | null> {
  const dir = join(profile, "WidevineCdm");
  let best: string | null = null;
  const newer = (a: string, b: string) => {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    return false;
  };
  for (const name of await list(dir)) {
    try {
      const version = (JSON.parse(await readFile(join(dir, name, "manifest.json"), "utf8")) as { version?: unknown }).version;
      if (typeof version === "string" && VERSION.test(version) && (!best || newer(version, best))) best = version;
    } catch {
      // Not a module.
    }
  }
  return best;
}

// Runs in the screen daemon, as the person: tells the daemon which Widevine
// the services' Chromium has, as it starts and whenever Chromium fetches a
// new one, which it does in the background a few minutes after its first
// start.
export class WidevineWatch {
  private options: { home: string; profile: string; log?: (line: string) => void };
  private watchers: FSWatcher[] = [];
  private told: string | null | undefined;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: { home: string; profile: string; log?: (line: string) => void }) {
    this.options = options;
  }

  start(): this {
    this.watchProfile();
    void this.tell();
    return this;
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    clearTimeout(this.timer);
  }

  // The profile itself, for WidevineCdm to appear, and WidevineCdm once it's
  // there, for a newer module. Chromium writes a lot, so changes settle for
  // a second first.
  private watchProfile(): void {
    const module = join(this.options.profile, "WidevineCdm");
    const changed = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (this.watchers.length < 2) {
          this.stop();
          this.watchProfile();
        }
        void this.tell();
      }, 1000);
    };
    for (const dir of [this.options.profile, module]) {
      try {
        const watcher = watch(dir, (_, name) => {
          if (dir === module || name === "WidevineCdm") changed();
        });
        watcher.on("error", () => {});
        this.watchers.push(watcher);
      } catch {
        // Not there yet.
      }
    }
  }

  private async tell(): Promise<void> {
    const version = await widevineVersion(this.options.profile);
    if (version === this.told) return;
    try {
      const response = await fetch(new URL("api/box/widevine", this.options.home), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) this.told = version;
    } catch (error) {
      this.options.log?.(`couldn't tell the daemon about widevine: ${(error as Error).message}`);
    }
  }
}
