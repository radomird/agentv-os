// The household's TMDB key (stage 8): what's new and new episodes need one,
// and only someone with a TMDB account can make it, so each household
// brings its own and no key ships in any repo. It's given on the TV, with
// the phone's keyboard, and the daemon hands it to root the way it does the
// provider's key (daemon/key.ts): a drop in its own state, which
// agentv-key.path moves into /etc/agentv/env, and it never comes back out.
// /etc/agentv/tmdb.json says whether there's one.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The same shape agentv-key-store takes: the API key, 32 hex digits, or the
// API read access token.
const KEY = /^[A-Za-z0-9_.:-]{20,300}$/;

export interface TmdbKeyStatus {
  set: boolean;
  at?: string;
  error?: string;
}

export interface TmdbKeyOptions {
  state: string; // the daemon's own state: the drop goes in <state>/key-drop
  status?: string; // /etc/agentv/tmdb.json
  waitMs?: number; // how long the move as root may take
}

export class TmdbKey {
  private drop: string;
  private statusPath: string;
  private waitMs: number;

  constructor(options: TmdbKeyOptions) {
    this.drop = join(options.state, "key-drop", "tmdb.json");
    this.statusPath = options.status ?? "/etc/agentv/tmdb.json";
    this.waitMs = options.waitMs ?? 10_000;
  }

  status(): TmdbKeyStatus {
    try {
      const data = JSON.parse(readFileSync(this.statusPath, "utf8"));
      return { set: data.set === true, ...(typeof data.at === "string" ? { at: data.at } : {}), ...(typeof data.error === "string" ? { error: data.error } : {}) };
    } catch {
      return { set: false };
    }
  }

  check(key: unknown): string | null {
    return key === null || (typeof key === "string" && KEY.test(key.trim())) ? null : "that doesn't look like a tmdb key";
  }

  // Hands a key over, or with null takes it off. Null once root has it, or
  // why not.
  async store(key: unknown): Promise<string | null> {
    const wrong = this.check(key);
    if (wrong) return wrong;
    const before = this.status().at;
    mkdirSync(dirname(this.drop), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.drop}.next`, JSON.stringify({ key: key === null ? null : (key as string).trim() }), { mode: 0o600 });
    renameSync(`${this.drop}.next`, this.drop);
    const until = Date.now() + this.waitMs;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const now = this.status();
      if (now.at !== before) return now.error ?? null;
    }
    rmSync(this.drop, { force: true });
    return "Couldn't save the key. Restart your TV and try again.";
  }
}
