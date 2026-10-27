// AgenTV's app kit, contract 2 (ADR-043). A page app is its own HTML, CSS
// and JavaScript, shown full screen in a sandboxed frame on home. It reaches
// the box only through this kit, which the box serves to every page app at
// /_agentv/kit.js and which sets window.agentv. The kit talks to home with
// postMessage, and the daemon checks every call against the app's manifest:
// a call the manifest doesn't declare fails, whatever the page asks.
//
// By default an app gets the remote, a gamepad and the phone, sound (Web
// Audio and <audio> work as they do anywhere), and its own storage with a
// quota. It declares the rest in its manifest's tv block, and each one is
// shown at approval:
// - tv.origins: the internet origins it may reach, and nothing else;
// - tv.media: the box's photos or music, read-only, through the daemon;
// - the tile capability: a tile on home, which the app fills with tile.set;
// - tv.notices: a notice on the TV and the phone.
// Never files, a shell, other apps' data, sign-ins, keys or Settings.

import type { Tile } from "./contract.ts";

// Where the box serves the kit to every page app, on the app's own origin.
export const KIT_PATH = "/_agentv/kit.js";

// What a page app may keep, all of it together, in bytes of JSON.
export const STORAGE_QUOTA = 5 * 1024 * 1024;
// A storage key: up to this many characters.
export const STORAGE_KEY_MAX = 100;
// A notice: up to this many characters, and at most one a minute.
export const NOTICE_MAX = 120;
// How long the TV waits for an answer to Back before it leaves the app.
export const BACK_WAIT_MS = 300;

// The remote, the keyboard and the phone send directions, ok and play.
// A gamepad's d-pad and left stick are directions too, A is ok, B is Back
// (asked through onBack, below), and the rest go by their names. Home is
// never sent: it always goes home.
export type Button = "up" | "down" | "left" | "right" | "ok" | "play" | "x" | "y" | "lb" | "rb" | "lt" | "rt" | "start" | "view";

export interface InputEvent {
  button: Button;
  down: boolean; // pressed, or let go
  source: "remote" | "keyboard" | "phone" | "gamepad";
  pad?: number; // which gamepad, for two players
}

export interface Viewer {
  id: string;
  name: string;
  role: "adult" | "child";
}

// Where the box's photos and music come from: Music → sources (a folder, a
// USB drive or a NAS share), the same ones the TV's own apps read.
export interface MediaSource {
  id: string;
  name: string;
  kind: "folder" | "usb" | "share";
}

export interface Photo {
  id: string;
  name: string; // the file's name
  folder: string; // its folder within the source, "" at the top
  modified: string; // ISO 8601
}

export interface PhotoPage {
  folders: string[]; // the folders directly inside the one asked for
  photos: Photo[];
  total: number; // photos in this folder, of which these are offset to offset + limit
}

export interface Track {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  seconds?: number;
}

export interface Album {
  id: string;
  title: string;
  artist?: string;
  tracks: Track[];
}

// window.agentv, as the kit gives it to a page app.
export interface Kit {
  /** Say the first frame is drawn. Home shows the app from then on. */
  ready(): void;
  /** Leave the app and go back to home. */
  exit(): void;
  /** Who's watching. */
  viewer(): Promise<Viewer>;

  input: {
    /** Every button pressed or let go, from every input. */
    on(listener: (event: InputEvent) => void): void;
  };
  /**
   * Back, from the remote, the keyboard, the phone or a gamepad's B. Return
   * true to keep it, such as closing a photo or pausing a game. Without a
   * listener, or when it returns anything else within 300 ms, the TV leaves
   * the app. Holding Back always goes home.
   */
  onBack(listener: () => boolean | void): void;
  /** Home was pressed and the app is out of sight, or it's back in front. */
  onPause(listener: () => void): void;
  onResume(listener: () => void): void;

  /** The app's own storage, kept across versions, up to STORAGE_QUOTA. */
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };

  /** tv.media includes "photos": the box's photos, read-only. */
  photos: {
    sources(): Promise<MediaSource[]>;
    list(source: string, options?: { folder?: string; offset?: number; limit?: number }): Promise<PhotoPage>;
    /** A blob: address for the photo, scaled down to width when given. */
    url(id: string, options?: { width?: number }): Promise<string>;
  };

  /** tv.media includes "music": the box's music, read-only. */
  music: {
    albums(): Promise<Album[]>;
    /** A blob: address for the track, to play with <audio> or Web Audio. */
    url(id: string): Promise<string>;
  };

  /** The tile capability: what the app's tile on home shows, until it changes. */
  tile: {
    set(tile: Omit<Tile, "refreshMins">): Promise<void>;
  };

  /** tv.notices: a short notice on the TV and the phone. */
  notify(text: string): Promise<void>;
}

// --- How the kit talks to home ------------------------------------------
// Each message carries agentv: 1. The frame sends calls; home answers each
// one by its id, and sends events.

export type Call =
  | "ready"
  | "exit"
  | "viewer"
  | "storage.get"
  | "storage.set"
  | "storage.remove"
  | "storage.keys"
  | "photos.sources"
  | "photos.list"
  | "photos.image"
  | "music.albums"
  | "music.track"
  | "tile.set"
  | "notify";

// What the manifest has to declare for each call. Calls not listed here are
// every page app's.
export const NEEDS: Partial<Record<Call, { media?: "photos" | "music"; capability?: "tile"; notices?: true }>> = {
  "photos.sources": { media: "photos" },
  "photos.list": { media: "photos" },
  "photos.image": { media: "photos" },
  "music.albums": { media: "music" },
  "music.track": { media: "music" },
  "tile.set": { capability: "tile" },
  notify: { notices: true },
};

export type FromApp =
  | { agentv: 1; id: number; call: Call; args: unknown[] }
  | { agentv: 1; back: number; kept: boolean };

export type ToApp =
  | { agentv: 1; id: number; ok: true; value?: unknown }
  | { agentv: 1; id: number; ok: false; error: string }
  | { agentv: 1; event: "input"; input: InputEvent }
  | { agentv: 1; event: "back"; back: number }
  | { agentv: 1; event: "pause" }
  | { agentv: 1; event: "resume" };

// photos.image and music.track answer with the file itself, which the kit
// turns into a blob: address.
export interface Bytes {
  type: string;
  bytes: ArrayBuffer;
}
