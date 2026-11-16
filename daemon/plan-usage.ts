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
// while, as Omarchy's own panel does. Numbers the check measured just now
// are shown as they are. One that couldn't ask prints the last numbers it
// kept, marked stale. Where it says why is only its token lapsing ("Limits
// paused", which Claude Code's own next run puts right), the TV shows those
// with when they were read ("As of 8 hours ago", Q341). The check keeps them
// in its own cache in the builder's home, with when it read them, and
// nothing of the sign-in goes with them. Other old numbers aren't shown:
// the TV says it's using the plan. Where the plan's sign-in ran out, or was
// never done, the TV says so and offers signing in.

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

// The plan's sign-in has to be done again ("expired"), or hasn't been done
// ("none").
export type UsageSignIn = "expired" | "none";

export interface PlanUsage {
  provider: UsageProvider;
  windows: UsageWindow[];
  // With no windows: the plan's sign-in is what's missing.
  signIn?: UsageSignIn;
  // When the windows were read, for numbers kept while the limits are
  // paused (ISO 8601).
  asOf?: string;
  at: string;
}

// What the plan's service answers the daemon: the windows (with when they
// were read, when they're kept ones), or that the plan's sign-in has to be
// done. Anything else is no answer.
export type UsageReply = { windows: UsageWindow[]; asOf?: string } | { signIn: UsageSignIn };

// What a check printed comes to, for the service: its reply, and what kind
// of answer it was for the service's log, never a number.
export interface UsageAnswer {
  reply: UsageReply | null;
  said: string;
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
    // Omarchy's own collectors, and no Python packages from the builder's
    // home in their place.
    PYTHONNOUSERSITE: "1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  if (o.proxy) for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) env[name] = o.proxy;
  return { command: `${omarchy}/bin/${CHECKS[provider]}`, args: ["--limits-only"], env };
}

// Omarchy's words for a sign-in that has to be done.
const SIGNED_OUT = new Map<string, UsageSignIn>([
  ["Sign-in expired", "expired"],
  ["Waiting for auth", "none"],
]);

// What a check printed, and nothing else of it: the windows it measured just
// now, a 5-hour window, the week and, for a plan that counts by the month,
// the month. Its last line is its record. Numbers kept past a check that
// couldn't ask (limitsStale, or a status such as "Limits paused") are old,
// and no answer. "Sign-in expired" and "Waiting for auth" say the plan's
// sign-in is what's missing.
export function usageAnswer(printed: string): UsageAnswer {
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(printed.trim().split("\n").filter(Boolean).at(-1) ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { reply: null, said: "nothing to read" };
    record = parsed as Record<string, unknown>;
  } catch {
    return { reply: null, said: "nothing to read" };
  }
  const status = typeof record.usageStatusText === "string" ? record.usageStatusText : "";
  const signIn = SIGNED_OUT.get(status);
  if (signIn) return { reply: { signIn }, said: signIn === "expired" ? "sign-in expired" : "not signed in" };
  // Only the token lapsed: the numbers it kept, with when it read them.
  if (status === "Limits paused") {
    const kept = windowsOf(record.limits);
    const read = typeof record.limitsFetchedAt === "number" && record.limitsFetchedAt > 0 ? new Date(record.limitsFetchedAt) : null;
    return kept && read && !Number.isNaN(read.getTime()) ? { reply: { windows: kept, asOf: read.toISOString() }, said: "kept numbers, limits paused" } : { reply: null, said: "limits paused" };
  }
  if (record.limitsStale === true || record.live === false) return { reply: null, said: "old numbers" };
  if (status) return { reply: null, said: "no numbers" };
  const windows = windowsOf(record.limits);
  return windows ? { reply: { windows }, said: `${windows.length} window${windows.length === 1 ? "" : "s"}` } : { reply: null, said: "no windows" };
}

// The windows alone, or null when there are none to show now.
export function usageWindows(printed: string): UsageWindow[] | null {
  const { reply } = usageAnswer(printed);
  return reply && "windows" in reply ? reply.windows : null;
}

function windowsOf(limits: unknown): UsageWindow[] | null {
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
  ask: (provider: UsageProvider) => Promise<UsageReply | null>;
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
    // Today's numbers are kept a while. Kept ones, no answer, and a sign-in
    // to do are asked again sooner, so fresh numbers show soon.
    const keep = kept?.usage?.windows.length && !kept.usage.asOf ? (this.o.keepMs ?? 120_000) : (this.o.failedMs ?? 30_000);
    if (kept && !fresh && this.now() - kept.at < keep) return kept.usage;
    let asking = this.asking.get(provider);
    if (!asking) {
      asking = this.o
        .ask(provider)
        .catch(() => null)
        .then((reply) => {
          const at = new Date(this.now()).toISOString();
          const usage: PlanUsage | null =
            reply && "windows" in reply && reply.windows.length
              ? { provider, windows: reply.windows, ...(reply.asOf ? { asOf: reply.asOf } : {}), at }
              : reply && "signIn" in reply
                ? { provider, windows: [], signIn: reply.signIn, at }
                : null;
          this.kept.set(provider, { at: this.now(), usage });
          return usage;
        })
        .finally(() => this.asking.delete(provider));
      this.asking.set(provider, asking);
    }
    return asking;
  }
}
