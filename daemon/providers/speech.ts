// The household's AI provider's own voice (stage 8, Q152): the most natural
// one each offers, for the TV to say its answers over HDMI. It runs in the
// router's service, which alone reads the key (daemon/router-serve.ts), and
// answers with WAV the TV session plays.
//
// Checked on 2026-11-01, from each provider's docs:
// - OpenAI: /v1/audio/speech with gpt-4o-mini-tts and its marin voice, which
//   OpenAI says sounds best. OpenAI shuts its speech models down on
//   2027-01-06 for a realtime one this endpoint doesn't take, so ChatGPT's
//   voice will need another look before then.
// - Google: the Interactions API with gemini-3.8-flash-tts and the Sulafat
//   voice, which Google calls warm, with the style said apart from the words.
// - xAI: /v1/tts with its default voice, eve.
// - Anthropic and Meta have no speech API, so Claude and Muse households
//   hear the TV's own voice, or none, as a household on a plan does.
//
// Nothing here logs the words.

import type { Provider } from "../ai.ts";
import { AI_NAMES } from "../../builder/reasons.ts";

export const SPEECH: Partial<Record<Provider, { model: string; voice: string }>> = {
  chatgpt: { model: "gpt-4o-mini-tts", voice: "marin" },
  gemini: { model: "gemini-3.8-flash-tts", voice: "Sulafat" },
  grok: { model: "tts", voice: "eve" },
};

const BASES: Partial<Record<Provider, string>> = {
  chatgpt: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
  grok: "https://api.x.ai",
};

// How it should sound, for the providers that take a style.
const STYLE = "warm, relaxed and natural, like a friend on the sofa answering a quick question";

// At most this much to say: a sentence or two.
export const SPEECH_MAX = 400;
const MAX_BYTES = 8 * 1024 * 1024;

export interface Speech {
  ok: boolean;
  wav?: Buffer;
  model?: string;
  voice?: string;
  error?: string;
}

export function speaks(provider: Provider): boolean {
  return Boolean(SPEECH[provider]);
}

// The request to a provider's speech API, for a line of text.
export function speechRequest(provider: Provider, key: string, text: string, base?: string): { url: string; init: RequestInit } | null {
  const which = SPEECH[provider];
  const root = (base || BASES[provider] || "").replace(/\/+$/, "");
  if (!which || !root) return null;
  const json = (body: object, headers: Record<string, string>) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (provider === "chatgpt") {
    return { url: `${root}/v1/audio/speech`, init: json({ model: which.model, voice: which.voice, input: text, instructions: `Speak ${STYLE}.`, response_format: "wav" }, { Authorization: `Bearer ${key}` }) };
  }
  if (provider === "gemini") {
    return {
      url: `${root}/v1beta/interactions`,
      init: json(
        {
          model: which.model,
          input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: STYLE }] }] }],
          response_format: { type: "audio", mime_type: "audio/wav" },
          generation_config: { speech_config: [{ voice: which.voice }] },
        },
        { "x-goog-api-key": key },
      ),
    };
  }
  return { url: `${root}/v1/tts`, init: json({ text, language: "en", voice_id: which.voice, output_format: { codec: "wav", sample_rate: 24000 } }, { Authorization: `Bearer ${key}` }) };
}

const isWav = (bytes: Buffer) => bytes.length > 44 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WAVE";

// A line of text in the provider's voice, as WAV.
export async function speak(provider: Provider, key: string, text: string, options: { base?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<Speech> {
  const which = SPEECH[provider];
  const asked = speechRequest(provider, key, text.slice(0, SPEECH_MAX), options.base);
  if (!which || !asked) return { ok: false, error: `${AI_NAMES[provider]} has no voice` };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(asked.url, { ...asked.init, signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
  } catch (error) {
    return { ok: false, error: (error as Error).name === "TimeoutError" ? "the voice took too long" : "the voice couldn't be reached" };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) return { ok: false, error: "the voice's answer was too big" };
  if (!response.ok) return { ok: false, error: `the voice answered ${response.status}` };
  let wav = bytes;
  // Google's comes as JSON, the audio base64 in its last model_output step.
  if (provider === "gemini") {
    try {
      const data = JSON.parse(bytes.toString("utf8")) as { steps?: { type?: string; content?: { type?: string; data?: string }[] }[] };
      const audio = (data.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []).filter((c) => c.type === "audio" && typeof c.data === "string").pop();
      wav = Buffer.from(audio?.data ?? "", "base64");
    } catch {
      return { ok: false, error: "the voice's answer wasn't json" };
    }
  }
  if (!isWav(wav)) return { ok: false, error: "the voice's answer wasn't wav" };
  return { ok: true, wav, model: which.model, voice: which.voice };
}
