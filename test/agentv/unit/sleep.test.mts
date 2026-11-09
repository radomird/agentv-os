// Guards daemon/sleep.ts, sleep as a setting (ADR-072, T13.2), on stand-in
// clocks and a stand-in logind, and daemon/inhibit.ts, the inhibitor a build
// or a download holds. Run by sleep-test.sh.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Inhibitor } from "../../../daemon/inhibit.ts";
import { Sleep, blocking, type SleepPlatform } from "../../../daemon/sleep.ts";

const HOUR = 60 * 60_000;
const scratch = mkdtempSync(join(tmpdir(), "agentv-sleep-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A box: its two clocks, its settings, who holds an inhibitor, and what was
// asked of logind and the wake alarm.
function box(options: { sleep?: boolean; overnight?: boolean; suspends?: boolean } = {}) {
  const t = {
    wall: 1_800_000_000_000,
    mono: 1000,
    settings: { sleep: options.sleep ?? true, overnight: options.overnight ?? false },
    held: [] as { who: string; why: string }[],
    alarms: [] as boolean[],
    suspends: 0,
    woke: 0,
    lines: [] as string[],
    // Time passing while awake moves both clocks; asleep, only the wall's.
    pass(ms: number) {
      t.wall += ms;
      t.mono += ms;
    },
    sleepFor(ms: number) {
      t.wall += ms;
    },
  };
  const platform: SleepPlatform = {
    settings: async () => t.settings,
    inhibitors: async () => t.held,
    wakeAlarm: async (on) => (t.alarms.push(on), true),
    suspend: async () => (t.suspends++, options.suspends ?? true),
  };
  const sleep = new Sleep({ platform, now: () => t.wall, monotonic: () => t.mono, log: (line) => t.lines.push(line), woke: () => t.woke++ });
  return { t, sleep };
}

test("T13.2 with the setting off, the box never sleeps", async () => {
  const { t, sleep } = box({ sleep: false });
  sleep.tv(false);
  for (let i = 0; i < 8; i++) {
    t.pass(HOUR / 2);
    await sleep.tick();
  }
  assert.equal(t.suspends, 0);
  assert.deepEqual(t.alarms, []);
});

test("T13.2 with it on, the box sleeps once the TV has been off for the hour, not before", async () => {
  const { t, sleep } = box();
  t.pass(2 * HOUR);
  sleep.tv(false);
  t.pass(HOUR - 60_000);
  await sleep.tick();
  assert.equal(t.suspends, 0, "not before the hour");
  assert.equal(sleep.status().due_in_s, 60);
  t.pass(60_000);
  await sleep.tick();
  assert.equal(t.suspends, 1);
  assert.deepEqual(t.alarms, [false], "with overnight installs off, no wake alarm");
  assert.ok(t.lines.some((line) => line === "sleeping: the TV's been off for 60 min"), t.lines.join("\n"));
});

test("T13.2 the TV back on starts the hour again", async () => {
  const { t, sleep } = box();
  t.pass(2 * HOUR);
  sleep.tv(false);
  t.pass(HOUR / 2);
  sleep.tv(true);
  sleep.tv(false);
  t.pass(HOUR / 2);
  await sleep.tick();
  assert.equal(t.suspends, 0);
  assert.equal(sleep.status().tv_off_s, 30 * 60);
  sleep.tv(true);
  t.pass(2 * HOUR);
  await sleep.tick();
  assert.equal(t.suspends, 0, "never with the TV on");
  assert.deepEqual(sleep.status(), { tv_off_s: null, due_in_s: null });
});

test("T13.2 never while a build, an update or a download holds an inhibitor, and once it's let go, it sleeps", async () => {
  const { t, sleep } = box();
  t.pass(2 * HOUR);
  sleep.tv(false);
  t.held = [{ who: "omarchy-update", why: "Omarchy update in progress" }];
  t.pass(HOUR);
  await sleep.tick();
  t.pass(60_000);
  await sleep.tick();
  assert.equal(t.suspends, 0);
  assert.equal(t.lines.filter((line) => line.startsWith("not sleeping yet")).length, 1, "it says why once");
  assert.ok(t.lines.includes("not sleeping yet: omarchy-update (Omarchy update in progress)"), t.lines.join("\n"));
  t.held = [];
  t.pass(15_000);
  await sleep.tick();
  assert.equal(t.suspends, 1);
});

test("T13.2 with overnight installs on, it sets the wake alarm before it sleeps", async () => {
  const { t, sleep } = box({ overnight: true });
  t.pass(2 * HOUR);
  sleep.tv(false);
  t.pass(HOUR);
  await sleep.tick();
  assert.deepEqual(t.alarms, [true]);
  assert.equal(t.suspends, 1);
  assert.ok(t.lines.some((line) => line.endsWith("with a wake alarm for the night's update")), t.lines.join("\n"));
});

test("T13.2 a wake is noticed, and the box stays up an hour before it sleeps again", async () => {
  const { t, sleep } = box({ overnight: true });
  t.pass(2 * HOUR);
  sleep.tv(false);
  t.pass(HOUR);
  await sleep.tick();
  assert.equal(t.suspends, 1);
  // Asleep until the night's wake alarm.
  t.sleepFor(5 * HOUR);
  t.pass(15_000);
  await sleep.tick();
  assert.equal(t.woke, 1, "the screen hears the box is awake");
  assert.ok(t.lines.some((line) => line.startsWith("the box woke from sleep")), t.lines.join("\n"));
  t.pass(HOUR / 2);
  await sleep.tick();
  assert.equal(t.suspends, 1, "not straight back to sleep, so the night's update installs");
  t.pass(HOUR / 2);
  await sleep.tick();
  assert.equal(t.suspends, 2, "then it sleeps again");
});

test("T13.2 when logind won't suspend, it tries again 10 minutes later, not every tick", async () => {
  const { t, sleep } = box({ suspends: false });
  t.pass(2 * HOUR);
  sleep.tv(false);
  t.pass(HOUR);
  await sleep.tick();
  t.pass(60_000);
  await sleep.tick();
  assert.equal(t.suspends, 1);
  t.pass(10 * 60_000);
  await sleep.tick();
  assert.equal(t.suspends, 2);
});

test("T13.2 agentv screen sleep-after shortens the hour, for the checks", async () => {
  const { t, sleep } = box();
  t.pass(2 * HOUR);
  assert.deepEqual(sleep.afterSeconds(60), { ok: true });
  sleep.tv(false);
  t.pass(60_000);
  await sleep.tick();
  assert.equal(t.suspends, 1);
});

test("T13.2 only logind's inhibitors that block sleep hold it off", () => {
  const listed = JSON.stringify({
    type: "a(ssssuu)",
    data: [
      [
        ["sleep", "NetworkManager", "NetworkManager needs to turn off networks", "delay", 0, 812],
        ["sleep:idle", "omarchy-update", "Omarchy update in progress", "block", 1000, 4242],
        ["shutdown", "AgenTV", "something", "block", 0, 1],
        ["sleep", "AgenTV", "building an app", "block", 64000, 900],
      ],
    ],
  });
  assert.deepEqual(blocking(listed), [
    { who: "omarchy-update", why: "Omarchy update in progress" },
    { who: "AgenTV", why: "building an app" },
  ]);
  assert.deepEqual(blocking(JSON.stringify({ type: "a(ssssuu)", data: [[]] })), []);
  assert.equal(blocking("not json").length, 1, "an answer that doesn't read holds sleep off");
});

test("T13.2 a build or a download holds an inhibitor while it runs, and letting go ends it", async () => {
  // systemd-inhibit as far as the inhibitor uses it: it notes how it was
  // asked, then runs the command it was given.
  const stand = join(scratch, "systemd-inhibit");
  writeFileSync(stand, `#!/bin/bash\necho "$*" >"${scratch}/asked"\nshift 3\nexec sleep 30\n`);
  chmodSync(stand, 0o755);
  const awake = new Inhibitor("building an app", [stand, "--what=sleep", "--who=AgenTV", "--mode=block"]);
  awake.set(true);
  awake.set(true);
  assert.equal(awake.held, true);
  for (let i = 0; i < 50 && !existsSync(join(scratch, "asked")); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(readFileSync(join(scratch, "asked"), "utf8").trim(), "--what=sleep --who=AgenTV --mode=block --why=building an app sleep infinity");
  awake.set(false);
  assert.equal(awake.held, false);
  // With no systemd-inhibit at all, nothing breaks.
  const none = new Inhibitor("building an app", [join(scratch, "nothing-here")]);
  none.set(true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(none.held, false);
  none.set(false);
});
