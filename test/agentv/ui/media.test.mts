// Home's pause and resume (daemon/media.ts, ADR-031) in a real Chromium, over
// a DevTools pipe the way the screen daemon holds the services' Chromium: a
// page playing audio, one element inside a shadow root and one the viewer
// paused. Home pauses what plays and nothing else, the time stays where it
// was, and choosing the app again plays only what Home paused.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { after, before, test } from "node:test";
import { CdpPipe } from "../../../daemon/cdp.ts";
import { PAUSE, RESUME } from "../../../daemon/media.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A second of a quiet tone as a WAV, three players of it: one in the page,
// one in a shadow root, and one the viewer paused.
const PAGE = `<!doctype html><body><div id="host"></div><script>
  const rate = 8000, samples = rate;
  const data = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (at, s) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF"); data.setUint32(4, 36 + samples * 2, true); text(8, "WAVEfmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, rate, true); data.setUint32(28, rate * 2, true); data.setUint16(32, 2, true);
  data.setUint16(34, 16, true); text(36, "data"); data.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) data.setInt16(44 + i * 2, Math.sin(i / 8) * 200, true);
  const src = URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
  const player = (id) => Object.assign(document.createElement("audio"), { id, src, loop: true });
  const main = player("main");
  const inner = player("inner");
  const mine = player("mine");
  document.body.append(main, mine);
  document.getElementById("host").attachShadow({ mode: "open" }).append(inner);
  window.ready = Promise.all([main.play(), inner.play()]).then(() => "playing");
</script></body>`;

let browser: ChildProcess;
let cdp: CdpPipe;

before(() => {
  browser = spawn(
    process.env.AGENTV_UI_BROWSER!,
    ["--headless=new", "--no-sandbox", "--remote-debugging-pipe", "--no-first-run", "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${mkdtempSync(join(tmpdir(), "agentv-media-"))}`, "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  cdp = new CdpPipe(browser.stdio[3] as Writable, browser.stdio[4] as Readable);
});

after(() => {
  browser?.kill();
});

test("S2.15 Home pauses what plays, keeps its place, and plays only that again", async () => {
  const page = await cdp.open(`data:text/html,${encodeURIComponent(PAGE)}`);
  let state = "";
  for (let tries = 0; tries < 50 && state !== "playing"; tries++) {
    state = await cdp.evaluateIn(page, "window.ready ?? 'loading'").catch(() => "loading");
    if (state !== "playing") await sleep(100);
  }
  assert.equal(state, "playing");
  await sleep(300);
  const status = () =>
    cdp.evaluateIn(
      page,
      `(() => { const inner = document.getElementById("host").shadowRoot.getElementById("inner");
        return { main: document.getElementById("main").paused, inner: inner.paused, mine: document.getElementById("mine").paused,
          at: document.getElementById("main").currentTime }; })()`,
    );

  assert.equal(await cdp.evaluateIn(page, PAUSE), 2);
  const paused = await status();
  assert.deepEqual([paused.main, paused.inner, paused.mine], [true, true, true]);
  await sleep(300);
  assert.equal((await status()).at, paused.at, "the place stays where Home paused it");

  assert.equal(await cdp.evaluateIn(page, RESUME), 2);
  await sleep(300);
  const playing = await status();
  assert.deepEqual([playing.main, playing.inner, playing.mine], [false, false, true], "the viewer's own pause stays");
  assert.ok(playing.at > paused.at, "it plays on from where it was");
  // Nothing playing: Home has nothing to pause, and nothing to play again.
  await cdp.evaluateIn(page, `document.querySelectorAll("audio").forEach((a) => a.pause()); document.getElementById("host").shadowRoot.getElementById("inner").pause()`);
  assert.equal(await cdp.evaluateIn(page, PAUSE), 0);
  assert.equal(await cdp.evaluateIn(page, RESUME), 0);
  await cdp.close(page);
});
