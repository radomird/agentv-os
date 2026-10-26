// What the setup screens ask AgenTV's daemon (daemon/setup.ts): where setup
// is, how the box is online, the setup hotspot and the phones, and each step
// moving on.

export type Step = "welcome" | "ready" | "goal";
export type Goal = "streaming" | "music" | "media" | "gaming";
export type UpdateFirst = "checking" | "installing" | "done" | "none" | "failed" | "skipped";

export interface SetupState {
  done: boolean;
  step: Step;
  finished: Partial<Record<Step, string>>;
  keyboard: boolean;
  goal: Goal | null;
  ready: { asked: string | null; update: UpdateFirst | null; from: string | null; to: string | null };
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

export interface Network {
  ssid: string;
  signal: number;
  secure: boolean;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
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
  pair: async () => (await call<{ pairing: { code: string; until: string; url: string | null } | null }>("POST", "/api/phones/pair")).pairing,
};
