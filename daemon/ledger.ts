// The ledger (PHASE-1-PLAN.md, "App contract"; Q3): what each viewer watched
// and listened to on this box, from what the box itself launched, one row
// per title (or episode) with where it got to. Kept in SQLite, in the
// daemon's own state folder. "Continue" and the free continue tile read the
// newest rows (ADR-016).
//
// While an app with playback is open, the screen daemon reads its playback
// state every 10 s and hands it here. The same title, season and episode
// again moves its row on; anything else is a new row.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ItemKind, PlaybackState } from "../apps/contract/contract.ts";

export interface LedgerViewer {
  id: string;
  name: string;
  role: "adult" | "kid";
  avatar?: string;
}

export interface WatchRow {
  // Set on a row that's new, not moved on, by record().
  inserted?: boolean;
  id: number;
  viewer_id: string;
  app_id: string;
  kind: ItemKind;
  title: string;
  season: number | null;
  episode: number | null;
  position_s: number | null;
  duration_s: number | null;
  started_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS viewer (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('adult', 'kid')),
  avatar TEXT
);
CREATE TABLE IF NOT EXISTS watch (
  id INTEGER PRIMARY KEY,
  viewer_id TEXT NOT NULL REFERENCES viewer(id),
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  season INTEGER, episode INTEGER,
  position_s INTEGER, duration_s INTEGER,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS watch_recent ON watch(viewer_id, updated_at DESC);
`;

const KINDS: ItemKind[] = ["film", "series", "episode", "track", "album", "playlist", "photo-album", "game"];
const TITLE_MAX = 300;

// Why a playback state from an app can't go in the ledger, or null.
export function badState(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return "a playback state is an object";
  const s = state as Record<string, unknown>;
  if (typeof s.title !== "string" || !s.title.trim() || s.title.length > TITLE_MAX) return `a title of up to ${TITLE_MAX} characters`;
  for (const key of ["season", "episode"]) {
    if (s[key] !== undefined && s[key] !== null && !(Number.isInteger(s[key]) && (s[key] as number) >= 0)) return `${key} is a whole number`;
  }
  if (typeof s.position !== "number" || !(s.position >= 0)) return "position is a number of seconds";
  // A live stream has no duration: NaN in the page, null once it's JSON.
  if (s.duration !== null && (typeof s.duration !== "number" || s.duration < 0)) return "duration is a number of seconds";
  if (typeof s.playing !== "boolean") return "playing is true or false";
  return null;
}

// What kind of thing a playback state is: an episode when it has a season or
// an episode, else by what the app is for.
export function kindOf(state: PlaybackState, category: string): ItemKind {
  if (state.season !== undefined || state.episode !== undefined) return "episode";
  if (category === "music") return "track";
  if (category === "games") return "game";
  if (category === "photos") return "photo-album";
  return "film";
}

export class Ledger {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  // Adds or updates a viewer. Until profiles come (stage 4) that's the box's
  // own person, an adult.
  viewer(viewer: LedgerViewer): void {
    this.db
      .prepare("INSERT INTO viewer (id, name, role, avatar) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, avatar = excluded.avatar")
      .run(viewer.id, viewer.name, viewer.role, viewer.avatar ?? null);
  }

  viewers(): LedgerViewer[] {
    return (this.db.prepare("SELECT id, name, role, avatar FROM viewer ORDER BY id").all() as unknown as LedgerViewer[]).map((v) => ({
      ...v,
      avatar: v.avatar ?? undefined,
    }));
  }

  // Where a viewer got to in an app: the same title, season and episode as
  // the app's newest row moves that row on, anything else starts a new one.
  record(viewer: string, app: string, kind: ItemKind, state: PlaybackState, at = new Date()): WatchRow {
    if (!KINDS.includes(kind)) throw new Error(`'${kind}' isn't a kind of item`);
    const why = badState(state);
    if (why) throw new Error(why);
    const now = at.toISOString();
    const season = state.season ?? null;
    const episode = state.episode ?? null;
    const position = Math.round(state.position);
    const duration = typeof state.duration === "number" && Number.isFinite(state.duration) ? Math.round(state.duration) : null;
    const last = this.db
      .prepare("SELECT * FROM watch WHERE viewer_id = ? AND app_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1")
      .get(viewer, app) as unknown as WatchRow | undefined;
    if (last && last.title === state.title && last.season === season && last.episode === episode) {
      this.db.prepare("UPDATE watch SET kind = ?, position_s = ?, duration_s = ?, updated_at = ? WHERE id = ?").run(kind, position, duration, now, last.id);
      return { ...last, kind, position_s: position, duration_s: duration, updated_at: now, inserted: false };
    }
    const result = this.db
      .prepare(
        "INSERT INTO watch (viewer_id, app_id, kind, title, season, episode, position_s, duration_s, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(viewer, app, kind, state.title, season, episode, position, duration, now, now);
    return { ...this.row(Number(result.lastInsertRowid))!, inserted: true };
  }

  private row(id: number): WatchRow | null {
    return (this.db.prepare("SELECT * FROM watch WHERE id = ?").get(id) as unknown as WatchRow | undefined) ?? null;
  }

  // A viewer's rows, newest first, in one app or across them, of some kinds
  // or of any.
  recent(viewer: string, options: { app?: string; kinds?: ItemKind[]; limit?: number } = {}): WatchRow[] {
    const where = ["viewer_id = ?"];
    const values: (string | number)[] = [viewer];
    if (options.app) {
      where.push("app_id = ?");
      values.push(options.app);
    }
    if (options.kinds?.length) {
      where.push(`kind IN (${options.kinds.map(() => "?").join(", ")})`);
      values.push(...options.kinds);
    }
    values.push(Math.max(1, Math.min(100, options.limit ?? 10)));
    return this.db
      .prepare(`SELECT * FROM watch WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...values) as unknown as WatchRow[];
  }

  // Drops every row of an app, for one that's gone from the box, such as
  // agentv selftest's stand-in. Says how many went.
  forget(app: string): number {
    return Number(this.db.prepare("DELETE FROM watch WHERE app_id = ?").run(app).changes);
  }

  close(): void {
    this.db.close();
  }
}
