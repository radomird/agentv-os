// Sleep, as a setting (ADR-072): Settings → Power's "sleep when the TV's been
// off for an hour", off by default.
//
// With it on, the box suspends once the TV has been off for an hour and the
// box has been awake for an hour, so a box woken in the night doesn't drop
// straight back. It never suspends while something holds a systemd
// inhibitor that blocks sleep: a build, an update or a download each hold
// one. logind lets a caller past inhibitors held by its own user, and
// Omarchy's update holds its own as the box's owner, so this reads logind's
// list itself rather than leaving it to logind.
//
// With overnight updates on, it first sets a wake alarm for the update
// window (agentv-wake.timer), so the night's update still installs, and the
// box sleeps again an hour later. The alarm is only for while the box
// sleeps: once it's awake again, and when the screen daemon starts, the
// alarm goes off, so turning sleep off never leaves one behind for another
// suspend, Omarchy's desktop's say, to wake the box by every night. The
// box's power button or a key on a USB keyboard or remote wakes it to the
// ambient screen. The phone's web remote can't wake it, which the setting's
// line says.
//
// It runs in the screen daemon, which knows when the TV is off. A wake shows
// as the wall clock jumping ahead of the monotonic one, which stands still
// while the box sleeps. On a box that suspends to idle without stopping its
// clocks, neither moves apart, so the kernel's own count of suspends it came
// back from is read too. Missing a wake would put the box straight back to
// sleep, since the hour awake would look long over.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

export const SLEEP_AFTER_MS = 60 * 60_000;

export interface SleepPlatform {
  // Settings: whether sleep is on, and whether updates install overnight.
  settings(): Promise<{ sleep: boolean; overnight: boolean }>;
  // Who holds an inhibitor that blocks sleep right now, and why.
  inhibitors(): Promise<{ who: string; why: string }[]>;
  // Sets the wake alarm for the night's update window, or clears it. False
  // when it couldn't.
  wakeAlarm(on: boolean): Promise<boolean>;
  // Asks logind to suspend the box. False when it wouldn't.
  suspend(): Promise<boolean>;
  // How many suspends the kernel has come back from since it started, or
  // null when it doesn't say.
  suspended?(): Promise<number | null>;
}

interface Options {
  platform: SleepPlatform;
  now?: () => number;
  // A clock that stands still while the box sleeps.
  monotonic?: () => number;
  log?: (line: string) => void;
  // How often it looks, and how long the TV must be off.
  tickMs?: number;
  afterMs?: number;
  // Called once the box is awake again after sleeping.
  woke?: () => void;
}

export class Sleep {
  private platform: SleepPlatform;
  private now: () => number;
  private monotonic: () => number;
  private log: (line: string) => void;
  private tickMs: number;
  private afterMs: number;
  private afterOverride: number | null = null;
  private woke?: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  // When the TV went off, or null while it's on.
  private offSince: number | null = null;
  private awakeSince: number;
  private offset: number;
  // The kernel's count of suspends at the last look, or null before the
  // first one and on a kernel that doesn't count.
  private suspended: number | null = null;
  private busy = false;
  private heldSaid = "";
  private retryAt = 0;
  // Whether the wake alarm may be on. Unknown at first: the timer outlives
  // the screen daemon.
  private alarm: boolean | null = null;
  // An alarm that wouldn't clear is tried again after the next wake, not at
  // every look.
  private alarmStuck = false;
  // Asked logind to suspend, and hasn't seen the box wake since. The box can
  // take a few seconds to go, and the alarm stays on meanwhile.
  private asked = false;

  constructor(options: Options) {
    this.platform = options.platform;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.log = options.log ?? ((line) => console.log(line));
    this.tickMs = options.tickMs ?? 15_000;
    this.afterMs = options.afterMs ?? SLEEP_AFTER_MS;
    this.woke = options.woke;
    this.awakeSince = this.now();
    this.offset = this.now() - this.monotonic();
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // The TV went off or came back on (the screen daemon says so).
  tv(on: boolean): void {
    if (on) this.offSince = null;
    else if (this.offSince === null) this.offSince = this.now();
  }

  // The night's update waits for another night, so a box the wake alarm
  // woke for it goes back to sleep at the next look, not an hour later. One
  // that someone has used since it woke stays up its hour.
  nothingTonight(lastInput: number): void {
    if (lastInput >= this.awakeSince) return;
    this.awakeSince = Math.min(this.awakeSince, this.now() - this.after);
  }

  // For the checks: sleep after this many seconds, not an hour.
  afterSeconds(seconds: number | null): object {
    this.afterOverride = seconds === null ? null : seconds * 1000;
    return { ok: true };
  }

  private get after(): number {
    return this.afterOverride ?? this.afterMs;
  }

  // How long until it would sleep, in seconds, with the TV off.
  status(): { tv_off_s: number | null; due_in_s: number | null } {
    if (this.offSince === null) return { tv_off_s: null, due_in_s: null };
    const now = this.now();
    const due = Math.max(this.offSince, this.awakeSince) + this.after;
    return { tv_off_s: Math.round((now - this.offSince) / 1000), due_in_s: Math.max(0, Math.round((due - now) / 1000)) };
  }

  async tick(): Promise<void> {
    // Awake again: the wall clock moved on while the monotonic one stood.
    // Between two looks they drift apart by far less than a second, so 10 s
    // is a sleep, even one cut short by the power button.
    const offset = this.now() - this.monotonic();
    const jumped = offset - this.offset;
    this.offset = offset;
    // Or the kernel counted a suspend since the last look, on a box whose
    // clocks ran through it.
    const count = (await this.platform.suspended?.().catch(() => null)) ?? null;
    const counted = count !== null && this.suspended !== null && count > this.suspended;
    if (count !== null) this.suspended = count;
    if (jumped > 10_000 || counted) {
      this.awakeSince = this.now();
      this.heldSaid = "";
      this.asked = false;
      this.alarmStuck = false;
      this.log(`the box woke from sleep${jumped > 10_000 ? `, ${Math.round(jumped / 1000)} s later` : ""}`);
      this.woke?.();
    }
    if (this.busy) return;
    this.busy = true;
    try {
      // Awake, so no wake alarm.
      if (this.alarm !== false && !this.asked && !this.alarmStuck) await this.setAlarm(false);
      if (this.offSince === null) return;
      const now = this.now();
      if (now < this.retryAt) return;
      if (now - this.offSince < this.after || now - this.awakeSince < this.after) return;
      const settings = await this.platform.settings().catch(() => ({ sleep: false, overnight: false }));
      if (!settings.sleep) return;
      const held = await this.platform.inhibitors().catch(() => [{ who: "logind", why: "it didn't answer" }]);
      if (held.length > 0) {
        const said = held.map((one) => `${one.who} (${one.why})`).join(", ");
        if (said !== this.heldSaid) this.log(`not sleeping yet: ${said}`);
        this.heldSaid = said;
        return;
      }
      this.heldSaid = "";
      // The night's update still installs: the box wakes for its window.
      if (settings.overnight || this.alarm !== false) await this.setAlarm(settings.overnight);
      if (this.offSince === null) return;
      this.log(`sleeping: the TV's been off for ${Math.round((this.now() - this.offSince) / 60_000)} min${settings.overnight ? ", with a wake alarm for the night's update" : ""}`);
      if (await this.platform.suspend().catch(() => false)) {
        this.asked = true;
      } else {
        this.log("logind wouldn't suspend the box; trying again in 10 min");
        this.retryAt = this.now() + 10 * 60_000;
      }
    } finally {
      this.busy = false;
    }
  }

  // Sets the wake alarm or clears it, and says so when it can't.
  private async setAlarm(on: boolean): Promise<void> {
    if (await this.platform.wakeAlarm(on).catch(() => false)) {
      this.alarm = on;
      this.alarmStuck = false;
      return;
    }
    // Whether it's on now is anyone's guess.
    this.alarm = null;
    this.alarmStuck = !on;
    this.log(on ? "no wake alarm for the night's update" : "the wake alarm didn't clear");
  }
}

const LOGIND = ["org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager"];

function run(command: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000 }, (error, stdout) => resolve({ ok: !error, out: String(stdout) }));
  });
}

// Which of logind's inhibitors block sleep, from its ListInhibitors: each
// is what, who, why, mode, uid and pid.
export function blocking(json: string): { who: string; why: string }[] {
  try {
    const rows = (JSON.parse(json)?.data?.[0] ?? []) as [string, string, string, string, number, number][];
    return rows.filter(([what, , , mode]) => mode === "block" && what.split(":").includes("sleep")).map(([, who, why]) => ({ who, why }));
  } catch {
    return [{ who: "logind", why: "its answer didn't read" }];
  }
}

// The box's own: logind over busctl, and the wake alarm's timer through
// systemctl. polkit lets the box's owner suspend and start or stop the timer
// from the TV session (system/polkit/50-agentv-sleep.rules), but never past
// an inhibitor.
export function logindSleep(settings: () => Promise<{ sleep: boolean; overnight: boolean }>): SleepPlatform {
  return {
    settings,
    async inhibitors() {
      const answer = await run("busctl", ["--json=short", "call", ...LOGIND, "ListInhibitors"]);
      if (!answer.ok) throw new Error("logind didn't list its inhibitors");
      return blocking(answer.out);
    },
    async wakeAlarm(on) {
      return (await run("systemctl", [on ? "start" : "stop", "agentv-wake.timer"])).ok;
    },
    async suspend() {
      return (await run("busctl", ["call", ...LOGIND, "Suspend", "b", "false"])).ok;
    },
    async suspended() {
      const count = Number.parseInt(await readFile("/sys/power/suspend_stats/success", "utf8"), 10);
      return Number.isFinite(count) ? count : null;
    },
  };
}
