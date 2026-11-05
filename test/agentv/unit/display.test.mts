// The TV's resolution and its three sizes (daemon/display.ts, ADR-062): the
// mode a TV runs at, the scale for each size's canvas, which sizes a TV
// offers, /api/display on the daemon, and the screen daemon setting it in
// Hyprland and keeping it for the next session.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanScale, Display, DisplayWatch, displayFile, offered, parseMode, pickMode, targetFor, type DisplayHyprland, type Mode } from "../../../daemon/display.ts";
import { Features } from "../../../daemon/features.ts";
import type { Monitor } from "../../../daemon/hyprland.ts";
import { Daemon } from "../../../daemon/server.ts";

const base = mkdtempSync(join(tmpdir(), "agentv-display-"));
after(() => rmSync(base, { recursive: true, force: true }));

const modes = (...list: string[]): Mode[] => list.map((text) => parseMode(text)!);
// The Panasonic's modes, as Hyprland lists them on the NUC, more or less.
const PANASONIC = ["3840x2160@60.00Hz", "3840x2160@30.00Hz", "4096x2160@60.00Hz", "2560x1440@60.00Hz", "1920x1080@60.00Hz", "1920x1080@59.94Hz", "1280x720@60.00Hz"];
const HD = ["1920x1080@60.00Hz", "1920x1080@50.00Hz", "1280x720@60.00Hz"];

test("a TV runs at its full 16:9 resolution at 60 Hz, or 1080p when asked", () => {
  assert.deepEqual(pickMode(modes(...PANASONIC), "auto"), { width: 3840, height: 2160, refresh: 60 });
  assert.deepEqual(pickMode(modes(...PANASONIC), "1080p"), { width: 1920, height: 1080, refresh: 60 });
  assert.deepEqual(pickMode(modes("3840x2160@30.00Hz", "3840x2160@120.00Hz"), "auto"), { width: 3840, height: 2160, refresh: 30 }, "never more than 60 Hz while 60 or less is there");
  assert.deepEqual(pickMode(modes("3840x2160@120.00Hz"), "auto"), { width: 3840, height: 2160, refresh: 120 });
  assert.deepEqual(pickMode(modes("1366x768@60.00Hz", "1280x720@60.00Hz"), "1080p"), { width: 1280, height: 720, refresh: 60 }, "a TV with no 1080p takes the biggest 16:9 below it");
  assert.equal(pickMode([], "auto"), null);
  assert.equal(parseMode("3840x2160"), null);
  assert.equal(parseMode('3840x2160@60"; os.exit()'), null);
});

test("each size's scale leaves whole pixels, as Hyprland wants", () => {
  assert.equal(cleanScale(3840 / 1600, 3840, 2160), 2.4);
  assert.equal(cleanScale(3840 / 1920, 3840, 2160), 2);
  assert.equal(cleanScale(3840 / 2400, 3840, 2160), 1.6);
  assert.equal(cleanScale(1920 / 1600, 1920, 1080), 1.2);
  assert.equal(cleanScale(2560 / 1920, 2560, 1440), 4 / 3);
  for (const [w, h] of [[1366, 768], [3440, 1440], [4096, 2160], [1280, 720]]) {
    for (const canvas of [1600, 1920, 2400]) {
      const scale = cleanScale(w / canvas, w, h);
      assert.ok(Number.isInteger(Math.round((w / scale) * 1e6) / 1e6) && Number.isInteger(Math.round((h / scale) * 1e6) / 1e6), `${w}x${h} at ${scale}`);
      assert.ok(scale >= w / canvas - 1e-9, "the scale rounds up, so the canvas is never wider than asked");
    }
  }
});

test("a 4K TV offers all three sizes, and a 1080p TV larger and standard", () => {
  assert.deepEqual(offered({ width: 3840, height: 2160, refresh: 60 }), ["larger", "standard", "more"]);
  assert.deepEqual(offered({ width: 2560, height: 1440, refresh: 60 }), ["larger", "standard", "more"]);
  assert.deepEqual(offered({ width: 1920, height: 1080, refresh: 60 }), ["larger", "standard"]);
  assert.deepEqual(offered({ width: 1280, height: 720, refresh: 60 }), ["larger"], "a TV narrower than every canvas still gets one");
  assert.deepEqual(offered(null), ["larger", "standard"]);
});

test("each size is its logical canvas: a 4K TV at standard runs at scale 2", () => {
  const at = (size: "larger" | "standard" | "more", list: string[], output: "auto" | "1080p" = "auto") => targetFor("HDMI-A-1", modes(...list), size, output);
  assert.deepEqual(at("standard", PANASONIC), { target: { output: "HDMI-A-1", mode: "3840x2160@60", scale: 2 }, canvas: [1920, 1080], sizes: ["larger", "standard", "more"], size: "standard" });
  assert.deepEqual(at("larger", PANASONIC)?.target.scale, 2.4);
  assert.deepEqual(at("larger", PANASONIC)?.canvas, [1600, 900]);
  assert.deepEqual(at("more", PANASONIC)?.canvas, [2400, 1350]);
  assert.deepEqual(at("more", PANASONIC)?.target.scale, 1.6);
  assert.deepEqual(at("larger", HD)?.target, { output: "HDMI-A-1", mode: "1920x1080@60", scale: 1.2 });
  assert.deepEqual(at("more", HD)?.size, "standard", "more on screen on a 1080p TV shows standard");
  assert.deepEqual(at("standard", PANASONIC, "1080p")?.target, { output: "HDMI-A-1", mode: "1920x1080@60", scale: 1 }, "1080p output on a 4K TV, which scales it up");
});

const PANASONIC_TV = { output: "HDMI-A-1", modes: PANASONIC, live: { mode: "3840x2160@60", scale: 1 } };

test("the display keeps what's picked and the TV it saw, and nothing changes with the switch off", async () => {
  const state = join(base, "model");
  let on = false;
  let smooth: boolean | null = null;
  const display = new Display({ state, on: () => on, fourKSmooth: async () => smooth });
  assert.deepEqual(await display.state(), { size: "standard", output: "auto", mode: null, scale: null, canvas: [1920, 1080], sizes: [] });
  assert.deepEqual(await display.choose({ size: "larger" }), { ok: false, status: 409, error: "sizes are switched off on this box" });
  assert.deepEqual(await display.reported(PANASONIC_TV), { ok: true, changed: true });
  assert.equal(await display.target(), null, "the switch off leaves Hyprland's own mode and scale");
  assert.deepEqual((await display.state()).scale, 1, "and says what the TV runs at");

  on = true;
  assert.deepEqual(await display.state(), { size: "standard", output: "auto", mode: "3840x2160@60", scale: 2, canvas: [1920, 1080], sizes: ["larger", "standard", "more"] });
  assert.deepEqual(await display.target(), { output: "HDMI-A-1", mode: "3840x2160@60", scale: 2 });
  assert.deepEqual(await display.choose({ size: "more" }), { ok: true });
  assert.deepEqual((await display.state()).canvas, [2400, 1350]);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "display.json"), "utf8")).size, "more");
  assert.equal((await display.choose({ size: "huge" })).ok, false);
  assert.equal((await display.choose({ output: "720p" })).ok, false);
  assert.equal((await display.choose([])).ok, false);
  assert.deepEqual(await display.reported(PANASONIC_TV), { ok: true, changed: false });
  assert.equal((await display.reported({ output: 'HDMI"', modes: PANASONIC })).ok, false, "a connector name that could run Lua is refused");

  // A box that can't keep 4K smooth starts at 1080p, and can still pick 4K.
  smooth = false;
  assert.deepEqual(await display.state(), { size: "standard", output: "1080p", mode: "1920x1080@60", scale: 1, canvas: [1920, 1080], sizes: ["larger", "standard"] });
  assert.deepEqual(await display.choose({ output: "auto" }), { ok: true });
  assert.deepEqual((await display.state()).mode, "3840x2160@60");
  assert.deepEqual((await display.state()).size, "more", "the pick comes back with the 4K output");

  // The same box on a 1080p TV: more on screen isn't offered there.
  await display.reported({ output: "HDMI-A-2", modes: HD, live: null });
  assert.deepEqual((await display.state()).size, "standard");
  assert.deepEqual(await display.choose({ size: "more" }), { ok: false, status: 400, error: "this tv offers larger and standard" });
});

// --- The daemon's routes -------------------------------------------------

test("/api/display picks a size, the screen daemon sets it, and the TV hears it", async () => {
  const state = join(base, "daemon");
  mkdirSync(state, { recursive: true });
  const daemon = new Daemon({ root: join(base, "root"), state, apps: join(base, "apps"), builtins: null, port: 0, log: () => {} });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  const send = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
  };
  try {
    assert.equal((await send("GET", "/api/features")).data.sizes, false);
    assert.equal((await send("PUT", "/api/display", { size: "larger" })).status, 409);
    writeFileSync(join(state, "features.json"), JSON.stringify({ sizes: true }));
    assert.equal((await send("GET", "/api/features")).data.sizes, true);

    // The screen daemon tells it the TV, and hears what to set it to.
    const told = await send("POST", "/api/display/tv", PANASONIC_TV);
    assert.deepEqual(told.data, { ok: true, target: { output: "HDMI-A-1", mode: "3840x2160@60", scale: 2 } });
    assert.equal((await send("POST", "/api/display/tv", { output: "x" })).status, 400);

    // The TV's pages listen for the change.
    const events = await fetch(`${url}/api/events`);
    const reader = events.body!.getReader();
    let heard = "";
    const listening = (async () => {
      while (!heard.includes("event: display")) {
        const { value, done } = await reader.read();
        if (done) break;
        heard += new TextDecoder().decode(value);
      }
    })();

    // A stand-in screen daemon takes the ask and sets it.
    const screen = (async () => {
      const { ask } = (await (await fetch(`${url}/api/display/ask`)).json()) as { ask: { n: number; target: { scale: number } } };
      await fetch(`${url}/api/display/ask/${ask.n}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, live: { mode: "3840x2160@60", scale: ask.target.scale } }) });
      return ask.target;
    })();
    const started = Date.now();
    const put = await send("PUT", "/api/display", { size: "larger" });
    assert.deepEqual(put.data, { ok: true, size: "larger", output: "auto", mode: "3840x2160@60", scale: 2.4, canvas: [1600, 900], sizes: ["larger", "standard", "more"], applied: true });
    assert.ok(Date.now() - started < 1000, "a size change applies within a second");
    assert.deepEqual(await screen, { output: "HDMI-A-1", mode: "3840x2160@60", scale: 2.4 });
    await listening;
    assert.match(heard, /event: display\ndata: \{"size":"larger"/);
    await reader.cancel();
    assert.equal((await send("GET", "/api/display")).data.scale, 2.4);
    assert.equal((await send("POST", "/api/display/ask/999", { ok: true })).status, 404);
  } finally {
    await daemon.close();
  }
});

test("a size picked with no TV session running is kept for the next one", async () => {
  const state = join(base, "no-session");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "features.json"), JSON.stringify({ sizes: true }));
  const daemon = new Daemon({ root: join(base, "root"), state, apps: join(base, "apps"), builtins: null, port: 0, log: () => {} });
  const url = `http://127.0.0.1:${await daemon.listen()}`;
  try {
    // No TV seen yet: what every 1080p TV can do.
    const before = (await (await fetch(`${url}/api/display`)).json()) as Record<string, unknown>;
    assert.deepEqual(before.sizes, ["larger", "standard"]);
    const put = await fetch(`${url}/api/display`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size: "larger" }) });
    assert.deepEqual(((await put.json()) as Record<string, unknown>).canvas, [1600, 900]);
    assert.equal(JSON.parse(readFileSync(join(state, "display.json"), "utf8")).size, "larger");
  } finally {
    await daemon.close();
  }
});

test("the features file changes only the switches it names", () => {
  const state = join(base, "features");
  mkdirSync(state, { recursive: true });
  const features = new Features({ state });
  assert.equal(features.on("sizes"), false);
  writeFileSync(join(state, "features.json"), JSON.stringify({ sizes: true, nonsense: true, looks: "yes" }));
  assert.equal(features.on("sizes"), true);
  assert.equal(features.on("looks"), false);
  assert.equal("nonsense" in features.all(), false);
  writeFileSync(join(state, "features.json"), "{");
  assert.equal(features.on("sizes"), false);
});

// --- The screen daemon's side --------------------------------------------

class FakeHyprland implements DisplayHyprland {
  monitor: Monitor = { name: "HDMI-A-1", width: 3840, height: 2160, refreshRate: 60, focused: true, scale: 1, availableModes: PANASONIC };
  evals: string[] = [];
  handler: (name: string, data: string) => void = () => {};
  take = true;
  async monitors() {
    return [structuredClone(this.monitor)];
  }
  async eval(code: string) {
    this.evals.push(code);
    const m = /^hl\.monitor\(\{ output = "([^"]+)", mode = "(\d+)x(\d+)@[\d.]+", position = "auto", scale = ([\d.]+) \}\)$/.exec(code);
    if (m && this.take) setTimeout(() => Object.assign(this.monitor, { width: Number(m[2]), height: Number(m[3]), scale: Number(m[4]) }), 30);
    else if (/mode = "preferred"/.test(code)) Object.assign(this.monitor, { width: 3840, height: 2160, scale: 1 });
  }
  events(handler: (name: string, data: string) => void) {
    this.handler = handler;
  }
}

test("the screen daemon sets the mode and scale, and keeps them for the next session", async () => {
  const hypr = new FakeHyprland();
  const file = join(base, "home", "state", "agentv", "display");
  const watch = new DisplayWatch({ hyprland: hypr, url: "http://127.0.0.1:1/", file, log: () => {}, settleMs: 500 });
  const set = await watch.apply({ output: "HDMI-A-1", mode: "3840x2160@60", scale: 2 });
  assert.deepEqual(set, { ok: true, live: { mode: "3840x2160@60", scale: 2 } });
  assert.deepEqual(hypr.evals, ['hl.monitor({ output = "HDMI-A-1", mode = "3840x2160@60", position = "auto", scale = 2 })']);
  assert.equal(readFileSync(file, "utf8"), "HDMI-A-1 3840x2160@60 2\n");

  // What it runs at already isn't set again, so the TV doesn't look for its signal.
  await watch.apply({ output: "HDMI-A-1", mode: "3840x2160@60", scale: 2 });
  assert.equal(hypr.evals.length, 1);

  // Hyprland that doesn't take it says so.
  hypr.take = false;
  const refused = await watch.apply({ output: "HDMI-A-1", mode: "3840x2160@60", scale: 1.6 });
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), /scale 2/);
  hypr.take = true;

  // Nothing that could run Lua goes in.
  assert.equal((await watch.apply({ output: 'HDMI"})', mode: "3840x2160@60", scale: 2 })).ok, false);
  assert.equal((await watch.apply({ output: "HDMI-A-1", mode: "3840x2160@60 })", scale: 2 })).ok, false);
  assert.equal((await watch.apply({ output: "HDMI-A-1", mode: "3840x2160@60", scale: 99 })).ok, false);

  // The switch off: back to Hyprland's own, and no line for the next session.
  const back = await watch.apply(null);
  assert.equal(back.ok, true);
  assert.match(hypr.evals.at(-1)!, /^hl\.monitor\(\{ output = "HDMI-A-1", mode = "preferred", position = "auto", scale = "auto" \}\)$/);
  assert.equal(existsSync(file), false);
});

test("a session that started at the kept line goes back with the switch off", async () => {
  const hypr = new FakeHyprland();
  hypr.monitor.scale = 2;
  const file = join(base, "kept", "display");
  mkdirSync(join(base, "kept"), { recursive: true });
  writeFileSync(file, "HDMI-A-1 3840x2160@60 2\n");
  const watch = new DisplayWatch({ hyprland: hypr, url: "http://127.0.0.1:1/", file, log: () => {} });
  await watch.apply(null);
  assert.deepEqual(hypr.evals, ['hl.monitor({ output = "HDMI-A-1", mode = "preferred", position = "auto", scale = "auto" })']);
  assert.equal(hypr.monitor.scale, 1);
});

test("the screen daemon tells the daemon its TV at the start, and again when one's plugged in", async () => {
  const state = join(base, "watch");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "features.json"), JSON.stringify({ sizes: true }));
  writeFileSync(join(state, "display.json"), JSON.stringify({ size: "more" }));
  const daemon = new Daemon({ root: join(base, "root"), state, apps: join(base, "apps"), builtins: null, port: 0, log: () => {} });
  const url = `http://127.0.0.1:${await daemon.listen()}/`;
  const hypr = new FakeHyprland();
  const watch = new DisplayWatch({ hyprland: hypr, url, file: join(base, "watch-home", "display"), log: () => {} });
  try {
    await watch.start();
    assert.equal(hypr.monitor.scale, 1.6, "more on screen on the 4K TV, before home starts");
    assert.deepEqual(JSON.parse(readFileSync(join(state, "display.json"), "utf8")).tv.output, "HDMI-A-1");

    // A size picked on the TV: the daemon asks, the watch sets it.
    const put = await fetch(`${url}api/display`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size: "standard" }) });
    assert.equal(((await put.json()) as { applied: boolean }).applied, true);
    assert.equal(hypr.monitor.scale, 2);

    // Another TV plugged in: 1080p, which gets standard at scale 1.
    Object.assign(hypr.monitor, { name: "HDMI-A-2", width: 1920, height: 1080, scale: 1, availableModes: HD });
    hypr.handler("monitoraddedv2", "2,HDMI-A-2,TV");
    const seen = () => JSON.parse(readFileSync(join(state, "display.json"), "utf8")).tv.output;
    for (let i = 0; i < 40 && seen() !== "HDMI-A-2"; i++) await new Promise((done) => setTimeout(done, 50));
    assert.equal(seen(), "HDMI-A-2");
    const now = (await (await fetch(`${url}api/display`)).json()) as Record<string, unknown>;
    assert.deepEqual([now.mode, now.scale, now.sizes], ["1920x1080@60", 1, ["larger", "standard"]]);
  } finally {
    watch.stop();
    await daemon.close();
  }
});

test("the kept line lives in the person's own state", () => {
  assert.equal(displayFile({}, "/home/agentv"), "/home/agentv/.local/state/agentv/display");
  assert.equal(displayFile({ XDG_STATE_HOME: "/tmp/state" }, "/home/agentv"), "/tmp/state/agentv/display");
});
