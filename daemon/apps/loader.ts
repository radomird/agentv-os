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
//
// The worker runs under bubblewrap (workerJail below): its own namespaces,
// no network, and a root with only Node, the system's libraries and the
// app's own package, all read-only. Node's permission model stays on inside
// it as the second layer. An app that can't be started that way isn't
// loaded at all.

import { fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { boxHost } from "../../apps/contract/address.ts";
import type { Capability, Manifest } from "../../apps/contract/manifest.ts";
import { appHeaders, reach } from "./reach.ts";

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
  role: "adult" | "child";
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
  "playback.pause": { capability: "playback", ms: 10_000 },
  "playback.resume": { capability: "playback", ms: 10_000 },
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
// that isn't set, or isn't an http(s) address, gives no origin. Neither
// does one that's written as this box, which an app never reaches: the
// manifest's checks refuse it too, and this holds for an app that was
// installed before they did. thisBox is for the tests, whose servers are
// on this box.
export function allowedOrigins(manifest: Manifest, settings: Record<string, string>, thisBox = false): Set<string> {
  const origins = new Set<string>();
  for (const origin of manifest.tv.origins ?? []) {
    const value = origin.replace(/^\{([A-Za-z][A-Za-z0-9]*)\}/, (_, key: string) => settings[key] ?? "");
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      if (!thisBox && boxHost(url.hostname)) continue;
      origins.add(url.origin);
    } catch {
      // not set yet: nothing to reach
    }
  }
  return origins;
}

// The folders of the system Node needs: itself and its libraries. /lib and
// /lib64 are links into /usr on the box, and folders on some other systems.
export interface SystemPath {
  path: string;
  link?: string; // where it points, when it's a link
}

export function systemPaths(): SystemPath[] {
  const found: SystemPath[] = [{ path: "/usr" }];
  for (const path of ["/lib", "/lib64"]) {
    try {
      if (lstatSync(path).isSymbolicLink()) found.push({ path, link: readlinkSync(path) });
      else found.push({ path });
    } catch {
      // not on this system
    }
  }
  return found;
}

// The box's time zone, which /etc/localtime links to, so an app's clock
// says the time on the wall.
export function timeZoneLink(): string | undefined {
  try {
    return readlinkSync("/etc/localtime");
  } catch {
    return undefined;
  }
}

// bubblewrap's arguments for an app's worker, up to the command. The root
// is an empty one in memory. In it, read-only: the system's /usr with its
// libraries, Node itself, and the files given (the app's package, the
// worker and its package.json), each where it is outside. No network of
// any kind, so a request can only be asked of the loader. No /proc, no
// home, nothing of /var/lib/agentv or /etc/agentv but the app's own
// package. It goes when the loader does.
export function workerJail(o: { dir: string; node: string; read: string[]; system: SystemPath[]; localtime?: string }): string[] {
  const inside = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
  const args = ["--unshare-all", "--unshare-user", "--die-with-parent", "--new-session", "--cap-drop", "ALL"];
  const bound: string[] = [];
  for (const one of o.system) {
    if (one.link !== undefined) {
      args.push("--symlink", one.link, one.path);
    } else {
      args.push("--ro-bind", one.path, one.path);
      bound.push(one.path);
    }
  }
  args.push("--dev", "/dev");
  args.push("--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache");
  if (o.localtime !== undefined) args.push("--symlink", o.localtime, "/etc/localtime");
  for (const path of [o.node, ...o.read, o.dir]) {
    if (bound.some((folder) => inside(path, folder))) continue;
    args.push("--ro-bind", path, path);
    bound.push(path);
  }
  args.push("--chdir", o.dir, "--");
  return args;
}

// Whether bubblewrap can start a sandbox here, or why not. It can on the
// box. A test asks before it leaves the sandbox off (AppHostOptions.harness).
export function sandboxProblem(bwrap = "bwrap"): string | null {
  const node = realpathSync(process.execPath);
  const args = [...workerJail({ dir: dirname(WORKER), node, read: [], system: systemPaths() }), node, "--version"];
  const tried = spawnSync(bwrap, args, { env: {}, encoding: "utf8", timeout: 10_000 });
  if (tried.error) return `${bwrap} didn't run: ${tried.error.message}`;
  if (tried.status !== 0) return (tried.stderr || `it ended with ${tried.status ?? tried.signal}`).trim().split("\n")[0].slice(0, 300);
  return null;
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
  // What answers the app's requests, once they're past the origin check:
  // the network, or the contract tests' fixtures (test/agentv/contract).
  fetch?: typeof fetch;
  log?: (line: string) => void;
  // Only for a test harness, which runs outside the box. Nothing in an
  // app, its manifest or the environment sets these, and the daemons never
  // do. thisBox lets the app reach servers on this box, where a test's
  // stand-in servers are. noSandbox starts the worker without bubblewrap,
  // for a machine where it can't start (sandboxProblem says so).
  harness?: { thisBox?: boolean; noSandbox?: boolean };
  bwrap?: string; // bubblewrap, when it isn't the one on the path
}

export class AppHost {
  readonly manifest: Manifest;
  readonly dir: string;
  private settings: Record<string, string>;
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private stopped = false;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private limits: Partial<Record<string, number>>;
  private userAgent: string;
  private fetcher: typeof fetch;
  private page?: PageBroker;
  private log: (line: string) => void;
  private thisBox: boolean;
  private noSandbox: boolean;
  private bwrap: string;

  constructor(options: AppHostOptions) {
    this.manifest = options.manifest;
    this.dir = resolve(options.dir);
    this.settings = { ...(options.settings ?? {}) };
    this.limits = options.limits ?? {};
    this.userAgent = `${options.userAgent ?? "AgenTV"} ${options.manifest.id}/${options.manifest.version}`;
    this.thisBox = options.harness?.thisBox === true;
    this.noSandbox = options.harness?.noSandbox === true;
    this.bwrap = options.bwrap ?? "bwrap";
    // Out to the network, never to this box, at the addresses that were
    // checked (reach.ts). A test's own fetch answers from its fixtures.
    this.fetcher = options.fetch ?? reach(this.thisBox ? { forbid: () => false, maxBytes: FETCH_MAX_BYTES } : { maxBytes: FETCH_MAX_BYTES });
    this.page = options.page;
    this.log = options.log ?? (() => {});
  }

  // Starts the worker, and checks the module against the manifest. Not once
  // the host is stopped: a call that comes after that, from a timer or an
  // answer still on its way, would start a worker nothing stops.
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new AppError("crashed", `${this.manifest.name} stopped`));
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

    // The channel to the worker is the same either way: Node hands it down
    // as a descriptor, and bubblewrap passes it on to the Node it starts.
    const stdio = ["ignore", "pipe", "pipe", "ipc"] as const;
    let child: ChildProcess;
    if (this.noSandbox) {
      child = fork(WORKER, [entry], { execArgv, env: {}, cwd: this.dir, serialization: "advanced", stdio: [...stdio] });
    } else {
      const node = realpathSync(process.execPath);
      const jail = workerJail({ dir: this.dir, node, read: [WORKER, join(dirname(dirname(WORKER)), "package.json")], system: systemPaths(), localtime: timeZoneLink() });
      // Its own process group, so letGo can end all of it at once.
      child = spawn(this.bwrap, [...jail, node, ...execArgv, WORKER, entry], { env: {}, cwd: this.dir, serialization: "advanced", stdio: [...stdio], detached: true });
    }
    this.child = child;
    // What bubblewrap itself says, which is why the sandbox didn't start.
    let sandbox = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (text: string) => {
        for (const line of text.split("\n")) {
          if (!line) continue;
          if (!sandbox && line.startsWith("bwrap: ")) sandbox = line.slice(0, 300);
          this.log(`${this.manifest.id}: ${line}`.slice(0, 500));
        }
      });
    }

    return new Promise((resolveStart, rejectStart) => {
      const timer = setTimeout(() => {
        letGo(child);
        rejectStart(new AppError("timeout", `${this.manifest.name} didn't start in time`));
      }, START_MS);
      // No sandbox, no app: it never runs outside one instead.
      const unsafe = (why: string) => {
        this.log(`${this.manifest.id}: its sandbox didn't start, so it isn't loaded: ${why}`);
        return new AppError("failed", `${this.manifest.name} couldn't load: this tv couldn't start it safely`);
      };
      let ready = false;
      // Whether the process started at all. An error before that is
      // bubblewrap not running. One after it is something else, such as an
      // answer that came for a worker already stopped, and its exit says the
      // rest.
      let started = false;
      child.on("spawn", () => {
        started = true;
      });
      child.on("error", (error) => {
        if (started) {
          this.log(`${this.manifest.id}: ${error.message}`.slice(0, 500));
          return;
        }
        clearTimeout(timer);
        if (this.child === child) {
          this.child = undefined;
          this.starting = undefined;
        }
        rejectStart(this.noSandbox ? new AppError("failed", `${this.manifest.name} couldn't load: ${error.message}`) : unsafe(`${this.bwrap} didn't run: ${error.message}`));
      });

      child.on("message", (message: Record<string, unknown>) => {
        if (message.type === "ready") {
          ready = true;
          clearTimeout(timer);
          const problem = this.checkModule(String(message.id), message.capabilities as string[]);
          if (problem) {
            letGo(child);
            rejectStart(new AppError("refused", problem));
          } else {
            resolveStart();
          }
        } else if (message.type === "failed") {
          ready = true;
          clearTimeout(timer);
          // The worker ends itself after saying so, but the app's own code
          // ran first and can have replaced what it ends with. So it's let
          // go from here too, and forgotten, before a next start makes
          // another over it.
          if (this.child === child) {
            this.child = undefined;
            this.starting = undefined;
          }
          letGo(child);
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
        rejectStart(!ready && sandbox ? unsafe(sandbox) : new AppError("crashed", `${this.manifest.name} stopped while starting`));
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
        (response) => tell(child, { type: "fetched", id: message.id, response }),
        (error: Error) => tell(child, { type: "fetched", id: message.id, error: error.message }),
      );
    } else if (message.type === "page") {
      this.pageFor(message).then(
        (reply) => tell(child, { type: "paged", id: message.id, ...reply }),
        (error: Error) => tell(child, { type: "paged", id: message.id, error: error.message }),
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
    const allowed = allowedOrigins(this.manifest, this.settings, this.thisBox);
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

  // fetch for the app, to its declared origins only, and never to this box.
  // The app's headers go along, but for the ones only the loader may say.
  private async fetchFor(message: Record<string, unknown>) {
    const url = new URL(String(message.url));
    if (!allowedOrigins(this.manifest, this.settings, this.thisBox).has(url.origin)) {
      this.log(`${this.manifest.id}: refused a fetch to ${url.origin}, which isn't one of its origins`);
      throw new Error(`${url.origin} isn't one of the app's origins`);
    }
    const headers = appHeaders(Array.isArray(message.headers) ? (message.headers as [string, string][]) : []);
    if (!headers.has("user-agent")) headers.set("user-agent", this.userAgent);
    const response = await this.fetcher(url, {
      method: String(message.method),
      headers,
      body: message.body ? new Uint8Array(message.body as Uint8Array) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_MS),
    }).catch((error: Error) => {
      if (/is this tv itself|only by link-local/.test(error.message)) this.log(`${this.manifest.id}: refused a fetch to ${url.origin}: ${error.message}`);
      throw error;
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
    // The worker can be stopped between its start and here, or before the
    // call is sent: the app was updated or removed, or the daemon is closing.
    const stopped = () => new AppError("crashed", `${this.manifest.name} stopped`);
    const child = this.child;
    if (!child?.connected) throw stopped();
    const id = ++this.nextId;
    const ms = this.limits[path] ?? known.ms;
    return new Promise<T>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new AppError("timeout", `${this.manifest.name} took too long to answer ${path}`));
        if (child.connected) this.checkAlive(child);
      }, ms);
      this.pending.set(id, { resolve: resolveCall as (value: unknown) => void, reject: rejectCall, timer });
      void this.pageInfo().then((page) =>
        child.send({ type: "call", id, path: path.split("."), args, settings: this.settings, viewer, page }, (error) => {
          if (!error || !this.pending.delete(id)) return;
          clearTimeout(timer);
          rejectCall(stopped());
        }),
      );
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
    const done = () => {
      clearTimeout(timer);
      child.off("message", pong);
      child.off("exit", done);
    };
    const timer = setTimeout(() => {
      done();
      this.log(`${this.manifest.id}: stuck, so it's stopped`);
      letGo(child);
    }, PING_MS);
    const pong = (message: Record<string, unknown>) => {
      if (message.type === "pong") done();
    };
    child.on("message", pong);
    // A worker that ended by itself meanwhile isn't stuck, and there's
    // nothing left to stop.
    child.on("exit", done);
    tell(child, { type: "ping" });
  }

  setSettings(settings: Record<string, string>): void {
    this.settings = { ...settings };
  }

  // For good: the app was updated or removed, or the daemon is closing, and
  // whoever needs the app again makes a new host for it.
  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    this.starting = undefined;
    if (child) letGo(child);
  }
}

// An answer for a worker, unless it's gone meanwhile: stopped, or ended by
// itself, with the answer still on its way.
function tell(child: ChildProcess, message: Record<string, unknown>): void {
  if (child.connected) child.send(message, () => {});
}

// Ends a worker and everything under it. Killing bubblewrap alone isn't
// enough: caught as it starts, the sandbox it had already forked lives on
// with the worker in it, holding this end's pipes open, and the daemon
// can't end while it does. So the channel and the pipes are closed from
// this side first, which is the worker's sign to go (worker.ts), and then
// bubblewrap is killed with its whole process group. The group reaches a
// sandbox still being set up, which has no worker yet to see the channel
// close. The worker itself is in a session of its own by then.
function letGo(child: ChildProcess): void {
  try {
    if (child.connected) child.disconnect();
  } catch {
    // gone already
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    // no group of its own: a worker started without the sandbox
  }
  child.kill("SIGKILL");
}
