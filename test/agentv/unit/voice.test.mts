// The TV's spoken answers (stage 8, Q146, Q152): each provider with a voice
// of its own is asked the way its docs say, and its answer is WAV; the
// router's service speaks with the household's key and never logs the
// words; the daemon picks the provider's voice when there's a key for one
// that has it, and the TV's own voice otherwise, which is whatever the
// agentv-voice package ships: its say program, Piper from the package
// before, or nothing, when the answer only shows (T17.1); every answer the
// TV shows is said, "i didn't get that" included; and the TV session plays
// the clip through the box's player.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AiState } from "../../../daemon/ai.ts";
import { AskWatch } from "../../../daemon/asks.ts";
import { speak, speechRequest } from "../../../daemon/providers/speech.ts";
import { NONE, type Routed } from "../../../daemon/router.ts";
import { routeServer } from "../../../daemon/router-serve.ts";
import { Say, type SayAnswer, type SayAsk } from "../../../daemon/say.ts";
import { Daemon } from "../../../daemon/server.ts";
import { numberWords, ownVoice, PIPER_VOICE, sayOn, speakable, VOICE_DIR, Voice } from "../../../daemon/voice.ts";
import { VoicePlayer } from "../../../daemon/voice-play.ts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-voice-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A WAV file's start, and a little silence after it.
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(64)]);
const KEY = ["sk", "test", "voice", "x".repeat(24)].join("-");

// --- The providers' voices -----------------------------------------------------------------

test("each provider with a voice is asked the way its docs say, with the key where it goes", () => {
  const openai = speechRequest("chatgpt", KEY, "i didn't get that")!;
  assert.equal(openai.url, "https://api.openai.com/v1/audio/speech");
  assert.equal((openai.init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  const o = JSON.parse(String(openai.init.body));
  assert.deepEqual([o.model, o.voice, o.input, o.response_format], ["gpt-4o-mini-tts", "marin", "i didn't get that", "wav"]);
  assert.ok(/warm/.test(o.instructions));

  const google = speechRequest("gemini", KEY, "i didn't get that")!;
  assert.equal(google.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal((google.init.headers as Record<string, string>)["x-goog-api-key"], KEY);
  const g = JSON.parse(String(google.init.body));
  assert.equal(g.model, "gemini-3.8-flash-tts");
  assert.deepEqual(g.generation_config, { speech_config: [{ voice: "Sulafat" }] });
  assert.equal(g.input[0].content[0].text, "i didn't get that", "the words alone, with the style apart from them");
  assert.equal(g.input[0].content[0].annotations[0].type, "speech_metadata");
  assert.deepEqual(g.response_format, { type: "audio", mime_type: "audio/wav" });

  const xai = speechRequest("grok", KEY, "i didn't get that", "http://127.0.0.1:9/")!;
  assert.equal(xai.url, "http://127.0.0.1:9/v1/tts");
  assert.deepEqual(JSON.parse(String(xai.init.body)), { text: "i didn't get that", language: "en", voice_id: "eve", output_format: { codec: "wav", sample_rate: 24000 } });

  assert.equal(speechRequest("claude", KEY, "hi"), null, "anthropic has no speech api");
  assert.equal(speechRequest("muse", KEY, "hi"), null, "nor does meta");
});

test("a provider's answer counts only as WAV: Google's comes base64 in its last model output, and anything else is refused", async () => {
  const answer = (body: BodyInit, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  assert.deepEqual((await speak("chatgpt", KEY, "hi", { fetch: answer(new Uint8Array(WAV)) })).wav, WAV);
  const steps = { steps: [{ type: "thought", content: [] }, { type: "model_output", content: [{ type: "audio", data: WAV.toString("base64") }] }] };
  const gemini = await speak("gemini", KEY, "hi", { fetch: answer(JSON.stringify(steps)) });
  assert.equal(gemini.ok, true);
  assert.deepEqual(gemini.wav, WAV);
  assert.deepEqual(await speak("grok", KEY, "hi", { fetch: answer("<html>no</html>") }), { ok: false, error: "the voice's answer wasn't wav" });
  assert.deepEqual(await speak("grok", KEY, "hi", { fetch: answer("{}", 401) }), { ok: false, error: "the voice answered 401" });
  assert.deepEqual(await speak("claude", KEY, "hi"), { ok: false, error: "this provider has no voice" });
});

test("the router's service speaks with the key, a line at a time, and logs how long, never the words", async () => {
  const lines: string[] = [];
  const asked: string[] = [];
  const server = routeServer({
    route: async () => ({}) as Routed,
    speak: async (provider, words) => (asked.push(`${provider}: ${words}`), provider === "chatgpt" ? { ok: true, wav: WAV, model: "gpt-4o-mini-tts", voice: "marin" } : { ok: false, error: "this provider has no voice" }),
    log: (line) => lines.push(line),
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const post = async (body: unknown) => (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/speak`, { method: "POST", body: JSON.stringify(body) })).json();
  try {
    const said = await post({ provider: "chatgpt", text: "new this week: night train" });
    assert.equal(said.ok, true);
    assert.deepEqual(Buffer.from(said.wav, "base64"), WAV);
    assert.deepEqual(await post({ provider: "claude", text: "hi" }), { ok: false, error: "this provider has no voice" });
    assert.deepEqual(await post({ provider: "someone", text: "hi" }), { ok: false, error: "which provider, and what to say" });
    assert.deepEqual(asked, ["chatgpt: new this week: night train", "claude: hi"]);
    assert.ok(lines.every((line) => !line.includes("night train")), lines.join("\n"));
    assert.ok(lines[0].startsWith("speech chatgpt gpt-4o-mini-tts: "), lines[0]);
  } finally {
    server.close();
  }
});

// --- Which voice -----------------------------------------------------------------------------

function voice(options: { ai?: Partial<AiState>; key?: { set: boolean; provider: string | null }; spoken?: boolean; providerFails?: boolean; now?: () => number } = {}) {
  const dir = mkdtempSync(join(scratch, "voice-"));
  const used: string[] = [];
  const v = new Voice({
    dir,
    ai: async () => ({ provider: "claude", path: "key", accepted: true, ...options.ai }) as unknown as AiState,
    key: () => options.key ?? { set: true, provider: (options.ai?.provider as string) ?? "claude" },
    spoken: async () => options.spoken ?? true,
    provider: async (provider) => (used.push(provider), options.providerFails ? { ok: false, error: "the voice answered 500" } : { ok: true, wav: WAV }),
    own: async () => (used.push("own"), { ok: true, wav: WAV }),
    now: options.now,
  });
  return { v, used, dir };
}

test("with a key for a provider that has a voice, the TV says its answers in that voice", async () => {
  for (const provider of ["chatgpt", "gemini", "grok"] as const) {
    const { v, used } = voice({ ai: { provider } });
    const clip = await v.make("i didn't get that");
    assert.equal(clip?.by, "provider");
    assert.deepEqual(used, [provider]);
    assert.equal((await v.state()).by, "provider");
  }
});

test("with Claude's or Muse's key, on a plan, or when the provider's voice doesn't answer, the TV's own voice says it", async () => {
  for (const ai of [{ provider: "claude" }, { provider: "muse" }, { provider: "claude", path: "plan" }] as Partial<AiState>[]) {
    const { v, used } = voice({ ai });
    assert.equal((await v.make("i didn't get that"))?.by, "own", JSON.stringify(ai));
    assert.deepEqual(used, ["own"]);
  }
  const { v, used } = voice({ ai: { provider: "chatgpt" }, providerFails: true });
  assert.equal((await v.make("i didn't get that"))?.by, "own");
  assert.deepEqual(used, ["chatgpt", "own"]);
});

test("with spoken answers off in Settings → Sound, nothing is said", async () => {
  const { v, used } = voice({ spoken: false });
  assert.equal(await v.make("i didn't get that"), null);
  assert.deepEqual(used, []);
});

const claudeKey = { ai: async () => ({ provider: "claude", path: "key", accepted: true }) as unknown as AiState, key: () => ({ set: true, provider: "claude" }), spoken: async () => true };

test("T17.1 with no voice package, the TV has no voice of its own: the answer is only shown, nothing fails, and the log says so once", async () => {
  const dir = mkdtempSync(join(scratch, "novoice-"));
  const lines: string[] = [];
  const v = new Voice({ dir, ...claudeKey, log: (line) => lines.push(line) });
  assert.deepEqual(await v.state(), { spoken: true, by: null, provider: null, own: "missing" });
  assert.equal(ownVoice(dir), null);
  assert.equal(await v.make("i didn't get that"), null);
  assert.equal(await v.make("i didn't get that"), null);
  assert.equal(lines.filter((line) => line.includes("no voice of its own")).length, 1, "the log says so once");
  assert.ok(!lines.some((line) => /didn't get that/.test(line)), "and never the words");
  // A folder that doesn't exist at all is the same: agentv-voice was never
  // installed.
  const gone = new Voice({ dir: join(scratch, "never-installed"), ...claudeKey });
  assert.equal((await gone.state()).by, null);
  assert.equal(await gone.make("i didn't get that"), null);
  assert.equal(VOICE_DIR, "/usr/lib/agentv-voice");
});

test("T17.1 a provider's own voice stays where a key has one, on a TV with no voice of its own", async () => {
  const dir = mkdtempSync(join(scratch, "provideronly-"));
  const v = new Voice({
    dir,
    ai: async () => ({ provider: "chatgpt", path: "key", accepted: true }) as unknown as AiState,
    key: () => ({ set: true, provider: "chatgpt" }),
    spoken: async () => true,
    provider: async () => ({ ok: true, wav: WAV }),
  });
  assert.deepEqual(await v.state(), { spoken: true, by: "provider", provider: "chatgpt", own: "missing" });
  assert.equal((await v.make("i didn't get that"))?.by, "provider");
});

test("T17.1 the TV's own voice is the package's say program: the line on its input, a WAV file where it's told, and nothing else known about it", async () => {
  const dir = mkdtempSync(join(scratch, "say-"));
  // A stand-in for a package's say: it keeps the line it was given, and
  // writes a WAV file.
  writeFileSync(join(dir, "say"), `#!/bin/bash\ncat >"${dir}/heard"\nprintf 'RIFF....WAVEfmt ' >"$1"\n`);
  assert.equal(ownVoice(dir), null, "a say that can't be run isn't a voice");
  chmodSync(join(dir, "say"), 0o755);
  assert.equal(ownVoice(dir), "say");
  const v = new Voice({ dir, ...claudeKey });
  assert.deepEqual([(await v.state()).own, (await v.state()).by], ["ready", "own"]);
  const clip = await v.make("blade runner 2049,   on jellyfin");
  assert.equal(clip?.by, "own");
  assert.equal(clip?.wav.subarray(0, 4).toString(), "RIFF");
  // It got the line as words, on one line.
  const heard = await import("node:fs").then((fs) => fs.readFileSync(join(dir, "heard"), "utf8"));
  assert.equal(heard, "blade runner twenty forty nine, on jellyfin\n");
  // A say that fails, writes no file, or writes something that isn't WAV:
  // nothing is said, and nothing throws.
  for (const body of ["exit 3", "exit 0", 'echo nope >"$1"']) {
    writeFileSync(join(dir, "say"), `#!/bin/bash\ncat >/dev/null\n${body}\n`);
    const lines: string[] = [];
    assert.equal(await new Voice({ dir, ...claudeKey, log: (line) => lines.push(line) }).make("hello"), null, body);
    assert.equal(lines.filter((line) => line.startsWith("the tv's own voice didn't say it")).length, 1, body);
  }
  // One that hangs is stopped.
  writeFileSync(join(dir, "say"), "#!/bin/bash\nexec sleep 30\n");
  assert.deepEqual(await sayOn(dir, 200)("hello"), { ok: false, error: "the tv's voice took too long" });
});

test("two answers close together each get their own audio", async () => {
  const dir = mkdtempSync(join(scratch, "two-"));
  // A say that writes its file at once and then, for the first line, takes
  // its time to finish: the second line is made while the first still runs.
  writeFileSync(join(dir, "say"), `#!/bin/bash\nread -r line\nprintf 'RIFF%s' "$line" >"$1"\n[[ $line != *first* ]] || sleep 0.8\n`);
  chmodSync(join(dir, "say"), 0o755);
  const v = new Voice({ dir, ...claudeKey });
  const first = v.make("the first answer");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const second = v.make("the second answer");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a?.wav.toString(), "RIFFthe first answer", "the slower answer isn't lost");
  assert.equal(b?.wav.toString(), "RIFFthe second answer");
});

test("the package from before still speaks: Piper and its cori voice, with no say, until the package changes", async () => {
  const dir = mkdtempSync(join(scratch, "piper-"));
  mkdirSync(join(dir, "piper"));
  writeFileSync(join(dir, "piper", "piper"), "");
  assert.equal(ownVoice(dir), null, "piper alone isn't enough");
  writeFileSync(join(dir, `${PIPER_VOICE}.onnx`), "");
  assert.equal(ownVoice(dir), "piper");
  const v = new Voice({ dir, ...claudeKey });
  assert.deepEqual([(await v.state()).own, (await v.state()).by], ["ready", "own"]);
});

test("T17.1 numbers, years, ordinals, times and money are said as words, so a voice that only knows words drops none", () => {
  assert.equal(numberWords(0), "zero");
  assert.equal(numberWords(21), "twenty one");
  assert.equal(numberWords(305), "three hundred five");
  assert.equal(numberWords(12_040), "twelve thousand forty");
  assert.equal(speakable("blade runner 2049, on jellyfin"), "blade runner twenty forty nine, on jellyfin");
  assert.equal(speakable("3 new this week"), "three new this week");
  assert.equal(speakable("yes, season 2 came out on the 14th"), "yes, season two came out on the fourteenth");
  assert.equal(speakable("the 1st, the 22nd, the 3rd and the 30th"), "the first, the twenty second, the third and the thirtieth");
  assert.equal(speakable("made in 1999, 2005 and 1900"), "made in nineteen ninety nine, two thousand five and nineteen hundred");
  assert.equal(speakable("it starts at 20:30, or 9:05"), "it starts at twenty thirty, or nine oh five");
  assert.equal(speakable("never more than $5 a build"), "never more than five dollars a build");
  assert.equal(speakable("$1 and $2.50"), "one dollar and two dollars and fifty cents");
  assert.equal(speakable("4.5 stars, 80% done, tom & jerry"), "four point five stars, eighty percent done, tom and jerry");
  assert.equal(speakable("1,250 songs"), "one thousand two hundred fifty songs");
  assert.equal(speakable("i didn't get that"), "i didn't get that");
  assert.doesNotMatch(speakable("room 101, 007 and 12345678901"), /\d/);
});

// --- Every answer, said ----------------------------------------------------------------------

test("S7.3 every answer the TV shows is said aloud, 'i didn't get that' included", async () => {
  const spoken: string[] = [];
  const routes: Record<string, Routed["route"]> = { "play frozen": { ...NONE, intent: "play", query: "Frozen" } };
  const say = new Say({
    route: async (sentence) => ({ sentence, route: routes[sentence] ?? { ...NONE }, ...(routes[sentence] ? {} : { none: "unroutable" as const }), provider: "claude", via: "api", model: "test", ms: 1 }),
    viewer: async () => ({ id: "radomir", name: "radomir", role: "adult" }),
    apps: async () => [{ id: "local.kino", name: "Kino", category: "streaming", capabilities: ["launch", "search"] }],
    rows: () => [],
    ask: async (ask) => (ask.kind === "search" ? { ok: true, found: [{ app: "local.kino", items: [{ id: "1", kind: "film", title: "Frozen" }, { id: "2", kind: "film", title: "Frozen" }] }] } : { ok: true }),
    changed: () => {},
    speak: (text) => spoken.push(text),
  });
  await say.hear("turn the lights off", "iphone");
  const choose = await say.hear("play frozen", "iphone");
  await say.pick(choose.n, 0);
  assert.deepEqual(spoken, ["i didn't get that", "which one?", "frozen, on kino"]);
});

// --- The TV session plays it -------------------------------------------------------------------

test("the TV session fetches the clip and plays it with PipeWire's player, or PulseAudio's when that isn't there", async () => {
  const served: string[] = [];
  const { createServer } = await import("node:http");
  const home = createServer((request, response) => {
    served.push(request.url ?? "");
    if (request.url === "/api/voice/7") {
      response.writeHead(200, { "Content-Type": "audio/wav" });
      response.end(WAV);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((done) => home.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(home.address() as { port: number }).port}/`;
  const dir = join(scratch, "runtime");
  try {
    const player = new VoicePlayer({ home: url, dir, players: [[join(scratch, "no-such-player"), []], ["true", []]] });
    const played = await player.play(7);
    assert.equal(played.ok, true, JSON.stringify(played));
    assert.ok(!existsSync(join(dir, "7.wav")), "the clip is gone once it's played");
    assert.deepEqual(await player.play(8), { ok: false, error: "the clip wasn't there" });
    const failing = new VoicePlayer({ home: url, dir, players: [["false", []]] });
    assert.deepEqual(await failing.play(7), { ok: false, error: "false stopped (1)" });
  } finally {
    home.close();
  }
});

// --- Through the daemon ---------------------------------------------------------------------------

test("S7.3 the daemon makes the clip, the TV session plays it, and the log says which voice and never the words", async () => {
  const base = join(scratch, "daemon");
  mkdirSync(join(base, "state"), { recursive: true });
  writeFileSync(join(base, "state", "setup.json"), JSON.stringify({ done: true }));
  const lines: string[] = [];
  const daemon = new Daemon({
    root: base,
    state: join(base, "state"),
    builtins: null,
    port: 0,
    log: (line) => lines.push(line),
    keyStatus: join(base, "key.json"),
    tmdbStatus: join(base, "tmdb.json"),
    tmdb: async () => ({ ok: false, error: "no" }),
    router: async (sentence) => ({ sentence, route: { ...NONE }, none: "unroutable", provider: "claude", via: "api", model: "test", ms: 1 }),
    voice: { own: async () => ({ ok: true, wav: WAV }) },
  });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  const played: number[] = [];
  const tvSession = new AskWatch<SayAsk, SayAnswer>({
    url: `${url}/`,
    path: "api/say/ask",
    what: "a sentence",
    handle: async (ask) => {
      if (ask.kind !== "speak") return { ok: true };
      const clip = await fetch(`${url}/api/voice/${ask.clip}`);
      assert.equal(clip.headers.get("content-type"), "audio/wav");
      assert.deepEqual(Buffer.from(await clip.arrayBuffer()), WAV);
      played.push(ask.clip);
      return { ok: true };
    },
    failed: (error) => ({ ok: false, error: error.message }),
    log: () => {},
    retryMs: 50,
  });
  tvSession.start();
  try {
    await fetch(`${url}/api/say`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sentence: "the cat sat on the" }) });
    for (let i = 0; i < 100 && !played.length; i++) await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(played, [1]);
    for (let i = 0; i < 100 && !lines.some((l) => l.startsWith("the tv said")); i++) await new Promise((done) => setTimeout(done, 20));
    const state = await (await fetch(`${url}/api/voice`)).json();
    assert.equal(state.by, "own");
    assert.equal(state.last.played, true);
    assert.ok(lines.some((line) => /^the tv said its answer with its own voice, made in \d+ ms$/.test(line)), lines.join("\n"));
    assert.ok(!lines.join("\n").includes("cat sat"), "the log never has what was said");
    assert.equal((await fetch(`${url}/api/voice/99`)).status, 404);
  } finally {
    tvSession.stop();
    await daemon.close();
  }
});
