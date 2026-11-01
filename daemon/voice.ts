// The TV's spoken answers over HDMI (stage 8, Q146, Q152): every answer the
// TV shows for something said to it is said aloud too, "i didn't get that"
// included, beside ADR-054's listening bar. The words are the outcome's own
// line, so a child's profile hears only what it was shown: what's on the
// apps a child can open.
//
// Which voice:
// - with a key for a provider that has a voice of its own (ChatGPT, Gemini,
//   Grok), that one, the most natural it offers, through the router's
//   service, which alone holds the key (daemon/providers/speech.ts);
// - otherwise, and whenever that one doesn't answer, Piper on the box, with
//   its cori voice (British English, public domain), which needs no key and
//   no network once it's here. Claude and Muse have no speech API, and a
//   plan has no key, so they hear Piper.
//
// Piper isn't in AgenTV's package: the first time it's needed, the daemon
// asks root to fetch it, pinned by checksum (bin/agentv-voice-fetch), and
// that answer is shown and not said. Settings → Sound turns spoken answers
// off.
//
// Nothing here logs the words.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiState, Provider } from "./ai.ts";
import { speaks } from "./providers/speech.ts";

export const VOICE_DIR = "/var/lib/agentv/voice";
export const PIPER_VOICE = "en_GB-cori-medium";
const SPEAK_SOCKET = "/run/agentv-router/router.sock";
// How long Piper may take for a line, and how often to ask root for it
// again after a fetch that didn't work.
const PIPER_MS = 20_000;
const FETCH_AGAIN_MS = 3600_000;

export interface Clip {
  wav: Buffer;
  by: "provider" | "piper";
  provider?: Provider;
  ms: number;
}

export type Voiced = { ok: true; wav: Buffer } | { ok: false; error: string };

export interface VoiceState {
  spoken: boolean;
  by: "provider" | "piper" | null; // what says the next answer
  provider: Provider | null;
  piper: "ready" | "fetching" | "missing";
}

export interface VoiceOptions {
  dir?: string; // Piper and its voice: /var/lib/agentv/voice
  drop?: string; // where the daemon asks root to fetch it: <state>/voice-drop/fetch
  ai: () => Promise<AiState>;
  key: () => { set: boolean; provider: string | null };
  spoken: () => Promise<boolean>;
  // The provider's voice through the router's service, and Piper; tests
  // stand both in.
  provider?: (provider: Provider, text: string) => Promise<Voiced>;
  piper?: (text: string) => Promise<Voiced>;
  log?: (line: string) => void;
  now?: () => number;
}

// The provider's voice, through the router's service, which holds the key.
export function speakViaRouter(socket = SPEAK_SOCKET, timeoutMs = 25_000): (provider: Provider, text: string) => Promise<Voiced> {
  return (provider, text) =>
    new Promise((resolve) => {
      const asked = request({ socketPath: socket, path: "/speak", method: "POST", headers: { "Content-Type": "application/json" }, timeout: timeoutMs }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => {
          try {
            const answer = JSON.parse(body) as { ok?: boolean; wav?: string; error?: string };
            resolve(answer.ok && answer.wav ? { ok: true, wav: Buffer.from(answer.wav, "base64") } : { ok: false, error: answer.error ?? "the voice didn't answer" });
          } catch {
            resolve({ ok: false, error: "the router didn't answer" });
          }
        });
      });
      asked.on("timeout", () => {
        asked.destroy();
        resolve({ ok: false, error: "the voice took too long" });
      });
      asked.on("error", () => resolve({ ok: false, error: "the router isn't running" }));
      asked.end(JSON.stringify({ provider, text }));
    });
}

// Piper on the box: the line on its standard input, WAV in a file of the
// daemon's own.
export function piperOn(dir: string, timeoutMs = PIPER_MS): (text: string) => Promise<Voiced> {
  let n = 0;
  return (text) =>
    new Promise((resolve) => {
      const out = join(tmpdir(), `agentv-voice-${process.pid}-${++n}.wav`);
      const done = (said: Voiced) => {
        rmSync(out, { force: true });
        resolve(said);
      };
      const child = spawn(join(dir, "piper", "piper"), ["--model", join(dir, `${PIPER_VOICE}.onnx`), "--output_file", out], {
        stdio: ["pipe", "ignore", "ignore"],
        env: { PATH: process.env.PATH ?? "/usr/bin", LD_LIBRARY_PATH: join(dir, "piper") },
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", () => (clearTimeout(timer), done({ ok: false, error: "piper didn't start" })));
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0 || !existsSync(out)) return done({ ok: false, error: code === null ? "piper took too long" : `piper stopped (${code})` });
        done({ ok: true, wav: readFileSync(out) });
      });
      child.stdin.end(`${text.replace(/\s+/g, " ").trim()}\n`);
    });
}

export class Voice {
  private o: VoiceOptions;
  private dir: string;
  private asked = Number.NEGATIVE_INFINITY;

  constructor(options: VoiceOptions) {
    this.o = options;
    this.dir = options.dir ?? VOICE_DIR;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  piperReady(): boolean {
    return Boolean(this.o.piper) || existsSync(join(this.dir, "ready"));
  }

  // The provider whose own voice says the answers, or null for Piper: one
  // with a voice, whose key is the one kept.
  private async provider(): Promise<Provider | null> {
    const ai = await this.o.ai();
    const key = this.o.key();
    if (ai.path !== "key" || !ai.provider || !key.set || key.provider !== ai.provider || !speaks(ai.provider)) return null;
    return ai.provider;
  }

  async state(): Promise<VoiceState> {
    const provider = await this.provider();
    const piper = this.piperReady() ? "ready" : this.o.drop && existsSync(this.o.drop) ? "fetching" : "missing";
    return { spoken: await this.o.spoken(), by: provider ? "provider" : piper === "ready" ? "piper" : null, provider, piper };
  }

  // Asks root to fetch Piper and its voice, at most once an hour.
  fetchPiper(): void {
    if (!this.o.drop || this.piperReady() || this.now() - this.asked < FETCH_AGAIN_MS) return;
    this.asked = this.now();
    try {
      mkdirSync(join(this.o.drop, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(this.o.drop, `${new Date(this.now()).toISOString()}\n`);
      this.o.log?.("asked for piper's voice, for the tv's spoken answers");
    } catch (error) {
      this.o.log?.(`couldn't ask for piper's voice: ${(error as Error).message}`);
    }
  }

  // A line as the TV says it, or null when it isn't said: spoken answers are
  // off, or no voice answered.
  async make(text: string): Promise<Clip | null> {
    if (!text.trim() || !(await this.o.spoken())) return null;
    const started = this.now();
    const provider = await this.provider();
    if (provider) {
      const said = await (this.o.provider ?? speakViaRouter())(provider, text);
      if (said.ok) return { wav: said.wav, by: "provider", provider, ms: this.now() - started };
      this.o.log?.(`${provider}'s voice didn't answer (${said.error}), so piper says it`);
    }
    if (!this.o.piper && !this.piperReady()) {
      this.fetchPiper();
      return null;
    }
    const said = await (this.o.piper ?? piperOn(this.dir))(text);
    if (!said.ok) {
      this.o.log?.(`piper didn't say it: ${said.error}`);
      return null;
    }
    return { wav: said.wav, by: "piper", ms: this.now() - started };
  }
}
