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
  window.__agentvPaused = paused;
  return paused.length;
})()`;

// How many it played again.
export const RESUME = `(async () => {
  const paused = window.__agentvPaused ?? [];
  window.__agentvPaused = [];
  let played = 0;
  for (const el of paused) {
    if (!el.isConnected) continue;
    try { await el.play(); played++; } catch {}
  }
  return played;
})()`;
