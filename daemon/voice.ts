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
// - otherwise, and whenever that one doesn't answer, the TV's own voice,
//   which needs no key and no network. Claude and Muse have no speech API,
//   and a plan has no key, so they hear the TV's own.
//
// The TV's own voice is whatever the agentv-voice package ships (ADR-087):
// - a program named say in its folder, which takes the line on its standard
//   input and writes a WAV file where its one argument says. The daemon
//   knows nothing else about it, so another voice is the package's change
//   alone;
// - or, in the package from before, Piper and its cori voice, run as they
//   were;
// - or nothing. With no package the TV has no voice of its own: the answer
//   shows on the TV as always, nothing is said, and nothing fails.
//
// Settings → Sound turns spoken answers off. Nothing here logs the words.

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiState, Provider } from "./ai.ts";
import { speaks } from "./providers/speech.ts";

export const VOICE_DIR = "/usr/lib/agentv-voice";
export const PIPER_VOICE = "en_GB-cori-medium";
const SPEAK_SOCKET = "/run/agentv-router/router.sock";
// How long the TV's own voice may take for a line.
const OWN_MS = 20_000;

export interface Clip {
  wav: Buffer;
  by: "provider" | "own";
  provider?: Provider;
  ms: number;
}

export type Voiced = { ok: true; wav: Buffer } | { ok: false; error: string };

export interface VoiceState {
  spoken: boolean;
  by: "provider" | "own" | null; // what says the next answer, or nothing does
  provider: Provider | null;
  own: "ready" | "missing"; // whether the TV has a voice of its own
}

export interface VoiceOptions {
  dir?: string; // the TV's own voice, from agentv-voice: /usr/lib/agentv-voice
  ai: () => Promise<AiState>;
  key: () => { set: boolean; provider: string | null };
  spoken: () => Promise<boolean>;
  // The provider's voice through the router's service, and the TV's own;
  // tests stand both in.
  provider?: (provider: Provider, text: string) => Promise<Voiced>;
  own?: (text: string) => Promise<Voiced>;
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

// A program that takes the line on its standard input and writes a WAV
// file: the package's say, or Piper. Its own words to the terminal are
// thrown away, so nothing it prints can reach a log.
function runVoice(command: string, args: (out: string) => string[], env: Record<string, string>, what: string, timeoutMs: number): (text: string) => Promise<Voiced> {
  let n = 0;
  return (text) =>
    new Promise((resolve) => {
      const out = join(tmpdir(), `agentv-voice-${process.pid}-${++n}.wav`);
      const done = (said: Voiced) => {
        rmSync(out, { force: true });
        resolve(said);
      };
      const child = spawn(command, args(out), { stdio: ["pipe", "ignore", "ignore"], env: { PATH: process.env.PATH ?? "/usr/bin", ...env } });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", () => (clearTimeout(timer), done({ ok: false, error: `${what} didn't start` })));
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0 || !existsSync(out)) return done({ ok: false, error: code === null ? `${what} took too long` : `${what} stopped (${code})` });
        const wav = readFileSync(out);
        done(wav.subarray(0, 4).toString("latin1") === "RIFF" ? { ok: true, wav } : { ok: false, error: `${what} didn't make a WAV file` });
      });
      // A pipe that closes early is the program's own stop, told by its exit.
      child.stdin.on("error", () => {});
      child.stdin.end(`${text.replace(/\s+/g, " ").trim()}\n`);
    });
}

// The package's own program: the line in, a WAV file out.
export function sayOn(dir: string, timeoutMs = OWN_MS): (text: string) => Promise<Voiced> {
  const run = runVoice(join(dir, "say"), (out) => [out], {}, "the tv's voice", timeoutMs);
  // The program reads plain words: digits and signs are said as words here,
  // so every voice says "3" and "2049" the same way.
  return (text) => run(speakable(text));
}

// Piper, in the package from before: the line on its standard input, WAV in
// a file of the daemon's own.
export function piperOn(dir: string, timeoutMs = OWN_MS): (text: string) => Promise<Voiced> {
  return runVoice(join(dir, "piper", "piper"), (out) => ["--model", join(dir, `${PIPER_VOICE}.onnx`), "--output_file", out], { LD_LIBRARY_PATH: join(dir, "piper") }, "piper", timeoutMs);
}

// Which voice of its own the TV has in a folder: the package's say, Piper
// from the package before, or none.
export function ownVoice(dir: string): "say" | "piper" | null {
  try {
    accessSync(join(dir, "say"), constants.X_OK);
    return "say";
  } catch {}
  return existsSync(join(dir, "piper", "piper")) && existsSync(join(dir, `${PIPER_VOICE}.onnx`)) ? "piper" : null;
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORDINALS: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };

function underHundred(n: number): string {
  if (n < 20) return ONES[n];
  return n % 10 ? `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}` : TENS[Math.floor(n / 10)];
}

function underThousand(n: number): string {
  if (n < 100) return underHundred(n);
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` ${underHundred(rest)}` : ""}`;
}

// A whole number in words, up to the millions. Past that, digit by digit.
export function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1_000_000_000) return String(n).split("").map((d) => ONES[Number(d)] ?? d).join(" ");
  if (n < 1000) return underThousand(n);
  const parts: string[] = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  if (millions) parts.push(`${underThousand(millions)} million`);
  if (thousands) parts.push(`${underThousand(thousands)} thousand`);
  if (rest) parts.push(underThousand(rest));
  return parts.join(" ");
}

// A year the way it's said: 1999 is nineteen ninety nine, 2005 two thousand
// five, 2049 twenty forty nine.
function yearWords(n: number): string {
  const [high, low] = [Math.floor(n / 100), n % 100];
  if (low === 0) return high % 10 === 0 ? numberWords(n) : `${underHundred(high)} hundred`;
  if (high === 20 && low < 10) return `two thousand ${ONES[low]}`;
  return `${underHundred(high)} ${low < 10 ? `oh ${ONES[low]}` : underHundred(low)}`;
}

function ordinalWords(n: number): string {
  const words = numberWords(n).split(" ");
  const last = words.pop()!;
  words.push(ORDINALS[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`));
  return words.join(" ");
}

// A line as a voice that only knows words can say it: numbers, ordinals,
// years, times, money and a few signs written out. "blade runner 2049" is
// "blade runner twenty forty nine", "the 14th" is "the fourteenth", "$5" is
// "five dollars" and "20:30" is "twenty thirty".
export function speakable(text: string): string {
  return text
    .replace(/\$(\d+)(?:\.(\d{2}))?/g, (_, whole: string, cents?: string) => `${numberWords(Number(whole))} dollar${Number(whole) === 1 ? "" : "s"}${cents && Number(cents) ? ` and ${numberWords(Number(cents))} cents` : ""}`)
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, hour: string, minute: string) => `${numberWords(Number(hour))} ${Number(minute) === 0 ? "o'clock" : Number(minute) < 10 ? `oh ${ONES[Number(minute)]}` : underHundred(Number(minute))}`)
    .replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n: string) => ordinalWords(Number(n)))
    .replace(/\b(\d+)\.(\d+)\b/g, (_, whole: string, part: string) => `${numberWords(Number(whole))} point ${part.split("").map((d) => ONES[Number(d)]).join(" ")}`)
    .replace(/\b(\d{1,3}(?:,\d{3})+)\b/g, (found: string) => numberWords(Number(found.replace(/,/g, ""))))
    .replace(/\b(1[1-9]\d\d|20\d\d)\b/g, (found: string) => yearWords(Number(found)))
    .replace(/\d+/g, (found: string) => (found.length > 1 && found.startsWith("0") ? found.split("").map((d) => ONES[Number(d)]).join(" ") : numberWords(Number(found))))
    .replace(/%/g, " percent")
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/[·→]/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/ ,/g, ",")
    .trim();
}

export class Voice {
  private o: VoiceOptions;
  private dir: string;
  private missingSaid = false;

  constructor(options: VoiceOptions) {
    this.o = options;
    this.dir = options.dir ?? VOICE_DIR;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  // Whether the TV has a voice of its own: the package's, in its folder.
  ownReady(): boolean {
    return Boolean(this.o.own) || ownVoice(this.dir) !== null;
  }

  // The provider whose own voice says the answers, or null for the TV's
  // own: one with a voice, whose key is the one kept.
  private async provider(): Promise<Provider | null> {
    const ai = await this.o.ai();
    const key = this.o.key();
    if (ai.path !== "key" || !ai.provider || !key.set || key.provider !== ai.provider || !speaks(ai.provider)) return null;
    return ai.provider;
  }

  async state(): Promise<VoiceState> {
    const provider = await this.provider();
    const own = this.ownReady() ? "ready" : "missing";
    return { spoken: await this.o.spoken(), by: provider ? "provider" : own === "ready" ? "own" : null, provider, own };
  }

  // A line as the TV says it, or null when it isn't said: spoken answers are
  // off, or no voice answered, or the TV has none.
  async make(text: string): Promise<Clip | null> {
    if (!text.trim() || !(await this.o.spoken())) return null;
    const started = this.now();
    const provider = await this.provider();
    if (provider) {
      const said = await (this.o.provider ?? speakViaRouter())(provider, text);
      if (said.ok) return { wav: said.wav, by: "provider", provider, ms: this.now() - started };
      this.o.log?.(`${provider}'s voice didn't answer (${said.error}), so the tv's own voice says it`);
    }
    const kind = this.o.own ? "say" : ownVoice(this.dir);
    if (!kind) {
      if (!this.missingSaid) this.o.log?.(`the tv has no voice of its own (nothing in ${this.dir}), so it shows its answers without saying them`);
      this.missingSaid = true;
      return null;
    }
    const said = await (this.o.own ?? (kind === "say" ? sayOn(this.dir) : piperOn(this.dir)))(text);
    if (!said.ok) {
      this.o.log?.(`the tv's own voice didn't say it: ${said.error}`);
      return null;
    }
    return { wav: said.wav, by: "own", ms: this.now() - started };
  }
}
