// AgenTV's daemon (PHASE-1-PLAN.md, "Repository layout"): it serves the TV's
// pages and the state behind them, on this box only (127.0.0.1) for now. The
// phone companions reach it over the network from stage 4.
//
// - The welcome page until setup is done, and the home screen (launcher/)
//   after it. Setup isn't built until stage 5, so `agentv setup skip` marks it
//   done for now.
// - /health, which CI's image checks and `agentv selftest` read. The page on
//   the TV tells the daemon each time it has been drawn, so /health can say the
//   welcome screen is really on the TV (S0.1, S1.3, S1.6).
// - The launcher's TypeScript, served as JavaScript with its types stripped,
//   so the box needs no build step, as for the daemon itself.
// - /api/events, a stream of what changed, so the TV follows without polling.
//
// Only requests addressed to this box by name, and coming from its own pages
// or from no page at all (a command on the box), are answered. A web page
// elsewhere can't change anything here.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize, resolve, sep } from "node:path";
import { APPS_TILE, Home } from "./home.ts";
import { installedPackage, userAgent } from "./identity.ts";
import { badState, kindOf, Ledger } from "./ledger.ts";
import { Updates } from "./updates.ts";
import type { Size } from "../launcher/layout.ts";

export interface DaemonOptions {
  root: string; // AgenTV's files: /usr/share/agentv, or a checkout
  state: string; // the daemon's own state: /var/lib/agentv/daemon
  apps?: string; // the box's apps: /var/lib/agentv/apps
  updates?: string; // what the update check and an install write: /var/lib/agentv/update
  builtins?: string | null; // AgenTV's own apps: <root>/apps/builtin, or null for none
  ledger?: string; // the ledger's database: <state>/ledger.db
  port: number;
  host?: string;
  log?: (line: string) => void;
  // The agentv package this daemon runs: the one installed as it starts.
  running?: string;
}

interface Setup {
  done: boolean;
  at?: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ogg": "audio/ogg",
  ".woff2": "font/woff2",
};

// The folders the TV's pages come from, by their first path segment.
const STATIC = ["launcher", "setup"];
const MAX_BODY = 64 * 1024;

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
}

export class Daemon {
  readonly server: Server;
  private options: DaemonOptions;
  private log: (line: string) => void;
  private welcome = { shownAt: null as string | null, lastShownAt: null as string | null, count: 0 };
  private streams = new Set<ServerResponse>();
  private stripped = new Map<string, { mtime: number; code: string }>();
  readonly home: Home;
  readonly updates: Updates;
  private ledgerPath: string;
  private openLedger?: Ledger;
  private running: string;

  constructor(options: DaemonOptions) {
    this.options = options;
    this.running = options.running ?? installedPackage();
    this.log = options.log ?? ((line) => console.log(line));
    this.home = new Home({
      appsDir: options.apps ?? "/var/lib/agentv/apps",
      state: options.state,
      ledger: () => this.ledger,
      builtins: options.builtins === null ? undefined : (options.builtins ?? join(options.root, "apps", "builtin")),
      userAgent: userAgent(options.root),
      changed: (event) => this.broadcast(event, {}),
      log: this.log,
    });
    this.updates = new Updates({ dir: options.updates ?? "/var/lib/agentv/update", state: options.state });
    this.ledgerPath = options.ledger ?? join(options.state, "ledger.db");
    this.updates.watch(() => void this.updates.read().then((state) => this.broadcast("updates", state)));
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: Error) => {
        this.log(`error: ${request.method} ${request.url}: ${error.message}`);
        if (!response.headersSent) this.json(response, 500, { ok: false, error: "something went wrong" });
        else response.end();
      });
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.options.port, this.options.host ?? "127.0.0.1", () => {
        resolve((this.server.address() as { port: number }).port);
      });
    });
  }

  // The ledger, opened the first time something needs it.
  get ledger(): Ledger {
    this.openLedger ??= new Ledger(this.ledgerPath);
    return this.openLedger;
  }

  close(): Promise<void> {
    for (const stream of this.streams) stream.end();
    this.home.stop();
    this.updates.stop();
    this.openLedger?.close();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // --- State --------------------------------------------------------------

  private async settings(): Promise<Record<string, string>> {
    const values: Record<string, string> = { AGENTV_VERSION: "dev", AGENTV_CHANNEL: "dev" };
    const text = await readFile(join(this.options.root, "settings"), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0 && line.slice(0, at) in values) values[line.slice(0, at)] = line.slice(at + 1).trim();
    }
    return values;
  }

  async setup(): Promise<Setup> {
    try {
      const setup = JSON.parse(await readFile(join(this.options.state, "setup.json"), "utf8"));
      return { done: setup.done === true, at: setup.at };
    } catch {
      return { done: false };
    }
  }

  private async saveSetup(setup: Setup): Promise<void> {
    await mkdir(this.options.state, { recursive: true });
    const next = join(this.options.state, ".setup.json.next");
    await writeFile(next, `${JSON.stringify(setup, null, 2)}\n`);
    await rename(next, join(this.options.state, "setup.json"));
  }

  // Tells every page that's listening what changed.
  private broadcast(event: string, data: unknown): void {
    for (const stream of this.streams) stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // --- Requests -----------------------------------------------------------

  // Requests have to be addressed to this box by name (no DNS rebinding), and
  // anything that changes state has to come from one of its own pages or from
  // no page at all.
  private allowed(request: IncomingMessage): { ok: boolean; why?: string } {
    const port = (this.server.address() as { port: number }).port;
    const names = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!names.includes(String(request.headers.host))) return { ok: false, why: "unknown host" };
    if (request.method === "GET" || request.method === "HEAD") return { ok: true };
    const origin = request.headers.origin;
    if (origin !== undefined && !names.map((name) => `http://${name}`).includes(origin)) {
      return { ok: false, why: "not from one of this box's own pages" };
    }
    return { ok: true };
  }

  private json(response: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  }

  private async text(request: IncomingMessage): Promise<string> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new Error("the request is too big");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async body(request: IncomingMessage): Promise<unknown> {
    if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) return undefined;
    try {
      return JSON.parse(await this.text(request));
    } catch {
      return undefined;
    }
  }

  private send(response: ServerResponse, type: string, body: Buffer | string, extra: Record<string, string> = {}): void {
    response.writeHead(200, {
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    });
    response.end(body);
  }

  private async file(response: ServerResponse, relative: string): Promise<void> {
    const path = join(this.options.root, relative);
    const type = TYPES[extname(path).toLowerCase()];
    let info;
    try {
      info = await stat(path);
    } catch {
      this.json(response, 404, { ok: false, error: "not found" });
      return;
    }
    if (!type || !info.isFile()) {
      this.json(response, 404, { ok: false, error: "not found" });
      return;
    }
    let body: Buffer | string = await readFile(path);
    if (path.endsWith(".ts")) {
      const cached = this.stripped.get(path);
      if (cached?.mtime === info.mtimeMs) {
        body = cached.code;
      } else {
        body = stripTypeScriptTypes(body.toString("utf8"), { mode: "strip" });
        this.stripped.set(path, { mtime: info.mtimeMs, code: body });
      }
    }
    response.writeHead(200, {
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const allowed = this.allowed(request);
    if (!allowed.ok) {
      this.log(`refused ${request.method} ${request.url}: ${allowed.why}`);
      this.json(response, 403, { ok: false, error: "not allowed" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = request.method;

    if (method === "GET" && path === "/health") {
      const [info, setup] = await Promise.all([this.settings(), this.setup()]);
      this.json(response, 200, {
        ok: true,
        service: "agentv",
        version: info.AGENTV_VERSION,
        channel: info.AGENTV_CHANNEL,
        // What this process runs, which after an update and before AgenTV's
        // services restart is still the package from before (agentv-restart).
        running: this.running,
        screen: setup.done ? "home" : "welcome",
        welcome_shown: this.welcome.shownAt !== null,
        welcome_shown_at: this.welcome.shownAt,
        welcome_last_shown_at: this.welcome.lastShownAt,
        welcome_shown_count: this.welcome.count,
      });
      return;
    }

    if (method === "POST" && path === "/api/welcome-shown") {
      const at = now();
      this.welcome.shownAt ??= at;
      this.welcome.lastShownAt = at;
      this.welcome.count++;
      response.writeHead(204).end();
      return;
    }

    if (method === "GET" && path === "/api/state") {
      const [info, setup] = await Promise.all([this.settings(), this.setup()]);
      this.json(response, 200, { ok: true, version: info.AGENTV_VERSION, channel: info.AGENTV_CHANNEL, setup });
      return;
    }

    if (method === "POST" && path === "/api/setup") {
      const body = (await this.body(request)) as { done?: unknown } | undefined;
      if (typeof body?.done !== "boolean") {
        this.json(response, 400, { ok: false, error: 'send {"done": true} or {"done": false} as JSON' });
        return;
      }
      const setup: Setup = body.done ? { done: true, at: now() } : { done: false };
      await this.saveSetup(setup);
      this.log(body.done ? "setup marked done" : "setup reset");
      this.broadcast("setup", setup);
      this.json(response, 200, { ok: true, setup });
      return;
    }

    // --- The home screen ---------------------------------------------------

    if (method === "GET" && path === "/api/home") {
      const viewer = await this.home.viewer();
      const [info, setup, apps, layout, settings] = await Promise.all([
        this.settings(),
        this.setup(),
        this.home.apps(),
        this.home.layout(viewer.id),
        this.home.settings(),
      ]);
      this.json(response, 200, {
        ok: true,
        version: info.AGENTV_VERSION,
        channel: info.AGENTV_CHANNEL,
        setup,
        viewer,
        apps,
        appsTile: APPS_TILE,
        layout,
        settings,
      });
      return;
    }

    if (method === "PUT" && path === "/api/layout") {
      const body = (await this.body(request)) as { layout?: unknown } | undefined;
      const viewer = await this.home.viewer();
      const why = await this.home.saveLayout(viewer.id, body?.layout);
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      const layout = await this.home.layout(viewer.id);
      this.broadcast("layout", { viewer: viewer.id, layout });
      this.json(response, 200, { ok: true, layout });
      return;
    }

    // Updates (ADR-025): what the check found, an install's progress, and
    // the release whose toast home has shown.
    if (method === "GET" && path === "/api/updates") {
      this.json(response, 200, { ok: true, ...(await this.updates.read()) });
      return;
    }

    if (method === "POST" && path === "/api/updates/toasted") {
      const body = (await this.body(request)) as { version?: unknown } | undefined;
      const why = await this.updates.markToasted(body?.version);
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      this.json(response, 200, { ok: true });
      return;
    }

    // Install tonight (ADR-025), from Settings → Updates or the phone; the
    // screen daemon does it between 02:00 and 05:00.
    if (method === "POST" && path === "/api/updates/tonight") {
      const why = await this.updates.setTonight(await this.body(request));
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      const state = await this.updates.read();
      this.broadcast("updates", state);
      this.json(response, 200, { ok: true, tonight: state.tonight });
      return;
    }

    // The check after an update (bin/agentv-update-after): does every
    // installed app still load?
    if (method === "GET" && path === "/api/apps/check") {
      this.json(response, 200, { ok: true, apps: await this.home.check() });
      return;
    }

    // What the TV has dealt with: Keep this version on its "something's off"
    // screen, for that check, and the toast after going back.
    if (method === "POST" && path === "/api/updates/seen") {
      const why = await this.updates.markSeen(await this.body(request));
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      this.broadcast("updates", await this.updates.read());
      this.json(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && path === "/api/settings") {
      const why = await this.home.saveSettings(await this.body(request));
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      const settings = await this.home.settings();
      this.broadcast("settings", settings);
      this.json(response, 200, { ok: true, settings });
      return;
    }

    // The viewer, until profiles come (stage 4) the box's own person.
    if (method === "GET" && path === "/api/viewer") {
      this.json(response, 200, { ok: true, viewer: await this.home.viewer() });
      return;
    }

    // The ledger (S3.3): where the viewer got to in an app, from the screen
    // daemon every 10 s while the app is open, and the newest rows.
    if (method === "POST" && path === "/api/ledger") {
      const body = (await this.body(request)) as { app?: unknown; state?: unknown } | undefined;
      const found = typeof body?.app === "string" ? await this.home.package(body.app) : null;
      const why = !found ? "that isn't an app on this box" : badState(body?.state);
      if (why || !found) {
        this.json(response, 400, { ok: false, error: why ?? "that isn't an app on this box" });
        return;
      }
      const viewer = await this.home.viewer();
      this.ledger.viewer(viewer);
      const state = body!.state as Parameters<Ledger["record"]>[3];
      const { inserted, ...row } = this.ledger.record(viewer.id, body!.app as string, kindOf(state, found.category), state);
      // Home draws its continue tiles again for a new row, not for every
      // moved one.
      if (inserted) this.broadcast("ledger", { viewer: viewer.id, app: row.app_id });
      this.json(response, 200, { ok: true, row });
      return;
    }

    if (method === "GET" && path === "/api/ledger") {
      const viewer = await this.home.viewer();
      const rows = this.ledger.recent(viewer.id, {
        app: url.searchParams.get("app") ?? undefined,
        limit: Number(url.searchParams.get("limit")) || 10,
      });
      this.json(response, 200, { ok: true, viewer: viewer.id, rows });
      return;
    }

    // An app that's gone from the box takes its rows with it.
    if (method === "DELETE" && path === "/api/ledger") {
      const app = url.searchParams.get("app") ?? "";
      if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(app) || (await this.home.package(app))) {
        this.json(response, 400, { ok: false, error: "only an app that's gone from the box is forgotten" });
        return;
      }
      this.json(response, 200, { ok: true, forgotten: this.ledger.forget(app) });
      return;
    }

    // What an app said when the screen daemon asked whether it's signed in
    // (ADR-032), for its tile.
    const signedIn = /^\/api\/apps\/([a-z0-9.-]+)\/signed-in$/.exec(path);
    if (method === "POST" && signedIn) {
      const body = (await this.body(request)) as { signedIn?: unknown } | undefined;
      if (typeof body?.signedIn !== "boolean") {
        this.json(response, 400, { ok: false, error: "signedIn is true or false" });
        return;
      }
      if (!(await this.home.signedIn(signedIn[1], body.signedIn))) {
        this.json(response, 404, { ok: false, error: "that isn't an app here that signs in" });
        return;
      }
      this.json(response, 200, { ok: true });
      return;
    }

    const pkg = /^\/api\/apps\/([a-z0-9.-]+)\/package$/.exec(path);
    if (method === "GET" && pkg) {
      const found = await this.home.package(pkg[1]);
      if (!found) {
        this.json(response, 404, { ok: false, error: "not found" });
        return;
      }
      this.json(response, 200, { ok: true, ...found });
      return;
    }

    // Settings → Weather: the city the forecast is for, and the units.
    if (method === "GET" && path === "/api/weather") {
      this.json(response, 200, { ok: true, ...(await this.home.weather()) });
      return;
    }

    if (method === "POST" && path === "/api/weather") {
      const why = await this.home.saveWeather(await this.body(request));
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      const weather = await this.home.weather();
      this.broadcast("weather", { zone: weather.zone, name: weather.name, units: weather.units });
      this.json(response, 200, { ok: true, ...weather });
      return;
    }

    const tile = /^\/api\/tile\/([a-z0-9.-]+)\/([sml])$/.exec(path);
    if (method === "GET" && tile) {
      const content = await this.home.tile(tile[1], tile[2] as Size, await this.home.viewer());
      this.json(response, 200, { ok: true, tile: content });
      return;
    }

    const icon = /^\/api\/apps\/([a-z0-9.-]+)\/icon$/.exec(path);
    if (method === "GET" && icon) {
      const found = await this.home.icon(icon[1]);
      const type = found ? (found.type ?? TYPES[extname(found.path).toLowerCase()]) : undefined;
      if (!found || !type?.startsWith("image/")) {
        this.json(response, 404, { ok: false, error: "not found" });
        return;
      }
      // An app's icon is only ever drawn, never run.
      this.send(response, type, await readFile(found.path), { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      return;
    }

    const launch = /^\/api\/apps\/([a-z0-9.-]+)\/launch$/.exec(path);
    if (method === "GET" && launch) {
      const target = await this.home.launch(launch[1]);
      if (!target) {
        this.json(response, 404, { ok: false, error: "that app can't be opened yet" });
        return;
      }
      this.json(response, 200, { ok: true, ...target });
      return;
    }

    if (method === "GET" && path === "/api/image") {
      const image = await this.home.image(url.searchParams.get("app") ?? "", url.searchParams.get("url") ?? "");
      if (!image) {
        this.json(response, 404, { ok: false, error: "not found" });
        return;
      }
      this.send(response, image.type, image.body);
      return;
    }

    if (method === "GET" && path === "/api/theme.css") {
      this.send(response, TYPES[".css"], await this.home.theme());
      return;
    }

    // From Omarchy's theme-set hook, on this box: the theme's launcher.css.
    if (method === "POST" && path === "/api/theme") {
      if (!(await this.home.saveTheme(await this.text(request)))) {
        this.json(response, 400, { ok: false, error: "that theme has no colours the TV can use" });
        return;
      }
      this.broadcast("theme", {});
      this.json(response, 200, { ok: true });
      return;
    }

    if (method === "GET" && path === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      response.write(": agentv\n\n");
      this.streams.add(response);
      // A comment now and then keeps the connection open through idle hours.
      const beat = setInterval(() => response.write(": beat\n\n"), 25_000);
      request.on("close", () => {
        clearInterval(beat);
        this.streams.delete(response);
      });
      return;
    }

    if (method === "GET" && path === "/") {
      const setup = await this.setup();
      const home = join("launcher", "index.html");
      const hasHome = await stat(join(this.options.root, home)).then((info) => info.isFile(), () => false);
      await this.file(response, setup.done && hasHome ? home : join("setup", "welcome", "index.html"));
      return;
    }

    if (method === "GET" && path === "/logo.svg") {
      await this.file(response, join("branding", "logo.svg"));
      return;
    }

    // A file from one of the TV's page folders, and nowhere else.
    let relative: string;
    try {
      relative = normalize(decodeURIComponent(path)).replace(/^\/+/, "");
    } catch {
      this.json(response, 400, { ok: false, error: "that address isn't valid" });
      return;
    }
    if (method === "GET" && STATIC.includes(relative.split(sep)[0]) && !relative.split(sep).includes("..")) {
      await this.file(response, relative);
      return;
    }

    this.json(response, 404, { ok: false, error: "not found" });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf("--port");
  const port = at >= 0 ? Number(args[at + 1]) : Number(process.env.AGENTV_PORT ?? 3000);
  const daemon = new Daemon({
    root: process.env.AGENTV_PATH ?? "/usr/share/agentv",
    state: process.env.AGENTV_DAEMON_STATE ?? "/var/lib/agentv/daemon",
    apps: process.env.AGENTV_APPS ?? "/var/lib/agentv/apps",
    updates: process.env.AGENTV_UPDATE_STATE ?? "/var/lib/agentv/update",
    port,
  });
  const listening = await daemon.listen();
  console.log(`agentv daemon on http://127.0.0.1:${listening}/`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void daemon.close().then(() => process.exit(0)));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main();
