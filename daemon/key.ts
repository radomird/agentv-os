// The provider key (ADR-009, ADR-022, ADR-047, S4.6): an API key for Claude,
// ChatGPT, Gemini, Grok or Muse, given on the TV or the phone. The daemon
// can't write /etc, and shouldn't hold the key, so it leaves it in its own
// private state, where agentv-key.path starts bin/agentv-key-store as root
// to move it into /etc/agentv/env. It waits for that, and the key never comes back out: the
// TV only hears which provider has one, from /etc/agentv/key.json.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OFFERS, PROVIDER_LIST } from "./ai.ts";

// What agentv-key-store takes as a key, so the env file reads it as one.
const KEY = /^[A-Za-z0-9_.:-]{20,300}$/;

export interface KeyStatus {
  set: boolean;
  provider: string | null;
  at?: string;
  error?: string;
}

export interface KeyOptions {
  state: string; // the daemon's own state: the drop goes in <state>/key-drop
  status?: string; // /etc/agentv/key.json
  waitMs?: number; // how long the move as root may take
}

export class ProviderKey {
  private drop: string;
  private statusPath: string;
  private waitMs: number;

  constructor(options: KeyOptions) {
    this.drop = join(options.state, "key-drop", "key.json");
    this.statusPath = options.status ?? "/etc/agentv/key.json";
    this.waitMs = options.waitMs ?? 10_000;
  }

  status(): KeyStatus {
    try {
      const data = JSON.parse(readFileSync(this.statusPath, "utf8"));
      return { set: data.set === true, provider: typeof data.provider === "string" ? data.provider : null, at: data.at, ...(data.error ? { error: data.error } : {}) };
    } catch {
      return { set: false, provider: null };
    }
  }

  // Why a key won't do, before anything happens to it, or null.
  check(provider: unknown, key: unknown): string | null {
    if (provider !== null && (typeof provider !== "string" || !Object.hasOwn(OFFERS, provider))) return PROVIDER_LIST;
    if (provider !== null && (typeof key !== "string" || !KEY.test(key.trim()))) return "that doesn't look like a key";
    return null;
  }

  // Hands a key over, or with no provider takes it off. Null once root has
  // it, or why not.
  async store(provider: unknown, key: unknown): Promise<string | null> {
    const wrong = this.check(provider, key);
    if (wrong) return wrong;
    const before = this.status().at;
    mkdirSync(dirname(this.drop), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.drop}.next`, JSON.stringify(provider === null ? { provider: null } : { provider, key: (key as string).trim() }), { mode: 0o600 });
    renameSync(`${this.drop}.next`, this.drop);
    const until = Date.now() + this.waitMs;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const now = this.status();
      if (now.at !== before) return now.error ?? null;
    }
    // Nothing took it: it doesn't stay here.
    rmSync(this.drop, { force: true });
    return "the key couldn't be kept: agentv-key.path isn't running";
  }
}
