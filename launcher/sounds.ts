// The seven UI sounds (ADR-024), from preloaded Web Audio buffers so each one
// starts within a frame. They're quiet by default, Settings → Sound turns
// them off or down, a held arrow plays at most one move every 60 ms, and while
// something plays only success and failure sound, softer.

export type Sound = "move" | "select" | "forward" | "back" | "confirm" | "success" | "failure";
export const SOUNDS: Sound[] = ["move", "select", "forward", "back", "confirm", "success", "failure"];

const MOVE_EVERY = 60;

export class Sounds {
  on = true;
  volume = 0.6;
  playing = false; // a film or music is playing
  private context?: AudioContext;
  private buffers = new Map<Sound, AudioBuffer>();
  private lastMove = -Infinity;
  // Each sound that played, for the UI checks (S2.11).
  readonly log: { sound: Sound; at: number }[] = [];

  async load(base = "/launcher/sounds"): Promise<void> {
    this.context ??= new AudioContext();
    await Promise.all(
      SOUNDS.map(async (sound) => {
        try {
          const data = await (await fetch(`${base}/${sound}.ogg`)).arrayBuffer();
          this.buffers.set(sound, await this.context!.decodeAudioData(data));
        } catch {
          // A sound that won't load stays silent; the TV works without it.
        }
      }),
    );
  }

  play(sound: Sound): void {
    if (!this.on || this.volume <= 0) return;
    if (this.playing && sound !== "success" && sound !== "failure") return;
    const now = performance.now();
    if (sound === "move") {
      if (now - this.lastMove < MOVE_EVERY) return;
      this.lastMove = now;
    }
    this.log.push({ sound, at: now });
    if (this.log.length > 200) this.log.shift();

    const buffer = this.buffers.get(sound);
    const context = this.context;
    if (!buffer || !context) return;
    if (context.state === "suspended") void context.resume();
    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = this.volume * (this.playing ? 0.5 : 1);
    source.buffer = buffer;
    source.connect(gain).connect(context.destination);
    source.start();
  }
}
