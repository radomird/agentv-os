// The box's sound output (daemon/audio.ts, S2.19): full volume each time an
// output becomes the default, a level chosen in Settings → Sound kept for its
// output, the connected HDMI or DisplayPort output as the default when
// Settings picked none, and nothing else touched, against a stand-in for
// PipeWire.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Audio, level, pick, sinksFrom, type Pulse, type Sink } from "../../../daemon/audio.ts";

const dir = mkdtempSync(join(tmpdir(), "agentv-audio-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const statePath = () => join(dir, `audio-${++n}.json`);

const hdmi = (over: Partial<Sink> = {}): Sink => ({
  name: "alsa_output.pci-0000_00_1f.3.hdmi-stereo",
  description: "LG TV (HDMI)",
  volume: 0.4,
  hdmi: true,
  connected: true,
  ...over,
});
const analog = (over: Partial<Sink> = {}): Sink => ({
  name: "alsa_output.pci-0000_00_1f.3.analog-stereo",
  description: "Built-in Audio Analog Stereo",
  volume: 0.4,
  hdmi: false,
  connected: null,
  ...over,
});

class FakePulse implements Pulse {
  calls: string[] = [];
  changed?: () => void;
  list: Sink[];
  current: string | null;
  constructor(list: Sink[], current: string | null) {
    this.list = list;
    this.current = current;
  }
  async sinks() {
    return this.list.map((sink) => ({ ...sink }));
  }
  async defaultSink() {
    return this.current;
  }
  async setDefault(name: string) {
    this.calls.push(`default ${name}`);
    this.current = name;
  }
  async setVolume(name: string, volume: number) {
    this.calls.push(`volume ${name} ${Math.round(volume * 100)}%`);
    this.list.find((sink) => sink.name === name)!.volume = volume;
  }
  watch(changed: () => void) {
    this.changed = changed;
    return () => (this.changed = undefined);
  }
  // PipeWire reporting a change, and the box looking again after it.
  async fire(audio: Audio) {
    this.changed?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await audio.check();
  }
}

function box(list: Sink[], current: string | null, state = statePath()) {
  const pulse = new FakePulse(list, current);
  const lines: string[] = [];
  const audio = new Audio({ pulse, state, log: (line) => lines.push(line), settleMs: 0 });
  return { pulse, audio, lines, state };
}

test("S2.19 the default is the output Settings picked, else a connected HDMI or DisplayPort one", () => {
  const h = hdmi();
  const a = analog();
  assert.equal(pick([h, a], h.name, {}), h.name, "a connected HDMI default stays");
  assert.equal(pick([h, a], a.name, {}), h.name, "with nothing picked, the connected HDMI output takes over from analog");
  assert.equal(pick([hdmi({ connected: false }), a], a.name, {}), a.name, "an unplugged HDMI output doesn't");
  assert.equal(pick([hdmi({ connected: null }), a], a.name, {}), a.name, "nor one that can't tell");
  assert.equal(pick([h, a], h.name, { output: a.name }), a.name, "the output Settings picked wins");
  assert.equal(pick([h, analog({ connected: false })], h.name, { output: a.name }), h.name, "unless it's unplugged");
  assert.equal(pick([h], h.name, { output: "alsa_output.gone" }), h.name, "or gone");
  assert.equal(pick([h, a], "easyeffects_sink", {}), null, "a filter someone set up as the default is left alone");
  assert.equal(pick([], "auto_null", {}), null, "no sound card, nothing to do");
  assert.equal(pick([a], null, {}), a.name, "no default yet: the one there is");
});

test("S2.19 an output plays at 100% unless Settings chose a lower level for it", () => {
  assert.equal(level("x", {}), 1);
  assert.equal(level("x", { levels: { x: 0.6 } }), 0.6);
  assert.equal(level("y", { levels: { x: 0.6 } }), 1);
  assert.equal(level("x", { levels: { x: 7 } }), 1);
});

test("S2.19 as the TV session starts, the default output goes to 100%, once", async () => {
  const { pulse, audio, lines } = box([hdmi(), analog()], hdmi().name);
  audio.start();
  await audio.check();
  assert.deepEqual(pulse.calls, [`volume ${hdmi().name} 100%`]);
  assert.match(lines.join("\n"), /LG TV \(HDMI\) plays at 100%/);
  // Turned down by other means, it stays down: a port or the default
  // looked at again doesn't move a volume back.
  pulse.list[0].volume = 0.3;
  await pulse.fire(audio);
  assert.deepEqual(pulse.calls, [`volume ${hdmi().name} 100%`]);
  audio.stop();
});

test("S2.19 a new screen's HDMI output becomes the default at 100%, and so does an output that becomes the default", async () => {
  const { pulse, audio } = box([analog()], analog().name);
  audio.start();
  await audio.check();
  assert.deepEqual(pulse.calls, [`volume ${analog().name} 100%`]);
  pulse.calls = [];
  // A TV comes on HDMI.
  pulse.list.push(hdmi());
  await pulse.fire(audio);
  assert.deepEqual(pulse.calls, [`default ${hdmi().name}`, `volume ${hdmi().name} 100%`]);
  pulse.calls = [];
  // The TV goes; analog is the default again, and plays at 100% again.
  pulse.list = [analog({ volume: 0.5 })];
  pulse.current = analog().name;
  await pulse.fire(audio);
  assert.deepEqual(pulse.calls, [`volume ${analog().name} 100%`]);
  audio.stop();
});

test("S2.19 a level chosen in Settings stays with its output, across a restart of the screen daemon", async () => {
  const state = statePath();
  const first = box([hdmi({ volume: 1 }), analog()], hdmi().name, state);
  first.audio.start();
  await first.audio.check();
  const set = (await first.audio.setLevel(0.6)) as { ok: boolean; volume: number; expected: number };
  assert.equal(set.ok, true);
  assert.equal(set.volume, 0.6);
  assert.equal(set.expected, 0.6);
  assert.deepEqual(JSON.parse(readFileSync(state, "utf8")).levels, { [hdmi().name]: 0.6 });
  first.audio.stop();

  // The next start, with WirePlumber's own level somewhere else.
  const again = box([hdmi({ volume: 0.4 }), analog()], hdmi().name, state);
  again.audio.start();
  await again.audio.check();
  assert.deepEqual(again.pulse.calls, [`volume ${hdmi().name} 60%`]);
  assert.match(again.lines.join("\n"), /plays at 60%, as chosen in settings/);
  // Another output still gets 100%.
  again.pulse.calls = [];
  await again.audio.choose(analog().name);
  assert.deepEqual(again.pulse.calls, [`default ${analog().name}`, `volume ${analog().name} 100%`]);
  again.audio.stop();
  assert.deepEqual(await again.audio.setLevel(1.5), { ok: false, error: "a volume from 0 to 100%" });
});

test("S2.19 Settings → Sound's output picker keeps its output the default, over the HDMI rule", async () => {
  const { pulse, audio, state } = box([hdmi(), analog()], hdmi().name);
  audio.start();
  await audio.check();
  pulse.calls = [];
  const status = (await audio.choose(analog().name)) as { ok: boolean; output: string; outputs: unknown[] };
  assert.equal(status.output, analog().name);
  assert.equal(status.outputs.length, 2);
  assert.equal(JSON.parse(readFileSync(state, "utf8")).output, analog().name);
  pulse.calls = [];
  await pulse.fire(audio);
  assert.deepEqual(pulse.calls, [], "the connected HDMI output doesn't take it back");
  assert.deepEqual(await audio.choose("alsa_output.nowhere"), { ok: false, error: "that output isn't there" });
  audio.stop();
});

test("S2.19 a filter or a virtual output someone made the default is left alone", async () => {
  const { pulse, audio } = box([hdmi(), analog()], "easyeffects_sink");
  audio.start();
  await audio.check();
  assert.deepEqual(pulse.calls, []);
  const status = (await audio.status()) as { output: string | null; volume: number | null };
  assert.equal(status.output, null);
  assert.equal(status.volume, null);
  assert.deepEqual(await audio.setLevel(0.5), { ok: false, error: "there's no sound output to set" });
  audio.stop();
});

test("pactl's sinks: real outputs only, their volume, and whether their port is plugged in", () => {
  const json = JSON.stringify([
    {
      name: "alsa_output.pci-0000_00_1f.3.hdmi-stereo",
      description: "Built-in Audio Digital Stereo (HDMI)",
      volume: { "front-left": { value: 26214, value_percent: "40%" }, "front-right": { value: 26214, value_percent: "40%" } },
      ports: [{ name: "hdmi-output-0", availability: "available" }],
      active_port: "hdmi-output-0",
    },
    {
      name: "alsa_output.pci-0000_00_1f.3.analog-stereo",
      description: "Built-in Audio Analog Stereo",
      volume: { mono: { value: 65536 } },
      ports: [{ name: "analog-output-headphones", availability: "not available" }],
      active_port: "analog-output-headphones",
    },
    { name: "alsa_output.usb-dac.iec958-stereo", description: "USB DAC", volume: {}, ports: [{ name: "iec958-stereo-output", availability: "availability unknown" }], active_port: "iec958-stereo-output" },
    { name: "easyeffects_sink", description: "Easy Effects Sink", volume: { mono: { value: 65536 } } },
  ]);
  const sinks = sinksFrom(json);
  assert.deepEqual(sinks.map((s) => s.name), ["alsa_output.pci-0000_00_1f.3.hdmi-stereo", "alsa_output.pci-0000_00_1f.3.analog-stereo", "alsa_output.usb-dac.iec958-stereo"]);
  assert.equal(Math.round(sinks[0].volume * 100), 40);
  assert.deepEqual([sinks[0].hdmi, sinks[0].connected], [true, true]);
  assert.deepEqual([sinks[1].hdmi, sinks[1].connected, sinks[1].volume], [false, false, 1]);
  assert.deepEqual([sinks[2].hdmi, sinks[2].connected], [false, null]);
  assert.deepEqual(sinksFrom("not json"), []);
});
