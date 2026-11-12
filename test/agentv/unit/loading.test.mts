// A tile whose content isn't there yet (daemon/home.ts, T17.1). Home draws
// within seconds of a start, often before the TV is online, so Weather's
// first ask for its forecast can fail. The daemon says the tile is waiting,
// so home can show that it's loading and ask again, and it says "tiles" once
// the content is there. A tile with nothing to show isn't waiting, and what
// was kept still shows when the forecast can't be reached later.

import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import type { Daemon } from "../../../daemon/server.ts";
import { keepAsking, LATER, setWatching, WAITS } from "../../../launcher/loading.ts";
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
  assert.equal(answer.tile?.headline?.label, "Amsterdam");
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


// The asking again, on a clock the test turns (launcher/loading.ts).
test("something that never loads is asked for less and less, and not at all while nobody's watching", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let asks = 0;
    keepAsking(
      async () => {
        asks++;
        return true;
      },
      () => true,
    );
    // The clock a second at a time, with room for each ask to answer.
    const pass = async (ms: number) => {
      for (let at = 0; at < ms; at += 1000) {
        mock.timers.tick(1000);
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
    };
    const soon = WAITS.reduce((sum, wait) => sum + wait, 0);
    await pass(soon);
    assert.equal(asks, WAITS.length, "soon at first, then once a minute for a few minutes");
    await pass(3_600_000);
    assert.equal(asks, WAITS.length + 3_600_000 / LATER, "then every five minutes: twelve an hour, not sixty");

    // The idle screen comes up, or the TV goes off: nothing is asked for.
    setWatching(false);
    const before = asks;
    await pass(3_600_000);
    assert.equal(asks, before, "nothing is asked for while nobody's watching");
    // Someone's back: it's asked for at once, and the asking carries on.
    setWatching(true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(asks, before + 1, "asked for at once when someone's back");
    await pass(LATER);
    assert.equal(asks, before + 2);
    // Away for a moment, with the next ask still minutes off: it's asked for
    // as they come back all the same.
    setWatching(false);
    await pass(2000);
    setWatching(true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(asks, before + 3, "asked for at once, however far off the next ask was");
  } finally {
    setWatching(true);
    mock.timers.reset();
  }
});
