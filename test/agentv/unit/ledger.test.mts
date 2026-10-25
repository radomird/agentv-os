// The ledger (daemon/ledger.ts), the screen daemon's playback watch
// (daemon/playback.ts) and the daemon's ledger requests: a row within 10 s
// of an app opening, one row per viewer (S3.3), the same title moving its
// row on, viewers' roles, and nothing in it that isn't a playback state.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { PlaybackState } from "../../../apps/contract/contract.ts";
import { badState, kindOf, Ledger } from "../../../daemon/ledger.ts";
import { PlaybackWatch } from "../../../daemon/playback.ts";
import type { AppHost, PageBroker, Viewer } from "../../../daemon/apps/loader.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, startBox } from "../ui/box.mts";

const episode = (episode: number, position: number): PlaybackState => ({ title: "Sintel", season: 1, episode, position, duration: 888, playing: true });

test("the ledger's tables are the plan's, and a viewer is an adult or a kid", () => {
  const ledger = new Ledger(":memory:");
  ledger.viewer({ id: "radomir", name: "Radomir", role: "adult" });
  ledger.viewer({ id: "ana", name: "Ana", role: "kid", avatar: "fox" });
  ledger.viewer({ id: "ana", name: "Ana", role: "kid", avatar: "owl" });
  assert.deepEqual(ledger.viewers(), [
    { id: "ana", name: "Ana", role: "kid", avatar: "owl" },
    { id: "radomir", name: "Radomir", role: "adult", avatar: undefined },
  ]);
  assert.throws(() => ledger.viewer({ id: "x", name: "X", role: "teen" as "adult" }), /CHECK constraint/);
  // A row needs a viewer the ledger knows.
  assert.throws(() => ledger.record("nobody", "agentv.tube", "film", episode(1, 0)), /FOREIGN KEY/);
  ledger.close();
});

test("S3.3 a second viewer gets a separate row, and the same episode moves its row on", () => {
  const ledger = new Ledger(":memory:");
  ledger.viewer({ id: "radomir", name: "Radomir", role: "adult" });
  ledger.viewer({ id: "ana", name: "Ana", role: "kid" });
  const first = ledger.record("radomir", "agentv.tube", "episode", episode(1, 10), new Date("2026-10-25T20:00:00Z"));
  const again = ledger.record("radomir", "agentv.tube", "episode", episode(1, 20.6), new Date("2026-10-25T20:00:10Z"));
  assert.equal(again.id, first.id);
  assert.equal(again.position_s, 21);
  assert.equal(again.started_at, "2026-10-25T20:00:00.000Z");
  assert.equal(again.updated_at, "2026-10-25T20:00:10.000Z");
  const ana = ledger.record("ana", "agentv.tube", "episode", episode(1, 5), new Date("2026-10-25T20:00:20Z"));
  assert.notEqual(ana.id, first.id);
  assert.deepEqual(ledger.recent("radomir").map((row) => [row.title, row.episode, row.position_s]), [["Sintel", 1, 21]]);
  assert.deepEqual(ledger.recent("ana").map((row) => [row.viewer_id, row.position_s]), [["ana", 5]]);
  // The next episode is a row of its own, and the newest comes first.
  const next = ledger.record("radomir", "agentv.tube", "episode", episode(2, 0), new Date("2026-10-25T20:15:00Z"));
  assert.notEqual(next.id, first.id);
  assert.deepEqual(ledger.recent("radomir").map((row) => row.episode), [2, 1]);
  ledger.close();
});

test("the newest rows, by app and kind, and a live stream with no duration", () => {
  const ledger = new Ledger(":memory:");
  ledger.viewer({ id: "radomir", name: "Radomir", role: "adult" });
  ledger.record("radomir", "agentv.tube", "film", { title: "Spring", position: 60, duration: 464, playing: false }, new Date("2026-10-25T19:00:00Z"));
  ledger.record("radomir", "agentv.music", "track", { title: "Track 1", position: 3, duration: null as unknown as number, playing: true }, new Date("2026-10-25T19:30:00Z"));
  ledger.record("radomir", "agentv.tube", "episode", episode(3, 100), new Date("2026-10-25T20:00:00Z"));
  assert.deepEqual(ledger.recent("radomir", { app: "agentv.tube" }).map((row) => row.title), ["Sintel", "Spring"]);
  assert.deepEqual(ledger.recent("radomir", { kinds: ["episode", "film"], limit: 1 }).map((row) => row.kind), ["episode"]);
  assert.equal(ledger.recent("radomir", { app: "agentv.music" })[0].duration_s, null);
  ledger.close();
});

test("only a playback state goes in, and its kind follows what it is", () => {
  assert.equal(badState(episode(1, 0)), null);
  assert.match(badState({ ...episode(1, 0), title: "" }) ?? "", /title/);
  assert.match(badState({ ...episode(1, 0), season: 1.5 }) ?? "", /season/);
  assert.match(badState({ ...episode(1, 0), position: -1 }) ?? "", /position/);
  assert.match(badState({ ...episode(1, 0), playing: "yes" }) ?? "", /playing/);
  assert.match(badState("Sintel") ?? "", /object/);
  assert.equal(kindOf(episode(1, 0), "streaming"), "episode");
  assert.equal(kindOf({ title: "Spring", position: 0, duration: 1, playing: true }, "media"), "film");
  assert.equal(kindOf({ title: "Track", position: 0, duration: 1, playing: true }, "music"), "track");
});

// --- The playback watch -------------------------------------------------------

function fakeHost(states: (PlaybackState | null | Error)[], pages: (PageBroker | undefined)[] = []) {
  let reads = 0;
  let stopped = false;
  const host = {
    setPage(page: PageBroker | undefined) {
      pages.push(page);
    },
    async call(_viewer: Viewer, path: string) {
      assert.equal(path, "playback.readPlaybackState");
      const next = states[Math.min(reads++, states.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
    stop() {
      stopped = true;
    },
  };
  return { host: host as unknown as AppHost, reads: () => reads, stopped: () => stopped };
}

test("S3.3 an open app's playback is read at once, every second until it comes, then every 10 s, and stops when it closes", async () => {
  const recorded: [string, PlaybackState][] = [];
  const lines: string[] = [];
  const pages: (PageBroker | undefined)[] = [];
  const fake = fakeHost([episode(1, 1), new Error("the page went away"), null, episode(1, 31)], pages);
  const page = { url: async () => "https://tube.example/", call: async () => null } satisfies PageBroker;
  const watch = new PlaybackWatch({
    host: async (id) => (id === "agentv.tube" ? fake.host : null),
    viewer: async () => ({ id: "radomir", role: "adult" }),
    record: async (app, state) => void recorded.push([app, state]),
    every: 30,
    first: 5,
    log: (line) => lines.push(line),
  });
  watch.opened("agentv.tube", page);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The first read comes as the app opens, well inside 10 s.
  assert.deepEqual(recorded, [["agentv.tube", episode(1, 1)]]);
  assert.equal(pages[0], page);
  await new Promise((resolve) => setTimeout(resolve, 110));
  watch.closed("agentv.tube");
  const reads = fake.reads();
  assert.ok(reads >= 4, `${reads} reads`);
  // The failed read and the empty one leave nothing; the next reads do.
  const positions = recorded.map(([, state]) => state.position);
  assert.equal(positions[0], 1);
  assert.ok(positions.length >= 2 && positions.slice(1).every((position) => position === 31), positions.join(", "));
  assert.ok(lines.some((line) => line.includes("the page went away")), "a failed read is logged");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fake.reads(), reads, "nothing is read after it closes");
  assert.equal(fake.stopped(), true, "its worker is stopped");
  // An app without playback is never read.
  watch.opened("agentv.clock");
  await new Promise((resolve) => setTimeout(resolve, 50));
  watch.stop();
  assert.ok(recorded.every(([app]) => app === "agentv.tube"));
});

test("an item chosen on a tile opens with the app's playback.open once its page is up", async () => {
  const opened: unknown[] = [];
  let tries = 0;
  const host = {
    setPage() {},
    async call(_viewer: Viewer, path: string, item: unknown) {
      if (path === "playback.readPlaybackState") return null;
      assert.equal(path, "playback.open");
      if (++tries < 3) throw new Error("the page isn't on one of the app's origins");
      opened.push(item);
    },
    stop() {},
  } as unknown as AppHost;
  const watch = new PlaybackWatch({ host: async () => host, viewer: async () => ({ id: "radomir", role: "adult" }), record: async () => {}, first: 5, every: 1000 });
  watch.opened("agentv.tube");
  const item = { id: "ledger:1", kind: "episode", title: "Sintel", season: 1, episode: 4 };
  assert.equal(await watch.play("agentv.tube", item), true);
  assert.deepEqual(opened, [item]);
  assert.equal(tries, 3);
  // An app that never takes it gives up after its time.
  tries = -100;
  assert.equal(await watch.play("agentv.tube", item, 30), false);
  // And one that isn't open has nothing to open it in.
  assert.equal(await watch.play("agentv.radio", item), false);
  watch.stop();
});

// --- The daemon's ledger requests ---------------------------------------------

let daemon: Daemon;
let url = "";
let passwd = "";

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentv-ledger-"));
  passwd = join(dir, "passwd");
  writeFileSync(passwd, "root:x:0:0::/root:/bin/bash\nradomir:x:1000:1000::/home/radomir:/bin/bash\n");
  process.env.AGENTV_PASSWD = passwd;
  ({ daemon, url } = await startBox(0, FIXTURES));
});

after(async () => {
  await daemon?.close();
  delete process.env.AGENTV_PASSWD;
});

async function send(body: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(`${url}/api/ledger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

test("S3.3 the daemon keeps what the screen daemon sends, for the viewer, one row per viewer", async () => {
  assert.deepEqual((await (await fetch(`${url}/api/viewer`)).json()).viewer, { id: "radomir", name: "radomir", role: "adult" });
  const first = await send({ app: "local.mytv", state: episode(4, 12) });
  assert.equal(first.status, 200);
  assert.deepEqual([first.data.row.viewer_id, first.data.row.kind, first.data.row.title, first.data.row.episode], ["radomir", "episode", "Sintel", 4]);
  // A film in a media app.
  const film = await send({ app: "agentv.sample", state: { title: "Spring", position: 1, duration: 464, playing: true } });
  assert.equal(film.data.row.kind, "film");
  // Someone else on the box: until profiles come, the box's first user.
  writeFileSync(passwd, "ana:x:1000:1000::/home/ana:/bin/bash\n");
  await send({ app: "local.mytv", state: episode(4, 3) });
  const rows = await (await fetch(`${url}/api/ledger`)).json();
  assert.equal(rows.viewer, "ana");
  assert.deepEqual(rows.rows.map((row: any) => [row.viewer_id, row.position_s]), [["ana", 3]]);
  writeFileSync(passwd, "radomir:x:1000:1000::/home/radomir:/bin/bash\n");
  assert.deepEqual((await (await fetch(`${url}/api/ledger?app=local.mytv`)).json()).rows.map((row: any) => [row.viewer_id, row.position_s]), [["radomir", 12]]);
});

test("S3.10 an app with playback and no tile() gets a medium continue tile from the ledger", async () => {
  // local.mytv has playback and no tile(); its rows from the test above.
  await send({ app: "local.mytv", state: { title: "Spring", position: 230, duration: 464, playing: false } });
  const { tile } = await (await fetch(`${url}/api/tile/local.mytv/m`)).json();
  assert.equal(tile.headline.label, "continue");
  assert.deepEqual(
    tile.entries.map((entry: any) => [entry.label, entry.caption, Math.round(entry.progress * 100)]),
    [
      ["Spring", "film · 4 min left", 50],
      ["Sintel", "S1 E4 · 15 min left", 1],
    ],
  );
  assert.deepEqual(tile.entries[1].item, { id: tile.entries[1].item.id, kind: "episode", title: "Sintel", season: 1, episode: 4 });
  assert.match(tile.entries[1].item.id, /^ledger:\d+$/);
  // Only medium, and only for an app without its own tile().
  assert.equal((await (await fetch(`${url}/api/tile/local.mytv/s`)).json()).tile, null);
  assert.notEqual((await (await fetch(`${url}/api/tile/agentv.sample/m`)).json()).tile.headline.label, "continue");
  // An app with nothing in the ledger keeps its logo.
  assert.equal((await (await fetch(`${url}/api/tile/agentv.tube/m`)).json()).tile, null);
});

test("the ledger takes only apps on this box and real playback states", async () => {
  assert.equal((await send({ app: "agentv.nothing", state: episode(1, 0) })).status, 400);
  assert.equal((await send({ app: "local.mytv", state: { title: "Sintel" } })).status, 400);
  assert.equal((await send({ app: "local.mytv" })).status, 400);
  const response = await fetch(`${url}/api/ledger`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
  assert.equal(response.status, 403);
});

test("an app that's gone from the box takes its rows with it, and only then", async () => {
  await send({ app: "local.mytv", state: episode(9, 1) });
  const refused = await fetch(`${url}/api/ledger?app=local.mytv`, { method: "DELETE" });
  assert.equal(refused.status, 400);
  const ledger = (daemon as unknown as { ledger: Ledger }).ledger;
  ledger.record("radomir", "local.gone", "film", { title: "Gone", position: 1, duration: 2, playing: true });
  const gone = await (await fetch(`${url}/api/ledger?app=local.gone`, { method: "DELETE" })).json();
  assert.equal(gone.forgotten, 1);
  assert.equal(ledger.recent("radomir", { app: "local.gone" }).length, 0);
});

test("the screen daemon's worker finds an app's package through the daemon", async () => {
  const found = await (await fetch(`${url}/api/apps/local.mytv/package`)).json();
  assert.equal(found.tier, "local");
  assert.equal(found.category, "streaming");
  assert.match(found.dir, /local\.mytv$/);
  assert.equal((await fetch(`${url}/api/apps/agentv.nothing/package`)).status, 404);
});
