// How much of a plan is used, in % (ADR-103, Q313): the 5-hour window and
// the week, each with when it resets, from Omarchy's own usage checks,
// `omarchy-agent-usage-claude`, `-codex` and `-grok`. Each reads the CLI's
// own sign-in and asks the provider's own usage page, so it runs where that
// sign-in lives: in the plan router's service (daemon/router-serve.ts, as
// origaitv-builder, with the builder's home), never in the daemon, which
// still never reads a plan's tokens. The service hands back only the
// numbers: which window, how much of it is used, and when it resets.
// Nothing else the check prints leaves it: no account, no plan name, no
// counts of what was asked.
//
// The daemon asks the service now and then, and keeps the answer a little
// while, as Omarchy's own panel does. Where the check can't answer, the TV
// says it's using the plan, and no number.

import type { Provider } from "./ai.ts";

// The plans whose CLI has an Omarchy usage check.
export const USAGE_PROVIDERS = ["claude", "chatgpt", "grok"] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];
const CHECKS: Record<UsageProvider, string> = { claude: "omarchy-agent-usage-claude", chatgpt: "omarchy-agent-usage-codex", grok: "omarchy-agent-usage-grok" };

export function hasUsage(provider: Provider | null | undefined): provider is UsageProvider {
  return (USAGE_PROVIDERS as readonly string[]).includes(provider ?? "");
}

// One window of a plan's limits: how much of it is used, 0 to 100, and when
// it starts over, if the provider says.
export interface UsageWindow {
  window: "hours" | "week" | "month";
  hours?: number; // a window's length, for "hours"
  percent: number;
  resets?: string; // ISO 8601
}

export interface PlanUsage {
  provider: UsageProvider;
  windows: UsageWindow[];
  at: string;
}

// Omarchy's check, as the plan's service runs it: the builder's home, the
// CLI's own folder in it, Omarchy's own files for the check's helpers, and
// the service's one way out.
export function usageCommand(provider: UsageProvider, o: { home: string; omarchy?: string; proxy?: string }): { command: string; args: string[]; env: Record<string, string> } {
  const omarchy = o.omarchy ?? "/usr/share/omarchy";
  const env: Record<string, string> = {
    HOME: o.home,
    PATH: `${o.home}/.local/bin:${omarchy}/bin:/usr/local/bin:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    OMARCHY_PATH: omarchy,
    XDG_CACHE_HOME: `${o.home}/.cache`,
    XDG_STATE_HOME: `${o.home}/.local/state`,
    XDG_DATA_HOME: `${o.home}/.local/share`,
    XDG_CONFIG_HOME: `${o.home}/.config`,
    CLAUDE_CONFIG_DIR: `${o.home}/.claude`,
    CODEX_HOME: `${o.home}/.codex`,
    GROK_HOME: `${o.home}/.grok`,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  if (o.proxy) for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) env[name] = o.proxy;
  return { command: `${omarchy}/bin/${CHECKS[provider]}`, args: ["--limits-only"], env };
}

// The windows a check printed, and nothing else of it: a 5-hour window, the
// week and, for a plan that counts by the month, the month. Null when it
// has none to say, as when it isn't signed in or can't reach its provider.
export function usageWindows(printed: string): UsageWindow[] | null {
  let record: unknown;
  try {
    record = JSON.parse(printed.trim().split("\n").filter(Boolean).at(-1) ?? "");
  } catch {
    return null;
  }
  const limits = (record as { limits?: unknown })?.limits;
  if (!Array.isArray(limits)) return null;
  const windows: UsageWindow[] = [];
  for (const limit of limits) {
    if (typeof limit !== "object" || limit === null) continue;
    const { label, percent, resetsAt, title } = limit as Record<string, unknown>;
    if (typeof label !== "string" || typeof percent !== "number" || !Number.isFinite(percent)) continue;
    // A model's own allowance ("Opus Weekly") carries a title of its own,
    // and isn't the plan's.
    if (title !== undefined) continue;
    const hours = /^Session \((\d+)-hour\)$/.exec(label)?.[1] ?? /^(\d+)h window$/.exec(label)?.[1];
    const window: UsageWindow["window"] | null = hours ? "hours" : /^Weekly( \(7-day\))?$/.test(label) ? "week" : label === "Monthly" ? "month" : null;
    if (!window || windows.some((w) => w.window === window)) continue;
    const reset = typeof resetsAt === "string" && !Number.isNaN(Date.parse(resetsAt)) ? new Date(resetsAt).toISOString() : undefined;
    windows.push({ window, ...(hours ? { hours: Number(hours) } : {}), percent: Math.round(Math.max(0, Math.min(1, percent)) * 100), ...(reset ? { resets: reset } : {}) });
  }
  const order = { hours: 0, week: 1, month: 2 };
  return windows.length ? windows.sort((a, b) => order[a.window] - order[b.window]) : null;
}

export interface PlanUsageOptions {
  // The plan's service, asked for a provider's windows (router-client.ts).
  ask: (provider: UsageProvider) => Promise<UsageWindow[] | null>;
  now?: () => number;
  // How long an answer is kept, and a failed one.
  keepMs?: number;
  failedMs?: number;
}

// The daemon's side: the windows for the plan in use, asked for at most
// every few minutes, and nothing when the check couldn't answer.
export class PlanUsages {
  private o: PlanUsageOptions;
  private kept = new Map<UsageProvider, { at: number; usage: PlanUsage | null }>();
  private asking = new Map<UsageProvider, Promise<PlanUsage | null>>();

  constructor(options: PlanUsageOptions) {
    this.o = options;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  async get(provider: Provider | null, fresh = false): Promise<PlanUsage | null> {
    if (!hasUsage(provider)) return null;
    const kept = this.kept.get(provider);
    const keep = kept?.usage ? (this.o.keepMs ?? 120_000) : (this.o.failedMs ?? 30_000);
    if (kept && !fresh && this.now() - kept.at < keep) return kept.usage;
    let asking = this.asking.get(provider);
    if (!asking) {
      asking = this.o
        .ask(provider)
        .catch(() => null)
        .then((windows) => {
          const usage = windows?.length ? { provider, windows, at: new Date(this.now()).toISOString() } : null;
          this.kept.set(provider, { at: this.now(), usage });
          return usage;
        })
        .finally(() => this.asking.delete(provider));
      this.asking.set(provider, asking);
    }
    return asking;
  }
}
