// Pausing what plays in a page, and playing it again (ADR-031): Home pauses
// the app in front, and choosing it again picks up where it was. These run
// in the page over the services' Chromium's DevTools pipe. They reach every
// audio and video element, in open shadow roots and same-origin frames too,
// and resume only what Home paused, so a film the viewer paused stays
// paused.

// How many it paused.
export const PAUSE = `(() => {
  const found = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el instanceof HTMLMediaElement) found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el instanceof HTMLIFrameElement) {
        try { if (el.contentDocument) walk(el.contentDocument); } catch {}
      }
    }
  };
  walk(document);
  const paused = found.filter((el) => !el.paused && !el.ended);
  for (const el of paused) el.pause();
  window.__origaitvPaused = paused;
  return paused.length;
})()`;

// How many it played again.
export const RESUME = `(async () => {
  const paused = window.__origaitvPaused ?? [];
  window.__origaitvPaused = [];
  let played = 0;
  for (const el of paused) {
    if (!el.isConnected) continue;
    try { await el.play(); played++; } catch {}
  }
  return played;
})()`;

// Muting a game's page while the TV is off (ADR-108): a cloud game keeps
// running, as a native game does, with its sound off. How many it muted.
export const MUTE = `(() => {
  const found = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el instanceof HTMLMediaElement) found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el instanceof HTMLIFrameElement) {
        try { if (el.contentDocument) walk(el.contentDocument); } catch {}
      }
    }
  };
  walk(document);
  const muted = found.filter((el) => !el.muted);
  for (const el of muted) el.muted = true;
  window.__origaitvMuted = muted;
  return muted.length;
})()`;

// Its sound back, for only what the TV going off muted.
export const UNMUTE = `(() => {
  const muted = window.__origaitvMuted ?? [];
  window.__origaitvMuted = [];
  let back = 0;
  for (const el of muted) {
    if (!el.isConnected) continue;
    el.muted = false;
    back++;
  }
  return back;
})()`;
