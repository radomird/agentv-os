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
}

export interface Settings {
  sound: { on: boolean; volume: number };
  reduceMotion: boolean;
  idleMinutes: number;
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

export interface TileEntry {
  label?: string;
  value?: string;
  caption?: string;
  icon?: string;
  image?: string;
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

const waiting = new Map<number, (reply: { ok: boolean; error?: string }) => void>();
let next = 0;
(window as ScreenWindow).agentvScreenReply = (id, reply) => {
  waiting.get(id)?.(JSON.parse(reply));
  waiting.delete(id);
};

function ask(request: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
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
  // Puts an app in front, the way its manifest says to open it.
  open: (app: string) => ask({ cmd: "open-app", app }),
  // Settings → Omarchy desktop: the PIN check, then a log-out to it.
  desktop: () => ask({ cmd: "desktop" }),
};
