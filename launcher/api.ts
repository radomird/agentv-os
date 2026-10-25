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
  viewer: { id: string; name: string; role: "adult" | "kid" };
  apps: App[];
  appsTile: string;
  layout: Placed[];
  settings: Settings;
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

// Settings → Weather: the forecast's city, and the cities it can be.
export interface WeatherPlace {
  zone: string;
  name: string;
  units: "c" | "f";
  chosen: boolean;
  cities: { zone: string; name: string }[];
}

export interface TileData {
  headline?: TileEntry;
  entries?: TileEntry[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error ?? `${method} ${path} failed`);
  return data as T;
}

export const daemon = {
  home: () => call<HomeState>("GET", "/api/home"),
  saveLayout: (layout: Placed[]) => call<{ layout: Placed[] }>("PUT", "/api/layout", { layout }),
  saveSettings: (change: Partial<Settings>) => call<{ settings: Settings }>("POST", "/api/settings", change),
  tile: async (id: string, size: Size) => (await call<{ tile: TileData | null }>("GET", `/api/tile/${id}/${size}`)).tile,
  updates: () => call<Updates>("GET", "/api/updates"),
  toasted: (version: string) => call<{ ok: boolean }>("POST", "/api/updates/toasted", { version }),
  seen: (change: { kept?: string; wentBack?: string; later?: string }) => call<{ ok: boolean }>("POST", "/api/updates/seen", change),
  tonight: (version: string | null) => call<{ ok: boolean }>("POST", "/api/updates/tonight", { version }),
  weather: () => call<WeatherPlace>("GET", "/api/weather"),
  saveWeather: (change: { zone?: string | null; units?: "c" | "f" | null }) => call<WeatherPlace>("POST", "/api/weather", change),
  image: (app: string, url: string) => `/api/image?app=${encodeURIComponent(app)}&url=${encodeURIComponent(url)}`,
};

// Things that changed, as the daemon tells them.
export function listen(handlers: Record<string, (data: unknown) => void>): void {
  const source = new EventSource("/api/events");
  for (const [event, handler] of Object.entries(handlers)) {
    source.addEventListener(event, (message) => handler(JSON.parse((message as MessageEvent).data)));
  }
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

function ask(request: Record<string, unknown>): Promise<Reply> {
  const binding = (window as ScreenWindow).agentvScreen;
  if (!binding) return Promise.resolve({ ok: false, error: "that works on the TV" });
  const id = ++next;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    binding(JSON.stringify({ ...request, id }));
    setTimeout(() => {
      if (waiting.delete(id)) resolve({ ok: false, error: "the TV didn't answer" });
    }, 30_000);
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
  installUpdate: () => ask({ cmd: "update-install" }),
  // Go back to the version from before the last update.
  goBack: () => ask({ cmd: "update-go-back" }),
  // Settings → Omarchy desktop: the PIN check, then a log-out to it.
  desktop: () => ask({ cmd: "desktop" }),
  // AgenTV's sign-in screen for an app whose tile says Sign in (ADR-032).
  signIn: (app: string) => ask({ cmd: "sign-in", app }),
  // The built-in Music app's library and player, in the TV session (ADR-017).
  music: (op: string, args: Record<string, unknown> = {}) => ask({ cmd: "music", op, ...args }),
};
