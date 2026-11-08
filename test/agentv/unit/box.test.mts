// The box check (ADR-061, track 3): the parsers on recorded readings (T3.1),
// the readers on a made-up sysfs, and the daemon's routes. The readings in
// test/agentv/fixtures/box/ are what `agentv box readings` prints; the
// NUC8i5BEH's is a stand-in from its published specs until one is recorded
// on the NUC. The EDIDs in fixtures/box/edid/ are stand-ins too, checked
// with edid-decode.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  anonymousEdid,
  Box,
  cpuName,
  gamesVerdict,
  memoryGb,
  modelName,
  parseEdid,
  parseSpeed,
  pciNames,
  report,
  smoothPassed,
  widevineVersion,
  WidevineWatch,
  type Readings,
  type SmoothResult,
} from "../../../daemon/box.ts";
import { HOTSPOT_ADDRESS } from "../../../daemon/hotspot.ts";
import { Daemon } from "../../../daemon/server.ts";
import { Setup } from "../../../daemon/setup.ts";
import { boxLines, summary } from "../../../launcher/box-lines.ts";

const ROOT = join(import.meta.dirname, "../../..");
const FIXTURES = join(ROOT, "test/agentv/fixtures/box");
const scratch = mkdtempSync(join(tmpdir(), "agentv-box-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const readings = (name: string): Readings => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
const edid = (name: string) => readFileSync(join(FIXTURES, "edid", `${name}.bin`));
const passed = (gpu: string): SmoothResult => ({ gpu, width: 3840, height: 2160, fps: 59.8, slow: 0.01, at: "2026-11-05T10:00:00+00:00" });

test("T3.1 the NUC8i5BEH on its Panasonic gives the plan's own example", () => {
  const box = report(readings("nuc8i5beh"), passed("8086:3ea5"));
  const { modes, ...tv } = box.tv;
  assert.deepEqual(
    { ...box, tv },
    {
      model: "NUC8i5BEH",
      cpu: { name: "Intel Core i5-8259U", threads: 8 },
      memoryGb: 16,
      storage: { totalGb: 1863, freeGb: 1650 },
      gpu: { vendor: "intel", name: "Iris Plus 655", decode: ["h264", "hevc", "vp9"] },
      tv: { name: "Panasonic-TV", hdr: false, audio: ["pcm", "ac3"] },
      network: { kind: "wifi", mbps: 433 },
      bluetooth: true,
      gamepads: 0,
      widevine: true,
      verdicts: { fourK: true, fourKSmooth: true, games: "light", spaceLow: false },
    },
  );
  assert.equal(modes[0], "3840x2160@60", "the best mode first");
  assert.ok(modes.includes("1920x1080@60"));
  assert.deepEqual(
    boxLines(box, "passed").map((line) => `${line.label}: ${line.value}`),
    ["tv: 4k tv · panasonic · 60 hz", "box: keeps 4k smooth", "games: light games · intel iris plus 655", "space: 1.6 tb free", "network: wi-fi · 433 mbps"],
    "the box step's lines, as D3 draws them",
  );
  assert.equal(summary(box), "4k tv · light games · 1.6 tb free · wi-fi");
});

test("T3.1 the Panasonic's EDID: its name, every progressive mode it lists, no HDR, PCM and AC-3", () => {
  const tv = parseEdid(edid("panasonic-tv"))!;
  assert.equal(tv.maker, "MEI");
  assert.equal(tv.name, "Panasonic-TV");
  assert.equal(tv.hdr, false);
  assert.deepEqual(tv.audio, ["pcm", "ac3"]);
  const modes = tv.modes.map((m) => `${m.width}x${m.height}@${m.refresh}`);
  for (const [mode, from] of [
    ["640x480@60", "the established timings"],
    ["1280x720@60", "the standard timings"],
    ["3840x2160@60", "the first detailed timing"],
    ["4096x2160@30", "the video block's VIC 100"],
    ["720x480@60", "the video block's VIC 3, at 59.94 Hz"],
  ]) {
    assert.ok(modes.includes(mode), `${mode}, from ${from}`);
  }
  assert.ok(!modes.some((m) => m.startsWith("1920x540")), "the interlaced 1080i timing is left out");
  assert.equal(new Set(modes).size, modes.length, "each mode once");
});

test("T3.1 an HDR TV's EDID: HDR10 and HLG, its 4:2:0-only modes, HDMI 1.4's own 4K id, and its audio", () => {
  const tv = parseEdid(edid("hdr-tv"))!;
  assert.equal(tv.hdr, true);
  const modes = tv.modes.map((m) => `${m.width}x${m.height}@${m.refresh}`);
  assert.deepEqual(modes.slice(0, 3), ["3840x2160@120", "3840x2160@100", "3840x2160@60"]);
  assert.ok(modes.includes("4096x2160@60") && modes.includes("4096x2160@50"), "from the YCbCr 4:2:0 video block");
  assert.ok(modes.includes("4096x2160@24"), "from HDMI's own video ids");
  assert.deepEqual(tv.audio, ["pcm", "ac3", "dts", "eac3", "truehd"]);
});

test("T3.1 a 1080p TV's EDID: a video id marked native, and no 4K", () => {
  const tv = parseEdid(edid("hd-tv"))!;
  const modes = tv.modes.map((m) => `${m.width}x${m.height}@${m.refresh}`);
  assert.equal(modes[0], "1920x1080@60");
  assert.ok(modes.includes("1920x1080@50"), "SVD 159 is VIC 31, native");
  assert.ok(!modes.some((m) => m.startsWith("3840")));
  assert.equal(parseEdid(Buffer.alloc(128)), null, "not an EDID");
  assert.equal(parseEdid(edid("hd-tv").subarray(0, 100)), null, "too short");
});

test("an EDID shared as a reading has no serial numbers, and its checksum still adds up", () => {
  const sum = (bytes: Uint8Array) => bytes.subarray(0, 128).reduce((a, b) => a + b, 0) % 256;
  const panasonic = anonymousEdid(edid("panasonic-tv"));
  assert.deepEqual([...panasonic.subarray(12, 16)], [0, 0, 0, 0]);
  assert.equal(sum(panasonic), 0);
  const hdr = anonymousEdid(edid("hdr-tv"));
  assert.ok(!Buffer.from(hdr).toString("latin1").includes("SN0123456789"), "the serial number descriptor is blank");
  assert.equal(sum(hdr), 0);
  assert.equal(parseEdid(hdr)?.name, "Example-TV", "and it still reads");
});

test("T3.1 games: good with a discrete GPU, light with Vulkan on an Intel or AMD integrated one, and none otherwise", () => {
  assert.equal(gamesVerdict(readings("gaming-pc")), "good");
  assert.equal(gamesVerdict(readings("amd-mini-pc")), "light");
  assert.equal(gamesVerdict(readings("nuc8i5beh")), "light");
  assert.equal(gamesVerdict(readings("qemu")), "none", "software Vulkan doesn't count");
  // Without vulkaninfo: NVIDIA is discrete, and Intel's Vulkan driver counts.
  assert.equal(gamesVerdict({ ...readings("gaming-pc"), vulkaninfo: null }), "good");
  assert.equal(gamesVerdict({ ...readings("nuc8i5beh"), vulkaninfo: null }), "light");
  assert.equal(gamesVerdict({ ...readings("nuc8i5beh"), vulkaninfo: null, icds: [] }), "none");
});

test("T3.1 the GPU's name: Vulkan's, or the marketing name in pci.ids, without the maker's legal name", () => {
  assert.equal(report(readings("gaming-pc")).gpu.name, "GeForce RTX 3060");
  assert.equal(report(readings("amd-mini-pc")).gpu.name, "Radeon");
  assert.equal(report({ ...readings("nuc8i5beh"), vulkaninfo: null }).gpu.name, "Iris Plus 655", "from pci.ids' brackets");
  assert.equal(report({ ...readings("amd-mini-pc"), vulkaninfo: null }).gpu.name, "Lucienne");
  assert.equal(report(readings("qemu")).gpu.vendor, "other");
  assert.deepEqual(report(readings("qemu")).gpu.decode, [], "no VA-API, no hardware decoding");
  assert.deepEqual(report(readings("gaming-pc")).gpu.decode, ["h264", "hevc", "vp9", "av1"]);
  const ids = "# comment\n8086  Intel Corporation\n\t3ea5  CoffeeLake-U GT3e [Iris Plus Graphics 655]\n10de  NVIDIA Corporation\n\t3ea5  Something else\nC 03  Display controller\n\t00  VGA compatible controller\n";
  assert.deepEqual(pciNames(ids, [{ vendor: "0x8086", device: "0x3ea5" }]).get("8086:3ea5"), { vendorName: "Intel Corporation", deviceName: "CoffeeLake-U GT3e [Iris Plus Graphics 655]" });
});

test("T3.1 the CPU, the memory and the model, without the makers' filler", () => {
  assert.equal(cpuName("model name\t: AMD Ryzen 7 5700U with Radeon Graphics"), "AMD Ryzen 7 5700U");
  assert.equal(cpuName("model name\t: Intel(R) N100"), "Intel N100");
  assert.equal(memoryGb("MemTotal:       15671444 kB", null), 16, "MemTotal, less what the GPU keeps, rounds up to what's fitted");
  assert.equal(memoryGb("MemTotal:        3881236 kB", null), 4);
  assert.equal(memoryGb("", { size: 134217728, online: 130 }), 16);
  assert.equal(modelName({ product: "To Be Filled By O.E.M.", board: "Default string", vendor: "AZW" }), "AZW");
  assert.equal(modelName({ product: "System Product Name", board: "ROG STRIX B550-F GAMING", vendor: "ASUS" }), "ROG STRIX B550-F GAMING");
});

test("T3.1 space is short under 32 GB free, and a link speed nobody knows is 0", () => {
  const mini = report(readings("amd-mini-pc"));
  assert.equal(mini.verdicts.spaceLow, true);
  assert.equal(boxLines(mini, "unchecked").find((line) => line.key === "space")?.value, "only 20 gb free");
  assert.equal(mini.verdicts.fourK, false);
  assert.equal(boxLines(mini, "unchecked").find((line) => line.key === "box")?.value, "amd ryzen 7 5700u · 16 gb", "a box on a 1080p TV says its CPU and memory");
  assert.equal(parseSpeed("433 Mb/s"), 433);
  assert.equal(parseSpeed("1000"), 1000);
  assert.equal(parseSpeed("-1"), 0);
  assert.equal(parseSpeed("unknown"), 0);
  assert.equal(report(readings("qemu")).network.mbps, 0);
});

test("T3.1 4K stays smooth only on a 4K test that held 57 fps on this GPU", () => {
  assert.equal(smoothPassed(passed("8086:3ea5"), "8086:3ea5"), true);
  assert.equal(smoothPassed(passed("8086:3ea5"), "1002:73ff"), false, "a new GPU is checked again");
  assert.equal(smoothPassed({ ...passed("8086:3ea5"), width: 1920 }, "8086:3ea5"), false, "drawn at 1080p, it says nothing about 4K");
  assert.equal(smoothPassed({ ...passed("8086:3ea5"), fps: 50 }, "8086:3ea5"), false);
  assert.equal(smoothPassed({ ...passed("8086:3ea5"), slow: 0.1 }, "8086:3ea5"), false, "too many late frames");
  assert.equal(report(readings("nuc8i5beh")).verdicts.fourKSmooth, false, "not tested yet");
  const qemu = report(readings("qemu"));
  assert.deepEqual(qemu.tv, { name: "", modes: [], hdr: false, audio: [] }, "no EDID to read");
  assert.equal(boxLines(qemu, "unchecked")[0].value, "couldn't read the tv");
});

test("T3.2 setup shows your box as step 4 of 12, after getting ready, only with its switch on", async () => {
  const path = join(scratch, "setup-box", "setup.json");
  const off = new Setup({ path, on: async (feature) => feature === "setup2" });
  assert.ok(!(await off.steps()).includes("box"));
  await off.finish("welcome");
  assert.equal((await off.finish("ready")).state?.step, "country", "with the switch off, getting ready goes on to the location");
  const on = new Setup({ path: join(scratch, "setup-box-on", "setup.json"), on: async (feature) => feature === "setup2" || feature === "boxcheck" });
  assert.equal((await on.progress()).parts.box, "4 of 12 · your box");
  await on.finish("welcome");
  assert.equal((await on.finish("ready")).state?.step, "box");
  assert.equal((await on.finish("box")).state?.step, "country");
});

// --- The readers, on a made-up machine --------------------------------------

const tree = join(scratch, "root");
const NUC = readings("nuc8i5beh");

function put(path: string, content: string | Uint8Array = ""): void {
  mkdirSync(join(tree, path, ".."), { recursive: true });
  writeFileSync(join(tree, path), content);
}

function gpuDevice(device: string): void {
  put("sys/bus/pci/devices/0000:00:02.0/device", `${device}\n`);
}

before(() => {
  put("sys/class/dmi/id/product_name", "NUC8i5BEH\n");
  put("sys/class/dmi/id/board_name", "NUC8BEB\n");
  put("sys/class/dmi/id/sys_vendor", "Intel(R) Client Systems\n");
  put("proc/cpuinfo", `${NUC.cpuinfo.split("\n").map((line) => (line.startsWith("model name") ? `vendor_id\t: GenuineIntel\n${line}\nflags\t\t: fpu vme` : line)).join("\n")}\n`);
  put("proc/meminfo", "MemTotal:       16226440 kB\nMemFree:         1000000 kB\n");
  put("sys/devices/system/memory/block_size_bytes", "8000000\n");
  for (let i = 0; i < 131; i++) put(`sys/devices/system/memory/memory${i}/online`, i < 130 ? "1\n" : "0\n");
  put("sys/bus/pci/devices/0000:00:00.0/class", "0x060000\n");
  put("sys/bus/pci/devices/0000:00:02.0/class", "0x030000\n");
  put("sys/bus/pci/devices/0000:00:02.0/vendor", "0x8086\n");
  gpuDevice("0x3ea5");
  put("sys/bus/pci/devices/0000:00:02.0/boot_vga", "1\n");
  mkdirSync(join(tree, "sys/bus/pci/devices/0000:00:02.0/drm/card1"), { recursive: true });
  mkdirSync(join(tree, "sys/bus/pci/devices/0000:00:02.0/drm/renderD128"), { recursive: true });
  put("usr/share/hwdata/pci.ids", "8086  Intel Corporation\n\t3ea0  WhiskeyLake-U GT2 [UHD Graphics 620]\n\t3ea5  CoffeeLake-U GT3e [Iris Plus Graphics 655]\n");
  for (const icd of NUC.icds) put(`usr/share/vulkan/icd.d/${icd}`, "{}");
  put("sys/class/drm/card1-DP-1/status", "disconnected\n");
  put("sys/class/drm/card1-DP-1/edid", "");
  put("sys/class/drm/card1-DP-2/status", "disconnected\n");
  put("sys/class/drm/card1-HDMI-A-1/status", "connected\n");
  put("sys/class/drm/card1-HDMI-A-1/edid", edid("panasonic-tv"));
  mkdirSync(join(tree, "sys/class/bluetooth/hci0"), { recursive: true });
  // A keyboard and a gamepad, as udev marked them.
  put("sys/class/input/event3/dev", "13:67\n");
  put("sys/class/input/event3/device/name", "AT Translated Set 2 keyboard\n");
  put("run/udev/data/c13:67", "E:ID_INPUT=1\nE:ID_INPUT_KEYBOARD=1\n");
  put("sys/class/input/event7/dev", "13:71\n");
  put("sys/class/input/event7/device/name", "Xbox Wireless Controller\n");
  put("run/udev/data/c13:71", "E:ID_INPUT=1\nE:ID_INPUT_JOYSTICK=1\n");
});

// vainfo, vulkaninfo and nmcli, as the NUC answered them.
const ran: string[] = [];
const exec = async (command: string, args: string[]) => {
  ran.push([command, ...args].join(" "));
  if (command === "vainfo") return NUC.gpus[0].vainfo;
  if (command === "vulkaninfo") return NUC.vulkaninfo;
  if (command === "nmcli") return "433 Mb/s\n";
  return null;
};
const wifi = { wlan0: [{ address: "192.168.50.191", netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:02", internal: false, cidr: "192.168.50.191/24" }] };

test("T3.1 the readers read the machine the way the recorded readings have it", async () => {
  const box = new Box({ state: join(scratch, "box-state"), root: tree, exec, interfaces: () => wifi, disk: scratch });
  const got = await box.readings();
  const { storage, gamepads, widevine, ...rest } = got;
  const { storage: _s, gamepads: _g, widevine: _w, ...want } = NUC;
  assert.deepEqual(rest, want, "the TV's EDID among them, with its serial zeroed");
  assert.ok(storage && storage.total > 0 && storage.free > 0);
  assert.deepEqual(gamepads, ["Xbox Wireless Controller"], "the keyboard isn't a gamepad");
  assert.equal(widevine, null, "until the screen daemon says");
  assert.ok(ran.includes("vainfo --display drm --device /dev/dri/renderD128"));
  assert.ok(ran.includes("nmcli -g CAPABILITIES.SPEED device show wlan0"));

  // The GPU's slow readings are kept until the GPU changes.
  ran.length = 0;
  await box.readings();
  assert.ok(!ran.some((line) => line.startsWith("vainfo") || line.startsWith("vulkaninfo")));
  gpuDevice("0x3ea0");
  try {
    assert.equal((await box.report()).gpu.name, "UHD 620", "named again, from pci.ids");
    assert.ok(ran.some((line) => line.startsWith("vainfo")), "a new GPU is read again");
  } finally {
    gpuDevice("0x3ea5");
  }
});

test("the network: a wire before Wi-Fi, and the box's own setup hotspot isn't one", async () => {
  const state = join(scratch, "net-state");
  const at = (address: string) => [{ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:03", internal: false, cidr: `${address}/24` }];
  put("sys/class/net/enp0s31f6/speed", "1000\n");
  const both = new Box({ state, root: tree, exec, interfaces: () => ({ ...wifi, enp0s31f6: at("192.168.50.20") }), disk: scratch });
  assert.deepEqual((await both.readings()).network, { kind: "ethernet", speed: "1000" });
  const hotspot = new Box({ state, root: tree, exec, interfaces: () => ({ wlan0: at(HOTSPOT_ADDRESS) }), disk: scratch });
  assert.deepEqual((await hotspot.readings()).network, { kind: "none", speed: null });
});

test("Widevine: the newest module in the profile, told to the daemon as Chromium fetches it", async () => {
  const profile = join(scratch, "chromium");
  mkdirSync(profile, { recursive: true });
  assert.equal(await widevineVersion(profile), null);
  const told: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      told.push({ path: request.url, ...JSON.parse(body) });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const watch = new WidevineWatch({ home: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, profile }).start();
  try {
    const until = async (n: number) => {
      for (let i = 0; i < 100 && told.length < n; i++) await new Promise((r) => setTimeout(r, 50));
    };
    await until(1);
    assert.deepEqual(told[0], { path: "/api/box/widevine", version: null });
    for (const version of ["4.10.2830.0", "4.10.2891.0", "4.9.9999.0"]) {
      mkdirSync(join(profile, "WidevineCdm", version), { recursive: true });
      writeFileSync(join(profile, "WidevineCdm", version, "manifest.json"), JSON.stringify({ version }));
    }
    await until(2);
    assert.deepEqual(told[told.length - 1], { path: "/api/box/widevine", version: "4.10.2891.0" });
  } finally {
    watch.stop();
    server.close();
  }
});

// --- The daemon's routes ----------------------------------------------------

let daemon: Daemon;
let url = "";
let lan = "";
let state = "";

before(async () => {
  state = join(scratch, "state");
  mkdirSync(join(scratch, "daemon-root", "setup"), { recursive: true });
  daemon = new Daemon({ root: join(scratch, "daemon-root"), state, port: 0, log: () => {}, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1", box: { root: tree, exec, interfaces: () => wifi, disk: scratch } });
  url = `http://127.0.0.1:${await daemon.listen()}`;
  lan = `http://127.0.0.1:${daemon.lanPort}`;
});

after(async () => {
  await daemon?.close();
});

const get = async (path: string) => (await fetch(`${url}${path}`)).json();
const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("T3.1 GET /api/box answers in the plan's shape, and the 4K test's result counts on this GPU only", async () => {
  const box = await get("/api/box");
  assert.deepEqual(Object.keys(box), ["model", "cpu", "memoryGb", "storage", "gpu", "tv", "network", "bluetooth", "gamepads", "widevine", "verdicts"]);
  assert.deepEqual(box.verdicts, { fourK: true, fourKSmooth: false, games: "light", spaceLow: box.storage.freeGb < 32 });
  assert.deepEqual(await get("/api/box/smooth"), { ok: true, gpu: "8086:3ea5", needed: true, passed: false, result: null });

  assert.equal((await post("/api/box/smooth", { width: 3840, height: 2160, fps: "fast", slow: 0 })).status, 400);
  const saved = await (await post("/api/box/smooth", { width: 3840, height: 2160, fps: 59.84, slow: 0.012 })).json();
  assert.equal(saved.passed, true);
  assert.equal(saved.needed, false);
  assert.equal((await get("/api/box")).verdicts.fourKSmooth, true);

  gpuDevice("0x3ea0");
  try {
    assert.equal((await get("/api/box")).verdicts.fourKSmooth, false, "a new GPU hasn't been tested");
    assert.equal((await get("/api/box/smooth")).needed, true);
  } finally {
    gpuDevice("0x3ea5");
  }
  assert.equal((await get("/api/box")).verdicts.fourKSmooth, true, "and the old one's result still holds for it");
});

test("the screen daemon tells the daemon about Widevine, and the readings can be shared", async () => {
  assert.equal((await get("/api/box")).widevine, false);
  assert.equal((await post("/api/box/widevine", { version: "4.10.2891.0" })).status, 200);
  assert.equal((await get("/api/box")).widevine, true);
  assert.equal((await post("/api/box/widevine", { version: "../../etc" })).status, 400);
  const readings = (await get("/api/box/readings")) as Readings;
  assert.equal(readings.widevine, "4.10.2891.0");
  assert.equal(parseEdid(Buffer.from(readings.connectors[2].edid, "base64"))?.name, "Panasonic-TV");
});

test("a paired phone gets the box in one line, for its menu", async () => {
  assert.equal((await fetch(`${lan}/api/phone/box`)).status, 401);
  const code = (await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json()).pairing.code;
  const token = (await (await fetch(`${lan}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "iphone" }) })).json()).token;
  const answer = await (await fetch(`${lan}/api/phone/box`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(answer.ok, true);
  assert.match(answer.line, /^4k tv · light games · .+ free · wi-fi$/);
  assert.equal(answer.box.model, "NUC8i5BEH");
});
