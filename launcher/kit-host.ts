// Home's side of AgenTV's app kit (contract 2, ADR-043): it holds a page
// app's frame, answers the kit's calls from that frame alone, and hands the
// app its input, Back, and Home's pause. Which app asked is the frame's, not
// anything in the message, so one app can't speak for another. The calls go
// where they're done: storage, the tile, notices and who's watching to the
// daemon, the photos and music to the TV session, and ready and exit to
// home itself. The daemon checks each one against the manifest.

import type { Call, FromApp, InputEvent, ToApp } from "../apps/contract/kit.ts";

// The contract's BACK_WAIT_MS. The launcher's pages load only what's in
// launcher/ and setup/, so it's here as well; a unit test keeps the two the
// same.
export const BACK_WAIT_MS = 300;

export interface KitBackend {
  // A call the daemon or the TV session does: what it gives back, or a
  // thrown Error with why not.
  daemon(app: string, call: Call, args: unknown[]): Promise<unknown>;
  media(app: string, call: Call, args: unknown[]): Promise<unknown>;
  ready(): void;
  exit(): void;
}

const MEDIA = new Set<string>(["photos.sources", "photos.list", "photos.image", "music.albums", "music.track"]);
const CALLS = new Set<string>(["ready", "exit", "viewer", "storage.get", "storage.set", "storage.remove", "storage.keys", "tile.set", "notify", ...MEDIA]);

export class KitHost {
  readonly app: string;
  readonly frame: HTMLIFrameElement;
  private backend: KitBackend;
  private nextBack = 0;
  private backs = new Map<number, (kept: boolean) => void>();
  private listener = (event: MessageEvent) => void this.heard(event);

  constructor(frame: HTMLIFrameElement, app: string, backend: KitBackend) {
    this.frame = frame;
    this.app = app;
    this.backend = backend;
    window.addEventListener("message", this.listener);
  }

  close(): void {
    window.removeEventListener("message", this.listener);
    for (const answer of this.backs.values()) answer(false);
    this.backs.clear();
  }

  private post(message: ToApp, transfer: Transferable[] = []): void {
    // The frame's origin is opaque, so there's no name to send to: it's this
    // frame's window, whatever it holds.
    this.frame.contentWindow?.postMessage(message, "*", transfer);
  }

  private async heard(event: MessageEvent): Promise<void> {
    if (!this.frame.contentWindow || event.source !== this.frame.contentWindow) return;
    const message = event.data as FromApp;
    if (!message || message.agentv !== 1) return;
    if ("back" in message) {
      const answer = this.backs.get(message.back);
      this.backs.delete(message.back);
      answer?.(message.kept === true);
      return;
    }
    const { id, call } = message;
    if (typeof id !== "number") return;
    const args = Array.isArray(message.args) ? message.args : [];
    if (!CALLS.has(call)) {
      this.post({ agentv: 1, id, ok: false, error: `${String(call)} isn't something the app kit does` });
      return;
    }
    try {
      if (call === "ready") {
        this.backend.ready();
        this.post({ agentv: 1, id, ok: true });
      } else if (call === "exit") {
        this.post({ agentv: 1, id, ok: true });
        this.backend.exit();
      } else if (MEDIA.has(call)) {
        const value = await this.backend.media(this.app, call, args);
        // A photo or a track comes as base64 from the TV session, and goes
        // to the frame as its bytes.
        if (call === "photos.image" || call === "music.track") {
          const file = value as { type: string; bytes: string };
          const bytes = Uint8Array.from(atob(file.bytes), (c) => c.charCodeAt(0)).buffer;
          this.post({ agentv: 1, id, ok: true, value: { type: file.type, bytes } }, [bytes]);
        } else {
          this.post({ agentv: 1, id, ok: true, value });
        }
      } else {
        this.post({ agentv: 1, id, ok: true, value: await this.backend.daemon(this.app, call, args) });
      }
    } catch (error) {
      this.post({ agentv: 1, id, ok: false, error: (error as Error).message || "that didn't work" });
    }
  }

  input(event: InputEvent): void {
    this.post({ agentv: 1, event: "input", input: event });
  }

  pause(): void {
    this.post({ agentv: 1, event: "pause" });
  }

  resume(): void {
    this.post({ agentv: 1, event: "resume" });
  }

  // Back, offered to the app: true when it kept it. No answer in time, from
  // an app with no listener or one that's stuck, is no.
  back(waitMs = BACK_WAIT_MS): Promise<boolean> {
    const back = ++this.nextBack;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.backs.delete(back);
        resolve(false);
      }, waitMs);
      this.backs.set(back, (kept) => {
        clearTimeout(timer);
        resolve(kept);
      });
      this.post({ agentv: 1, event: "back", back });
    });
  }
}

// --- Input ---------------------------------------------------------------

// The keys the remote, the keyboard and the phone send, as the kit's
// buttons. Back and Home aren't here: home handles both.
export const KEY_BUTTONS: Record<string, InputEvent["button"]> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "ok",
  NumpadEnter: "ok",
  " ": "ok",
  MediaPlayPause: "play",
};
export const BACK_KEYS = ["Escape", "Backspace", "BrowserBack", "GoBack"];

// A standard gamepad's buttons: A is ok, B is Back, the guide button is
// Home, and the d-pad is directions. The left stick is read separately.
export const PAD_BUTTONS: Record<number, InputEvent["button"] | "back" | "home"> = {
  0: "ok",
  1: "back",
  2: "x",
  3: "y",
  4: "lb",
  5: "rb",
  6: "lt",
  7: "rt",
  8: "view",
  9: "start",
  12: "up",
  13: "down",
  14: "left",
  15: "right",
  16: "home",
};
const STICK_ON = 0.6;
const STICK_OFF = 0.4;

// What's held on each gamepad, from one reading of them to the next, as the
// presses and releases between: the d-pad and the left stick both count for
// a direction, which is held while either holds it.
export function padChanges(
  pads: { index: number; buttons: readonly { pressed: boolean }[]; axes: readonly number[] }[],
  held: Map<number, Set<string>>,
): { pad: number; button: InputEvent["button"] | "back" | "home"; down: boolean }[] {
  const changes: { pad: number; button: InputEvent["button"] | "back" | "home"; down: boolean }[] = [];
  const seen = new Set<number>();
  for (const pad of pads) {
    seen.add(pad.index);
    const before = held.get(pad.index) ?? new Set<string>();
    const now = new Set<string>();
    for (const [index, button] of Object.entries(PAD_BUTTONS)) {
      if (pad.buttons[Number(index)]?.pressed) now.add(button);
    }
    const [x = 0, y = 0] = pad.axes;
    const stick = (name: string, value: number, sign: number) => {
      const v = value * sign;
      if (v > STICK_ON || (before.has(`stick-${name}`) && v > STICK_OFF)) now.add(`stick-${name}`);
    };
    stick("left", x, -1);
    stick("right", x, 1);
    stick("up", y, -1);
    stick("down", y, 1);
    for (const dir of ["up", "down", "left", "right"]) if (now.has(`stick-${dir}`)) now.add(dir);
    for (const button of now) if (!before.has(button) && !button.startsWith("stick-")) changes.push({ pad: pad.index, button: button as InputEvent["button"], down: true });
    for (const button of before) if (!now.has(button) && !button.startsWith("stick-")) changes.push({ pad: pad.index, button: button as InputEvent["button"], down: false });
    held.set(pad.index, now);
  }
  // A gamepad that went away lets go of everything it held.
  for (const [index, before] of held) {
    if (seen.has(index)) continue;
    for (const button of before) if (!button.startsWith("stick-")) changes.push({ pad: index, button: button as InputEvent["button"], down: false });
    held.delete(index);
  }
  return changes;
}
