// One app, in a process of its own (PHASE-1-PLAN.md, "App contract"). The
// loader (loader.ts) starts this file with Node's permission model: the
// process can read only its own app's package and this file, and it can't
// start processes or threads, load addons or open connections. Its fetch goes
// through the loader, which lets it reach only the app's declared origins.
// It talks to nothing but the loader, over the IPC channel.
//
// This file imports nothing outside Node itself, since anything it imported
// would need reading too.

type Request =
  | { type: "call"; id: number; path: string[]; args: unknown[]; settings: Record<string, string>; viewer: Viewer }
  | { type: "fetched"; id: number; response?: Fetched; error?: string }
  | { type: "ping" };

interface Viewer {
  id: string;
  role: "adult" | "kid";
}

interface Fetched {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array;
}

const send = process.send!.bind(process);
const entry = process.argv[2];

// What an app could use to reach past its sandbox, gone before its code runs.
// The permission model already refuses files, processes and (on Node 25 and
// later) the network; these close the rest.
const proc = process as unknown as Record<string, unknown>;
function remove(owner: Record<string, unknown>, name: string): void {
  try {
    delete owner[name];
  } catch {
    owner[name] = undefined;
  }
}
for (const name of ["kill", "dlopen", "binding", "_linkedBinding", "getBuiltinModule", "chdir", "abort", "setuid", "setgid"]) {
  remove(proc, name);
}
const globals = globalThis as unknown as Record<string, unknown>;
for (const name of ["WebSocket", "EventSource"]) remove(globals, name);

// fetch, through the loader. Redirects come back to the app as they are, so
// each address it follows is checked too.
let nextFetch = 0;
const fetching = new Map<number, { resolve: (value: Fetched) => void; reject: (error: Error) => void }>();
globals.fetch = async (input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
  const request = new globalThis.Request(input, { ...init, redirect: "manual" });
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  const id = ++nextFetch;
  const fetched = await new Promise<Fetched>((resolve, reject) => {
    fetching.set(id, { resolve, reject });
    send({ type: "fetch", id, url: request.url, method: request.method, headers: [...request.headers], body });
  });
  const nullBody = [101, 103, 204, 205, 304].includes(fetched.status);
  return new Response(nullBody ? null : new Uint8Array(fetched.body), {
    status: fetched.status,
    statusText: fetched.statusText,
    headers: fetched.headers,
  });
};

function resolvePath(app: Record<string, unknown>, path: string[]): ((...args: unknown[]) => unknown) | undefined {
  let target: unknown = app;
  let owner: unknown = app;
  for (const key of path) {
    owner = target;
    target = target && typeof target === "object" ? (target as Record<string, unknown>)[key] : undefined;
  }
  return typeof target === "function" ? (target as (...args: unknown[]) => unknown).bind(owner) : undefined;
}

// Which capabilities the module really has, so the loader can hold it to its
// manifest.
function capabilities(app: Record<string, unknown>): string[] {
  const has = (...path: string[]) => resolvePath(app, path) !== undefined;
  const found: string[] = [];
  if (has("launch")) found.push("launch");
  if (has("signIn", "isSignedIn")) found.push("signIn");
  if (has("search")) found.push("search");
  if (has("playback", "open") && has("playback", "readPlaybackState")) found.push("playback");
  if (has("profiles", "list") && has("profiles", "select")) found.push("profiles");
  if (has("nowPlaying")) found.push("nowPlaying");
  if (has("tile")) found.push("tile");
  return found;
}

let app: Record<string, unknown>;
try {
  const module = await import(entry);
  app = module.default;
  if (!app || typeof app !== "object") throw new Error("its module has no default export");
  send({ type: "ready", id: String(app.id), capabilities: capabilities(app) });
} catch (error) {
  send({ type: "failed", message: (error as Error).message ?? String(error) });
  process.exit(1);
}

process.on("message", async (message: Request) => {
  if (message.type === "ping") {
    send({ type: "pong" });
  } else if (message.type === "fetched") {
    const waiting = fetching.get(message.id);
    fetching.delete(message.id);
    if (message.response) waiting?.resolve(message.response);
    else waiting?.reject(new TypeError(`fetch failed: ${message.error}`));
  } else if (message.type === "call") {
    const fn = resolvePath(app, message.path);
    try {
      if (!fn) throw new Error(`the app has no ${message.path.join(".")}`);
      const ctx = { settings: message.settings, viewer: message.viewer };
      const value = await fn(ctx, ...message.args);
      try {
        send({ type: "result", id: message.id, value });
      } catch {
        send({ type: "error", id: message.id, message: "the app answered with something that can't be passed on" });
      }
    } catch (error) {
      send({ type: "error", id: message.id, message: (error as Error)?.message ?? String(error) });
    }
  }
});
