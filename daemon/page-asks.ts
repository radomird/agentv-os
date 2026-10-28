// A streaming service's stage B (ADR-011): the build sees a page of the
// service as the household's signed-in browser shows it, through AgenTV and
// never the browser itself. The builder's way out (builder/sandbox/net.ts)
// passes on the address, the daemon checks it against the build that's
// running and queues it here, and the screen daemon, which holds the
// services' Chromium, takes it, reads the page out of sight and answers:
// its structure and a copy without its scripts, on the app's declared
// origins only.

import { type Asked, Asks, AskWatch } from "./asks.ts";

export interface PageAsk extends Asked {
  url: string;
  origins: string[];
}

export interface PageAnswer {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  lines?: string[];
  html?: string;
}

const HTML_MAX = 2 * 1024 * 1024;
const LINES_MAX = 300;
// The most a page answer's JSON may be, with its copy escaped: more than
// the daemon takes in any other body.
export const ANSWER_MAX = 6 * 1024 * 1024;

// Only what a page answer has, within bounds.
export function cleanPage(said: unknown): PageAnswer {
  const a = (typeof said === "object" && said !== null ? said : {}) as Record<string, unknown>;
  if (a.ok !== true) return { ok: false, error: typeof a.error === "string" ? a.error.slice(0, 300) : "the TV couldn't show it" };
  return {
    ok: true,
    url: typeof a.url === "string" ? a.url.slice(0, 2000) : "",
    title: typeof a.title === "string" ? a.title.slice(0, 300) : "",
    lines: Array.isArray(a.lines) ? a.lines.filter((line): line is string => typeof line === "string").slice(0, LINES_MAX).map((line) => line.slice(0, 400)) : [],
    html: typeof a.html === "string" ? a.html.slice(0, HTML_MAX) : "",
  };
}

// The daemon's side: asks waiting for the screen daemon, one at a time.
export class PageAsks {
  private asks = new Asks<{ url: string; origins: string[] }, PageAnswer>({
    clean: cleanPage,
    late: { ok: false, error: "the TV didn't answer in time: is its session running?" },
  });

  // An ask from the build, answered by the screen daemon, or not in time.
  ask(url: string, origins: string[], ms = 90_000): Promise<PageAnswer> {
    return this.asks.ask({ url, origins }, ms);
  }

  // The next ask, for the screen daemon, or null after a while with none.
  take(ms = 25_000): Promise<PageAsk | null> {
    return this.asks.take(ms);
  }

  answer(n: number, said: unknown): boolean {
    return this.asks.answer(n, said);
  }

  close(): void {
    this.asks.close();
  }
}

export interface PageAskWatchOptions {
  url: string; // the daemon: http://127.0.0.1:3000/
  // Reads one page in the services' Chromium (Screen.snapshot).
  snapshot: (url: string, origins: string[]) => Promise<PageAnswer>;
  log?: (line: string) => void;
  retryMs?: number;
}

// The screen daemon's side: it waits for an ask, reads the page, answers,
// and waits again, for as long as the TV session runs.
export class PageAskWatch extends AskWatch<PageAsk, PageAnswer> {
  constructor(o: PageAskWatchOptions) {
    super({
      url: o.url,
      path: "api/builder/page-ask",
      what: "stage B's pages",
      // Only what the daemon takes, so a big page's copy still gets there.
      handle: async (ask) => cleanPage(await o.snapshot(ask.url, ask.origins)),
      failed: (error) => ({ ok: false, error: error.message }),
      ...(o.log ? { log: o.log } : {}),
      ...(o.retryMs !== undefined ? { retryMs: o.retryMs } : {}),
    });
  }
}
