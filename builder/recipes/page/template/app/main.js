// A page app on AgenTV: full screen in a frame on home, reaching the box
// only through window.agentv, the app kit. This starts it: a canvas drawn
// every frame, the buttons as they're pressed and let go, Back, Home's
// pause, and the app's own storage. Replace the drawing with the app.

const kit = window.agentv;
const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d");

// Which buttons are held now, by name: up, down, left, right, ok, play, and
// a gamepad's x, y, lb, rb, lt, rt, start and view.
const held = new Set();
kit.input.on((event) => {
  if (event.down) held.add(event.button);
  else held.delete(event.button);
});

// Back: return true to keep it (close something, pause), or nothing to
// leave the app.
let paused = false;
kit.onBack(() => {
  if (paused) return false;
  paused = true;
  return true;
});
kit.onPause(() => {
  paused = true;
});

function frame() {
  ctx.fillStyle = "#1a1b26";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#c0caf5";
  ctx.font = "48px monospace";
  ctx.fillText(paused ? "paused" : [...held].join(" ") || "press a button", 120, 160);
  requestAnimationFrame(frame);
}

requestAnimationFrame(() => {
  frame();
  kit.ready();
});
