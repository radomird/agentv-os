// AgenTV's app contract, version 1 (PHASE-1-PLAN.md, "App contract"). Every
// TV app is a TypeScript module that the daemon loads in a worker of its own.
// Its default export is a TvApp. A web app gets one page in the services'
// Chromium, limited to the origins its manifest declares; a native app gets
// none.
//
// Apps import these types with `import type`, which Node strips, so an app
// never loads anything from outside its own folder.

import type { Page } from "playwright-core";

export type ItemKind = "film" | "series" | "episode" | "track" | "album" | "playlist" | "photo-album" | "game";

export interface Item {
  id: string; // app-local id
  kind: ItemKind;
  title: string;
  season?: number;
  episode?: number;
  subtitle?: string; // artist, year, album owner
  poster?: string; // 2:3 artwork URL; falls back to TMDB by title (ADR-014)
  still?: string; // 16:9 episode still URL, used by Continue
}

export interface PlaybackState {
  title: string; // series or film title as the site shows it
  season?: number; // absent for films
  episode?: number;
  position: number; // seconds, from <video>.currentTime
  duration: number; // seconds, from <video>.duration
  playing: boolean;
}

export type TileSize = "s" | "m" | "l"; // 1×1, 2×1, 2×2 (ADR-016)

export interface TileEntry {
  label?: string; // "thu", "continue", a track name
  value?: string; // "18°", "S2 E4"
  caption?: string; // "l 10°", "6 min left"
  icon?: string; // a name from the launcher's pixel set: 'rain', 'wind', 'play', ...
  image?: string; // poster or still URL, from the app's origins or TMDB
  item?: Item; // choosing the entry opens it through playback.open
}

export interface Tile {
  headline?: TileEntry; // drawn large: the weather now, the show to continue
  entries?: TileEntry[]; // the launcher fits as many as the size allows, in order
  refreshMins?: number; // 5 at least, 30 by default
}

// A web app's page in the services' Chromium: these of Playwright's Page,
// and nothing else. Each call goes through the worker's loader, which holds
// it to the app's declared origins, so a page that's moved off them answers
// nothing. evaluate() takes a function, which runs in the page with its one
// argument, or an expression; what it returns comes back as JSON.
export type AppPage = Pick<Page, "url" | "title" | "goto" | "evaluate" | "waitForSelector" | "click" | "fill" | "press">;

export interface AppContext {
  page?: AppPage; // web apps: one page, declared origins only
  settings: Record<string, string>; // values from the manifest's setup fields
  viewer: { id: string; role: "adult" | "kid" };
}

export interface TvApp {
  id: string;

  /** Open the home URL or start the native window. */
  launch(ctx: AppContext): Promise<void>;

  /** Stage A. False puts "Sign in" on the tile. */
  signIn?: { isSignedIn(ctx: AppContext): Promise<boolean> };

  /** "Play X" across kinds (ADR-013). */
  search?(ctx: AppContext, query: string): Promise<Item[]>;

  playback?: {
    /** Find and start an item. Resolves when it is playing. */
    open(ctx: AppContext, item: Item): Promise<void>;
    /** Read from URL + DOM + <video>; never from pixels. Null when nothing is playing. */
    readPlaybackState(ctx: AppContext): Promise<PlaybackState | null>;
    /** The site's own "next episode" control, used by the continue executor. */
    next?(ctx: AppContext): Promise<void>;
  };

  /** Kids (ADR-009): list the service's profiles once, then open the mapped one for kid viewers. */
  profiles?: {
    list(ctx: AppContext): Promise<string[]>;
    select(ctx: AppContext, name: string): Promise<void>;
  };

  /** Music: what is playing now, for the home rail. */
  nowPlaying?(ctx: AppContext): Promise<{ title: string; subtitle?: string; playing: boolean } | null>;

  /** Content for each size the manifest lists (ADR-016). Answers within 3 s. No headline for 's' keeps the logo. */
  tile?(ctx: AppContext, size: TileSize): Promise<Tile>;
}
