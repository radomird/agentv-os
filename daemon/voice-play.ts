// The TV says its answer (stage 8): the screen daemon, which runs in the TV
// session as the person, plays the daemon's clip through PipeWire to the
// box's sound output, over HDMI to the TV, whatever is in front. A newer
// answer stops one still playing. The clip is WAV, from the provider's
// voice or the TV's own (daemon/voice.ts), and it's gone once it's played.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Played {
  ok: boolean;
  ms?: number;
  error?: string;
}

// How a clip is played: PipeWire's own player, else PulseAudio's, which
// PipeWire answers too.
const PLAYERS: [string, string[]][] = [
  ["pw-play", ["--media-role", "Notification"]],
  ["paplay", []],
];

export class VoicePlayer {
  private home: string;
  private dir: string;
  private playing: ChildProcess | null = null;
  private players: [string, string[]][];

  constructor(options: { home: string; dir?: string; players?: [string, string[]][] }) {
    this.home = options.home;
    this.dir = options.dir ?? join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "agentv-voice");
    this.players = options.players ?? PLAYERS;
  }

  // The daemon's clip, played to the end, or why not.
  async play(clip: number): Promise<Played> {
    const response = await fetch(`${this.home}api/voice/${clip}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!response?.ok) return { ok: false, error: "the clip wasn't there" };
    const bytes = Buffer.from(await response.arrayBuffer());
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${clip}.wav`);
    writeFileSync(file, bytes, { mode: 0o600 });
    this.playing?.kill("SIGTERM");
    try {
      for (const [player, args] of this.players) {
        const played = await this.run(player, [...args, file]);
        if (played.ok || played.error !== "missing") return played;
      }
      return { ok: false, error: "there's no player for sound on this box" };
    } finally {
      rmSync(file, { force: true });
    }
  }

  private run(player: string, args: string[]): Promise<Played> {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(player, args, { stdio: "ignore" });
      this.playing = child;
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ ok: false, error: error.code === "ENOENT" ? "missing" : error.message });
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (this.playing === child) this.playing = null;
        if (signal === "SIGTERM") return resolve({ ok: true, ms: Date.now() - started, error: "a newer answer took over" });
        resolve(code === 0 ? { ok: true, ms: Date.now() - started } : { ok: false, error: `${player} stopped (${code ?? signal})` });
      });
    });
  }
}
