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
// No pairing agent is registered, so BlueZ pairs the way a device with no
// screen and no keys does ("just works"). A controller that wants a code
// fails, and the page says so in one line.
//
// Looking for controllers is a discovery BlueZ runs for as long as the client
// that asked stays on the bus, so it's a bluetoothctl kept running while
// Settings shows the page. The page asks again every few seconds; when it
// stops asking, so does the looking.

import { spawn } from "node:child_process";

export interface Controller {
  id: string; // its Bluetooth address, "AA:BB:CC:DD:EE:FF"
  name: string;
  paired: boolean;
  connected: boolean;
}

// "none": the TV has no Bluetooth. "off": it has, switched off.
export type Bluetooth = "on" | "off" | "none";

// Why an ask didn't do what it was for, for the page's one line.
export type Why = "none" | "off" | "not-a-controller" | "gone" | "code" | "failed";
export const WHYS: Why[] = ["none", "off", "not-a-controller", "gone", "code", "failed"];

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

// What the list shows: every paired controller, and while looking, the ones
// nearby that have said their name. Connected first, then paired, by name.
export function listed(devices: Device[], adapter: string, looking: boolean): Controller[] {
  return devices
    .filter((device) => device.adapter === adapter && isController(device) && (device.paired || (looking && device.name !== "")))
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
}

const BUS = ["--system", "--no-pager", "--timeout=45"];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export class Controllers {
  private o: Required<ControllersOptions>;
  private looking: Looking | null = null;
  private until = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: ControllersOptions = {}) {
    this.o = { run, look, log: (line) => console.log(line), keepMs: 10_000, settleMs: 6000, ...options };
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

  stop(): void {
    clearTimeout(this.timer);
    this.looking?.stop();
    this.looking = null;
    this.until = 0;
  }

  private bus(args: string[], ms = 5000): Promise<Ran> {
    return this.o.run("busctl", [...BUS, ...args], ms);
  }

  private async read(): Promise<{ adapter: Adapter | null; devices: Device[] }> {
    const ran = await this.bus(["--json=short", "call", "org.bluez", "/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects"]);
    const { adapters, devices } = ran.code === 0 ? parseObjects(ran.out) : { adapters: [], devices: [] };
    return { adapter: adapters.find((adapter) => adapter.powered) ?? adapters[0] ?? null, devices };
  }

  private isLooking(): boolean {
    return this.looking !== null && Date.now() < this.until;
  }

  private answer(found: { adapter: Adapter | null; devices: Device[] }, more: Partial<ControllerAnswer> = {}): ControllerAnswer {
    const bluetooth: Bluetooth = !found.adapter ? "none" : found.adapter.powered ? "on" : "off";
    const looking = bluetooth === "on" && this.isLooking();
    return { ok: true, bluetooth, looking, controllers: found.adapter ? listed(found.devices, found.adapter.path, looking) : [], ...more };
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
  // adapter. Anything else is refused here, whatever the page showed.
  private find(found: { adapter: Adapter | null; devices: Device[] }, id: string): { device?: Device; refused?: ControllerAnswer } {
    if (!found.adapter) return { refused: this.answer(found, { ok: false, why: "none", error: "there's no bluetooth here" }) };
    if (!found.adapter.powered) return { refused: this.answer(found, { ok: false, why: "off", error: "bluetooth is off" }) };
    const device = ADDRESS.test(id) ? found.devices.find((d) => d.address === id && d.adapter === found.adapter!.path) : undefined;
    if (!device) return { refused: this.answer(found, { ok: false, why: "gone", error: "that controller isn't nearby any more" }) };
    if (!isController(device)) {
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
    this.o.log("paired a game controller");
    return this.answer(found);
  }

  // Removes a controller's pairing, so it has to be paired again.
  async remove(id: string): Promise<ControllerAnswer> {
    const { device, refused } = this.find(await this.read(), id);
    if (!device) return refused!;
    const removed = await this.bus(["call", "org.bluez", device.adapter, "org.bluez.Adapter1", "RemoveDevice", "o", device.path], 10_000);
    const found = await this.read();
    if (removed.code !== 0 && found.devices.some((d) => d.path === device.path && d.paired)) {
      this.o.log(`a controller wasn't removed: ${removed.err.trim().slice(0, 200)}`);
      return this.answer(found, { ok: false, why: "failed", error: "it wasn't removed" });
    }
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
