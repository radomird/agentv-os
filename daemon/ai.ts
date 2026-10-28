// The AI provider (ADR-011, ADR-022, ADR-023): which one the household uses,
// with its plan or an API key, the provider's terms an adult accepted on the
// phone before anything of it installs, and how the first run of its agent
// CLI went. Omarchy's own wrapper fetches the CLI on that first run, once the
// terms are accepted. The choice is kept in ai.json in the daemon's own
// state, and every acceptance in terms.json, which nothing takes back: which
// provider, which terms (as read on which day), who accepted, and when.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Provider = "claude" | "chatgpt" | "gemini" | "grok" | "muse";
// The agent CLI each provider publishes, as Omarchy's wrappers name it.
export type Cli = "claude" | "codex" | "gemini" | "grok" | "muse";
export type Path = "plan" | "key";

export interface Terms {
  id: string;
  name: string;
  url: string;
}

// The day each provider's terms were last read on its own pages. A new
// reading is a new acceptance. xAI's pages turn away a script, so they were
// read in a browser (Q133).
export const TERMS_READ: Record<Provider, string> = {
  claude: "2026-10-26",
  chatgpt: "2026-10-26",
  gemini: "2026-10-26",
  grok: "2026-10-28",
  muse: "2026-10-27",
};

// The providers, as an error message names them.
export const PROVIDER_LIST = "claude, chatgpt, gemini, grok or muse";

export interface Offer {
  provider: Provider;
  name: string;
  maker: string;
  // The agent CLI Omarchy's wrapper fetches on first use, and its name.
  cli: Cli;
  cliName: string;
  // A plan runs through the CLI's own sign-in (ADR-022). Claude's is offered.
  // ChatGPT's and Grok's are offered on edge, as best effort, and on stable
  // once a build has run on each headless on the NUC (ADR-053). Muse's waits
  // for Meta (ADR-051), and Google's for its new CLI to run headless. A note
  // says who can't use one at all.
  plan: { offered: boolean; name: string; note?: string; edge?: boolean; bestEffort?: boolean };
  keyUrl: string;
  terms: Record<Path, Terms[]>;
  // One line for the TV on what the terms are.
  summary: Record<Path, string>;
}

const ANTHROPIC_USAGE: Terms = { id: "anthropic-usage-policy", name: "anthropic's usage policy", url: "https://www.anthropic.com/legal/aup" };
const CLAUDE_CODE: Terms = { id: "claude-code-legal", name: "claude code's legal notes", url: "https://code.claude.com/docs/en/legal-and-compliance" };
const OPENAI_USAGE: Terms = { id: "openai-usage-policies", name: "openai's usage policies", url: "https://openai.com/policies/usage-policies/" };
const GOOGLE_USE: Terms = { id: "google-generative-ai-use-policy", name: "google's generative ai prohibited use policy", url: "https://policies.google.com/terms/generative-ai/use-policy" };
const XAI_USE: Terms = { id: "xai-acceptable-use-policy", name: "xai's acceptable use policy", url: "https://x.ai/legal/acceptable-use-policy" };
const META_TERMS: Terms = { id: "meta-model-api-terms", name: "the meta model api's terms of service", url: "https://dev.meta.ai/legal/terms-of-service" };
const META_USE: Terms = { id: "meta-model-api-acceptable-use-policy", name: "the meta model api's acceptable use policy", url: "https://dev.meta.ai/legal/acceptable-use-policy" };

export const OFFERS: Record<Provider, Offer> = {
  claude: {
    provider: "claude",
    name: "claude",
    maker: "anthropic",
    cli: "claude",
    cliName: "claude code",
    plan: { offered: true, name: "claude pro or max" },
    keyUrl: "https://platform.claude.com/settings/keys",
    terms: {
      plan: [{ id: "anthropic-consumer-terms", name: "anthropic's consumer terms", url: "https://www.anthropic.com/legal/consumer-terms" }, ANTHROPIC_USAGE, CLAUDE_CODE],
      key: [{ id: "anthropic-commercial-terms", name: "anthropic's commercial terms", url: "https://www.anthropic.com/legal/commercial-terms" }, ANTHROPIC_USAGE, CLAUDE_CODE],
    },
    summary: {
      plan: "your plan, under anthropic's consumer terms and usage policy, through claude code as anthropic publishes it.",
      key: "your key, under anthropic's commercial terms and usage policy, through claude code as anthropic publishes it.",
    },
  },
  chatgpt: {
    provider: "chatgpt",
    name: "chatgpt",
    maker: "openai",
    cli: "codex",
    cliName: "codex",
    plan: { offered: false, name: "chatgpt plus or pro", edge: true },
    keyUrl: "https://platform.openai.com/api-keys",
    terms: {
      plan: [{ id: "openai-terms-of-use", name: "openai's terms of use", url: "https://openai.com/policies/terms-of-use/" }, OPENAI_USAGE],
      key: [{ id: "openai-services-agreement", name: "openai's services agreement", url: "https://openai.com/policies/services-agreement/" }, OPENAI_USAGE],
    },
    summary: {
      plan: "your plan, under openai's terms of use and usage policies, through codex as openai publishes it.",
      key: "your key, under openai's services agreement and usage policies, through codex as openai publishes it.",
    },
  },
  gemini: {
    provider: "gemini",
    name: "gemini",
    maker: "google",
    cli: "gemini",
    cliName: "gemini cli",
    plan: { offered: false, name: "google ai pro or ultra" },
    keyUrl: "https://aistudio.google.com/apikey",
    terms: {
      plan: [{ id: "google-terms", name: "google's terms of service", url: "https://policies.google.com/terms" }, GOOGLE_USE],
      key: [
        { id: "google-terms", name: "google's terms of service", url: "https://policies.google.com/terms" },
        { id: "gemini-api-terms", name: "the gemini api's additional terms", url: "https://ai.google.dev/gemini-api/terms" },
        GOOGLE_USE,
      ],
    },
    summary: {
      plan: "your plan, under google's terms of service and its generative ai use policy.",
      key: "your key, under google's terms, the gemini api's additional terms and its generative ai use policy, through gemini cli.",
    },
  },
  grok: {
    provider: "grok",
    name: "grok",
    maker: "xai",
    cli: "grok",
    cliName: "grok build",
    plan: { offered: false, name: "supergrok or x premium+", edge: true },
    keyUrl: "https://console.x.ai",
    terms: {
      plan: [{ id: "xai-consumer-terms", name: "xai's consumer terms of service", url: "https://x.ai/legal/terms-of-service" }, XAI_USE],
      key: [{ id: "xai-enterprise-terms", name: "xai's enterprise terms of service", url: "https://x.ai/legal/terms-of-service-enterprise" }, XAI_USE],
    },
    summary: {
      plan: "your plan, under xai's consumer terms and acceptable use policy, through grok build as xai publishes it.",
      key: "your key, under xai's enterprise terms and acceptable use policy, through grok build as xai publishes it.",
    },
  },
  muse: {
    provider: "muse",
    name: "muse",
    maker: "meta",
    cli: "muse",
    cliName: "muse code",
    plan: { offered: false, name: "a muse code subscription", note: "a meta managed account can only use a key." },
    keyUrl: "https://dev.meta.ai",
    terms: {
      plan: [META_TERMS, { id: "meta-subscription-terms", name: "meta's subscription terms of service", url: "https://www.facebook.com/legal/meta_subs_terms" }, META_USE],
      key: [META_TERMS, META_USE],
    },
    summary: {
      plan: "your plan, under the meta model api's terms, meta's subscription terms and its acceptable use policy, through muse code as meta publishes it.",
      key: "your key, under the meta model api's terms and acceptable use policy, through muse code as meta publishes it.",
    },
  },
};

// What each provider offers on a box on this channel: on edge, a plan that
// stable doesn't offer yet, but edge may, is offered as best effort
// (ADR-053).
export function offersOn(channel: string): Record<Provider, Offer> {
  const early = (offer: Offer) => !offer.plan.offered && offer.plan.edge === true && channel === "edge";
  return Object.fromEntries(
    Object.values(OFFERS).map((offer) => [offer.provider, early(offer) ? { ...offer, plan: { ...offer.plan, offered: true, bestEffort: true } } : offer]),
  ) as Record<Provider, Offer>;
}

export interface Acceptance {
  provider: Provider;
  path: Path;
  terms: Terms[];
  read: string; // the provider's TERMS_READ, when they were accepted
  by: { phone: string; viewer: string };
  at: string;
}

export type CliState = "installing" | "ready" | "failed";

export interface AiState {
  provider: Provider | null;
  path: Path | null;
  // The acceptance of this provider's terms for this path, as they read now.
  accepted: Acceptance | null;
  // How the first run of its CLI went, once they're accepted.
  cli: { state: CliState; cli: string; version: string | null; error: string | null; at: string } | null;
}

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  const next = `${path}.next`;
  await writeFile(next, `${JSON.stringify(data, null, 2)}\n`);
  await rename(next, path);
}

const isProvider = (value: unknown): value is Provider => typeof value === "string" && value in OFFERS;
const isPath = (value: unknown): value is Path => value === "plan" || value === "key";
// What a phone or a profile is called, as it shows on the TV.
const NAME = /^[\p{L}\p{N}' ._-]{1,40}$/u;

export class Ai {
  private state: string;
  // The channel the box updates from, as `agentv channel` says it.
  private channel: () => Promise<string>;

  constructor(options: { state: string; channel?: () => Promise<string> }) {
    this.state = options.state;
    this.channel = options.channel ?? (async () => "stable");
  }

  // What each provider offers on this box's channel.
  async offers(): Promise<Record<Provider, Offer>> {
    return offersOn(await this.channel());
  }

  private get choicePath(): string {
    return join(this.state, "ai.json");
  }

  private get historyPath(): string {
    return join(this.state, "terms.json");
  }

  // Every acceptance, oldest first.
  async history(): Promise<Acceptance[]> {
    const all = await readJson<unknown>(this.historyPath, []);
    return Array.isArray(all) ? (all as Acceptance[]) : [];
  }

  // The latest acceptance of a provider's terms for a path, as they read
  // now, or null.
  async acceptance(provider: Provider, path: Path): Promise<Acceptance | null> {
    return [...(await this.history())].reverse().find((a) => a.provider === provider && a.path === path && a.read === TERMS_READ[provider]) ?? null;
  }

  async read(): Promise<AiState> {
    const saved = await readJson<Record<string, unknown>>(this.choicePath, {});
    const provider = isProvider(saved.provider) ? saved.provider : null;
    const path = isPath(saved.path) ? saved.path : null;
    const accepted = provider && path ? await this.acceptance(provider, path) : null;
    const cli = saved.cli as AiState["cli"] | undefined;
    return { provider, path, accepted, cli: accepted && cli && cli.cli === OFFERS[provider!].cli ? cli : null };
  }

  // The provider and the path, as picked on the TV, or none, as when the TV
  // goes back to pick again. A plan only where it's offered on this box's
  // channel. A plan picked on edge stays picked if the box goes back to
  // stable: it's the household's, already signed in, and stable only keeps
  // it from being picked anew.
  async choose(provider: unknown, path: unknown): Promise<{ state?: AiState; error?: string }> {
    const saved = await readJson<Record<string, unknown>>(this.choicePath, {});
    if (provider === null) {
      await mkdir(this.state, { recursive: true });
      await writeJson(this.choicePath, { ...saved, provider: null, path: null });
      return { state: await this.read() };
    }
    if (!isProvider(provider)) return { error: PROVIDER_LIST };
    if (!isPath(path)) return { error: "a plan or a key" };
    if (path === "plan" && !(await this.offers())[provider].plan.offered) return { error: `${OFFERS[provider].plan.name} is coming soon. use an api key for now` };
    await mkdir(this.state, { recursive: true });
    await writeJson(this.choicePath, { ...saved, provider, path });
    return { state: await this.read() };
  }

  // An adult accepted the terms on a phone: for the provider and path the TV
  // shows, as they read now.
  async accept(provider: unknown, path: unknown, by: { phone: unknown; viewer: unknown }): Promise<{ state?: AiState; error?: string }> {
    const shown = await this.read();
    if (!shown.provider || !shown.path || shown.provider !== provider || shown.path !== path) return { error: "those aren't the terms the tv shows" };
    const recorded = await this.record(shown.provider, shown.path, by);
    return recorded.error ? { error: recorded.error } : { state: await this.read() };
  }

  // An adult's acceptance of a provider's terms for a path, kept with the
  // rest: for what setup shows, or for a key Settings → AI waits to keep
  // (Q104).
  async record(provider: Provider, path: Path, by: { phone: unknown; viewer: unknown }): Promise<{ acceptance?: Acceptance; error?: string }> {
    if (typeof by.phone !== "string" || !NAME.test(by.phone) || typeof by.viewer !== "string" || !NAME.test(by.viewer)) return { error: "who accepted them" };
    const acceptance: Acceptance = { provider, path, terms: OFFERS[provider].terms[path], read: TERMS_READ[provider], by: { phone: by.phone, viewer: by.viewer }, at: now() };
    await mkdir(this.state, { recursive: true });
    await writeJson(this.historyPath, [...(await this.history()), acceptance]);
    return { acceptance };
  }

  // How the first run of the CLI goes, from the screen daemon.
  async setCli(change: unknown): Promise<{ state?: AiState; error?: string }> {
    const c = (typeof change === "object" && change !== null ? change : {}) as Record<string, unknown>;
    const state = await this.read();
    if (!state.provider || !state.accepted) return { error: "the provider's terms aren't accepted yet" };
    if (c.state !== "installing" && c.state !== "ready" && c.state !== "failed") return { error: "installing, ready or failed" };
    const text = (value: unknown) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120) : null);
    const saved = await readJson<Record<string, unknown>>(this.choicePath, {});
    const cli = { state: c.state, cli: OFFERS[state.provider].cli, version: text(c.version), error: text(c.error), at: now() };
    await writeJson(this.choicePath, { ...saved, cli });
    return { state: await this.read() };
  }
}
