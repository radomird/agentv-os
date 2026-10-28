// AgenTV's test TV, in a page app's own frame (builder/gates/, ADR-043).
// Only the test TV in the builder's sandbox serves this, first in the app's
// page, before the kit and the app; home never does. It keeps what the
// tests and AgenTV's checks read: the listeners the app gave the kit, the
// frames it drew, what it asked the network for, what it threw, and its
// memory. Each load runs the one test the host names, with the test API
// builder/prompts/tests.md describes, or none, for AgenTV's own checks.
// Like the kit, it's a plain script with no imports, only types.

interface Snapshot {
  storage: Record<string, unknown>;
  tile: unknown;
  ready: boolean;
  left: boolean;
  calls: { call: string; args: unknown[] }[];
}

interface Test {
  name: string;
  run: (t: unknown) => Promise<void> | void;
}

(() => {
  const host = window.parent;
  if (host === window) return;

  // --- What the checks read ----------------------------------------------

  let listening = { input: 0, back: false, pause: 0 };
  (window as { agentvTestTv?: unknown }).agentvTestTv = (now: typeof listening) => {
    listening = now;
  };

  const errors: string[] = [];
  const said = (value: unknown) => (value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value));
  window.addEventListener("error", (event) => errors.push(event.message || "an error"));
  window.addEventListener("unhandledrejection", (event) => errors.push(said(event.reason)));
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    errors.push(args.map(said).join(" "));
    consoleError(...args);
  };

  // What it asked for: what it loaded, and what its policy refused.
  let declared: string[] = [];
  const asked: { url: string; refused: boolean }[] = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) asked.push({ url: entry.name, refused: false });
  }).observe({ type: "resource", buffered: true });
  document.addEventListener("securitypolicyviolation", (event) => asked.push({ url: event.blockedURI || event.violatedDirective, refused: true }));
  const isDeclared = (url: string) => {
    try {
      const at = new URL(url, location.href);
      if (at.protocol === "blob:" || at.protocol === "data:") return true;
      if (at.host === location.host) return true;
      return declared.includes(at.origin);
    } catch {
      return false;
    }
  };

  // The frames the app drew, by when each was.
  const drawn: number[] = [];
  const raf = window.requestAnimationFrame.bind(window);
  let lastDrawn = -1;
  window.requestAnimationFrame = (callback: FrameRequestCallback) =>
    raf((time) => {
      if (time !== lastDrawn) {
        lastDrawn = time;
        drawn.push(time);
        if (drawn.length > 2000) drawn.splice(0, 1000);
      }
      callback(time);
    });
  // The middle of the times between frames: a frame that waits now and
  // then doesn't move it, a page that's slow all along does.
  const median = (times: number[]) => {
    const gaps = times.slice(1).map((time, i) => time - times[i]).sort((a, b) => a - b);
    return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  };
  let longest = 0;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longest = Math.max(longest, entry.duration);
    }).observe({ type: "longtask", buffered: false });
  } catch {}

  // --- Talking to the host -------------------------------------------------

  let next = 0;
  const waiting = new Map<number, (value: any) => void>();
  const ask = (op: string, extra: object = {}): Promise<any> =>
    new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      host.postMessage({ agentvTest: id, op, ...extra }, "*");
    });

  window.addEventListener("message", (event) => {
    if (event.source !== host || !event.data) return;
    const message = event.data as { agentvTest?: number; value?: unknown; agentvProbe?: number; since?: number };
    if (typeof message.agentvTest === "number") {
      waiting.get(message.agentvTest)?.(message.value);
      waiting.delete(message.agentvTest);
    } else if (typeof message.agentvProbe === "number") {
      // The host's checks: what's been seen, and the frames since a moment.
      const since = typeof message.since === "number" ? message.since : 0;
      const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
      host.postMessage(
        {
          agentvProbe: message.agentvProbe,
          value: {
            now: performance.now(),
            listening,
            errors: [...errors],
            requests: asked.map((r) => ({ url: r.url, declared: !r.refused && isDeclared(r.url) })),
            frames: drawn.filter((time) => time >= since).length,
            median: median(drawn.filter((time) => time >= since)),
            longest,
            memory,
          },
        },
        "*",
      );
    }
  });

  // --- The tests -----------------------------------------------------------

  const tests: Test[] = [];
  (window as { test?: unknown }).test = (name: string, run: Test["run"]) => void tests.push({ name, run });

  // n of this page's own animation frames, whatever the app draws.
  const frames = (n: number) =>
    new Promise<void>((resolve) => {
      let left = Math.max(1, Math.floor(n));
      const tick = () => (--left <= 0 ? resolve() : raf(tick));
      raf(tick);
    });

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  async function run(index: number, test: Test): Promise<void> {
    let state: Snapshot = await ask("started");
    const failed: string[] = [];
    const fresh = async (op: string, extra: object = {}) => {
      const answer = await ask(op, extra);
      state = answer.state;
      return answer;
    };
    const t = {
      press: (button: string, options: { source?: string; pad?: number } = {}) => fresh("press", { button, ...options }),
      down: (button: string, options: { source?: string; pad?: number } = {}) => fresh("down", { button, ...options }),
      up: (button: string, options: { source?: string; pad?: number } = {}) => fresh("up", { button, ...options }),
      back: async () => (await fresh("back")).kept === true,
      wait: async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(0, ms), 10_000)));
        await fresh("state");
      },
      frames: async (n: number) => {
        await frames(n);
        await fresh("state");
      },
      storage: () => ({ ...state.storage }),
      tile: () => state.tile ?? null,
      listening: () => ({ ...listening }),
      ready: () => state.ready,
      left: () => state.left,
      calls: (name: string, filter?: (args: unknown[]) => boolean) => state.calls.filter((c) => c.call === name && (!filter || filter(c.args))).length,
      requests: () => asked.map((r) => ({ url: r.url, declared: !r.refused && isDeclared(r.url) })),
      errors: () => [...errors],
      ok: (value: unknown, message = "expected it to be true") => void (value ? null : failed.push(message)),
      equal: (actual: unknown, expected: unknown, message = "expected them to be the same") =>
        void (same(actual, expected) ? null : failed.push(`${message}: ${JSON.stringify(actual)?.slice(0, 200)} isn't ${JSON.stringify(expected)?.slice(0, 200)}`)),
    };
    try {
      await test.run(t);
    } catch (error) {
      failed.push(`it threw: ${said(error)}`);
    }
    host.postMessage({ agentvTest: 0, op: "result", index, name: test.name, ok: failed.length === 0, failed }, "*");
  }

  window.addEventListener("load", async () => {
    const plan = await ask("which", { names: tests.map((test) => test.name) });
    declared = plan.declared ?? [];
    if (typeof plan.index === "number" && plan.index >= 0 && tests[plan.index]) await run(plan.index, tests[plan.index]);
  });
})();
