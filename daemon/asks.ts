// What the daemon asks of the screen daemon, which runs as the person in the
// TV session and holds what the daemon doesn't: the services' Chromium, and
// the person's own GitHub sign-in. The daemon queues an ask, the screen
// daemon takes it over the daemon's own port, does it as the person and
// answers. Stage B's pages (page-asks.ts) and Export's push (github.ts) go
// this way.

export interface Asked {
  n: number;
}

export interface AsksOptions<R> {
  clean: (said: unknown) => R; // only what an answer has, within bounds
  late: R; // the answer when the screen daemon doesn't give one in time
}

// The daemon's side: asks waiting for the screen daemon, one at a time.
export class Asks<A extends object, R> {
  private next = 1;
  private queue: (A & Asked)[] = [];
  private waiting = new Map<number, (answer: R) => void>();
  private takers: ((ask: (A & Asked) | null) => void)[] = [];
  private o: AsksOptions<R>;

  constructor(options: AsksOptions<R>) {
    this.o = options;
  }

  // An ask, answered by the screen daemon, or not in time.
  ask(what: A, ms: number): Promise<R> {
    const ask = { ...what, n: this.next++ };
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((a) => a !== ask);
        this.waiting.delete(ask.n);
        done(this.o.late);
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
  take(ms = 25_000): Promise<(A & Asked) | null> {
    const ask = this.queue.shift();
    if (ask) return Promise.resolve(ask);
    return new Promise((done) => {
      const taker = (found: (A & Asked) | null) => {
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

  // The screen daemon's answer to an ask that's still waiting.
  answer(n: number, said: unknown): boolean {
    const done = this.waiting.get(n);
    if (!done) return false;
    this.waiting.delete(n);
    done(this.o.clean(said));
    return true;
  }

  // As the daemon stops: every ask still waiting gets the late answer, and
  // every taker none.
  close(): void {
    for (const done of [...this.waiting.values()]) done(this.o.late);
    this.waiting.clear();
    this.queue = [];
    for (const taker of this.takers.splice(0)) taker(null);
  }
}

export interface AskWatchOptions<A, R> {
  url: string; // the daemon: http://127.0.0.1:3000/
  path: string; // where it hands out its asks: "api/builder/page-ask"
  what: string; // what they're for, in the log
  handle: (ask: A & Asked) => Promise<R>;
  failed: (error: Error) => R;
  log?: (line: string) => void;
  retryMs?: number;
}

// The screen daemon's side: it waits for an ask, does it, answers, and
// waits again, for as long as the TV session runs.
export class AskWatch<A, R> {
  private o: Required<AskWatchOptions<A, R>>;
  private stopped = false;
  private abort?: AbortController;

  constructor(options: AskWatchOptions<A, R>) {
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
        const response = await fetch(`${this.o.url}${this.o.path}`, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(40_000)]) });
        const { ask } = (await response.json()) as { ask: (A & Asked) | null };
        if (!ask) continue;
        const answer = await this.o.handle(ask).catch((error: Error) => this.o.failed(error));
        await fetch(`${this.o.url}${this.o.path}/${ask.n}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(answer), signal: AbortSignal.timeout(10_000) });
      } catch (error) {
        if (this.stopped) return;
        this.o.log(`${this.o.what}: ${(error as Error).message}`);
        await new Promise((done) => setTimeout(done, this.o.retryMs));
      }
    }
  }
}
