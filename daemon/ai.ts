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

// The day each provider's terms were last read on its own pages, for a plan
// and for a key. A new reading is a new acceptance, of that path's terms
// only: an acceptance of a key's terms stays good when only the plan's were
// read again. xAI's pages turn away a script, so they were read in a
// browser (Q133). Google's plan was read again on 2026-11-10, with the
// terms of the CLI its plans moved to. The terms for its key are as they
// were.
export const TERMS_READ: Record<Provider, Record<Path, string>> = {
  claude: { plan: "2026-10-26", key: "2026-10-26" },
  chatgpt: { plan: "2026-10-26", key: "2026-10-26" },
  gemini: { plan: "2026-11-10", key: "2026-10-26" },
  grok: { plan: "2026-10-28", key: "2026-10-28" },
  muse: { plan: "2026-10-27", key: "2026-10-27" },
};

// The providers, as an error message names them.
export const PROVIDER_LIST = "Claude, ChatGPT, Gemini, Grok or Muse";

export interface Offer {
  provider: Provider;
  name: string;
  maker: string;
  // The agent CLI Omarchy's wrapper fetches on first use, and its name.
  cli: Cli;
  cliName: string;
  // A plan runs through the CLI's own sign-in (ADR-022). Claude's, ChatGPT's
  // and Grok's are offered on every TV (ADR-087). Muse's and Google's
  // aren't: each company keeps its plan to its own apps, by its own terms
  // (ADR-051 for Meta; Google's were read on 2026-11-10). Muse's is "coming
  // soon", since Meta has been asked. Google's is key only, and its note is
  // the line that says so. Muse's note says who can't use a plan at all.
  plan: { offered: boolean; name: string; note?: string; keyOnly?: boolean };
  keyUrl: string;
  terms: Record<Path, Terms[]>;
  // One line for the TV on what the terms are.
  summary: Record<Path, string>;
}

const ANTHROPIC_USAGE: Terms = { id: "anthropic-usage-policy", name: "Anthropic's usage policy", url: "https://www.anthropic.com/legal/aup" };
const CLAUDE_CODE: Terms = { id: "claude-code-legal", name: "Claude Code's legal notes", url: "https://code.claude.com/docs/en/legal-and-compliance" };
const OPENAI_USAGE: Terms = { id: "openai-usage-policies", name: "OpenAI's usage policies", url: "https://openai.com/policies/usage-policies/" };
const GOOGLE_USE: Terms = { id: "google-generative-ai-use-policy", name: "Google's generative AI prohibited use policy", url: "https://policies.google.com/terms/generative-ai/use-policy" };
const XAI_USE: Terms = { id: "xai-acceptable-use-policy", name: "xAI's acceptable use policy", url: "https://x.ai/legal/acceptable-use-policy" };
const META_TERMS: Terms = { id: "meta-model-api-terms", name: "The Meta Model API's terms of service", url: "https://dev.meta.ai/legal/terms-of-service" };
const META_USE: Terms = { id: "meta-model-api-acceptable-use-policy", name: "The Meta Model API's acceptable use policy", url: "https://dev.meta.ai/legal/acceptable-use-policy" };

export const OFFERS: Record<Provider, Offer> = {
  claude: {
    provider: "claude",
    name: "Claude",
    maker: "Anthropic",
    cli: "claude",
    cliName: "Claude Code",
    plan: { offered: true, name: "Claude Pro or Max" },
    keyUrl: "https://platform.claude.com/settings/keys",
    terms: {
      plan: [{ id: "anthropic-consumer-terms", name: "Anthropic's consumer terms", url: "https://www.anthropic.com/legal/consumer-terms" }, ANTHROPIC_USAGE, CLAUDE_CODE],
      key: [{ id: "anthropic-commercial-terms", name: "Anthropic's commercial terms", url: "https://www.anthropic.com/legal/commercial-terms" }, ANTHROPIC_USAGE, CLAUDE_CODE],
    },
    summary: {
      plan: "Your plan, under Anthropic's consumer terms and usage policy, through Claude Code as Anthropic publishes it",
      key: "Your key, under Anthropic's commercial terms and usage policy, through Claude Code as Anthropic publishes it",
    },
  },
  chatgpt: {
    provider: "chatgpt",
    name: "ChatGPT",
    maker: "OpenAI",
    cli: "codex",
    cliName: "Codex",
    plan: { offered: true, name: "ChatGPT Plus or Pro" },
    keyUrl: "https://platform.openai.com/api-keys",
    terms: {
      plan: [{ id: "openai-terms-of-use", name: "OpenAI's terms of use", url: "https://openai.com/policies/terms-of-use/" }, OPENAI_USAGE],
      key: [{ id: "openai-services-agreement", name: "OpenAI's services agreement", url: "https://openai.com/policies/services-agreement/" }, OPENAI_USAGE],
    },
    summary: {
      plan: "Your plan, under OpenAI's terms of use and usage policies, through Codex as OpenAI publishes it",
      key: "Your key, under OpenAI's services agreement and usage policies, through Codex as OpenAI publishes it",
    },
  },
  gemini: {
    provider: "gemini",
    name: "Gemini",
    maker: "Google",
    cli: "gemini",
    cliName: "Gemini CLI",
    plan: { offered: false, name: "Google AI Pro or Ultra", keyOnly: true, note: "Google keeps its plan to its own apps. A key works now." },
    keyUrl: "https://aistudio.google.com/apikey",
    terms: {
      plan: [{ id: "google-terms", name: "Google's terms of service", url: "https://policies.google.com/terms" }, GOOGLE_USE],
      key: [
        { id: "google-terms", name: "Google's terms of service", url: "https://policies.google.com/terms" },
        { id: "gemini-api-terms", name: "The Gemini API's additional terms", url: "https://ai.google.dev/gemini-api/terms" },
        GOOGLE_USE,
      ],
    },
    summary: {
      plan: "Your plan, under Google's terms of service and its generative AI use policy",
      key: "Your key, under Google's terms, the Gemini API's additional terms and its generative AI use policy, through Gemini CLI",
    },
  },
  grok: {
    provider: "grok",
    name: "Grok",
    maker: "xAI",
    cli: "grok",
    cliName: "Grok Build",
    plan: { offered: true, name: "SuperGrok or X Premium+" },
    keyUrl: "https://console.x.ai",
    terms: {
      plan: [{ id: "xai-consumer-terms", name: "xAI's consumer terms of service", url: "https://x.ai/legal/terms-of-service" }, XAI_USE],
      key: [{ id: "xai-enterprise-terms", name: "xAI's enterprise terms of service", url: "https://x.ai/legal/terms-of-service-enterprise" }, XAI_USE],
    },
    summary: {
      plan: "Your plan, under xAI's consumer terms and acceptable use policy, through Grok Build as xAI publishes it",
      key: "Your key, under xAI's enterprise terms and acceptable use policy, through Grok Build as xAI publishes it",
    },
  },
  muse: {
    provider: "muse",
    name: "Muse",
    maker: "Meta",
    cli: "muse",
    cliName: "Muse Code",
    plan: { offered: false, name: "A Muse Code subscription", note: "A Meta managed account can only use a key" },
    keyUrl: "https://dev.meta.ai",
    terms: {
      plan: [META_TERMS, { id: "meta-subscription-terms", name: "Meta's subscription terms of service", url: "https://www.facebook.com/legal/meta_subs_terms" }, META_USE],
      key: [META_TERMS, META_USE],
    },
    summary: {
      plan: "Your plan, under the Meta Model API's terms, Meta's subscription terms and its acceptable use policy, through Muse Code as Meta publishes it",
      key: "Your key, under the Meta Model API's terms and acceptable use policy, through Muse Code as Meta publishes it",
    },
  },
};

// Why a plan that isn't offered can't be picked, in one line: that its
// maker keeps it to its own apps, or that it's coming soon.
export function planRefused(offer: Offer): string {
  return offer.plan.keyOnly && offer.plan.note ? offer.plan.note : `${offer.plan.name} is coming soon. Use a key for now.`;
}

export interface Acceptance {
  provider: Provider;
  path: Path;
  terms: Terms[];
  read: string; // TERMS_READ for the provider and the path, when they were accepted
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

  // channel is no longer read: what's offered is the same on every channel.
  constructor(options: { state: string; channel?: () => Promise<string> }) {
    this.state = options.state;
  }

  // What each provider offers. It's the same on every TV, whichever channel
  // its updates come from (ADR-087).
  async offers(): Promise<Record<Provider, Offer>> {
    return OFFERS;
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
    return [...(await this.history())].reverse().find((a) => a.provider === provider && a.path === path && a.read === TERMS_READ[provider][path]) ?? null;
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
  // goes back to pick again. A plan only where it's offered.
  async choose(provider: unknown, path: unknown): Promise<{ state?: AiState; error?: string }> {
    const saved = await readJson<Record<string, unknown>>(this.choicePath, {});
    if (provider === null) {
      await mkdir(this.state, { recursive: true });
      await writeJson(this.choicePath, { ...saved, provider: null, path: null });
      return { state: await this.read() };
    }
    if (!isProvider(provider)) return { error: PROVIDER_LIST };
    if (!isPath(path)) return { error: "a plan or a key" };
    if (path === "plan" && !OFFERS[provider].plan.offered) return { error: planRefused(OFFERS[provider]) };
    await mkdir(this.state, { recursive: true });
    await writeJson(this.choicePath, { ...saved, provider, path });
    return { state: await this.read() };
  }

  // An adult accepted the terms on a phone: for the provider and path the TV
  // shows, as they read now.
  async accept(provider: unknown, path: unknown, by: { phone: unknown; viewer: unknown }): Promise<{ state?: AiState; error?: string }> {
    const shown = await this.read();
    if (!shown.provider || !shown.path || shown.provider !== provider || shown.path !== path) return { error: "Those aren't the terms on your TV" };
    const recorded = await this.record(shown.provider, shown.path, by);
    return recorded.error ? { error: recorded.error } : { state: await this.read() };
  }

  // An adult's acceptance of a provider's terms for a path, kept with the
  // rest: for what setup shows, or for a key Settings → AI waits to keep
  // (Q104).
  async record(provider: Provider, path: Path, by: { phone: unknown; viewer: unknown }): Promise<{ acceptance?: Acceptance; error?: string }> {
    if (typeof by.phone !== "string" || !NAME.test(by.phone) || typeof by.viewer !== "string" || !NAME.test(by.viewer)) return { error: "who accepted them" };
    const acceptance: Acceptance = { provider, path, terms: OFFERS[provider].terms[path], read: TERMS_READ[provider][path], by: { phone: by.phone, viewer: by.viewer }, at: now() };
    await mkdir(this.state, { recursive: true });
    await writeJson(this.historyPath, [...(await this.history()), acceptance]);
    return { acceptance };
  }

  // How the first run of the CLI goes, from the screen daemon.
  async setCli(change: unknown): Promise<{ state?: AiState; error?: string }> {
    const c = (typeof change === "object" && change !== null ? change : {}) as Record<string, unknown>;
    const state = await this.read();
    if (!state.provider || !state.accepted) return { error: state.provider ? `Accept ${OFFERS[state.provider].name}'s terms first` : "Set up AI in Settings first" };
    if (c.state !== "installing" && c.state !== "ready" && c.state !== "failed") return { error: "installing, ready or failed" };
    const text = (value: unknown) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120) : null);
    const saved = await readJson<Record<string, unknown>>(this.choicePath, {});
    const cli = { state: c.state, cli: OFFERS[state.provider].cli, version: text(c.version), error: text(c.error), at: now() };
    await writeJson(this.choicePath, { ...saved, cli });
    return { state: await this.read() };
  }
}
