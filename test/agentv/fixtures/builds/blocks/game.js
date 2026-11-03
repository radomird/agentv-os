// Blocks: a falling-block game on AgenTV's app kit, for the page runtime's
// tests. The remote, the phone or a gamepad move and turn the piece, ok
// drops it, Back pauses, and Back again leaves. The best score is kept in
// the app's own storage and shown on its tile.

const kit = window.agentv;
const W = 10;
const H = 20;
const SIZE = 30;
const SHAPES = [
  [[0, 0], [1, 0], [2, 0], [3, 0]],
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[1, 0], [0, 1], [1, 1], [2, 1]],
  [[0, 0], [0, 1], [1, 1], [2, 1]],
  [[2, 0], [0, 1], [1, 1], [2, 1]],
  [[1, 0], [2, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [1, 1], [2, 1]],
];
const COLOURS = ["#7dcfff", "#e0af68", "#bb9af7", "#7aa2f7", "#ff9e64", "#9ece6a", "#f7768e"];

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const scoreEl = document.getElementById("score");
const bestEl = document.getElementById("best");
const stateEl = document.getElementById("state");

let board = Array.from({ length: H }, () => Array(W).fill(null));
let piece = null;
let score = 0;
let best = 0;
let paused = false;
let over = false;
let last = 0;
let fall = 0;

function spawn() {
  const kind = Math.floor(Math.random() * SHAPES.length);
  piece = { cells: SHAPES[kind].map(([x, y]) => [x, y]), x: 3, y: 0, colour: COLOURS[kind] };
  if (collides(piece.cells, piece.x, piece.y)) end();
}

function collides(cells, px, py) {
  return cells.some(([x, y]) => px + x < 0 || px + x >= W || py + y >= H || (py + y >= 0 && board[py + y][px + x]));
}

function move(dx, dy) {
  if (!collides(piece.cells, piece.x + dx, piece.y + dy)) {
    piece.x += dx;
    piece.y += dy;
    return true;
  }
  return false;
}

function turn() {
  const turned = piece.cells.map(([x, y]) => [2 - y, x]);
  if (!collides(turned, piece.x, piece.y)) piece.cells = turned;
}

function lock() {
  for (const [x, y] of piece.cells) if (piece.y + y >= 0) board[piece.y + y][piece.x + x] = piece.colour;
  const kept = board.filter((row) => row.some((cell) => !cell));
  const cleared = H - kept.length;
  board = [...Array.from({ length: cleared }, () => Array(W).fill(null)), ...kept];
  score += [0, 100, 300, 500, 800][cleared];
  scoreEl.textContent = String(score);
  spawn();
}

function end() {
  over = true;
  stateEl.textContent = "game over · ok to play again";
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    kit.storage.set("best", best);
    kit.tile.set({ headline: { label: "best", value: String(best) } });
  }
}

function restart() {
  board = Array.from({ length: H }, () => Array(W).fill(null));
  score = 0;
  over = false;
  scoreEl.textContent = "0";
  stateEl.textContent = "";
  spawn();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!board[y][x]) continue;
      ctx.fillStyle = board[y][x];
      ctx.fillRect(x * SIZE + 1, y * SIZE + 1, SIZE - 2, SIZE - 2);
    }
  }
  if (piece) {
    ctx.fillStyle = piece.colour;
    for (const [x, y] of piece.cells) ctx.fillRect((piece.x + x) * SIZE + 1, (piece.y + y) * SIZE + 1, SIZE - 2, SIZE - 2);
  }
}

function frame(now) {
  const dt = Math.min(100, now - last);
  last = now;
  if (!paused && !over) {
    fall += dt;
    if (fall > 500) {
      fall = 0;
      if (!move(0, 1)) lock();
    }
  }
  draw();
  requestAnimationFrame(frame);
}

kit.input.on((event) => {
  if (!event.down) return;
  if (over) {
    if (event.button === "ok") restart();
    return;
  }
  if (paused) {
    if (event.button === "ok") {
      paused = false;
      stateEl.textContent = "";
    }
    return;
  }
  if (event.button === "left") move(-1, 0);
  else if (event.button === "right") move(1, 0);
  else if (event.button === "down") move(0, 1);
  else if (event.button === "up" || event.button === "x") turn();
  else if (event.button === "ok") while (move(0, 1));
});

// Back pauses a game in play; Back on the pause leaves.
kit.onBack(() => {
  if (paused || over) return false;
  paused = true;
  stateEl.textContent = "paused · ok to play · back to leave";
  return true;
});
kit.onPause(() => {
  if (!over) {
    paused = true;
    stateEl.textContent = "paused · ok to play · back to leave";
  }
});

kit.storage.get("best").then((saved) => {
  best = typeof saved === "number" ? saved : 0;
  bestEl.textContent = String(best);
});
spawn();
requestAnimationFrame((now) => {
  last = now;
  frame(now);
  kit.ready();
});
