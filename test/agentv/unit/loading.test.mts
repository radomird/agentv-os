// A tile whose content isn't there yet (daemon/home.ts, T17.1). Home draws
// within seconds of a start, often before the TV is online, so Weather's
// first ask for its forecast can fail. The daemon says the tile is waiting,
// so home can show that it's loading and ask again, and it says "tiles" once
// the content is there. A tile with nothing to show isn't waiting, and what
// was kept still shows when the forecast can't be reached later.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, startBox } from "../ui/box.mts";
import { startMet, type Met } from "../ui/met.mts";

let daemon: Daemon;
let met: Met;
let url = "";

before(async () => {
  met = await startMet();
  // The forecast can't be reached as the box starts.
  met.down(true);
  ({ daemon, url } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", forecast: met.url }));
});

after(async () => {
  await daemon?.close();
  met?.close();
});

async function tile(id: string, size: string, fresh = false): Promise<{ tile: { headline?: { label?: string; value?: string } } | null; waiting?: boolean }> {
  return (await fetch(`${url}/api/tile/${id}/${size}${fresh ? "?fresh" : ""}`)).json();
}

// Every event the daemon sends until one of that name, or two seconds on.
async function heard(name: string, during: () => Promise<void>): Promise<string> {
  const events = await fetch(`${url}/api/events`);
  const reader = events.body!.getReader();
  await during();
  let seen = "";
  const deadline = Date.now() + 2000;
  while (!seen.includes(`event: ${name}`) && Date.now() < deadline) {
    const { value } = await Promise.race([reader.read(), new Promise<{ value: undefined }>((r) => setTimeout(() => r({ value: undefined }), 300))]);
    if (value) seen += new TextDecoder().decode(value);
  }
  await reader.cancel();
  return seen;
}

test("T17.1 a tile whose app can't get its content yet is waiting, not empty", async () => {
  const answer = await tile("agentv.weather", "s");
  assert.equal(answer.tile, null);
  assert.equal(answer.waiting, true, "Weather with no forecast yet is waiting");
  assert.ok(met.seen.length > 0, "it asked for the forecast");
  // Asked again, it tries again: a wait is never kept as the answer.
  const asked = met.seen.length;
  assert.equal((await tile("agentv.weather", "s")).waiting, true);
  assert.ok(met.seen.length > asked, "the second ask went for the forecast again");
});

test("T17.1 a tile with nothing to show isn't waiting", async () => {
  // Tube has no tile content at all, and the sample app's server is its own.
  const answer = await tile("agentv.tube", "s");
  assert.equal(answer.tile, null);
  assert.equal(answer.waiting, undefined);
  assert.equal((await tile("agentv.clock", "s")).waiting, undefined);
});

test("T17.1 once the content is there, the tile has it and every home hears \"tiles\"", async () => {
  met.down(false);
  let answer: Awaited<ReturnType<typeof tile>> = { tile: null };
  const seen = await heard("tiles", async () => {
    answer = await tile("agentv.weather", "s");
  });
  assert.equal(answer.waiting, undefined);
  assert.equal(answer.tile?.headline?.label, "amsterdam");
  assert.equal(answer.tile?.headline?.value, "12°");
  assert.match(seen, /event: tiles/);
  // It's said once: the next ask finds the tile there, and nothing changed.
  const again = await heard("tiles", async () => {
    await tile("agentv.weather", "s");
  });
  assert.doesNotMatch(again, /event: tiles/);
});

test("T17.1 a forecast that can't be reached later keeps what the tile had, without a wait", async () => {
  met.down(true);
  const answer = await tile("agentv.weather", "s", true);
  assert.equal(answer.waiting, undefined);
  assert.equal(answer.tile?.headline?.value, "12°");
  met.down(false);
});
