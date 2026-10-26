// The setup soundtrack (ADR-014, ADR-024, S5.4): music from the welcome
// screen to the background step, with a small player in the bottom-left
// corner whose equaliser moves with what's playing. M mutes it, and so does
// the phone; setup keeps the choice. Until the soundtrack itself ships, a
// stand-in plays: a slow chord, made here, nothing fetched.

import { glyph } from "../launcher/glyphs.ts";
import { h } from "../launcher/dom.ts";

// The soundtrack's file, when the package has it.
const TRACK = "/setup/audio/setup-soundtrack-v1.mp3";
const BARS = 7;
const VOLUME = 0.35;

// A stand-in's chords, as frequencies: four bars of a slow progression.
const CHORDS = [
  [220, 277.18, 329.63],
  [196, 246.94, 293.66],
  [174.61, 220, 261.63],
  [196, 246.94, 329.63],
];
const CHORD_S = 4;

export class Soundtrack {
  readonly el: HTMLElement;
  private bars: HTMLElement[];
  private note: HTMLElement;
  private context?: AudioContext;
  private gain?: GainNode;
  private analyser?: AnalyserNode;
  private audio?: HTMLAudioElement;
  private timer = 0;
  private frame = 0;
  private muted = false;
  private playing = false;
  standIn = false;

  constructor() {
    this.bars = Array.from({ length: BARS }, (_, i) => h("span", { class: `eq-bar eq-${i < 2 ? "a" : i < 4 ? "b" : "c"}` }));
    this.note = h("span", { class: "player-note" }, "original score · m to mute");
    this.el = h(
      "div",
      { class: "player", "aria-label": "the setup soundtrack" },
      h("span", { class: "player-art" }, glyph("music", 40)),
      h("span", { class: "player-text" }, h("span", { class: "player-name" }, "setup soundtrack"), this.note),
      h("span", { class: "eq", role: "img", "aria-label": "music playing" }, ...this.bars),
    );
  }

  // Starts it, the soundtrack's file if the package has it, the stand-in
  // otherwise.
  async start(muted: boolean): Promise<void> {
    if (this.playing) return this.mute(muted);
    this.playing = true;
    this.context = new AudioContext();
    this.gain = this.context.createGain();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.7;
    this.analyser.connect(this.gain);
    this.gain.connect(this.context.destination);
    this.gain.gain.value = 0;
    const found = await fetch(TRACK, { method: "HEAD", cache: "no-store" }).then((r) => r.ok, () => false);
    if (found) {
      this.audio = new Audio(TRACK);
      this.audio.loop = true;
      this.context.createMediaElementSource(this.audio).connect(this.analyser);
      await this.audio.play().catch(() => {});
    } else {
      this.standIn = true;
      this.chords();
      this.timer = window.setInterval(() => this.chords(), CHORDS.length * CHORD_S * 1000);
    }
    await this.context.resume().catch(() => {});
    this.mute(muted);
    this.draw();
  }

  // The stand-in: each chord swells in and out, a few seconds each.
  private chords(): void {
    const context = this.context!;
    const now = context.currentTime;
    CHORDS.forEach((chord, i) => {
      const at = now + i * CHORD_S;
      // Each note with a few softer ones above it, so it reaches the
      // equaliser's higher bands as music does.
      for (const root of chord) {
        for (const [times, level] of [[1, 0.12], [2, 0.05], [4, 0.025], [8, 0.012], [16, 0.006]]) {
          const tone = context.createOscillator();
          const swell = context.createGain();
          tone.type = times === 1 ? "triangle" : "sine";
          tone.frequency.value = root * times;
          swell.gain.setValueAtTime(0, at);
          swell.gain.linearRampToValueAtTime(level, at + 1.2 + times * 0.05);
          swell.gain.linearRampToValueAtTime(0.0001, at + CHORD_S + 0.4);
          tone.connect(swell).connect(this.analyser!);
          tone.start(at);
          tone.stop(at + CHORD_S + 0.5);
        }
      }
    });
  }

  mute(muted: boolean): void {
    this.muted = muted;
    this.el.classList.toggle("muted", muted);
    this.note.textContent = muted ? "muted · m to play" : "original score · m to mute";
    if (this.gain && this.context) this.gain.gain.setTargetAtTime(muted ? 0 : VOLUME, this.context.currentTime, 0.15);
  }

  isMuted(): boolean {
    return this.muted;
  }

  // The equaliser, each frame, from what's playing: seven bands from 60 Hz
  // to 8 kHz, spaced as hearing spaces them, each bar scaled to its band's
  // loudest.
  private draw(): void {
    const data = new Uint8Array(this.analyser!.frequencyBinCount);
    const hz = this.context!.sampleRate / this.analyser!.fftSize;
    const edges = Array.from({ length: BARS + 1 }, (_, i) => Math.max(1, Math.round((60 * (8000 / 60) ** (i / BARS)) / hz)));
    const step = () => {
      if (!this.playing) return;
      this.analyser!.getByteFrequencyData(data);
      this.bars.forEach((bar, i) => {
        let top = 0;
        for (let j = edges[i]; j < Math.max(edges[i] + 1, edges[i + 1]) && j < data.length; j++) top = Math.max(top, data[j]);
        const level = this.muted ? 0 : top / 255;
        bar.style.transform = `scaleY(${Math.max(0.12, Math.min(1, level)).toFixed(3)})`;
      });
      this.frame = requestAnimationFrame(step);
    };
    step();
  }

  // The levels the bars show now, for the checks.
  levels(): number[] {
    return this.bars.map((bar) => Number(/scaleY\(([\d.]+)\)/.exec(bar.style.transform)?.[1] ?? 0));
  }

  stop(): void {
    this.playing = false;
    clearInterval(this.timer);
    cancelAnimationFrame(this.frame);
    this.audio?.pause();
    void this.context?.close();
  }
}
