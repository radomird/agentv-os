// Paired phones (ADR-007, ADR-008, stage 4): the TV shows a one-time code,
// and a QR code with the address of the box's phone companion and a longer
// secret. A phone proves it has one of the two without sending it, and the
// phone and the box agree on a key of the phone's own (see
// daemon/phone-channel.ts), which signs and seals what the phone sends from
// then on. The keys are kept in the daemon's own state, in a file only it
// reads, and Settings → Phones forgets a phone.
//
// A code lasts 10 minutes and pairs one phone. Five wrong tries end it, so
// the TV has to show a new one.

import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { b64u, hmac, INFO, phoneKey, same, unb64u, x25519Pair, x25519Shared } from "./phone-channel.ts";

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
  key: string; // the phone's key, 32 bytes in base64
}

// What a phone sends to pair: its one-time public key, and proof that it
// has the QR code's secret or the code on the TV.
export interface PairRequest {
  key?: unknown;
  name?: unknown;
  proof?: unknown;
}

// What the box answers: the phone's id, the box's one-time public key, and
// proof that the box came to the same key.
export interface Paired {
  id: string;
  key: string;
  confirm: string;
  phone: Phone;
}

export interface PhonesOptions {
  path: string; // <state>/phones.json
  now?: () => number;
}

const usable = (phone: Stored) => typeof phone?.id === "string" && typeof phone.key === "string" && Buffer.from(phone.key, "base64").length === 32;

export class Phones {
  private path: string;
  private now: () => number;
  private pending: { code: string; secret: Buffer; until: number; tries: number } | null = null;
  private seen = new Map<string, string>();

  constructor(options: PhonesOptions) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
  }

  private read(): Stored[] {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      const phones: Stored[] = Array.isArray(data?.phones) ? data.phones : [];
      // A phone paired before phones had keys has only a token's hash here.
      // Nothing takes a token any more, so it goes, and that phone pairs
      // again.
      const kept = phones.filter(usable);
      if (kept.length !== phones.length) this.write(kept);
      return kept;
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
    return this.read().map(({ key: _key, ...phone }) => ({ ...phone, seenAt: this.seen.get(phone.id) ?? phone.seenAt }));
  }

  // A new code for the TV to show, in place of any before it.
  code(): { code: string; until: string } {
    const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    this.pending = { code, secret: randomBytes(16), until: this.now() + CODE_MS, tries: 0 };
    return { code, until: new Date(this.pending.until).toISOString() };
  }

  // The code being shown, while it lasts.
  showing(): { code: string; until: string } | null {
    if (!this.pending || this.pending.until <= this.now()) return null;
    return { code: this.pending.code, until: new Date(this.pending.until).toISOString() };
  }

  // The secret that goes with the code on show, for the QR code only. It
  // rides in the part of the address a browser keeps to itself (after the
  // #), so it's never sent over the network and never on the TV as text.
  secret(): string | null {
    return this.pending && this.pending.until > this.now() ? b64u(this.pending.secret) : null;
  }

  // A phone that scanned the QR code or typed the TV's code: it sends a
  // public key and proof that it has the secret or the code, never either
  // of them. A wrong proof is a wrong try. The answer has the box's public
  // key, and both sides now hold the phone's key without it having crossed
  // the network.
  pair(request: PairRequest | undefined): Paired | { error: string } {
    const pending = this.pending;
    if (!pending || pending.until <= this.now()) return { error: "That code expired. Get a new one on your TV." };
    const wrong = () => {
      pending.tries++;
      if (pending.tries >= CODE_TRIES) this.pending = null;
      return { error: "That's not the code on your TV" };
    };
    const theirs = unb64u(request?.key, 32);
    const proof = unb64u(request?.proof, 32);
    if (!theirs || !proof) return wrong();
    // Both are worked out and compared every time, so how long it takes
    // says nothing about which was tried.
    const bySecret = same(proof, hmac(pending.secret, INFO.pair, theirs));
    const byCode = same(proof, hmac(Buffer.from(pending.code), INFO.pair, theirs));
    if (!bySecret && !byCode) return wrong();
    const ours = x25519Pair();
    const shared = x25519Shared(ours.secret, theirs);
    if (!shared) return wrong();
    const key = phoneKey(shared, bySecret ? pending.secret : Buffer.from(pending.code), theirs, ours.public);
    this.pending = null;
    const name = request?.name;
    const label = (typeof name === "string" && name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, NAME_MAX)) || "a phone";
    const phone: Phone = { id: `p-${randomBytes(4).toString("hex")}`, name: label, pairedAt: new Date(this.now()).toISOString() };
    this.write([...this.read(), { ...phone, key: key.toString("base64") }]);
    return { id: phone.id, key: b64u(ours.public), confirm: b64u(hmac(key, INFO.pairBox, theirs, ours.public)), phone };
  }

  // A paired phone and its key, by its id, or null.
  key(id: unknown): { phone: Phone; key: Buffer } | null {
    if (typeof id !== "string") return null;
    const found = this.read().find((phone) => phone.id === id);
    if (!found) return null;
    const { key, ...phone } = found;
    return { phone, key: Buffer.from(key, "base64") };
  }

  // A request this phone signed just came.
  saw(id: string): void {
    this.seen.set(id, new Date(this.now()).toISOString());
  }

  forget(id: string): boolean {
    const phones = this.read();
    const kept = phones.filter((phone) => phone.id !== id);
    if (kept.length === phones.length) return false;
    this.write(kept);
    return true;
  }
}
