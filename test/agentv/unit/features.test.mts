// The feature switches (daemon/features.ts): every track's switch is there
// and off by default, a box's changes are kept in features.json in the
// daemon's state, only an edge box turns one on, and a stable box shows its
// defaults even if a switch was turned on while it was on edge. Through the
// daemon: GET /api/features is the map and nothing else, PUT changes it and
// sends the event `features`, and a paired phone can read it too.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FEATURE_NAMES, FEATURES, featureOn, Features, features, isFeature } from "../../../daemon/features.ts";
import { Daemon } from "../../../daemon/server.ts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-features-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;
function box(channel = "edge", defaults?: Record<string, boolean>): { features: Features; state: string; set: (c: string) => void } {
  const state = join(scratch, `state-${count++}`);
  mkdirSync(state, { recursive: true });
  let current = channel;
  return { features: new Features({ state, channel: async () => current, defaults: defaults as never }), state, set: (c) => (current = c) };
}

test("T12.1 every track's switch is there, in the plan's names, and off by default", async () => {
  assert.deepEqual(FEATURE_NAMES, ["boxcheck", "sizes", "looks", "dynamicbg", "setup2", "remote2", "starter", "discover", "askbuilds"]);
  assert.ok(Object.values(FEATURES).every((on) => on === false));
  assert.deepEqual(await box().features.read(), Object.fromEntries(FEATURE_NAMES.map((name) => [name, false])));
  assert.equal(isFeature("looks"), true);
  assert.equal(isFeature("toString"), false);
  assert.equal(isFeature("Looks"), false);
});

test("an edge box turns a switch on and off, and keeps only what differs from the defaults", async () => {
  const { features, state } = box();
  const on = await features.set({ looks: true, sizes: true });
  assert.ok(on.ok);
  assert.equal(on.features.looks, true);
  assert.equal(await features.on("sizes"), true);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "features.json"), "utf8")), { looks: true, sizes: true });
  const off = await features.set({ looks: false });
  assert.ok(off.ok && !off.features.looks && off.features.sizes);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "features.json"), "utf8")), { sizes: true });
  await features.set({ sizes: false });
  assert.equal(existsSync(join(state, "features.json")), false, "back to the defaults, there's nothing to keep");
});

test("only edge turns a switch on, and a stable box shows its defaults", async () => {
  const { features, set } = box("stable");
  const refused = await features.set({ looks: true });
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.status === 409 && /only turn on on edge/.test(refused.error));
  assert.equal(await features.on("looks"), false);

  // Turned on while on edge, then back to stable: off again, and on again
  // if the box goes back to edge.
  set("edge");
  assert.ok((await features.set({ looks: true })).ok);
  set("stable");
  assert.equal(await features.on("looks"), false);
  set("edge");
  assert.equal(await features.on("looks"), true);
});

test("once a default flips to on, stable shows it, and turning it off works anywhere", async () => {
  const { features, state } = box("stable", { looks: true });
  assert.equal(await features.on("looks"), true);
  const off = await features.set({ looks: false });
  assert.ok(off.ok && off.features.looks === false);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "features.json"), "utf8")), { looks: false });
  // Back to its default, which needs no edge either.
  assert.ok((await features.set({ looks: true })).ok);
  assert.equal(await features.on("looks"), true);
});

test("a wrong change changes nothing", async () => {
  const { features, state } = box();
  for (const wrong of [null, [], "looks", {}, { looks: "yes" }, { nope: true }, { looks: true, nope: true }, { __proto__: null, constructor: true }]) {
    const answer = await features.set(wrong);
    assert.equal(answer.ok, false, JSON.stringify(wrong));
  }
  const unknown = await features.set({ nope: true });
  assert.ok(!unknown.ok && unknown.status === 404 && unknown.error.includes("boxcheck, sizes, looks"));
  assert.equal(existsSync(join(state, "features.json")), false);
});

test("with no channel, as in a test, features.json counts, through the class or the two functions", async () => {
  const state = join(scratch, "no-channel");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "features.json"), JSON.stringify({ setup2: true }));
  assert.equal(await new Features({ state }).on("setup2"), true);
  assert.deepEqual(await new Features({ state }).all(), await features(state));
  assert.equal(await featureOn(state, "setup2"), true);
  assert.equal(await featureOn(state, "looks"), false);
});

test("a features.json someone broke reads as the defaults, keeping what it can", async () => {
  const { features, state } = box();
  writeFileSync(join(state, "features.json"), "not json");
  assert.equal(await features.on("looks"), false);
  writeFileSync(join(state, "features.json"), JSON.stringify({ looks: true, sizes: "on", nope: true }));
  const all = await features.read();
  assert.equal(all.looks, true);
  assert.equal(all.sizes, false);
  assert.equal("nope" in all, false);
});

test("T12.1 through the daemon: GET and PUT /api/features, the event, and a paired phone", async () => {
  const state = join(scratch, "daemon");
  const channelFile = join(scratch, "channel");
  writeFileSync(channelFile, "edge\n");
  const daemon = new Daemon({ root: scratch, state, port: 0, log: () => {}, channelFile, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1" });
  const port = await daemon.listen();
  const url = `http://127.0.0.1:${port}`;
  const events = new AbortController();
  try {
    const listed = await (await fetch(`${url}/api/features`)).json();
    assert.deepEqual(Object.keys(listed), FEATURE_NAMES, "the answer is the switches and nothing else");

    // What the TV's pages hear when a switch changes.
    const stream = await fetch(`${url}/api/events`, { signal: events.signal });
    const reader = stream.body!.getReader();
    const heard = (async () => {
      let text = "";
      while (!text.includes("event: features")) text += new TextDecoder().decode((await reader.read()).value);
      return text;
    })();

    const put = (body: unknown) => fetch(`${url}/api/features`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const changed = await put({ discover: true });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).discover, true);
    assert.match(await heard, /event: features\ndata: \{[^\n]*"discover":true/);
    assert.equal((await put({ nope: true })).status, 404);
    assert.equal((await put("looks")).status, 400);
    assert.equal((await fetch(`${url}/api/features`, { method: "DELETE" })).status, 404);

    // A page elsewhere can't change one.
    const elsewhere = await fetch(`${url}/api/features`, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://example.com" }, body: '{"looks": true}' });
    assert.equal(elsewhere.status, 403);
    assert.equal((await (await fetch(`${url}/api/features`)).json()).looks, false);

    // A paired phone reads them; an unpaired one doesn't, and neither can
    // change them.
    const phone = `http://127.0.0.1:${daemon.lanPort}`;
    assert.equal((await fetch(`${phone}/api/phone/features`)).status, 401);
    const { code } = daemon.phones.code();
    {
      const { token } = await (await fetch(`${phone}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "test" }) })).json();
      const read = await fetch(`${phone}/api/phone/features`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal((await read.json()).discover, true);
      const write = await fetch(`${phone}/api/features`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: '{"looks": true}' });
      assert.notEqual(write.status, 200);
    }
  } finally {
    events.abort();
    await daemon.close();
  }
});
