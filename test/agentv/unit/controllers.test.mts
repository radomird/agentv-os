// Settings, controllers (ADR-084, T16.1): what BlueZ says read right, only
// game controllers listed, paired or removed, the adult guard, and the box
// check's count following a change.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { AskWatch } from "../../../daemon/asks.ts";
import { cleanAnswer, cleanName, Controllers, isController, listed, parseObjects, type ControllerAnswer, type ControllerAsk } from "../../../daemon/controllers.ts";
import { Daemon } from "../../../daemon/server.ts";
import { DUALSENSE, HEADPHONES, KEYBOARD, StandInBluez, XBOX } from "../fixtures/controllers/bluez.mts";

const ROOT = join(import.meta.dirname, "../../..");
const OBJECTS = readFileSync(join(ROOT, "test/agentv/fixtures/controllers/objects.json"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "agentv-controllers-"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => rmSync(scratch, { recursive: true, force: true }));

test("what busctl prints for BlueZ is read: the adapter, and each device with what it says it is", () => {
  const { adapters, devices } = parseObjects(OBJECTS);
  assert.deepEqual(adapters, [{ path: "/org/bluez/hci0", powered: true }]);
  assert.equal(devices.length, 8, "a service under a device isn't a device");
  assert.deepEqual(devices[0], {
    path: "/org/bluez/hci0/dev_AC_8E_BD_11_22_33",
    adapter: "/org/bluez/hci0",
    address: "AC:8E:BD:11:22:33",
    name: "Xbox Wireless Controller",
    icon: "input-gaming",
    cls: null,
    appearance: 0x03c4,
    paired: true,
    connected: true,
    trusted: true,
  });
  const nameless = devices.find((device) => device.address === "7A:3F:10:20:30:40");
  assert.equal(nameless?.name, "", "an alias that's only the address isn't a name");
  // Anything else gives nothing to act on.
  for (const text of ["", "not json", "{}", '{"data":[null]}', '{"data":"x"}']) assert.deepEqual(parseObjects(text), { adapters: [], devices: [] });
  // A device whose address isn't the one in its path is left out.
  const lying = JSON.parse(OBJECTS);
  lying.data[0]["/org/bluez/hci0/dev_AC_8E_BD_11_22_33"]["org.bluez.Device1"].Address.data = "34:88:5D:77:88:99";
  assert.equal(parseObjects(JSON.stringify(lying)).devices.some((device) => device.path.endsWith("AC_8E_BD_11_22_33")), false);
});

test("T16.1 only a game controller counts as one: never a keyboard, a mouse, headphones or a phone", () => {
  const { devices } = parseObjects(OBJECTS);
  const controllers = devices.filter(isController).map((device) => device.name);
  assert.deepEqual(controllers, ["Xbox Wireless Controller", "DualSense Wireless Controller", "Pro Controller"]);
  // BlueZ's word alone isn't enough when the device's own class or
  // appearance says otherwise.
  assert.equal(isController({ icon: "input-gaming", cls: 0x002508, appearance: null }), true, "a gamepad");
  assert.equal(isController({ icon: "input-gaming", cls: 0x002504, appearance: null }), true, "a joystick");
  assert.equal(isController({ icon: "input-gaming", cls: null, appearance: 0x03c3 }), true, "a low energy joystick");
  assert.equal(isController({ icon: "input-gaming", cls: null, appearance: null }), true, "BlueZ's word, with nothing against it");
  assert.equal(isController({ icon: "input-gaming", cls: 0x002548, appearance: null }), false, "a gamepad that's a keyboard too");
  assert.equal(isController({ icon: "input-gaming", cls: 0x002588, appearance: null }), false, "a gamepad that's a pointer too");
  assert.equal(isController({ icon: "input-gaming", cls: 0x240404, appearance: null }), false, "headphones");
  assert.equal(isController({ icon: "input-gaming", cls: null, appearance: 0x03c1 }), false, "a low energy keyboard");
  assert.equal(isController({ icon: "input-gaming", cls: 0x002508, appearance: 0x03c1 }), false, "one of the two says keyboard");
  assert.equal(isController({ icon: "input-keyboard", cls: 0x002508, appearance: 0x03c4 }), false, "BlueZ says keyboard");
  assert.equal(isController({ icon: "", cls: 0x002508, appearance: null }), false, "BlueZ doesn't say");
});

test("the list: paired controllers always, the ones nearby only while looking, and connected first", () => {
  const { devices } = parseObjects(OBJECTS);
  assert.deepEqual(
    listed(devices, "/org/bluez/hci0", false).map((one) => [one.name, one.paired, one.connected]),
    [
      ["Xbox Wireless Controller", true, true],
      ["Pro Controller", true, false],
    ],
  );
  assert.deepEqual(
    listed(devices, "/org/bluez/hci0", true).map((one) => one.name),
    ["Xbox Wireless Controller", "Pro Controller", "DualSense Wireless Controller"],
  );
  assert.deepEqual(listed(devices, "/org/bluez/hci1", true), [], "another adapter's aren't this one's");
  // A controller that hasn't said its name yet waits until it has.
  const quiet = devices.map((device) => (device.name === "DualSense Wireless Controller" ? { ...device, name: "" } : device));
  assert.equal(listed(quiet, "/org/bluez/hci0", true).length, 2);
});

test("a name is one plain line, whatever the device sent", () => {
  assert.equal(cleanName("  Pro\u0000 Controller\n‮​ "), "Pro Controller");
  assert.equal(cleanName("x".repeat(200)).length, 60);
});

function standIn(devices = [XBOX, DUALSENSE, KEYBOARD, HEADPHONES], options = {}) {
  const bluez = new StandInBluez(devices);
  const logged: string[] = [];
  const controllers = new Controllers({ run: bluez.run, look: bluez.look, log: (line) => logged.push(line), keepMs: 150, settleMs: 60, ...options });
  return { bluez, controllers, logged };
}

test("T16.1 looking finds the controllers nearby and not the keyboard, and pairing one pairs, trusts and connects it", async () => {
  const { bluez, controllers } = standIn();
  assert.deepEqual(await controllers.handle({ kind: "list" }), { ok: true, bluetooth: "on", looking: false, controllers: [] });
  const looking = await controllers.handle({ kind: "look", on: true });
  assert.equal(looking.looking, true);
  assert.equal(bluez.scanning, true);
  assert.deepEqual((await controllers.handle({ kind: "list" })).controllers, [
    { id: DUALSENSE.address, name: "DualSense Wireless Controller", paired: false, connected: false },
    { id: XBOX.address, name: "Xbox Wireless Controller", paired: false, connected: false },
  ]);

  bluez.calls.length = 0;
  const paired = await controllers.handle({ kind: "pair", id: XBOX.address });
  assert.equal(paired.ok, true);
  assert.deepEqual(paired.controllers, [
    { id: XBOX.address, name: "Xbox Wireless Controller", paired: true, connected: true },
    { id: DUALSENSE.address, name: "DualSense Wireless Controller", paired: false, connected: false },
  ]);
  // The looking stops for as long as the pairing takes, then goes on.
  const did = bluez.calls.filter((call) => !call.includes("GetManagedObjects"));
  const path = "/org/bluez/hci0/dev_AC_8E_BD_11_22_33";
  assert.deepEqual(did, ["bluetoothctl stopped", `busctl call org.bluez ${path} org.bluez.Device1 Pair`, `busctl set-property org.bluez ${path} org.bluez.Device1 Trusted b true`, `busctl call org.bluez ${path} org.bluez.Device1 Connect`, "bluetoothctl scan on"]);
  assert.equal(bluez.devices.find((device) => device.address === XBOX.address)?.trusted, true, "so it comes back by itself");

  // Removing it takes the pairing away.
  const removed = await controllers.handle({ kind: "remove", id: XBOX.address });
  assert.equal(removed.ok, true);
  assert.equal(removed.controllers.some((one) => one.paired), false);
  assert.ok(bluez.calls.includes(`busctl call org.bluez /org/bluez/hci0 org.bluez.Adapter1 RemoveDevice o ${path}`));
  controllers.stop();
});

test("T16.1 a keyboard is refused when it's asked for by its address, and so is removing what isn't a controller", async () => {
  const { bluez, controllers, logged } = standIn();
  await controllers.handle({ kind: "look", on: true });
  bluez.calls.length = 0;
  const keyboard = await controllers.handle({ kind: "pair", id: KEYBOARD.address });
  assert.equal(keyboard.ok, false);
  assert.equal(keyboard.why, "not-a-controller");
  assert.equal(bluez.calls.some((call) => / Pair$| Connect$|Trusted/.test(call)), false, "BlueZ is never asked");
  assert.equal(bluez.devices.find((device) => device.address === KEYBOARD.address)?.paired, undefined);
  assert.match(logged.join("\n"), /refused a bluetooth device that isn't a game controller \(input-keyboard\)/);

  const headphones = await controllers.handle({ kind: "remove", id: HEADPHONES.address });
  assert.equal(headphones.why, "not-a-controller");
  assert.equal(bluez.devices.some((device) => device.address === HEADPHONES.address && device.paired), true, "the headphones stay paired");

  for (const id of ["11:22:33:44:55:66", "", "../../etc", "ac:8e:bd:11:22:33", "/org/bluez/hci0"]) {
    const gone = await controllers.handle({ kind: "pair", id });
    assert.equal(gone.why, "gone", id);
  }
  assert.equal(bluez.calls.some((call) => / Pair$|RemoveDevice/.test(call)), false);
  controllers.stop();
});

test("a controller that wants a code fails with that reason, and leaves nothing half paired", async () => {
  const { bluez, controllers } = standIn([{ ...DUALSENSE, wantsCode: true }]);
  await controllers.handle({ kind: "look", on: true });
  const answer = await controllers.handle({ kind: "pair", id: DUALSENSE.address });
  assert.equal(answer.ok, false);
  assert.equal(answer.why, "code");
  assert.ok(bluez.calls.some((call) => call.includes("RemoveDevice")));
  assert.equal(bluez.calls.some((call) => call.includes("Trusted")), false);
  controllers.stop();
});

test("the looking stops by itself soon after the page stops asking, and at once when it says so", async () => {
  const { bluez, controllers } = standIn();
  await controllers.handle({ kind: "look", on: true });
  await sleep(80);
  await controllers.handle({ kind: "look", on: true });
  assert.equal(bluez.calls.filter((call) => call === "bluetoothctl scan on").length, 1, "one discovery, kept going");
  await sleep(100);
  assert.equal(bluez.scanning, true);
  await sleep(120);
  assert.equal(bluez.scanning, false, "nobody asked for 150 ms");
  assert.equal((await controllers.handle({ kind: "list" })).looking, false);
  await controllers.handle({ kind: "look", on: true });
  assert.equal(bluez.scanning, true);
  assert.equal((await controllers.handle({ kind: "look", on: false })).looking, false);
  assert.equal(bluez.scanning, false);
});

test("T16.1 a TV with no Bluetooth says none, and one that's switched off can be turned on", async () => {
  const none = standIn();
  none.bluez.adapter = false;
  assert.deepEqual(await none.controllers.handle({ kind: "look", on: true }), { ok: true, bluetooth: "none", looking: false, controllers: [] });
  assert.equal(none.bluez.scanning, false);
  assert.equal((await none.controllers.handle({ kind: "pair", id: XBOX.address })).why, "none");
  assert.equal((await none.controllers.handle({ kind: "power" })).why, "none");

  const off = standIn([{ ...XBOX, nearby: false, paired: true }]);
  off.bluez.powered = false;
  off.bluez.blocked = true;
  const state = await off.controllers.handle({ kind: "look", on: true });
  assert.deepEqual([state.bluetooth, state.looking], ["off", false]);
  assert.equal((await off.controllers.handle({ kind: "pair", id: XBOX.address })).why, "off");
  const on = await off.controllers.handle({ kind: "power" });
  assert.deepEqual([on.ok, on.bluetooth], [true, "on"]);
  assert.ok(off.bluez.calls.includes("rfkill unblock bluetooth"));
});

test("an answer from the TV session is kept within bounds", () => {
  assert.deepEqual(cleanAnswer(null), { ok: false, bluetooth: "none", looking: false, controllers: [] });
  const answer = cleanAnswer({ ok: true, bluetooth: "sideways", looking: "yes", why: "because", error: 7, extra: 1, controllers: [{ id: "AC:8E:BD:11:22:33", name: "Pad\n", paired: 1, connected: true, path: "/x" }, { id: "nope", name: "x" }, "x"] });
  assert.deepEqual(answer, { ok: true, bluetooth: "none", looking: false, controllers: [{ id: "AC:8E:BD:11:22:33", name: "Pad", paired: false, connected: true }] });
  assert.equal(cleanAnswer({ controllers: Array.from({ length: 100 }, (_, i) => ({ id: `AC:8E:BD:11:22:${String(i).padStart(2, "0")}` })) }).controllers.length, 40);
});

// --- The daemon's routes -----------------------------------------------------

let daemon: Daemon;
let url = "";
let bluez: StandInBluez;
let driver: Controllers;
let watch: AskWatch<ControllerAsk, ControllerAnswer>;
const asked: string[] = [];
const tree = join(scratch, "machine");
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(tree, path)), { recursive: true });
  writeFileSync(join(tree, path), text);
};

before(async () => {
  mkdirSync(join(scratch, "daemon-root", "setup"), { recursive: true });
  mkdirSync(join(tree, "sys/class/bluetooth/hci0"), { recursive: true });
  // A keyboard, and a gamepad on a cable.
  put("sys/class/input/event3/dev", "13:67\n");
  put("sys/class/input/event3/device/name", "AT Translated Set 2 keyboard\n");
  put("run/udev/data/c13:67", "E:ID_INPUT=1\nE:ID_INPUT_KEYBOARD=1\n");
  put("sys/class/input/event7/dev", "13:71\n");
  put("sys/class/input/event7/device/name", "8BitDo Pro 2 Wired Controller\n");
  put("sys/class/input/event7/device/id/bustype", "0003\n");
  put("run/udev/data/c13:71", "E:ID_INPUT=1\nE:ID_INPUT_JOYSTICK=1\n");
  daemon = new Daemon({ root: join(scratch, "daemon-root"), state: join(scratch, "state"), port: 0, log: () => {}, builtins: null, box: { root: tree, exec: async () => null, interfaces: () => ({}), disk: scratch } });
  url = `http://127.0.0.1:${await daemon.listen()}`;
  bluez = new StandInBluez([XBOX, KEYBOARD]);
  // Connecting makes the kernel's input device, as udev marks it, and
  // removing takes it away.
  const run: typeof bluez.run = async (command, args, ms) => {
    const ran = await bluez.run(command, args, ms);
    if (ran.code === 0 && args.includes("Connect")) {
      put("sys/class/input/event9/dev", "13:73\n");
      put("sys/class/input/event9/device/name", "Xbox Wireless Controller\n");
      put("sys/class/input/event9/device/id/bustype", "0005\n");
      put("run/udev/data/c13:73", "E:ID_INPUT=1\nE:ID_INPUT_JOYSTICK=1\n");
    }
    if (ran.code === 0 && args.includes("RemoveDevice")) rmSync(join(tree, "sys/class/input/event9"), { recursive: true, force: true });
    return ran;
  };
  driver = new Controllers({ run, look: bluez.look, log: () => {}, settleMs: 60 });
});

after(async () => {
  watch?.stop();
  driver?.stop();
  await daemon?.close();
});

const send = async (method: string, path: string, body?: unknown, grant?: string) => {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as Record<string, any> };
};

test("with no TV session to ask, the list says the TV isn't there yet, and still has the controller on a cable", async () => {
  daemon.controllerRoutes.quickMs = 200;
  const { status, data } = await send("GET", "/api/controllers");
  assert.equal(status, 200);
  assert.deepEqual([data.ok, data.bluetooth, data.controllers, data.usb], [false, "away", [], ["8BitDo Pro 2 Wired Controller"]]);
  daemon.controllerRoutes.quickMs = 8000;
});

test("T16.1 the box check's count follows a controller that's paired and one that's removed, with no restart", async () => {
  // The screen daemon's side, as it runs in the TV session.
  watch = new AskWatch<ControllerAsk, ControllerAnswer>({
    url: `${url}/`,
    path: "api/controllers/ask",
    what: "controllers",
    handle: (ask) => {
      asked.push(ask.kind);
      return driver.handle(ask);
    },
    failed: (error) => ({ ok: false, bluetooth: "none", looking: false, controllers: [], why: "failed", error: error.message }),
    log: () => {},
    retryMs: 50,
  });
  watch.start();
  const events: string[] = [];
  const stream = await fetch(`${url}/api/events`);
  const reader = stream.body!.getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      for (const match of new TextDecoder().decode(value).matchAll(/^event: (.*)$/gm)) events.push(match[1]);
    }
  })().catch(() => {});

  assert.equal((await send("GET", "/api/box")).data.gamepads, 1);
  const looking = (await send("POST", "/api/controllers/look", { on: true })).data;
  assert.deepEqual([looking.bluetooth, looking.looking, looking.usb], ["on", true, ["8BitDo Pro 2 Wired Controller"]]);
  assert.deepEqual((await send("GET", "/api/controllers")).data.controllers, [{ id: XBOX.address, name: "Xbox Wireless Controller", paired: false, connected: false }]);

  const paired = (await send("POST", "/api/controllers/pair", { id: XBOX.address })).data;
  assert.equal(paired.ok, true);
  assert.deepEqual(paired.controllers, [{ id: XBOX.address, name: "Xbox Wireless Controller", paired: true, connected: true }]);
  assert.deepEqual(paired.usb, ["8BitDo Pro 2 Wired Controller"], "the Bluetooth one isn't listed as on a cable too");
  assert.equal((await send("GET", "/api/box")).data.gamepads, 2);
  while (!events.includes("box")) await sleep(20);
  assert.ok(events.includes("controllers"), "the TV's pages hear it");

  const removed = (await send("DELETE", `/api/controllers/${XBOX.address}`)).data;
  assert.equal(removed.ok, true);
  assert.equal((await send("GET", "/api/box")).data.gamepads, 1);
  await reader.cancel().catch(() => {});

  // What isn't an address never reaches the TV session.
  asked.length = 0;
  assert.equal((await send("POST", "/api/controllers/pair", { id: "../x" })).status, 400);
  assert.equal((await send("DELETE", "/api/controllers/nope")).status, 404);
  assert.deepEqual(asked, []);
  // A keyboard's address does, and is refused there.
  await send("POST", "/api/controllers/look", { on: true });
  const keyboard = (await send("POST", "/api/controllers/pair", { id: KEYBOARD.address })).data;
  assert.deepEqual([keyboard.ok, keyboard.why], [false, "not-a-controller"]);
  await send("POST", "/api/controllers/look", { on: false });
});

test("T16.1 with a PIN set, pairing, removing and turning Bluetooth on need its grant, and a child's profile can still see the list", async () => {
  assert.equal((await send("PUT", "/api/pin", { pin: "4826" })).status, 200);
  const grant = (await send("POST", "/api/pin/check", { pin: "4826" })).data.grant as string;
  await send("POST", "/api/controllers/look", { on: true });
  asked.length = 0;
  for (const [method, path, body] of [
    ["POST", "/api/controllers/pair", { id: XBOX.address }],
    ["DELETE", `/api/controllers/${XBOX.address}`, undefined],
    ["POST", "/api/controllers/power", {}],
  ] as const) {
    for (const bad of [undefined, "made-up"]) {
      const refused = await send(method, path, body, bad);
      assert.equal(refused.status, 403, `${method} ${path}`);
      assert.deepEqual(refused.data, { ok: false, error: "that needs the pin", pin: true });
    }
  }
  assert.deepEqual(asked, [], "nothing reached the TV session");
  assert.notEqual(bluez.devices.find((device) => device.address === XBOX.address)?.paired, true);

  // A child's profile: the list, and nothing more without the PIN.
  const child = (await send("POST", "/api/viewers", { name: "mila", role: "child" }, grant)).data.profile;
  assert.equal((await send("POST", "/api/viewer", { id: child.id })).status, 200);
  const seen = await send("GET", "/api/controllers");
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.data.controllers.map((one: { name: string }) => one.name), ["Xbox Wireless Controller"]);
  assert.equal((await send("POST", "/api/controllers/pair", { id: XBOX.address })).status, 403);
  assert.notEqual(bluez.devices.find((device) => device.address === XBOX.address)?.paired, true);

  // With the PIN, it pairs.
  const paired = await send("POST", "/api/controllers/pair", { id: XBOX.address }, grant);
  assert.deepEqual([paired.status, paired.data.ok], [200, true]);
  assert.equal((await send("DELETE", `/api/controllers/${XBOX.address}`, undefined, grant)).data.ok, true);
});
