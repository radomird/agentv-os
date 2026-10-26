// Every press on the phone's remote answers (ADR-037): the button shows it's
// pressed, even on a quick tap, the phone clicks, and it buzzes where the
// browser lets a page, which Chrome on Android does. Safari on an iPhone
// gives pages no vibration, so there it's the look and the click. A switch
// on the remote turns the click and the buzz off.
//
// And no zoom: a double tap or a pinch never zooms the page, so quick taps
// each count as a press.

const KEY = "agentv-phone-feel";
const PRESSED_MS = 120;

export function feelOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setFeel(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // A private window keeps it only while the page is open.
  }
}

let audio: AudioContext | null = null;

// A short, quiet click, made here rather than played from a file.
function click(): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    const at = audio.currentTime;
    const tone = audio.createOscillator();
    const level = audio.createGain();
    tone.frequency.value = 1800;
    level.gain.setValueAtTime(0.06, at);
    level.gain.exponentialRampToValueAtTime(0.0001, at + 0.03);
    tone.connect(level).connect(audio.destination);
    tone.start(at);
    tone.stop(at + 0.035);
  } catch {
    // No sound here: the look and the buzz still answer.
  }
}

// A button pressed: it shows for at least a moment, and clicks and buzzes
// unless that's switched off.
export function press(el: HTMLElement): void {
  el.classList.add("pressed");
  const at = Date.now();
  const up = () => window.setTimeout(() => el.classList.remove("pressed"), Math.max(0, PRESSED_MS - (Date.now() - at)));
  el.addEventListener("pointerup", up, { once: true });
  el.addEventListener("pointercancel", up, { once: true });
  if (!feelOn()) return;
  click();
  navigator.vibrate?.(10);
}

export function listen(): void {
  // Every button on the page, the overlays' too.
  document.addEventListener(
    "pointerdown",
    (event) => {
      const button = (event.target as Element | null)?.closest?.("button");
      if (button instanceof HTMLButtonElement && !button.disabled) press(button);
    },
    { passive: true },
  );
  // Safari wakes its sound only on a tap's end, the first time.
  document.addEventListener("pointerup", () => void audio?.resume().catch(() => {}), { passive: true });
  // Safari's pinch, and a double tap anywhere.
  document.addEventListener("gesturestart", (event) => event.preventDefault());
  document.addEventListener("dblclick", (event) => event.preventDefault());
}
