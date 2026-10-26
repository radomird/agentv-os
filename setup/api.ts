// What the setup screens ask AgenTV's daemon (daemon/setup.ts): where setup
// is, how the box is online, the setup hotspot and the phones, and each step
// moving on.

export type Step = "welcome" | "ready" | "ai" | "people" | "goal" | "apps" | "theme" | "background";
export type Goal = "streaming" | "music" | "media" | "gaming";
export type UpdateFirst = "checking" | "installing" | "done" | "none" | "failed" | "skipped";

export interface SetupState {
  done: boolean;
  step: Step;
  finished: Partial<Record<Step, string>>;
  keyboard: boolean;
  goal: Goal | null;
  ready: { asked: string | null; update: UpdateFirst | null; from: string | null; to: string | null };
  // The apps asked for at "+ add your own", kept for later.
  wishes: string[];
  // The soundtrack muted (S5.4).
  muted: boolean;
}

export interface Hotspot {
  on: boolean;
  ssid: string | null;
  password: string | null;
  joining: string | null;
  joined: { ssid: string; address: string | null } | null;
  error: string | null;
}

export interface SetupInfo {
  version: string;
  running: string;
  setup: SetupState;
  steps: Step[];
  parts: Record<Step, string>;
  network: { online: boolean; via: "ethernet" | "wi-fi" | null; name: string | null };
  hotspot: Hotspot;
  phones: string[];
  // An adult PIN is set, as on a box whose setup was started again.
  pin: boolean;
}

export type Provider = "claude" | "chatgpt" | "gemini";
export type Path = "plan" | "key";

export interface Terms {
  id: string;
  name: string;
  url: string;
}

export interface Offer {
  provider: Provider;
  name: string;
  maker: string;
  cli: string;
  cliName: string;
  plan: { offered: boolean; name: string };
  keyUrl: string;
  terms: Record<Path, Terms[]>;
  summary: Record<Path, string>;
}

export interface AiInfo {
  provider: Provider | null;
  path: Path | null;
  accepted: { terms: Terms[]; by: { phone: string; viewer: string }; at: string } | null;
  cli: { state: "installing" | "ready" | "failed"; cli: string; version: string | null; error: string | null } | null;
  offers: Record<Provider, Offer>;
  key: { set: boolean; provider: string | null };
}

// Setup's apps (board 09): the official apps, the goal's first, the built-in
// ones beside them, and how each install the TV asked for is going.
export type InstallState = "queued" | "installing" | "installed" | "failed";
export type Installs = Record<string, { state: InstallState; error?: string }>;

export interface SetupApp {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  installed: boolean;
  state: InstallState | null;
  error?: string;
}

export interface SetupApps {
  goal: Goal | null;
  wishes: string[];
  for: SetupApp[];
  more: SetupApp[];
  error?: string;
}

export interface Network {
  ssid: string;
  signal: number;
  secure: boolean;
}

async function call<T>(method: string, path: string, body?: unknown, grant?: string): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error ?? `${method} ${path} didn't work`);
  return data as T;
}

export const setup = {
  info: () => call<SetupInfo>("GET", "/api/setup"),
  go: async (step: Step) => (await call<{ setup: SetupState }>("POST", "/api/setup/step", { step })).setup,
  finish: async (step: Step, change: { keyboard?: boolean } = {}) => (await call<{ setup: SetupState }>("POST", "/api/setup/finish", { step, ...change })).setup,
  goal: async (goal: Goal) => (await call<{ setup: SetupState }>("POST", "/api/setup/goal", { goal })).setup,
  ready: async (change: { update: UpdateFirst; from?: string | null; to?: string | null }) => (await call<{ setup: SetupState }>("POST", "/api/setup/ready", change)).setup,
  done: () => call<{ setup: SetupState }>("POST", "/api/setup", { done: true }),
  networks: async () => (await call<{ networks: Network[] }>("GET", "/api/setup/networks")).networks,
  wifi: (ssid: string, password: string) => call<{ joining: string }>("POST", "/api/setup/wifi", { ssid, password }),
  ai: () => call<AiInfo>("GET", "/api/ai"),
  choose: (provider: Provider | null, path?: Path) => call<AiInfo>("POST", "/api/ai", { provider, path }),
  key: (provider: Provider, key: string) => call<{ set: boolean }>("PUT", "/api/key", { provider, key }),
  music: async (muted: boolean) => (await call<{ setup: SetupState }>("POST", "/api/setup/music", { muted })).setup,
  apps: () => call<SetupApps>("GET", "/api/setup/apps"),
  install: async (ids: string[], grant?: string) => (await call<{ apps: Installs }>("POST", "/api/setup/apps", { install: ids }, grant)).apps,
  wish: (text: string) => call<{ setup: SetupState }>("POST", "/api/setup/wish", { text }),
  pair: async () => (await call<{ pairing: { code: string; until: string; url: string | null } | null }>("POST", "/api/phones/pair")).pairing,
};
