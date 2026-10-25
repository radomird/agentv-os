// Loads an installed app into a worker of its own (worker.ts) and calls its
// capabilities (PHASE-1-PLAN.md, "App contract"). Each call has a time limit
// and fails with a typed AppError, never a retry: the TV says what went wrong
// instead. The app is held to its manifest: a capability it declares has to
// be in its module, and only the capabilities it declares can be called.
// Its fetch reaches only its declared origins, with setup fields filled in,
// and says it comes from AgenTV and which app it is, unless the app says
// otherwise: a service such as MET Norway asks every request to say who's
// asking (ADR-015). A web app's page (the contract's AppPage) is relayed to a
// PageBroker, the screen daemon's DevTools pipe on the box or a test's own
// browser, and only while the page is on one of the app's origins.

import { fork, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import type { Capability, Manifest } from "../../apps/contract/manifest.ts";

export type AppErrorKind = "refused" | "timeout" | "failed" | "crashed";

export class AppError extends Error {
  readonly kind: AppErrorKind;
  constructor(kind: AppErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface Viewer {
  id: string;
  role: "adult" | "kid";
}

// What drives a web app's real page. url() says where it is now; call() does
// one of PAGE_METHODS there with the worker's arguments.
export interface PageBroker {
  url(): Promise<string>;
  call(method: string, args: unknown[]): Promise<unknown>;
}

export const PAGE_METHODS = ["title", "goto", "evaluate", "waitForSelector", "click", "fill", "press"];

// What each declared capability lets the daemon call, and how long each call
// may take. tile() answers within 3 s (ADR-016).
const CALLS: Record<string, { capability: Capability; ms: number }> = {
  launch: { capability: "launch", ms: 30_000 },
  "signIn.isSignedIn": { capability: "signIn", ms: 10_000 },
  "signIn.open": { capability: "signIn", ms: 30_000 },
  search: { capability: "search", ms: 10_000 },
  "playback.open": { capability: "playback", ms: 30_000 },
  "playback.readPlaybackState": { capability: "playback", ms: 5_000 },
  "playback.next": { capability: "playback", ms: 10_000 },
  "profiles.list": { capability: "profiles", ms: 10_000 },
  "profiles.select": { capability: "profiles", ms: 10_000 },
  nowPlaying: { capability: "nowPlaying", ms: 5_000 },
  tile: { capability: "tile", ms: 3_000 },
};

const WORKER = join(import.meta.dirname, "worker.ts");
const START_MS = 10_000;
const PING_MS = 1_000;
const FETCH_MS = 30_000;
const FETCH_MAX_BYTES = 16 * 1024 * 1024;

// The origins the app may reach, with its setup fields filled in. A field
// that isn't set, or isn't an http(s) address, gives no origin.
export function allowedOrigins(manifest: Manifest, settings: Record<string, string>): Set<string> {
  const origins = new Set<string>();
  for (const origin of manifest.tv.origins ?? []) {
    const value = origin.replace(/^\{([A-Za-z][A-Za-z0-9]*)\}/, (_, key: string) => settings[key] ?? "");
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
    } catch {
      // not set yet: nothing to reach
    }
  }
  return origins;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: AppError) => void;
  timer: NodeJS.Timeout;
}

export interface AppHostOptions {
  dir: string; // the app's package
  manifest: Manifest;
  settings?: Record<string, string>;
  limits?: Partial<Record<string, number>>; // per-call time limits, for tests
  userAgent?: string; // AgenTV's own, like "AgenTV/0.1.2 (+https://...)"
  page?: PageBroker; // a web app's page, when it has one open
  log?: (line: string) => void;
}

export class AppHost {
  readonly manifest: Manifest;
  readonly dir: string;
  private settings: Record<string, string>;
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private limits: Partial<Record<string, number>>;
  private userAgent: string;
  private page?: PageBroker;
  private log: (line: string) => void;

  constructor(options: AppHostOptions) {
    this.manifest = options.manifest;
    this.dir = resolve(options.dir);
    this.settings = { ...(options.settings ?? {}) };
    this.limits = options.limits ?? {};
    this.userAgent = `${options.userAgent ?? "AgenTV"} ${options.manifest.id}/${options.manifest.version}`;
    this.page = options.page;
    this.log = options.log ?? (() => {});
  }

  // Starts the worker, and checks the module against the manifest.
  start(): Promise<void> {
    this.starting ??= this.spawn().catch((error) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private spawn(): Promise<void> {
    const entry = join(this.dir, this.manifest.entryPoints.tvApp ?? "");
    const execArgv = [
      "--permission",
      `--allow-fs-read=${this.dir}/`,
      `--allow-fs-read=${WORKER}`,
      `--allow-fs-read=${join(dirname(dirname(WORKER)), "package.json")}`,
      "--disable-warning=ExperimentalWarning",
    ];
    if (!process.features.typescript) execArgv.push("--experimental-strip-types");

    const child = fork(WORKER, [entry], {
      execArgv,
      env: {},
      cwd: this.dir,
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (text: string) => {
        for (const line of text.split("\n")) if (line) this.log(`${this.manifest.id}: ${line}`.slice(0, 500));
      });
    }

    return new Promise((resolveStart, rejectStart) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectStart(new AppError("timeout", `${this.manifest.name} didn't start in time`));
      }, START_MS);

      child.on("message", (message: Record<string, unknown>) => {
        if (message.type === "ready") {
          clearTimeout(timer);
          const problem = this.checkModule(String(message.id), message.capabilities as string[]);
          if (problem) {
            child.kill("SIGKILL");
            rejectStart(new AppError("refused", problem));
          } else {
            resolveStart();
          }
        } else if (message.type === "failed") {
          clearTimeout(timer);
          rejectStart(new AppError("failed", `${this.manifest.name} couldn't load: ${String(message.message)}`));
        } else {
          this.onMessage(child, message);
        }
      });

      child.on("exit", () => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = undefined;
          this.starting = undefined;
        }
        for (const [id, call] of this.pending) {
          clearTimeout(call.timer);
          call.reject(new AppError("crashed", `${this.manifest.name} stopped`));
          this.pending.delete(id);
        }
        rejectStart(new AppError("crashed", `${this.manifest.name} stopped while starting`));
      });
    });
  }

  private checkModule(id: string, found: string[]): string | null {
    if (id !== this.manifest.id) return `${this.manifest.name}'s module says it's ${id}, not ${this.manifest.id}`;
    for (const capability of this.manifest.tv.capabilities) {
      if (!found.includes(capability)) return `${this.manifest.name} says it can ${capability}, but its module doesn't`;
    }
    return null;
  }

  private onMessage(child: ChildProcess, message: Record<string, unknown>): void {
    if (message.type === "result" || message.type === "error") {
      const call = this.pending.get(message.id as number);
      if (!call) return;
      this.pending.delete(message.id as number);
      clearTimeout(call.timer);
      if (message.type === "result") call.resolve(message.value);
      else call.reject(new AppError("failed", `${this.manifest.name}: ${String(message.message)}`));
    } else if (message.type === "fetch") {
      this.fetchFor(message).then(
        (response) => child.send({ type: "fetched", id: message.id, response }),
        (error: Error) => child.send({ type: "fetched", id: message.id, error: error.message }),
      );
    } else if (message.type === "page") {
      this.pageFor(message).then(
        (reply) => child.send({ type: "paged", id: message.id, ...reply }),
        (error: Error) => child.send({ type: "paged", id: message.id, error: error.message }),
      );
    }
  }

  // One call on the app's page, while the page is on one of the app's
  // origins, and going only to one of them.
  private async pageFor(message: Record<string, unknown>): Promise<{ value: unknown; url: string }> {
    const page = this.page;
    const method = String(message.method);
    if (!page || this.manifest.tv.runtime !== "web") throw new Error(`${this.manifest.name} has no page open`);
    if (!PAGE_METHODS.includes(method)) throw new Error(`a page can't ${method} here`);
    const args = Array.isArray(message.args) ? message.args : [];
    const allowed = allowedOrigins(this.manifest, this.settings);
    const origin = (url: string) => {
      try {
        return new URL(url).origin;
      } catch {
        return "";
      }
    };
    const before = await page.url();
    if (!allowed.has(origin(before))) {
      this.log(`${this.manifest.id}: refused a page call on ${origin(before) || "a page"} that isn't one of its origins`);
      throw new Error("the page isn't on one of the app's origins");
    }
    if (method === "goto" && !allowed.has(origin(String(args[0])))) {
      this.log(`${this.manifest.id}: refused to send its page to ${origin(String(args[0])) || String(args[0]).slice(0, 80)}`);
      throw new Error(`${origin(String(args[0])) || "that address"} isn't one of the app's origins`);
    }
    const value = await page.call(method, args);
    return { value, url: await page.url() };
  }

  // fetch for the app, to its declared origins only.
  private async fetchFor(message: Record<string, unknown>) {
    const url = new URL(String(message.url));
    if (!allowedOrigins(this.manifest, this.settings).has(url.origin)) {
      this.log(`${this.manifest.id}: refused a fetch to ${url.origin}, which isn't one of its origins`);
      throw new Error(`${url.origin} isn't one of the app's origins`);
    }
    const headers = new Headers(message.headers as [string, string][]);
    if (!headers.has("user-agent")) headers.set("user-agent", this.userAgent);
    const response = await fetch(url, {
      method: String(message.method),
      headers,
      body: message.body ? new Uint8Array(message.body as Uint8Array) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_MS),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > FETCH_MAX_BYTES) throw new Error("the answer is too big");
    return { status: response.status, statusText: response.statusText, headers: [...response.headers], body };
  }

  // Calls a capability, like call(viewer, "tile", "m") or
  // call(viewer, "playback.readPlaybackState").
  async call<T = unknown>(viewer: Viewer, path: string, ...args: unknown[]): Promise<T> {
    const known = CALLS[path];
    if (!known || !this.manifest.tv.capabilities.includes(known.capability)) {
      throw new AppError("refused", `${this.manifest.name} doesn't have ${path}`);
    }
    await this.start();
    const child = this.child!;
    const id = ++this.nextId;
    const ms = this.limits[path] ?? known.ms;
    return new Promise<T>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new AppError("timeout", `${this.manifest.name} took too long to answer ${path}`));
        this.checkAlive(child);
      }, ms);
      this.pending.set(id, { resolve: resolveCall as (value: unknown) => void, reject: rejectCall, timer });
      void this.pageInfo().then((page) => child.send({ type: "call", id, path: path.split("."), args, settings: this.settings, viewer, page }));
    });
  }

  // Where the page is as a call starts, so the app's page.url() can answer.
  private async pageInfo(): Promise<{ url: string } | undefined> {
    if (!this.page || this.manifest.tv.runtime !== "web") return undefined;
    return { url: await this.page.url().catch(() => "") };
  }

  // The page the app's calls use from now on, or none.
  setPage(page: PageBroker | undefined): void {
    this.page = page;
  }

  // After a call times out: a worker that doesn't answer a ping within a second
  // is stuck, so it's stopped and the next call starts a new one.
  private checkAlive(child: ChildProcess): void {
    const timer = setTimeout(() => {
      this.log(`${this.manifest.id}: stuck, so it's stopped`);
      child.kill("SIGKILL");
    }, PING_MS);
    const pong = (message: Record<string, unknown>) => {
      if (message.type !== "pong") return;
      clearTimeout(timer);
      child.off("message", pong);
    };
    child.on("message", pong);
    child.send({ type: "ping" });
  }

  setSettings(settings: Record<string, string>): void {
    this.settings = { ...settings };
  }

  stop(): void {
    this.child?.kill("SIGKILL");
    this.child = undefined;
    this.starting = undefined;
  }
}
