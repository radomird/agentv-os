// What the setup screens ask AgenTV's daemon (daemon/setup.ts): where setup
// is, how the box is online, the setup hotspot and the phones, and each step
// moving on.

import type { Country, CountryState } from "../launcher/api.ts";

export type { Country, CountryState };
// Every step's id, as daemon/setup.ts orders them, the ones behind a switch
// included.
export type Step = "welcome" | "ready" | "box" | "country" | "ai" | "people" | "goal" | "apps" | "look" | "theme" | "background";
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
  // The time zone of the phone setting it up.
  phoneZone: string | null;
}

// The location step (design page D3): where it starts, from the phone's
// time zone or the box's, and a country's time zones when they differ.
export interface Start {
  code: string;
  name: string;
  called: string; // "the netherlands"
  zone: string;
  from: "phone" | "box";
}

export interface ZoneChoice {
  zone: string;
  name: string; // "eastern"
  city: string; // "new york"
}

export interface ZoneAsk {
  code: string;
  name: string;
  called: string;
  zones: ZoneChoice[];
}

export interface LocationInfo {
  start: Start | null;
  phoneZone: string | null;
  countries: Country[];
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
  // The steps shown, in order, and what the status bar says for each. With
  // setup's own switch on, each one's number of the 12, for its blocks.
  steps: Step[];
  parts: Partial<Record<Step, string>>;
  numbers: Partial<Record<Step, number>> | null;
  of: number;
  network: { online: boolean; via: "ethernet" | "wi-fi" | null; name: string | null };
  hotspot: Hotspot;
  phones: string[];
  // An adult PIN is set, as on a box whose setup was started again.
  pin: boolean;
}

export type Provider = "claude" | "chatgpt" | "gemini" | "grok" | "muse";
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
  // keyOnly: its maker keeps the plan to its own apps, and note says so.
  plan: { offered: boolean; name: string; note?: string; keyOnly?: boolean };
  keyUrl: string;
  terms: Record<Path, Terms[]>;
  summary: Record<Path, string>;
}

// A plan's sign-in from the AI step (ADR-070): whether it's in, and how
// the one running is going.
export interface PlanSignIn {
  provider: Provider;
  signedIn: boolean;
  now?: { state: "starting" | "waiting" | "done" | "failed"; url?: string; code?: string; pastes?: boolean; reason?: string };
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
  // The streaming starter pack, with its switch on.
  starter?: SetupApp[];
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
  choose: (provider: Provider | null, path?: Path, grant?: string) => call<AiInfo>("POST", "/api/ai", { provider, path }, grant),
  // The plan's sign-in, started from the AI step, and a code its page gave.
  signIn: () => call<{ signIn: PlanSignIn | null }>("GET", "/api/ai/sign-in"),
  startSignIn: (grant?: string) => call<{ signIn: PlanSignIn | null }>("POST", "/api/ai/sign-in", {}, grant),
  signInCode: (code: string, grant?: string) => call<{ ok: true }>("POST", "/api/ai/sign-in/code", { code }, grant),
  key: (provider: Provider, key: string) => call<{ set: boolean }>("PUT", "/api/key", { provider, key }),
  music: async (muted: boolean) => (await call<{ setup: SetupState }>("POST", "/api/setup/music", { muted })).setup,
  apps: () => call<SetupApps>("GET", "/api/setup/apps"),
  install: async (ids: string[], grant?: string) => (await call<{ apps: Installs }>("POST", "/api/setup/apps", { install: ids }, grant)).apps,
  wish: (text: string) => call<{ setup: SetupState }>("POST", "/api/setup/wish", { text }),
  // The box's country (ADR-055): the time zone and new this week follow it.
  country: () => call<CountryState & { countries: Country[] }>("GET", "/api/country"),
  setCountry: (code: string, grant?: string) => call<CountryState>("PUT", "/api/country", { code }, grant),
  // The location step, with setup's own switch on: a country, and the zone
  // when the question asked it. The answer sets them, or asks which zone.
  location: () => call<LocationInfo>("GET", "/api/setup/location"),
  setLocation: (code: string, zone?: string, grant?: string) => call<{ location?: CountryState; ask?: ZoneAsk }>("PUT", "/api/setup/location", { code, zone }, grant),
  pair: async () => (await call<{ pairing: { code: string; until: string; url: string | null } | null }>("POST", "/api/phones/pair")).pairing,
};
