// The box's sound output (ADR-017, ADR-031, S2.19). The box plays at full
// volume and the TV's remote sets how loud it is, the way Apple TV and
// Chromecast do. The screen daemon sets the default output to 100% each time
// an output becomes the default: as the TV session starts, when a new screen
// or its HDMI or DisplayPort audio comes, and when the default moves. It
// never moves the volume otherwise. A level chosen in Settings → Sound is
// kept for that output instead, and an output picked there stays the default
// while it's there. With nothing picked, the default is the HDMI or
// DisplayPort output something is plugged into.
//
// It talks to PipeWire through its PulseAudio server with pactl, as
// Omarchy's own audio commands do, and only to real outputs: a sound card's
// or a Bluetooth device's, never a filter or a virtual sink someone set up.

import { spawn, execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export interface Sink {
  // PipeWire's name for it, the same at every start.
  name: string;
  description: string;
  // 1 is 100%.
  volume: number;
  // An HDMI or DisplayPort output.
  hdmi: boolean;
  // Whether its port says something is plugged in, or null when it can't
  // tell, as with most analog outputs.
  connected: boolean | null;
}

// What Settings → Sound chose, in ~/.local/state/agentv/audio.json.
export interface Chosen {
  output?: string;
  levels?: Record<string, number>;
}

// PipeWire, faked in the tests.
export interface Pulse {
  sinks(): Promise<Sink[]>;
  defaultSink(): Promise<string | null>;
  setDefault(name: string): Promise<void>;
  setVolume(name: string, volume: number): Promise<void>;
  // Calls back when an output comes or goes, the default moves, or a port
  // is plugged in or out; never for a volume change. Returns a stop.
  watch(changed: () => void): () => void;
}

// The output that should be the default, or null to leave things as they
// are: the one Settings picked while it's there and not unplugged, else the
// default while it's a connected HDMI or DisplayPort output, else the first
// connected one of those. A default that isn't a real output, such as a
// filter someone set up, is left alone.
export function pick(sinks: Sink[], current: string | null, chosen: Chosen): string | null {
  const find = (name: string | null | undefined) => sinks.find((sink) => sink.name === name);
  const picked = find(chosen.output);
  if (picked && picked.connected !== false) return picked.name;
  const now = find(current);
  if (current && !now) return null;
  if (now?.hdmi && now.connected === true) return now.name;
  const hdmi = sinks.find((sink) => sink.hdmi && sink.connected === true);
  if (hdmi) return hdmi.name;
  return now?.name ?? sinks[0]?.name ?? null;
}

// The level an output plays at: the one chosen for it in Settings, else 100%.
export function level(name: string, chosen: Chosen): number {
  const set = chosen.levels?.[name];
  return typeof set === "number" && Number.isFinite(set) ? Math.max(0, Math.min(1, set)) : 1;
}

const percent = (volume: number) => `${Math.round(volume * 100)}%`;

export interface AudioOptions {
  pulse: Pulse;
  // Where Settings → Sound's choices are kept.
  state?: string;
  log?: (line: string) => void;
  // How long it waits for PipeWire to settle after a change.
  settleMs?: number;
}

export class Audio {
  private pulse: Pulse;
  private path: string;
  private log: (line: string) => void;
  private settleMs: number;
  // The output that was the default when it last looked, so a new default
  // gets its level once, and then the TV's remote and the person have it.
  private last: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private stopWatch?: () => void;
  private running: Promise<void> = Promise.resolve();

  constructor(options: AudioOptions) {
    this.pulse = options.pulse;
    this.path = options.state ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "agentv", "audio.json");
    this.log = options.log ?? ((line) => console.log(line));
    this.settleMs = options.settleMs ?? 750;
  }

  // Looks now, then after every change PipeWire reports.
  start(): void {
    this.stopWatch = this.pulse.watch(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.check(), this.settleMs);
    });
    void this.check();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.stopWatch?.();
  }

  // One look at a time, in order.
  check(): Promise<void> {
    this.running = this.running.then(() => this.apply()).catch((error: Error) => this.log(`sound: ${error.message}`));
    return this.running;
  }

  private chosen(): Chosen {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  private save(chosen: Chosen): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.next`, JSON.stringify(chosen, null, 2));
    renameSync(`${this.path}.next`, this.path);
  }

  private async apply(): Promise<void> {
    const [sinks, current] = await Promise.all([this.pulse.sinks(), this.pulse.defaultSink()]);
    const chosen = this.chosen();
    const target = pick(sinks, current, chosen);
    if (!target) {
      this.last = current;
      return;
    }
    const sink = sinks.find((s) => s.name === target)!;
    if (target !== current) {
      await this.pulse.setDefault(target);
      this.log(`sound: the default output is ${sink.description} now`);
    }
    if (target !== this.last) {
      const want = level(target, chosen);
      if (Math.abs(sink.volume - want) > 0.005) {
        await this.pulse.setVolume(target, want);
        this.log(`sound: ${sink.description} plays at ${percent(want)}${chosen.levels?.[target] === undefined ? "" : ", as chosen in settings"}`);
      }
    }
    this.last = target;
  }

  // What Settings → Sound shows: the outputs, which one plays, its volume,
  // and the level it should be at.
  async status(): Promise<object> {
    await this.running;
    const [sinks, current] = await Promise.all([this.pulse.sinks(), this.pulse.defaultSink()]);
    const chosen = this.chosen();
    const now = sinks.find((sink) => sink.name === current);
    return {
      ok: true,
      output: now?.name ?? null,
      outputs: sinks.map((sink) => ({ name: sink.name, description: sink.description, hdmi: sink.hdmi, connected: sink.connected })),
      volume: now ? Math.round(now.volume * 100) / 100 : null,
      expected: now ? level(now.name, chosen) : null,
      chosen: { output: chosen.output ?? null, level: now ? (chosen.levels?.[now.name] ?? null) : null },
    };
  }

  // Settings → Sound's output picker: this output, from now on.
  async choose(name: string): Promise<object> {
    const sinks = await this.pulse.sinks();
    const sink = sinks.find((s) => s.name === name);
    if (!sink) return { ok: false, error: "that output isn't there" };
    this.save({ ...this.chosen(), output: name });
    this.log(`sound: ${sink.description} picked in settings`);
    await this.check();
    return this.status();
  }

  // Settings → Sound's volume: the default output at this level, from now on.
  async setLevel(volume: number): Promise<object> {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) return { ok: false, error: "a volume from 0 to 100%" };
    const current = await this.pulse.defaultSink();
    const sink = (await this.pulse.sinks()).find((s) => s.name === current);
    if (!sink) return { ok: false, error: "there's no sound output to set" };
    const rounded = Math.round(volume * 100) / 100;
    const chosen = this.chosen();
    this.save({ ...chosen, levels: { ...chosen.levels, [sink.name]: rounded } });
    await this.pulse.setVolume(sink.name, rounded);
    this.log(`sound: ${sink.description} set to ${percent(rounded)} in settings`);
    return this.status();
  }

  async handle(request: Record<string, unknown>): Promise<object> {
    if (typeof request.output === "string") return this.choose(request.output);
    if (request.volume !== undefined) return this.setLevel(Number(request.volume));
    return this.status();
  }
}

// --- pactl ----------------------------------------------------------------------

function pactl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("pactl", args, { timeout: 5_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`pactl ${args[0]}: ${(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}

interface PactlSink {
  name: string;
  description?: string;
  volume?: Record<string, { value?: number }>;
  ports?: { name: string; availability?: string }[];
  active_port?: string | null;
}

// A real output: a sound card's or a Bluetooth device's.
const REAL = /^(alsa_output|bluez_output)\./;
// ALSA names a DisplayPort output HDMI too.
const HDMI = /hdmi|displayport/i;

// pactl's JSON for its sinks, as Sinks.
export function sinksFrom(json: string): Sink[] {
  let list: PactlSink[];
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((sink) => typeof sink?.name === "string" && REAL.test(sink.name))
    .map((sink) => {
      const channels = Object.values(sink.volume ?? {}).map((channel) => Number(channel?.value) / 65536).filter(Number.isFinite);
      const port = sink.ports?.find((p) => p.name === sink.active_port);
      const availability = port?.availability ?? "";
      return {
        name: sink.name,
        description: sink.description || sink.name,
        volume: channels.length ? channels.reduce((a, b) => a + b, 0) / channels.length : 0,
        hdmi: HDMI.test(`${sink.name} ${sink.active_port ?? ""}`),
        connected: availability === "available" ? true : availability === "not available" ? false : null,
      };
    });
}

export class Pactl implements Pulse {
  async sinks(): Promise<Sink[]> {
    return sinksFrom(await pactl(["-f", "json", "list", "sinks"]));
  }

  async defaultSink(): Promise<string | null> {
    return (await pactl(["get-default-sink"])).trim() || null;
  }

  async setDefault(name: string): Promise<void> {
    await pactl(["set-default-sink", name]);
  }

  async setVolume(name: string, volume: number): Promise<void> {
    await pactl(["set-sink-volume", name, percent(volume)]);
  }

  watch(changed: () => void): () => void {
    let stopped = false;
    let child: ReturnType<typeof spawn> | undefined;
    const run = () => {
      if (stopped) return;
      child = spawn("pactl", ["subscribe"], { stdio: ["ignore", "pipe", "ignore"] });
      child.on("error", () => {});
      createInterface({ input: child.stdout! }).on("line", (line) => {
        // "Event 'new' on sink #63", "Event 'change' on server #4294967295"
        // when the default moves, "Event 'change' on card #47" when a port
        // is plugged in or out. A sink's own change is its volume.
        if (/'(new|remove)' on sink #|'change' on (server|card) #/.test(line)) changed();
      });
      // PipeWire restarted, or isn't up yet: try again, and look again then.
      child.on("exit", () => {
        if (stopped) return;
        setTimeout(() => {
          run();
          changed();
        }, 5_000);
      });
    };
    run();
    return () => {
      stopped = true;
      child?.kill();
    };
  }
}
