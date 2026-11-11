// A stand-in for BlueZ, for the tests of Settings, controllers: it answers
// busctl the way bluetoothd does on the system bus, in the JSON busctl
// prints with --json=short, and keeps what's paired, trusted and connected.
// It pairs anything it's asked to, a keyboard too, so a test that sees a
// keyboard refused is seeing AgenTV's own rule and not this file's.

import type { Looking, Ran, Run } from "../../../../daemon/controllers.ts";

export interface StandInDevice {
  address: string;
  name?: string;
  icon?: string;
  cls?: number;
  appearance?: number;
  paired?: boolean;
  connected?: boolean;
  trusted?: boolean;
  // Only found while BlueZ looks, as a device in pairing mode is.
  nearby?: boolean;
  // Wants a code typed, which nobody is there to do.
  wantsCode?: boolean;
  // What the kernel makes of it once it's connected, whatever it said
  // before: a gamepad unless this says a keyboard or a mouse comes with it.
  presents?: "keyboard" | "mouse";
  // Says something else about itself once it's connected.
  becomes?: { icon?: string; appearance?: number };
}

// What the devices in these tests say about themselves, as BlueZ reads it.
export const XBOX: StandInDevice = { address: "AC:8E:BD:11:22:33", name: "Xbox Wireless Controller", icon: "input-gaming", appearance: 0x03c4, nearby: true };
export const DUALSENSE: StandInDevice = { address: "D0:BC:C1:44:55:66", name: "DualSense Wireless Controller", icon: "input-gaming", cls: 0x002508, nearby: true };
export const KEYBOARD: StandInDevice = { address: "34:88:5D:77:88:99", name: "Keychron K2", icon: "input-keyboard", cls: 0x002540, nearby: true };
export const HEADPHONES: StandInDevice = { address: "94:DB:56:AA:BB:CC", name: "WH-1000XM4", icon: "audio-headset", cls: 0x240404, paired: true, trusted: true };

const variant = (type: string, data: unknown) => ({ type, data });

export class StandInBluez {
  adapter = true;
  powered = true;
  blocked = false; // the rfkill block Omarchy's Bluetooth switch sets
  scanning = false;
  devices: StandInDevice[] = [];
  seen = new Set<string>(); // found by a look, and kept until removed
  calls: string[] = []; // every command, as it was run
  // Something for a test to wait on before a pairing answers.
  hold: Promise<void> | null = null;

  constructor(devices: StandInDevice[] = []) {
    this.devices = devices.map((device) => ({ ...device }));
  }

  private path(device: StandInDevice): string {
    return `/org/bluez/hci0/dev_${device.address.replace(/:/g, "_")}`;
  }

  private at(path: string): StandInDevice | undefined {
    return this.devices.find((device) => this.path(device) === path);
  }

  private known(device: StandInDevice): boolean {
    return !device.nearby || device.paired === true || this.seen.has(device.address);
  }

  // GetManagedObjects, as busctl --json=short prints it.
  objects(): string {
    const all: Record<string, Record<string, Record<string, unknown>>> = {
      "/org/bluez": { "org.freedesktop.DBus.Introspectable": {}, "org.bluez.AgentManager1": {} },
    };
    if (this.adapter) {
      all["/org/bluez/hci0"] = {
        "org.freedesktop.DBus.Introspectable": {},
        "org.bluez.Adapter1": {
          Address: variant("s", "A4:6B:B6:00:00:01"),
          AddressType: variant("s", "public"),
          Name: variant("s", "agentv"),
          Alias: variant("s", "agentv"),
          Class: variant("u", 7078148),
          Powered: variant("b", this.powered),
          Discoverable: variant("b", false),
          Pairable: variant("b", true),
          Discovering: variant("b", this.scanning),
          UUIDs: variant("as", ["00001800-0000-1000-8000-00805f9b34fb"]),
        },
      };
      for (const device of this.devices.filter((d) => this.known(d))) {
        all[this.path(device)] = {
          "org.freedesktop.DBus.Introspectable": {},
          "org.bluez.Device1": {
            Address: variant("s", device.address),
            AddressType: variant("s", device.cls === undefined ? "random" : "public"),
            ...(device.name ? { Name: variant("s", device.name) } : {}),
            Alias: variant("s", device.name ?? device.address.replace(/:/g, "-")),
            ...(device.cls === undefined ? {} : { Class: variant("u", device.cls) }),
            ...(device.appearance === undefined ? {} : { Appearance: variant("q", device.appearance) }),
            ...(device.icon ? { Icon: variant("s", device.icon) } : {}),
            Paired: variant("b", device.paired === true),
            Bonded: variant("b", device.paired === true),
            Trusted: variant("b", device.trusted === true),
            Blocked: variant("b", false),
            LegacyPairing: variant("b", false),
            Connected: variant("b", device.connected === true),
            UUIDs: variant("as", []),
            Adapter: variant("o", "/org/bluez/hci0"),
            ServicesResolved: variant("b", device.connected === true),
          },
        };
      }
    }
    return JSON.stringify({ type: "a{oa{sa{sv}}}", data: [all] });
  }

  run: Run = async (command, args): Promise<Ran> => {
    const said = args.filter((arg) => !arg.startsWith("--"));
    this.calls.push([command, ...said].join(" "));
    const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
    const failed = (err: string): Ran => ({ code: 1, out: "", err: `Call failed: ${err}\n` });
    if (command === "rfkill") {
      this.blocked = false;
      return ok();
    }
    if (command !== "busctl") return { code: 127, out: "", err: "not found" };
    if (!this.adapter) return failed("The name org.bluez was not provided by any .service files");
    const [verb, , path, iface, member, ...rest] = said;
    if (verb === "call" && member === "GetManagedObjects") return ok(this.objects());
    if (verb === "set-property" && iface === "org.bluez.Adapter1" && member === "Powered") {
      if (this.blocked) return failed("Blocked through rfkill");
      this.powered = rest[1] === "true";
      return ok();
    }
    if (verb === "call" && iface === "org.bluez.Adapter1" && member === "RemoveDevice") {
      const device = this.at(rest[1]);
      if (!device) return failed("Does Not Exist");
      // Still in pairing mode, a look that's running finds it again.
      if (!this.scanning) this.seen.delete(device.address);
      if (device.nearby) Object.assign(device, { paired: false, trusted: false, connected: false });
      else this.devices = this.devices.filter((d) => d !== device);
      return ok();
    }
    const device = this.at(path);
    if (!device || !this.known(device)) return failed("Method \"" + member + "\" with signature \"\" on interface \"" + iface + "\" doesn't exist");
    if (verb === "set-property" && member === "Trusted") {
      device.trusted = rest[1] === "true";
      return ok();
    }
    if (verb === "call" && member === "Pair") {
      await this.hold;
      if (device.wantsCode) return failed("Authentication Failed");
      device.paired = true;
      return ok();
    }
    if (verb === "call" && member === "Connect") {
      if (!device.paired) return failed("Not Ready");
      device.connected = true;
      Object.assign(device, device.becomes ?? {});
      return ok();
    }
    return failed("Unknown method");
  };

  // /proc/bus/input/devices: the input devices the kernel made for what's
  // connected, each with the device's address as its Uniq, in lower case as
  // the kernel has it. A gamepad's keys are its buttons. A keyboard has the
  // typing keys, and a mouse moves on two axes.
  inputs = async (): Promise<string> => {
    const one = (device: StandInDevice, name: string, more: string[]) =>
      [`I: Bus=0005 Vendor=045e Product=0b13 Version=0001`, `N: Name="${name}"`, `P: Phys=a4:6b:b6:00:00:01`, `S: Sysfs=/devices/virtual/misc/uhid/0005:045E:0B13.0001/input/input1`, `U: Uniq=${device.address.toLowerCase()}`, ...more, ""].join("\n");
    const all = [`I: Bus=0019 Vendor=0000 Product=0001 Version=0000\nN: Name="Power Button"\nP: Phys=PNP0C0C/button/input0\nS: Sysfs=/devices/x\nU: Uniq=\nH: Handlers=kbd event0\nB: PROP=0\nB: EV=3\nB: KEY=10000000000000 0\n`];
    for (const device of this.devices.filter((d) => d.connected)) {
      const name = device.name ?? "Device";
      all.push(one(device, name, ["H: Handlers=event20 js0", "B: PROP=0", "B: EV=20001b", "B: KEY=7fdb000000000000 0 100040000000 0 0", "B: ABS=3003f", "B: MSC=10"]));
      if (device.presents === "keyboard") all.push(one(device, `${name} Keyboard`, ["H: Handlers=sysrq kbd event21 leds", "B: PROP=0", "B: EV=120013", "B: KEY=1000000000007 ff9f207ac14057ff febeffdfffefffff fffffffffffffffe", "B: MSC=10", "B: LED=1f"]));
      if (device.presents === "mouse") all.push(one(device, `${name} Mouse`, ["H: Handlers=mouse1 event22", "B: PROP=0", "B: EV=17", "B: KEY=1f0000 0 0 0 0", "B: REL=1943", "B: MSC=10"]));
    }
    return all.join("\n");
  };

  // bluetoothctl scan on, for as long as it's left running.
  look = (): Looking => {
    this.calls.push("bluetoothctl scan on");
    this.scanning = true;
    for (const device of this.devices) if (device.nearby) this.seen.add(device.address);
    let over = false;
    return {
      stop: () => {
        over = true;
        this.scanning = false;
        this.calls.push("bluetoothctl stopped");
      },
      over: () => over,
    };
  };
}
