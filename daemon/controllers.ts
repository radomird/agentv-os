// Bluetooth game controllers (ADR-084): what Settings, controllers lists,
// pairs and removes. This runs in the screen daemon, as the TV's owner, and
// talks to BlueZ over the system bus with busctl, which BlueZ's own D-Bus
// policy allows. Nothing here runs as root, and there's no sudo or polkit
// rule behind it. The daemon's routes (routes/controllers.ts) hand it each
// ask, past the PIN where one is needed.
//
// Game controllers and nothing else. A paired Bluetooth keyboard can type
// anything into the TV, so pairing one from the couch is never offered: a
// device shows, pairs and is removed here only when BlueZ itself calls it a
// game controller, and that's checked again as each ask is carried out, not
// only when the list is drawn. Headphones and remotes wait (ADR-017).
//
// What a device says before it's paired is only its word. So once one has
// connected, the input devices the kernel made for it are read, and one
// that can type or move a pointer is removed again. That's read again every
// time the kernel makes an input device, for as long as it's paired, since
// one can come back later as something else. And whatever this page
// paired it can show and remove, even when the device has changed what it
// says it is since.
//
// No pairing agent is registered, so BlueZ pairs the way a device with no
// screen and no keys does ("just works"). A controller that wants a code
// fails, and the page says so in one line.
//
// Looking for controllers is a discovery BlueZ runs for as long as the client
// that asked stays on the bus, so it's a bluetoothctl kept running while
// Settings shows the page. The page asks again every few seconds; when it
// stops asking, so does the looking.

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Controller {
  id: string; // its Bluetooth address, "AA:BB:CC:DD:EE:FF"
  name: string;
  paired: boolean;
  connected: boolean;
}

// "none": the TV has no Bluetooth. "off": it has, switched off.
export type Bluetooth = "on" | "off" | "none";

// Why an ask didn't do what it was for, for the page's one line.
// "not-removed": it turned out to type or point, and is still paired.
export type Why = "none" | "off" | "not-a-controller" | "not-removed" | "gone" | "code" | "failed";
export const WHYS: Why[] = ["none", "off", "not-a-controller", "not-removed", "gone", "code", "failed"];

export type ControllerAsk = { kind: "list" } | { kind: "look"; on: boolean } | { kind: "pair"; id: string } | { kind: "remove"; id: string } | { kind: "power" };

export interface ControllerAnswer {
  ok: boolean;
  bluetooth: Bluetooth;
  looking: boolean;
  controllers: Controller[];
  why?: Why;
  error?: string;
}

export const ADDRESS = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

// --- What BlueZ says ---------------------------------------------------------

export interface Adapter {
  path: string; // "/org/bluez/hci0"
  powered: boolean;
}

export interface Device {
  path: string; // "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF"
  adapter: string;
  address: string;
  name: string; // "" when it never said
  icon: string; // BlueZ's own word for what it is: "input-gaming"
  cls: number | null; // the class of device, from a classic one
  appearance: number | null; // the appearance, from a low energy one
  paired: boolean;
  connected: boolean;
  trusted: boolean;
}

// busctl writes a variant as { "type": "s", "data": "…" }.
function plain(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "type" in value && "data" in value) return (value as { data: unknown }).data;
  return value;
}

const string = (value: unknown) => (typeof plain(value) === "string" ? (plain(value) as string) : "");
const number = (value: unknown) => (typeof plain(value) === "number" && Number.isInteger(plain(value)) ? (plain(value) as number) : null);
const yes = (value: unknown) => plain(value) === true;

// A name as the list shows it: one line, nothing a terminal or a page would
// act on, and not longer than a row.
export function cleanName(name: string): string {
  return name
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

// Everything BlueZ knows, from the answer busctl prints for
// org.freedesktop.DBus.ObjectManager's GetManagedObjects with --json=short.
// Anything that isn't that answer gives no adapters and no devices.
export function parseObjects(text: string): { adapters: Adapter[]; devices: Device[] } {
  const adapters: Adapter[] = [];
  const devices: Device[] = [];
  let objects: unknown;
  try {
    const answer = JSON.parse(text) as { data?: unknown };
    objects = Array.isArray(answer?.data) ? answer.data[0] : null;
  } catch {
    objects = null;
  }
  if (typeof objects !== "object" || objects === null) return { adapters, devices };
  for (const [path, interfaces] of Object.entries(objects as Record<string, Record<string, Record<string, unknown>> | null>)) {
    const adapter = interfaces?.["org.bluez.Adapter1"];
    if (adapter && /^\/org\/bluez\/hci\d+$/.test(path)) adapters.push({ path, powered: yes(adapter.Powered) });
    const device = interfaces?.["org.bluez.Device1"];
    const at = /^(\/org\/bluez\/hci\d+)\/dev(_[0-9A-F]{2}){6}$/.exec(path);
    if (!device || !at) continue;
    const address = string(device.Address).toUpperCase();
    // The address is the one in the path, or it isn't a device to act on.
    if (!ADDRESS.test(address) || !path.endsWith(`/dev_${address.replace(/:/g, "_")}`)) continue;
    devices.push({
      path,
      adapter: at[1],
      address,
      name: cleanName(string(device.Name) || string(device.Alias).replace(/^([0-9A-F]{2}-){5}[0-9A-F]{2}$/i, "")),
      icon: string(device.Icon),
      cls: number(device.Class),
      appearance: number(device.Appearance),
      paired: yes(device.Paired),
      connected: yes(device.Connected),
      trusted: yes(device.Trusted),
    });
  }
  adapters.sort((a, b) => a.path.localeCompare(b.path));
  return { adapters, devices };
}

// A game controller, by everything the device says about itself. BlueZ's
// icon has to say so, and where the device gave a class or an appearance,
// those have to agree:
// - the class is a peripheral (major 5) that's a joystick or a gamepad
//   (minor 1 or 2), with neither the keyboard nor the pointer bit;
// - the appearance is a joystick (0x03C3) or a gamepad (0x03C4).
// A keyboard, a mouse, a remote, a headset or a phone is none of these.
export function isController(device: Pick<Device, "icon" | "cls" | "appearance">): boolean {
  if (device.icon !== "input-gaming") return false;
  if (device.cls !== null) {
    const major = (device.cls >> 8) & 0x1f;
    const keysOrPointer = (device.cls >> 6) & 0x3;
    const kind = (device.cls >> 2) & 0xf;
    if (major !== 5 || keysOrPointer !== 0 || (kind !== 1 && kind !== 2)) return false;
  }
  if (device.appearance !== null && device.appearance !== 0x03c3 && device.appearance !== 0x03c4) return false;
  return true;
}

// The keys that type: the digits, the letters, the punctuation, Backspace,
// Tab, Enter and Space, which are the kernel's key codes 2 to 57 without
// Ctrl, the Shifts, the keypad's star and Alt. A gamepad's own keys (its
// buttons, Back, Home, the volume) are none of these.
const MODIFIERS = new Set([29, 42, 54, 55, 56]);
const TYPING = Array.from({ length: 56 }, (_, i) => i + 2).filter((code) => !MODIFIERS.has(code));

// Whether a bit is set in one of the kernel's bitmaps, as /proc prints
// them: 64-bit words in hex, the highest first.
function bit(bitmap: string, n: number): boolean {
  const words = bitmap.trim().split(/\s+/).filter((word) => /^[0-9a-f]{1,16}$/i.test(word));
  const word = words[words.length - 1 - Math.floor(n / 64)];
  return word !== undefined && ((BigInt(`0x${word}`) >> BigInt(n % 64)) & 1n) === 1n;
}

// What the kernel made of a Bluetooth device, from /proc/bus/input/devices:
// true when one of its input devices can type or move a pointer (it has a
// typing key, or moves on both axes as a mouse does), false when none can,
// and null when the kernel has made none for that address yet. A
// controller's touchpad reports positions, not movement, so it isn't a mouse
// here.
export function typesOrPoints(inputs: string, address: string): boolean | null {
  let any = false;
  for (const block of inputs.split(/\n\s*\n/)) {
    const uniq = /^U: Uniq=(.*)$/m.exec(block)?.[1].trim().toUpperCase();
    if (uniq !== address) continue;
    any = true;
    const keys = /^B: KEY=(.*)$/m.exec(block)?.[1] ?? "";
    const rel = /^B: REL=(.*)$/m.exec(block)?.[1] ?? "";
    if (TYPING.some((code) => bit(keys, code))) return true;
    if (bit(rel, 0) && bit(rel, 1)) return true;
  }
  return any ? false : null;
}

// What the list shows: every paired controller, and while looking, the ones
// nearby that have said their name. Connected first, then paired, by name.
// One this page paired stays on it while it's paired, whatever it says it is
// now, so it can always be removed.
export function listed(devices: Device[], adapter: string, looking: boolean, mine: ReadonlySet<string> = new Set()): Controller[] {
  return devices
    .filter((device) => device.adapter === adapter && ((device.paired && mine.has(device.address)) || (isController(device) && (device.paired || (looking && device.name !== "")))))
    .map((device) => ({ id: device.address, name: device.name || "Controller", paired: device.paired, connected: device.connected }))
    .sort((a, b) => Number(b.connected) - Number(a.connected) || Number(b.paired) - Number(a.paired) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// BlueZ's reasons that mean the controller wanted a code or a yes that
// nobody was there to give.
const WANTED_A_CODE = /authentication (failed|rejected|cancell?ed|timeout)|org\.bluez\.Error\.Authentication/i;

// --- Driving BlueZ -----------------------------------------------------------

export interface Ran {
  code: number | null; // null when it didn't finish in time
  out: string;
  err: string;
}

export type Run = (command: string, args: string[], ms: number) => Promise<Ran>;

// A discovery that runs until it's stopped. over is true once it ended.
export interface Looking {
  stop(): void;
  over(): boolean;
}

const run: Run = (command, args, ms) =>
  new Promise((done) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      done({ code: 127, out, err: (error as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, out, err });
    }, ms);
    child.stdout.on("data", (chunk: Buffer) => (out = (out + chunk.toString("utf8")).slice(0, 1_000_000)));
    child.stderr.on("data", (chunk: Buffer) => (err = (err + chunk.toString("utf8")).slice(0, 10_000)));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: 127, out, err: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, out, err });
    });
  });

// bluetoothctl's own discovery, for as long as it runs. Its input stays
// open and unused: with none it leaves at once.
function look(seconds: number): Looking {
  let ended = false;
  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn("bluetoothctl", ["--timeout", String(seconds), "scan", "on"], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => (ended = true));
    child.on("close", () => (ended = true));
  } catch {
    ended = true;
  }
  return {
    stop() {
      ended = true;
      child?.kill("SIGTERM");
    },
    over: () => ended,
  };
}

export interface ControllersOptions {
  run?: Run;
  look?: (seconds: number) => Looking;
  log?: (line: string) => void;
  // How long the looking goes on after the page last asked for it.
  keepMs?: number;
  // How long a controller gets to connect after it paired.
  settleMs?: number;
  // The kernel's input devices, as /proc/bus/input/devices has them.
  inputs?: () => Promise<string>;
  // Tells when the kernel's input devices changed. Returns how to stop.
  changes?: (changed: () => void) => () => void;
  // How long after a change the input devices are read.
  checkMs?: number;
  // Where the addresses this page paired are kept. With none, they're kept
  // until the session ends.
  store?: string;
}

// The kernel's input devices come and go as nodes in /dev/input.
const changes = (changed: () => void) => {
  try {
    const watcher = watch("/dev/input", () => changed());
    watcher.on("error", () => {});
    return () => watcher.close();
  } catch {
    return () => {};
  }
};

// What BlueZ has, and whether that was read at all (known).
interface Found {
  adapter: Adapter | null;
  devices: Device[];
  known: boolean;
}

const inputs = () => readFile("/proc/bus/input/devices", "utf8").catch(() => "");

const BUS = ["--system", "--no-pager", "--timeout=45"];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export class Controllers {
  private o: Required<Omit<ControllersOptions, "store">> & { store?: string };
  // The addresses this page paired, read from the store the first time.
  private mine: Set<string> | null = null;
  private looking: Looking | null = null;
  private until = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private unwatch?: () => void;
  private checkTimer?: ReturnType<typeof setTimeout>;
  private checking: Promise<void> = Promise.resolve();

  constructor(options: ControllersOptions = {}) {
    this.o = { run, look, log: (line) => console.log(line), keepMs: 10_000, settleMs: 6000, inputs, changes, checkMs: 300, ...options };
  }

  // Reads what the kernel made of each controller paired here, now and each
  // time its input devices change: when one connects, and when one that's
  // connected opens something more.
  watch(): void {
    this.unwatch?.();
    const soon = () => {
      clearTimeout(this.checkTimer);
      this.checkTimer = setTimeout(() => void this.check(), this.o.checkMs);
      this.checkTimer.unref?.();
    };
    this.unwatch = this.o.changes(soon);
    soon();
  }

  // One paired here that can type or move a pointer goes, whenever that's
  // seen. One the kernel shows nothing for isn't connected, and is read
  // again when it is.
  check(): Promise<void> {
    this.checking = this.checking
      .then(async () => {
        const mine = await this.paired();
        if (!mine.size) return;
        const made = await this.o.inputs();
        const bad = [...mine].filter((address) => typesOrPoints(made, address) === true);
        if (!bad.length) return;
        const found = await this.read();
        for (const address of bad) {
          const device = found.devices.find((d) => d.address === address);
          if (device) await this.drop(device);
          else this.o.log("a controller paired here can type or point, and BlueZ didn't say where it is; it's read again when the input devices change");
        }
      })
      .catch((error: Error) => this.o.log(`couldn't check the controllers paired here: ${error.message}`));
    return this.checking;
  }

  // Removes a device that can type or point. When BlueZ won't, it's at
  // least not trusted and not connected, and stays on the page to remove.
  private async drop(device: Device): Promise<{ found: Found; gone: boolean }> {
    const removed = await this.bus(["call", "org.bluez", device.adapter, "org.bluez.Adapter1", "RemoveDevice", "o", device.path], 10_000);
    let found = await this.read();
    const gone = found.known ? !found.devices.some((d) => d.path === device.path && d.paired) : removed.code === 0;
    if (gone) {
      this.o.log("removed a bluetooth device that paired as a game controller and can type or point");
      await this.note(found, device.address, false);
      return { found, gone };
    }
    this.o.log(`a bluetooth device that can type or point wasn't removed: ${removed.code === null ? "no answer in time" : removed.err.trim().slice(0, 200)}`);
    await this.bus(["set-property", "org.bluez", device.path, "org.bluez.Device1", "Trusted", "b", "false"]);
    await this.bus(["call", "org.bluez", device.path, "org.bluez.Device1", "Disconnect"], 10_000);
    found = await this.read();
    await this.note(found, device.address, true);
    return { found, gone };
  }

  private async paired(): Promise<Set<string>> {
    if (this.mine) return this.mine;
    let kept: unknown = [];
    if (this.o.store) kept = await readFile(this.o.store, "utf8").then(JSON.parse, () => []);
    this.mine ??= new Set((Array.isArray(kept) ? kept : []).filter((id): id is string => typeof id === "string" && ADDRESS.test(id)).slice(0, 40));
    return this.mine;
  }

  // Notes a controller this page paired, or one it removed, and lets go of
  // any BlueZ no longer has paired.
  // A read of BlueZ that failed says nothing about the others, so they stay.
  private async note(found: Found, id: string, paired: boolean): Promise<void> {
    const mine = await this.paired();
    if (paired) mine.add(id);
    else mine.delete(id);
    if (found.known) for (const address of [...mine]) if (address !== id && !found.devices.some((d) => d.address === address && d.paired)) mine.delete(address);
    if (!this.o.store) return;
    try {
      await mkdir(dirname(this.o.store), { recursive: true });
      await writeFile(this.o.store, `${JSON.stringify([...mine].slice(-40))}\n`);
    } catch (error) {
      this.o.log(`couldn't keep which controllers were paired here: ${(error as Error).message}`);
    }
  }

  // One ask from the daemon. Each answer has the list as it is afterwards.
  async handle(ask: ControllerAsk): Promise<ControllerAnswer> {
    switch (ask?.kind) {
      case "list":
        return this.state();
      case "look":
        return this.look(ask.on === true);
      case "pair":
        return this.pair(String(ask.id ?? ""));
      case "remove":
        return this.remove(String(ask.id ?? ""));
      case "power":
        return this.power();
      default:
        return { ...(await this.state()), ok: false, why: "failed", error: "list, look, pair, remove or power" };
    }
  }

  // The page stopped looking. The watch on what's paired goes on.
  stop(): void {
    clearTimeout(this.timer);
    this.looking?.stop();
    this.looking = null;
    this.until = 0;
  }

  private bus(args: string[], ms = 5000): Promise<Ran> {
    return this.o.run("busctl", [...BUS, ...args], ms);
  }

  private async read(): Promise<Found> {
    await this.paired();
    const ran = await this.bus(["--json=short", "call", "org.bluez", "/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects"]);
    const { adapters, devices } = ran.code === 0 ? parseObjects(ran.out) : { adapters: [], devices: [] };
    // With no adapter in the answer, BlueZ has said nothing about devices.
    return { adapter: adapters.find((adapter) => adapter.powered) ?? adapters[0] ?? null, devices, known: ran.code === 0 && adapters.length > 0 };
  }

  private isLooking(): boolean {
    return this.looking !== null && Date.now() < this.until;
  }

  private answer(found: Found, more: Partial<ControllerAnswer> = {}): ControllerAnswer {
    const bluetooth: Bluetooth = !found.adapter ? "none" : found.adapter.powered ? "on" : "off";
    const looking = bluetooth === "on" && this.isLooking();
    return { ok: true, bluetooth, looking, controllers: found.adapter ? listed(found.devices, found.adapter.path, looking, this.mine ?? undefined) : [], ...more };
  }

  async state(): Promise<ControllerAnswer> {
    return this.answer(await this.read());
  }

  // Starts looking, or keeps it going a while longer, or stops it.
  async look(on: boolean): Promise<ControllerAnswer> {
    if (!on) {
      this.stop();
      return this.state();
    }
    const found = await this.read();
    if (!found.adapter?.powered) {
      this.stop();
      return this.answer(found);
    }
    this.keepLooking();
    return this.answer(found);
  }

  private keepLooking(): void {
    this.until = Date.now() + this.o.keepMs;
    if (!this.looking || this.looking.over()) this.looking = this.o.look(60);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), this.o.keepMs);
    this.timer.unref?.();
  }

  // Turns Bluetooth on: lifts the block Omarchy's own switch sets, which the
  // TV's owner may at their own seat, then powers the adapter.
  async power(): Promise<ControllerAnswer> {
    let found = await this.read();
    if (!found.adapter) return this.answer(found, { ok: false, why: "none", error: "there's no bluetooth here" });
    if (found.adapter.powered) return this.answer(found);
    const { path } = found.adapter;
    await this.o.run("rfkill", ["unblock", "bluetooth"], 3000);
    for (let tries = 0; tries < 6; tries++) {
      await this.bus(["set-property", "org.bluez", path, "org.bluez.Adapter1", "Powered", "b", "true"]);
      found = await this.read();
      if (found.adapter?.powered) break;
      await sleep(this.o.settleMs / 12);
    }
    if (!found.adapter?.powered) return this.answer(found, { ok: false, why: "failed", error: "bluetooth didn't turn on" });
    this.o.log("bluetooth is on, from settings");
    return this.answer(found);
  }

  // The device an ask names, when it's a game controller on the TV's
  // adapter. Anything else is refused here, whatever the page showed. To
  // remove one, having been paired from this page is enough.
  private find(found: Found, id: string, removing = false): { device?: Device; refused?: ControllerAnswer } {
    if (!found.adapter) return { refused: this.answer(found, { ok: false, why: "none", error: "there's no bluetooth here" }) };
    if (!found.adapter.powered) return { refused: this.answer(found, { ok: false, why: "off", error: "bluetooth is off" }) };
    const device = ADDRESS.test(id) ? found.devices.find((d) => d.address === id && d.adapter === found.adapter!.path) : undefined;
    if (!device) return { refused: this.answer(found, { ok: false, why: "gone", error: "that controller isn't nearby any more" }) };
    if (!isController(device) && !(removing && device.paired && this.mine?.has(device.address))) {
      this.o.log(`refused a bluetooth device that isn't a game controller (${device.icon || "no kind"})`);
      return { refused: this.answer(found, { ok: false, why: "not-a-controller", error: "that isn't a game controller" }) };
    }
    return { device };
  }

  // Pairs a controller, trusts it so it comes back by itself the next time
  // it's switched on, and connects it.
  async pair(id: string): Promise<ControllerAnswer> {
    const { device, refused } = this.find(await this.read(), id);
    if (!device) return refused!;
    // BlueZ pairs more surely with its looking stopped, so it stops for as
    // long as the pairing takes.
    const was = this.isLooking();
    this.stop();
    const answer = await this.pairing(device);
    if (!was) return answer;
    this.keepLooking();
    return { ...this.answer(await this.read()), ...(answer.ok ? {} : { ok: false, why: answer.why, error: answer.error }) };
  }

  private async pairing(device: Device): Promise<ControllerAnswer> {
    if (!device.paired) {
      const paired = await this.bus(["call", "org.bluez", device.path, "org.bluez.Device1", "Pair"], 50_000);
      if (paired.code !== 0 && !/already ?exists/i.test(paired.err)) {
        const code = WANTED_A_CODE.test(paired.err);
        this.o.log(`a controller didn't pair: ${paired.code === null ? "no answer in time" : paired.err.trim().slice(0, 200)}`);
        // Half a pairing is no use to anyone, so it goes.
        await this.bus(["call", "org.bluez", device.adapter, "org.bluez.Adapter1", "RemoveDevice", "o", device.path]);
        return this.answer(await this.read(), { ok: false, why: code ? "code" : "failed", error: code ? "it wanted a code" : "it didn't pair" });
      }
    }
    await this.bus(["set-property", "org.bluez", device.path, "org.bluez.Device1", "Trusted", "b", "true"]);
    // Most connect by themselves once paired, so this failing means nothing
    // when it's connected a moment later.
    await this.bus(["call", "org.bluez", device.path, "org.bluez.Device1", "Connect"], 20_000);
    let found = await this.read();
    for (let waited = 0; waited < this.o.settleMs && !found.devices.find((d) => d.path === device.path)?.connected; waited += this.o.settleMs / 6) {
      await sleep(this.o.settleMs / 6);
      found = await this.read();
    }
    // What it said before pairing was only its word. Now the kernel has it:
    // one that can type or move a pointer isn't only a game controller, and
    // trusted, it would come back by itself and do that. So it goes.
    let presents = typesOrPoints(await this.o.inputs(), device.address);
    const connected = () => found.devices.find((d) => d.path === device.path)?.connected === true;
    for (let waited = 0; waited < this.o.settleMs && presents === null && connected(); waited += this.o.settleMs / 6) {
      await sleep(this.o.settleMs / 6);
      presents = typesOrPoints(await this.o.inputs(), device.address);
    }
    if (presents) {
      const dropped = await this.drop(device);
      if (!dropped.gone) return this.answer(dropped.found, { ok: false, why: "not-removed", error: "it can type or point, and it wasn't removed" });
      return this.answer(dropped.found, { ok: false, why: "not-a-controller", error: "it can type or point, so it isn't only a game controller" });
    }
    // Paired here, so it's read again each time the kernel makes an input
    // device (watch). Nothing seen yet is not a controller that passed.
    await this.note(found, device.address, true);
    this.o.log(presents === null ? "paired a game controller; the kernel hasn't shown it yet, so it's checked when it connects" : "paired a game controller");
    return this.answer(found);
  }

  // Removes a controller's pairing, so it has to be paired again.
  async remove(id: string): Promise<ControllerAnswer> {
    const { device, refused } = this.find(await this.read(), id, true);
    if (!device) return refused!;
    const removed = await this.bus(["call", "org.bluez", device.adapter, "org.bluez.Adapter1", "RemoveDevice", "o", device.path], 10_000);
    const found = await this.read();
    if (removed.code !== 0 && found.devices.some((d) => d.path === device.path && d.paired)) {
      this.o.log(`a controller wasn't removed: ${removed.err.trim().slice(0, 200)}`);
      return this.answer(found, { ok: false, why: "failed", error: "it wasn't removed" });
    }
    await this.note(found, device.address, false);
    this.o.log("removed a game controller");
    return this.answer(found);
  }
}

// --- The daemon's side -------------------------------------------------------

// Only what an answer has, within bounds: it comes over the daemon's port.
export function cleanAnswer(said: unknown): ControllerAnswer {
  const c = (typeof said === "object" && said !== null ? said : {}) as Record<string, unknown>;
  const bluetooth = (["on", "off", "none"] as const).find((b) => b === c.bluetooth) ?? "none";
  const controllers = (Array.isArray(c.controllers) ? c.controllers : [])
    .slice(0, 40)
    .filter((one): one is Record<string, unknown> => typeof one === "object" && one !== null && typeof one.id === "string" && ADDRESS.test(one.id))
    .map((one) => ({ id: one.id as string, name: cleanName(typeof one.name === "string" ? one.name : "") || "Controller", paired: one.paired === true, connected: one.connected === true }));
  const why = WHYS.find((w) => w === c.why);
  return {
    ok: c.ok === true,
    bluetooth,
    looking: c.looking === true,
    controllers,
    ...(why ? { why } : {}),
    ...(typeof c.error === "string" ? { error: c.error.slice(0, 200) } : {}),
  };
}
