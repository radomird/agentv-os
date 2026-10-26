// The launcher's two neighbours: AgenTV's daemon over HTTP on this box, and
// the screen daemon in the TV session, which put the launcher on screen and
// answers it over the DevTools pipe it holds (window.agentvScreen). Outside
// the TV session, on a computer or in the tests, there's no screen daemon.

import type { Placed, Size } from "./layout.ts";

export interface SizeChoice {
  size: Size;
  label: string;
}

export interface App {
  id: string;
  name: string;
  version: string;
  tier: string;
  maker: string;
  owner?: string;
  description: string;
  category: string;
  runtime: string;
  icon?: string;
  sizes: SizeChoice[];
  reach: string[];
  needsSetup: boolean;
  signIn?: "needed"; // its service wants a sign-in (ADR-032)
  credit?: string;
  forChildren: boolean; // a child's profile can open it (ADR-009)
}

// An app's own setup, from its tile: its fields, such as a server's
// address, and whether a sign-in comes after them.
export interface AppSetup {
  id: string;
  name: string;
  fields: { key: string; label: string; value: string; address: boolean }[];
  signIn: boolean;
}

// Someone who watches (ADR-009): an avatar is a colour from the theme.
export interface Viewer {
  id: string;
  name: string;
  role: "adult" | "child";
  avatar: string;
  // An adult's profile that asks for the PIN to open (ADR-034).
  locked: boolean;
}

export interface Settings {
  sound: { on: boolean; volume: number };
  reduceMotion: boolean;
  idleMinutes: number;
  // Install tested updates between 02:00 and 05:00 without asking (Q79).
  updateOvernight: boolean;
}

export interface HomeState {
  version: string;
  channel: string;
  viewer: Viewer;
  viewers: Viewer[];
  apps: App[];
  appsTile: string;
  layout: Placed[];
  settings: Settings;
  // Whether there's an adult PIN, and whether the TV is locked (ADR-009).
  pin: { set: boolean; locked: boolean };
}

// What the daily update check found (bin/agentv-update-check, ADR-025).
export interface UpdateStatus {
  checked_at: string;
  ok: boolean;
  channel: string;
  agentv: { installed: string | null; available: string | null };
  omarchy: { installed: string | null; available: string | null };
  packages: number;
  // Off edge, the update waits until AgenTV's nightly run has passed it
  // (ADR-026), so there's nothing to install yet.
  waiting?: boolean;
  security: boolean;
  notes: { agentv: string[]; agentv_date: string | null; omarchy: string[] };
}

// How an install from the TV is going (bin/agentv-update-tv), or going back
// from one (bin/agentv-go-back).
export interface UpdateProgress {
  state: "running" | "restarting" | "done" | "failed" | "going-back";
  what?: "go-back";
  step: "start" | "snapshot" | "packages" | "migrations" | "restart";
  percent: number;
  detail: string;
  at: string;
  from: { agentv: string; omarchy: string };
  to: { agentv: string };
}

// The check after an update (bin/agentv-update-after).
export interface AfterCheck {
  at: string;
  ok: boolean;
  agentv: string;
  checks: { name: string; ok: boolean; detail: string }[];
}

// The snapshot Go back returns to, and the versions on either side of it.
export interface GoBack {
  snapshot: number;
  at: string;
  from: { agentv: string; omarchy: string };
  to: { agentv: string; omarchy: string };
}

export interface Updates {
  status: UpdateStatus | null;
  progress: UpdateProgress | null;
  toasted: string | null;
  after?: AfterCheck | null;
  goBack?: GoBack | null;
  wentBack?: { at: string; from: { agentv: string }; to: { agentv: string } } | null;
  seen?: { kept: string | null; wentBack: string | null; later?: string | null };
  // Tonight was chosen, for this release ("packages" when it's only those).
  tonight?: { version: string; at: string } | null;
}

// An item to open, as the contract's Item has it.
export interface Item {
  id: string;
  kind: string;
  title: string;
  season?: number;
  episode?: number;
}

export interface TileEntry {
  label?: string;
  value?: string;
  caption?: string;
  icon?: string;
  image?: string;
  item?: Item;
  // How far in, from 0 to 1: only the continue tile the daemon draws from
  // the ledger has it (ADR-016).
  progress?: number;
}

// Settings → AI: which provider has a key.
export interface KeyState {
  set: boolean;
  provider: string | null;
}

// Settings → Weather: the forecast's city, and the cities it can be.
export interface WeatherPlace {
  zone: string;
  name: string;
  units: "c" | "f";
  chosen: boolean;
  cities: { zone: string; name: string }[];
}

// Settings → Sound: the box's sound outputs, the one playing, and its volume
// (S2.19), from the screen daemon.
export interface AudioOutput {
  name: string;
  description: string;
  hdmi: boolean;
  connected: boolean | null;
}

export interface AudioState {
  ok: boolean;
  error?: string;
  output?: string | null;
  outputs?: AudioOutput[];
  volume?: number | null;
}

export interface TileData {
  headline?: TileEntry;
  entries?: TileEntry[];
}

// A request to the daemon. A guarded one sends the grant the PIN gave.
async function call<T>(method: string, path: string, body?: unknown, grant?: string): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error ?? `${method} ${path} failed`);
  return data as T;
}

// The backgrounds (ADR-012, board 13): the TV's pixel field, or the
// household's photos, each with who to thank for it.
export interface Background {
  id: string;
  type: string;
  credit: { text: string | null; from: string };
  added: string;
}

export interface Backgrounds {
  source: "field" | "photos";
  current: string | null;
  items: Background[];
}

// What the ambient screen says under a picture.
export function creditLine(item: Background): string {
  return item.credit.text ?? `photo · ${item.credit.from}`;
}

// One of Omarchy's themes setup and Settings offer (board 12), with the
// colours its preview draws.
export interface ThemePreview {
  id: string;
  name: string;
  note: string;
  mode: "light" | "dark";
  colors: { background: string; dark_background: string; accent: string; selection: string; foreground: string; bright_foreground: string };
}

export const daemon = {
  home: () => call<HomeState>("GET", "/api/home"),
  saveLayout: (layout: Placed[], grant?: string) => call<{ layout: Placed[] }>("PUT", "/api/layout", { layout }, grant),
  saveSettings: (change: Partial<Settings>, grant?: string) => call<{ settings: Settings }>("POST", "/api/settings", change, grant),
  tile: async (id: string, size: Size) => (await call<{ tile: TileData | null }>("GET", `/api/tile/${id}/${size}`)).tile,
  updates: () => call<Updates>("GET", "/api/updates"),
  toasted: (version: string) => call<{ ok: boolean }>("POST", "/api/updates/toasted", { version }),
  seen: (change: { kept?: string; wentBack?: string; later?: string }) => call<{ ok: boolean }>("POST", "/api/updates/seen", change),
  tonight: (version: string | null, grant?: string) => call<{ ok: boolean }>("POST", "/api/updates/tonight", { version }, grant),
  backgrounds: () => call<Backgrounds>("GET", "/api/backgrounds"),
  chooseBackground: (source: Backgrounds["source"], current?: string) => call<Backgrounds>("POST", "/api/backgrounds", { source, current }),
  // The looks setup and Settings → Look offer, and which one the TV has.
  themes: () => call<{ themes: ThemePreview[]; current: string | null }>("GET", "/api/themes"),
  weather: () => call<WeatherPlace>("GET", "/api/weather"),
  saveWeather: (change: { zone?: string | null; units?: "c" | "f" | null }, grant?: string) => call<WeatherPlace>("POST", "/api/weather", change, grant),
  // Profiles (ADR-009, S4.2).
  switchViewer: (id: string, grant?: string) => call<{ viewer: Viewer }>("POST", "/api/viewer", { id }, grant),
  addViewer: (profile: Omit<Viewer, "id" | "locked"> & { locked?: boolean }, grant?: string) => call<{ profile: Viewer }>("POST", "/api/viewers", profile, grant),
  editViewer: (id: string, change: Partial<Omit<Viewer, "id">>, grant?: string) => call<{ profile: Viewer }>("PUT", `/api/viewers/${id}`, change, grant),
  removeViewer: (id: string, grant?: string) => call<{ viewers: Viewer[] }>("DELETE", `/api/viewers/${id}`, undefined, grant),
  // The provider key (S4.6): which provider has one, never the key.
  key: () => call<KeyState>("GET", "/api/key"),
  saveKey: (provider: string, key: string, grant?: string) => call<KeyState>("PUT", "/api/key", { provider, key }, grant),
  removeKey: (grant?: string) => call<KeyState>("DELETE", "/api/key", undefined, grant),
  forChildren: (app: string, allowed: boolean, grant?: string) => call<{ ok: boolean }>("POST", `/api/apps/${app}/for-children`, { allowed }, grant),
  appSetup: (app: string) => call<{ setup: AppSetup }>("GET", `/api/apps/${app}/setup`).then((r) => r.setup),
  saveAppSetup: (app: string, values: Record<string, string>, grant?: string) => call<{ setup: AppSetup }>("POST", `/api/apps/${app}/setup`, { values }, grant).then((r) => r.setup),
  // The adult PIN (ADR-009, S4.5).
  checkPin: (pin: string) => call<{ grant: string; until: string }>("POST", "/api/pin/check", { pin }),
  setPin: (pin: string, grant?: string) => call<{ set: boolean }>("PUT", "/api/pin", { pin }, grant),
  removePin: (grant?: string) => call<{ set: boolean }>("DELETE", "/api/pin", undefined, grant),
  lock: () => call<{ locked: boolean }>("POST", "/api/pin/lock"),
  image: (app: string, url: string) => `/api/image?app=${encodeURIComponent(app)}&url=${encodeURIComponent(url)}`,
};

// Things that changed, as the daemon tells them. opened runs each time the
// stream opens: the first time, a moment after the page asked for what it
// shows, and again after a drop, such as the daemon restarting. Whatever
// changed in between came with no event the page heard.
export function listen(handlers: Record<string, (data: unknown) => void>, opened?: () => void): void {
  const source = new EventSource("/api/events");
  for (const [event, handler] of Object.entries(handlers)) {
    source.addEventListener(event, (message) => handler(JSON.parse((message as MessageEvent).data)));
  }
  if (opened) source.addEventListener("open", () => opened());
}

// --- The screen daemon ------------------------------------------------------

type Binding = (request: string) => void;
interface ScreenWindow {
  agentvScreen?: Binding;
  agentvScreenReply?: (id: number, reply: string) => void;
}

export interface Running {
  id: string;
  game: boolean;
  paused: boolean;
}

interface Reply {
  ok: boolean;
  error?: string;
  apps?: Running[];
  [key: string]: unknown;
}

const waiting = new Map<number, (reply: Reply) => void>();
let next = 0;
(window as ScreenWindow).agentvScreenReply = (id, reply) => {
  waiting.get(id)?.(JSON.parse(reply));
  waiting.delete(id);
};

function ask(request: Record<string, unknown>, ms = 30_000): Promise<Reply> {
  const binding = (window as ScreenWindow).agentvScreen;
  if (!binding) return Promise.resolve({ ok: false, error: "that works on the TV" });
  const id = ++next;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    binding(JSON.stringify({ ...request, id }));
    setTimeout(() => {
      if (waiting.delete(id)) resolve({ ok: false, error: "the TV didn't answer" });
    }, ms);
  });
}

export const screen = {
  // Puts an app in front, the way its manifest says to open it, or brings
  // it back where it was when it's open behind home.
  open: (app: string) => ask({ cmd: "open-app", app }),
  // Opens an app at an item, through its playback.open: an entry of its
  // tile, such as one to continue (ADR-016).
  openItem: (app: string, item: Item) => ask({ cmd: "open-app", app, item }),
  // The apps open behind home, and whether Home paused them.
  running: async () => (await ask({ cmd: "running" })).apps ?? [],
  // Closes an app open behind home, such as a game still running.
  quit: (app: string) => ask({ cmd: "quit", app }),
  // A key on the ambient screen: back to what was in front.
  wake: () => ask({ cmd: "wake" }),
  // Settings → Updates: Check now and Install now.
  checkUpdates: () => ask({ cmd: "update-check" }),
  // Each adult action sends the grant the PIN gave (ADR-009, S4.5).
  installUpdate: (grant: string) => ask({ cmd: "update-install", grant }),
  // Go back to the version from before the last update.
  goBack: (grant: string) => ask({ cmd: "update-go-back", grant }),
  // Settings → Omarchy desktop: a log-out to it.
  desktop: (grant: string) => ask({ cmd: "desktop", grant }),
  // Settings → Power, after its question, and Shut down after its countdown
  // (ADR-033): Omarchy's own restart or shut down.
  power: (what: "restart" | "shutdown", grant: string) => ask({ cmd: "power", what, grant }),
  // AgenTV's sign-in screen for an app whose tile says Sign in (ADR-032).
  signIn: (app: string) => ask({ cmd: "sign-in", app }),
  // The built-in Music app's library and player, in the TV session (ADR-017).
  // Mounting a share can wait on a slow NAS, and on root for one with a
  // password, so it gets longer.
  music: (op: string, args: Record<string, unknown> = {}) => ask({ cmd: "music", op, ...args }, op === "add-share" ? 60_000 : 30_000),
  // Setup's AI step: the provider's agent CLI, fetched on its first run once
  // an adult accepted its terms (ADR-023).
  cliInstall: () => ask({ cmd: "cli-install" }),
  // Sets one of Omarchy's themes, as its desktop does (board 12). Omarchy
  // takes a few seconds; the colours arrive as a theme event.
  setTheme: (theme: string) => ask({ cmd: "theme-set", theme }, 90_000),
  // Settings → Sound: the outputs and the volume, or another output or level
  // from now on (S2.19).
  audio: async (change: { output?: string; volume?: number } = {}) => (await ask({ cmd: "audio", ...change })) as AudioState,
};
