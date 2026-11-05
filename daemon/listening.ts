// The TV shows a sentence as it's said (ADR-054): while a paired phone's
// "ask your tv" box is open, a listening bar along the bottom of the TV,
// and the box's words on it as the phone's dictation fills it in. Then,
// once it's sent, the bar says it's thinking and shows what came of it
// (daemon/say.ts).
//
// Only text reaches the box (ADR-023), and the daemon keeps none of it:
// each change goes straight on to the TV's pages and the TV session, and
// all that stays is whether a box is open, on which phone, and a timer
// that takes the bar away after a while with no new words. The words are
// never logged and never written anywhere.

import { cleanSentence } from "./router.ts";

// What the bar shows: a box just opened, the words so far, or nothing.
export interface Heard {
  state: "open" | "words" | "closed";
  text: string;
  from: string;
}

export interface ListeningOptions {
  changed: (heard: Heard) => void;
  idleMs?: number; // with no new words for this long, the bar goes away
}

const IDLE_MS = 20_000;

export class Listening {
  private o: ListeningOptions;
  private open: { from: string; timer: ReturnType<typeof setTimeout> } | null = null;
  // Phones whose sentence went. Their box's words count again once it opens
  // again, so words that were still on their way when the sentence went,
  // on a connection of their own, don't bring the bar back over what came
  // of the sentence.
  private sentFrom = new Set<string>();

  constructor(options: ListeningOptions) {
    this.o = options;
  }

  // Whether the bar is up for a box that's open.
  get up(): boolean {
    return this.open !== null;
  }

  private wait(from: string): void {
    if (this.open) clearTimeout(this.open.timer);
    const timer = setTimeout(() => this.close(), this.o.idleMs ?? IDLE_MS);
    timer.unref?.();
    this.open = { from, timer };
  }

  // A change from a phone's box: it opened, its words changed, or it
  // closed without being sent. Null, or why not.
  change(from: string, body: unknown): string | null {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (b.open === false) {
      // Only the phone whose box it is closes the bar.
      if (this.open?.from === from) this.close();
      return null;
    }
    if (b.open === true && b.text === undefined) {
      this.sentFrom.delete(from);
      this.wait(from);
      this.o.changed({ state: "open", text: "", from });
      return null;
    }
    if (typeof b.text !== "string") return "open, or the words so far";
    if (this.sentFrom.has(from)) return null;
    const text = cleanSentence(b.text);
    this.wait(from);
    this.o.changed(text ? { state: "words", text, from } : { state: "open", text: "", from });
    return null;
  }

  // A phone's sentence was sent: what came of it takes the bar over, so it
  // stays up without a timer. True when there was a bar to take over.
  sent(from: string): boolean {
    this.sentFrom.add(from);
    if (!this.open) return false;
    clearTimeout(this.open.timer);
    this.open = null;
    return true;
  }

  // Closed on the phone, Back on the TV, or no new words for a while.
  close(): void {
    if (!this.open) return;
    const { from, timer } = this.open;
    clearTimeout(timer);
    this.open = null;
    this.o.changed({ state: "closed", text: "", from });
  }
}
