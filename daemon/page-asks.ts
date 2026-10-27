// A streaming service's stage B (ADR-011): the build sees a page of the
// service as the household's signed-in browser shows it, through AgenTV and
// never the browser itself. The builder's way out (builder/sandbox/net.ts)
// passes on the address, the daemon checks it against the build that's
// running and queues it here, and the screen daemon, which holds the
// services' Chromium, takes it, reads the page out of sight and answers:
// its structure and a copy without its scripts, on the app's declared
// origins only.

export interface PageAsk {
  n: number;
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

// The daemon's side: asks waiting for the screen daemon, one at a time.
export class PageAsks {
  private next = 1;
  private queue: PageAsk[] = [];
  private waiting = new Map<number, (answer: PageAnswer) => void>();
  private takers: ((ask: PageAsk | null) => void)[] = [];

  // An ask from the build, answered by the screen daemon, or not in time.
  ask(url: string, origins: string[], ms = 90_000): Promise<PageAnswer> {
    const ask: PageAsk = { n: this.next++, url, origins };
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((a) => a !== ask);
        this.waiting.delete(ask.n);
        done({ ok: false, error: "the TV didn't answer in time: is its session running?" });
      }, ms);
      this.waiting.set(ask.n, (answer) => {
        clearTimeout(timer);
        done(answer);
      });
      const taker = this.takers.shift();
      if (taker) taker(ask);
      else this.queue.push(ask);
    });
  }

  // The next ask, for the screen daemon, or null after a while with none.
  take(ms = 25_000): Promise<PageAsk | null> {
    const ask = this.queue.shift();
    if (ask) return Promise.resolve(ask);
    return new Promise((done) => {
      const taker = (found: PageAsk | null) => {
        clearTimeout(timer);
        done(found);
      };
      const timer = setTimeout(() => {
        this.takers = this.takers.filter((t) => t !== taker);
        done(null);
      }, ms);
      this.takers.push(taker);
    });
  }

  // The screen daemon's answer: only what a page answer has, within bounds.
  answer(n: number, said: unknown): boolean {
    const done = this.waiting.get(n);
    if (!done) return false;
    this.waiting.delete(n);
    const a = (typeof said === "object" && said !== null ? said : {}) as Record<string, unknown>;
    if (a.ok !== true) {
      done({ ok: false, error: typeof a.error === "string" ? a.error.slice(0, 300) : "the TV couldn't show it" });
      return true;
    }
    done({
      ok: true,
      url: typeof a.url === "string" ? a.url.slice(0, 2000) : "",
      title: typeof a.title === "string" ? a.title.slice(0, 300) : "",
      lines: Array.isArray(a.lines) ? a.lines.filter((line): line is string => typeof line === "string").slice(0, LINES_MAX).map((line) => line.slice(0, 400)) : [],
      html: typeof a.html === "string" ? a.html.slice(0, HTML_MAX) : "",
    });
    return true;
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
export class PageAskWatch {
  private o: Required<PageAskWatchOptions>;
  private stopped = false;
  private abort?: AbortController;

  constructor(options: PageAskWatchOptions) {
    this.o = { log: (line) => console.log(line), retryMs: 5000, ...options };
  }

  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        this.abort = new AbortController();
        const response = await fetch(`${this.o.url}api/builder/page-ask`, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(40_000)]) });
        const { ask } = (await response.json()) as { ask: PageAsk | null };
        if (!ask) continue;
        const answer = await this.o.snapshot(ask.url, ask.origins).catch((error: Error): PageAnswer => ({ ok: false, error: error.message }));
        await fetch(`${this.o.url}api/builder/page-ask/${ask.n}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(answer), signal: AbortSignal.timeout(10_000) });
      } catch (error) {
        if (this.stopped) return;
        this.o.log(`stage B's pages: ${(error as Error).message}`);
        await new Promise((done) => setTimeout(done, this.o.retryMs));
      }
    }
  }
}
