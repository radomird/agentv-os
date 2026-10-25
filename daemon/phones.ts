// Paired phones (ADR-007, ADR-008, stage 4): the TV shows a one-time code,
// as a QR code with the address of the box's phone companion, and a phone
// that sends it back gets a token of its own. Every request from the phone
// carries it. Only a hash of each token is kept, in the daemon's own state,
// and Settings → Phones forgets a phone.
//
// A code lasts 10 minutes and pairs one phone. Five wrong tries end it, so
// the TV has to show a new one.

import { createHash, randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// No 0 and O, or 1, I and L, which look alike on a TV.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
export const CODE_MS = 10 * 60_000;
const CODE_TRIES = 5;
const NAME_MAX = 30;

export interface Phone {
  id: string;
  name: string;
  pairedAt: string;
  seenAt?: string;
}

interface Stored extends Phone {
  token: string; // sha256 of the token, in hex
}

export interface PhonesOptions {
  path: string; // <state>/phones.json
  now?: () => number;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class Phones {
  private path: string;
  private now: () => number;
  private pending: { code: string; until: number; tries: number } | null = null;
  private seen = new Map<string, string>();

  constructor(options: PhonesOptions) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
  }

  private read(): Stored[] {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(data?.phones) ? data.phones : [];
    } catch {
      return [];
    }
  }

  private write(phones: Stored[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.next`, `${JSON.stringify({ phones }, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${this.path}.next`, this.path);
  }

  list(): Phone[] {
    return this.read().map(({ token: _token, ...phone }) => ({ ...phone, seenAt: this.seen.get(phone.id) ?? phone.seenAt }));
  }

  // A new code for the TV to show, in place of any before it.
  code(): { code: string; until: string } {
    const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    this.pending = { code, until: this.now() + CODE_MS, tries: 0 };
    return { code, until: new Date(this.pending.until).toISOString() };
  }

  // The code being shown, while it lasts.
  showing(): { code: string; until: string } | null {
    if (!this.pending || this.pending.until <= this.now()) return null;
    return { code: this.pending.code, until: new Date(this.pending.until).toISOString() };
  }

  // A phone sending the TV's code back: its token, which it keeps.
  pair(code: unknown, name: unknown): { token: string; phone: Phone } | { error: string } {
    const pending = this.pending;
    if (!pending || pending.until <= this.now()) return { error: "that code has run out: pair again from the tv" };
    if (typeof code !== "string" || code.replace(/[\s-]/g, "").toUpperCase() !== pending.code) {
      pending.tries++;
      if (pending.tries >= CODE_TRIES) this.pending = null;
      return { error: "that isn't the code on the tv" };
    }
    this.pending = null;
    const token = randomBytes(32).toString("base64url");
    const label = typeof name === "string" && name.trim() ? name.trim().slice(0, NAME_MAX) : "a phone";
    const phone: Phone = { id: `p-${randomBytes(4).toString("hex")}`, name: label, pairedAt: new Date(this.now()).toISOString() };
    this.write([...this.read(), { ...phone, token: hash(token) }]);
    return { token, phone };
  }

  // The phone a token belongs to, or null.
  who(token: unknown): Phone | null {
    if (typeof token !== "string" || token.length < 20) return null;
    const found = this.read().find((phone) => phone.token === hash(token));
    if (!found) return null;
    this.seen.set(found.id, new Date(this.now()).toISOString());
    const { token: _token, ...phone } = found;
    return phone;
  }

  forget(id: string): boolean {
    const phones = this.read();
    const kept = phones.filter((phone) => phone.id !== id);
    if (kept.length === phones.length) return false;
    this.write(kept);
    return true;
  }
}
