// The parent PIN (ADR-009, S4.5): four digits, and optional until a kid's
// profile needs one. Once it's set, it locks the TV after the box starts and
// after the TV has been off long enough for its apps to close, and it guards
// the adult actions: Omarchy's desktop, Settings → Power, installing an
// update or going back from one, and Settings → Parental itself. AI, the
// spend caps and kids' profiles join them as they're built.
//
// Only a hash is kept, in the daemon's own state, which the box's user
// account can't read. Five wrong tries in a row make it wait 30 seconds, and
// each wrong try after that doubles the wait, up to 15 minutes. The count
// survives a restart.
//
// The right PIN gives a grant: a random token the TV's pages hold for a few
// minutes and send with each guarded request. The daemon checks it, and so
// do the screen daemon and agentv-pin-check before their actions.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FOUR_DIGITS = /^\d{4}$/;
const TRIES = 5;
const WAIT_FIRST_MS = 30_000;
const WAIT_MAX_MS = 15 * 60_000;
// How long a grant lasts: long enough for a visit to Settings.
export const GRANT_MS = 5 * 60_000;

interface Stored {
  // "scrypt:<salt>:<hash>", both in hex.
  hash?: string;
  // Wrong tries in a row, and when the next one may come.
  fails?: number;
  waitUntil?: number;
  // The boot the TV was last unlocked in. Another boot, or the TV off for a
  // while, locks it.
  unlockedBoot?: string;
}

export interface PinStatus {
  set: boolean;
  locked: boolean;
  // Seconds before the next try, after too many wrong ones.
  wait: number;
}

export type Checked = { ok: true; grant: string; until: string } | { ok: false; error: string; wait?: number };

export interface PinOptions {
  path: string; // <state>/pin.json
  bootId?: () => string;
  now?: () => number;
  // Why the PIN has to stay set, such as a kid's profile, or null.
  needed?: () => string | null;
}

function hash(pin: string, salt = randomBytes(16)): string {
  return `scrypt:${salt.toString("hex")}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

function matches(pin: string, stored: string): boolean {
  const [kind, salt, expected] = stored.split(":");
  if (kind !== "scrypt" || !salt || !expected) return false;
  const got = scryptSync(pin, Buffer.from(salt, "hex"), 32);
  const want = Buffer.from(expected, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

function bootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "";
  }
}

export class Pin {
  private path: string;
  private boot: () => string;
  private now: () => number;
  private needed: () => string | null;
  private grants = new Map<string, number>();

  constructor(options: PinOptions) {
    this.path = options.path;
    this.boot = options.bootId ?? bootId;
    this.now = options.now ?? Date.now;
    this.needed = options.needed ?? (() => null);
  }

  private read(): Stored {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  private write(stored: Stored): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.next`, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    renameSync(`${this.path}.next`, this.path);
  }

  private wait(stored: Stored): number {
    return Math.max(0, Math.ceil(((stored.waitUntil ?? 0) - this.now()) / 1000));
  }

  status(): PinStatus {
    const stored = this.read();
    const set = typeof stored.hash === "string";
    return { set, locked: set && stored.unlockedBoot !== this.boot(), wait: set ? this.wait(stored) : 0 };
  }

  // The PIN, from the TV or the phone: a grant for the guarded actions, and
  // the TV unlocked, when it's right.
  check(pin: unknown): Checked {
    const stored = this.read();
    if (!stored.hash) return { ok: false, error: "there's no pin yet" };
    const wait = this.wait(stored);
    if (wait > 0) return { ok: false, error: `too many tries. try again in ${wait} s`, wait };
    if (typeof pin !== "string" || !FOUR_DIGITS.test(pin) || !matches(pin, stored.hash)) {
      const fails = (stored.fails ?? 0) + 1;
      const over = fails - TRIES;
      const waitMs = over >= 0 ? Math.min(WAIT_MAX_MS, WAIT_FIRST_MS * 2 ** over) : 0;
      this.write({ ...stored, fails, waitUntil: waitMs ? this.now() + waitMs : undefined });
      if (waitMs) return { ok: false, error: `that's not the pin. try again in ${waitMs / 1000} s`, wait: waitMs / 1000 };
      const left = TRIES - fails;
      return { ok: false, error: left <= 2 ? `that's not the pin. ${left} more ${left === 1 ? "try" : "tries"} before a wait` : "that's not the pin" };
    }
    this.write({ hash: stored.hash, unlockedBoot: this.boot() });
    return this.grant();
  }

  private grant(): Checked & { ok: true } {
    for (const [token, until] of this.grants) if (until <= this.now()) this.grants.delete(token);
    const token = randomBytes(24).toString("base64url");
    const until = this.now() + GRANT_MS;
    this.grants.set(token, until);
    return { ok: true, grant: token, until: new Date(until).toISOString() };
  }

  // Whether a guarded action may go ahead: always with no PIN set, and with
  // one, only with a grant that hasn't run out.
  allows(grant: unknown): boolean {
    if (!this.read().hash) return true;
    if (typeof grant !== "string") return false;
    const until = this.grants.get(grant);
    return until !== undefined && until > this.now();
  }

  // Sets the PIN, or changes it, which needs a grant from the one before.
  // Null when it's done, or why not.
  set(pin: unknown, grant: unknown): string | null {
    if (typeof pin !== "string" || !FOUR_DIGITS.test(pin)) return "a pin is 4 digits";
    if (!this.allows(grant)) return "that needs the pin";
    this.write({ hash: hash(pin), unlockedBoot: this.boot() });
    return null;
  }

  // Takes the PIN off, with a grant, unless something needs it.
  remove(grant: unknown): string | null {
    if (!this.read().hash) return "there's no pin to remove";
    if (!this.allows(grant)) return "that needs the pin";
    const why = this.needed();
    if (why) return why;
    this.write({});
    this.grants.clear();
    return null;
  }

  // Locks the TV until the PIN is entered, and ends every grant. False with
  // no PIN set.
  lock(): boolean {
    const stored = this.read();
    if (!stored.hash) return false;
    this.grants.clear();
    if (stored.unlockedBoot !== undefined) this.write({ ...stored, unlockedBoot: undefined });
    return true;
  }
}
