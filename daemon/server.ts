// AgenTV's daemon (PHASE-1-PLAN.md, "Repository layout"): it serves the TV's
// pages and the state behind them on this box only (127.0.0.1:3000), the
// phone companion on the home network (port 3001), where only a paired phone
// gets past pairing, and the setup hotspot's captive page (port 3002), on
// the hotspot's own address only (stage 4).
//
// - TV setup (setup/) until it's done, and the home screen (launcher/) after
//   it. Setup keeps its step in setup.json (daemon/setup.ts), and `agentv
//   setup skip` marks it done.
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

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize, resolve, sep } from "node:path";
import { APPS_TILE, Home } from "./home.ts";
import { installedPackage, userAgent } from "./identity.ts";
import { Ai, OFFERS, TERMS_READ } from "./ai.ts";
import { ARCHIVES, ArtArchives, type ArtOptions } from "./art.ts";
import { Backgrounds, MAX_BYTES as MAX_PHOTO } from "./backgrounds.ts";
import type { IndexEntry } from "./apps/index.ts";
import { badState, kindOf, Ledger } from "./ledger.ts";
import { HOTSPOT_ADDRESS, Hotspot, wifiQr } from "./hotspot.ts";
import { ProviderKey } from "./key.ts";
import { Phones } from "./phones.ts";
import { Pin, type PinStatus } from "./pin.ts";
import { Profiles, type Profile } from "./profiles.ts";
import { network, PARTS, Setup, STEPS, type SetupState } from "./setup.ts";
import { SetupApps } from "./setup-apps.ts";
import { currentTheme, previews } from "./themes.ts";
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
  // This boot's id, which the PIN's lock goes by: the kernel's, by default.
  bootId?: () => string;
  // Which provider has a key: /etc/agentv/key.json, which agentv-key-store
  // writes, and how long that may take.
  keyStatus?: string;
  keyWaitMs?: number;
  // Setup's apps: what agentv-setup-apps writes as it installs them
  // (/run/agentv-setup-apps/state.json), how long it may take to start, and
  // the official apps in the index, in place of the signed index itself.
  setupAppsStatus?: string;
  setupAppsWaitMs?: number;
  setupCatalog?: (source: string) => Promise<IndexEntry[]>;
  // Omarchy's own files, whose themes setup previews: /usr/share/omarchy.
  omarchy?: string;
  // The backgrounds and their credits: /var/lib/agentv/backgrounds.
  backgrounds?: string;
  // Tests point the museum archives at their own server.
  art?: Pick<ArtOptions, "endpoints" | "imageHosts" | "fetch">;
  // The phone companion's port on the home network, or none. 3001 on the box.
  lanPort?: number;
  lanHost?: string;
  // The box's address on the home network, for the pairing QR code.
  address?: () => string | null;
  // Its network interfaces, which say whether setup is online.
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  // qrencode, which draws the QR code.
  qrencode?: string;
  // The setup hotspot's captive page: its port, which agentv-hotspot sends
  // the phone's port 80 to (3002 on the box), or none; what agentv-hotspot
  // writes (/run/agentv-hotspot); and the box's address on the hotspot,
  // which the page answers on and nowhere else.
  setupPort?: number;
  setupHost?: string;
  hotspotRun?: string;
  hotspotAddress?: string;
  // How long a phone's ask for the state waits for a change (25 s).
  phoneWaitMs?: number;
}

// The box's address on the home network: its first wired or Wi-Fi IPv4
// address, never a container's, a VM bridge's or its own setup hotspot's.
export function lanAddress(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | null {
  const all = Object.entries(interfaces).filter(([name]) => !/^(lo|docker|br-|veth|virbr|tun|tap)/.test(name));
  all.sort(([a], [b]) => Number(/^(en|eth|wl)/.test(b)) - Number(/^(en|eth|wl)/.test(a)));
  for (const [, addresses] of all) {
    const found = addresses?.find((a) => a.family === "IPv4" && !a.internal && a.address !== HOTSPOT_ADDRESS);
    if (found) return found.address;
  }
  return null;
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
// All the captive page needs, and all a phone on the setup hotspot gets.
const CAPTIVE_FILES = ["companion-web/setup.ts", "companion-web/lib.ts", "companion-web/companion.css", "launcher/glyphs.ts"];
const MAX_BODY = 64 * 1024;
// How long a phone's ask for the state waits for something to change.
const PHONE_WAIT_MS = 25_000;
const FIELD_KINDS = ["text", "search", "email", "password", "number", "url"];

// What's on the TV, for the phone's remote to follow (ADR-037). The TV's page
// says what it shows: the PIN pad, what asks for it and how many digits are
// in, a text field with the focus and its kind, and home, a menu or the
// ambient screen. The screen daemon says what's in front and whether
// something plays. The desktop's relay says when Omarchy's desktop is on.
export interface TvContext {
  pin: { title: string; for: string; digits: number; error: string | null } | null;
  field: { kind: string } | null;
  screen: "home" | "menu" | "ambient";
  front: "home" | "app";
  playing: boolean;
  desktop: boolean;
}

// The page the phone's remote opens on, from what's on the TV.
export function remoteView(tv: TvContext, signingIn: boolean): "trackpad" | "pin" | "keyboard" | "playback" | "remote" {
  if (tv.desktop) return "trackpad";
  if (tv.pin) return "pin";
  if (tv.field || signingIn) return "keyboard";
  if (tv.playing) return "playback";
  return "remote";
}

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
  readonly pin: Pin;
  readonly profiles: Profiles;
  readonly key: ProviderKey;
  readonly phones: Phones;
  readonly hotspot: Hotspot;
  readonly setupState: Setup;
  readonly ai: Ai;
  readonly setupApps: SetupApps;
  readonly backgrounds: Backgrounds;
  private art: ArtArchives;
  // The phone companion's listener, on the home network.
  readonly lan?: Server;
  // The setup hotspot's captive page.
  readonly captive?: Server;
  // The screen daemon, taking the phone's keys and text for the virtual
  // input device.
  private remotes = new Set<ServerResponse>();
  // AgenTV's sign-in screen, while it's on the TV (ADR-032): the phone then
  // offers fields its password manager fills.
  private signingIn: { app: string; name: string } | null = null;
  // What's on the TV for the phones (ADR-037), and a count that goes up with
  // every change the phones should hear, which their asks for the state wait
  // on.
  private tv: TvContext = { pin: null, field: null, screen: "home", front: "home", playing: false, desktop: false };
  private phoneVersion = 1;
  private phoneWaiters = new Set<() => void>();
  // Omarchy's desktop's relay for the phone's trackpad, while it's on.
  private desktops = new Set<ServerResponse>();
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
      viewer: () => this.profiles.active(),
      goal: async () => (await this.setup()).goal,
      changed: (event) => this.broadcast(event, {}),
      log: this.log,
    });
    this.updates = new Updates({ dir: options.updates ?? "/var/lib/agentv/update", state: options.state });
    this.profiles = new Profiles({ ledger: () => this.ledger, state: options.state });
    this.key = new ProviderKey({ state: options.state, status: options.keyStatus, waitMs: options.keyWaitMs });
    this.phones = new Phones({ path: join(options.state, "phones.json") });
    this.hotspot = new Hotspot({ state: options.state, run: options.hotspotRun });
    this.setupState = new Setup({ path: join(options.state, "setup.json") });
    this.ai = new Ai({ state: options.state });
    this.backgrounds = new Backgrounds({ dir: options.backgrounds ?? "/var/lib/agentv/backgrounds" });
    this.art = new ArtArchives({ cache: options.state, userAgent: userAgent(options.root), ...options.art });
    this.setupApps = new SetupApps({
      state: options.state,
      status: options.setupAppsStatus,
      source: async () => process.env.AGENTV_INDEX_URL || (await this.settings()).AGENTV_INDEX_URL || undefined,
      catalog: options.setupCatalog,
      waitMs: options.setupAppsWaitMs,
      // The setup screens hear each install move on, and home gets each
      // app as it lands.
      onChange: (apps) => {
        this.broadcast("setup-apps", apps);
        this.broadcast("apps", {});
      },
    });
    if (options.lanPort !== undefined) {
      this.lan = createServer((request, response) => {
        this.handlePhone(request, response).catch((error: Error) => {
          this.log(`error: phone ${request.method} ${new URL(request.url ?? "/", "http://phone").pathname}: ${error.message}`);
          if (!response.headersSent) this.json(response, 500, { ok: false, error: "something went wrong" });
          else response.end();
        });
      });
    }
    if (options.setupPort !== undefined) {
      this.captive = createServer((request, response) => {
        this.handleCaptive(request, response).catch((error: Error) => {
          this.log(`error: setup page ${request.method} ${new URL(request.url ?? "/", "http://setup").pathname}: ${error.message}`);
          if (!response.headersSent) this.json(response, 500, { ok: false, error: "something went wrong" });
          else response.end();
        });
      });
    }
    // A child's profile, or one that asks for the PIN to open, keeps the PIN
    // on (ADR-009, ADR-034): see DELETE /api/pin.
    this.pin = new Pin({ path: join(options.state, "pin.json"), bootId: options.bootId });
    this.ledgerPath = options.ledger ?? join(options.state, "ledger.db");
    this.updates.watch(() => void this.updates.read().then((state) => this.broadcast("updates", state)));
    this.home.watchApps();
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: Error) => {
        this.log(`error: ${request.method} ${request.url}: ${error.message}`);
        if (!response.headersSent) this.json(response, 500, { ok: false, error: "something went wrong" });
        else response.end();
      });
    });
  }

  listen(): Promise<number> {
    const lan = this.lan;
    const captive = this.captive;
    const phones = Promise.all([
      lan ? new Promise<void>((resolve) => lan.listen(this.options.lanPort, this.options.lanHost ?? "0.0.0.0", () => resolve())) : null,
      captive ? new Promise<void>((resolve) => captive.listen(this.options.setupPort, this.options.setupHost ?? "0.0.0.0", () => resolve())) : null,
    ]);
    return phones.then(
      () =>
        new Promise((resolve) => {
          this.server.listen(this.options.port, this.options.host ?? "127.0.0.1", () => {
            resolve((this.server.address() as { port: number }).port);
          });
        }),
    );
  }

  // The phone companion's port, once it listens.
  get lanPort(): number | null {
    const address = this.lan?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  // The captive page's port, once it listens.
  get setupPort(): number | null {
    const address = this.captive?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  // The ledger, opened the first time something needs it.
  get ledger(): Ledger {
    this.openLedger ??= new Ledger(this.ledgerPath);
    return this.openLedger;
  }

  close(): Promise<void> {
    for (const stream of this.streams) stream.end();
    for (const stream of this.remotes) stream.end();
    this.lan?.close();
    this.captive?.close();
    this.home.stop();
    this.updates.stop();
    this.setupApps.stop();
    this.openLedger?.close();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // --- State --------------------------------------------------------------

  private async settings(): Promise<Record<string, string>> {
    const values: Record<string, string> = { AGENTV_VERSION: "dev", AGENTV_CHANNEL: "dev", AGENTV_INDEX_URL: "" };
    const text = await readFile(join(this.options.root, "settings"), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0 && line.slice(0, at) in values) values[line.slice(0, at)] = line.slice(at + 1).trim();
    }
    return values;
  }

  setup(): Promise<SetupState> {
    return this.setupState.read();
  }

  // Tells every page that's listening what changed, and the phones too.
  private broadcast(event: string, data: unknown): void {
    for (const stream of this.streams) stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    this.phonesChanged();
  }

  // Wakes every phone waiting for the state to change.
  private phonesChanged(): void {
    this.phoneVersion++;
    for (const wake of this.phoneWaiters) wake();
    this.phoneWaiters.clear();
  }

  // What changed on the TV, from its page or the screen daemon. Only what's
  // there and right is taken; the phones hear when something did change.
  private tvChanged(change: Record<string, unknown>): void {
    const next: TvContext = { ...this.tv };
    if (change.pin === null) next.pin = null;
    else if (change.pin && typeof change.pin === "object") {
      const pin = change.pin as Record<string, unknown>;
      if (typeof pin.for === "string") {
        next.pin = {
          title: typeof pin.title === "string" ? pin.title.slice(0, 60) : "enter the adult pin",
          for: pin.for.slice(0, 120),
          digits: Math.max(0, Math.min(4, Number(pin.digits) || 0)),
          error: typeof pin.error === "string" ? pin.error.slice(0, 120) : null,
        };
      }
    }
    if (change.field === null) next.field = null;
    else if (change.field && typeof change.field === "object") {
      const kind = (change.field as Record<string, unknown>).kind;
      next.field = { kind: typeof kind === "string" && FIELD_KINDS.includes(kind) ? kind : "text" };
    }
    if (change.screen === "home" || change.screen === "menu" || change.screen === "ambient") next.screen = change.screen;
    if (change.front === "home" || change.front === "app") next.front = change.front;
    if (typeof change.playing === "boolean") next.playing = change.playing;
    if (JSON.stringify(next) === JSON.stringify(this.tv)) return;
    this.tv = next;
    this.phonesChanged();
  }

  // The phone's state: who's watching, the lock, a sign-in, an update and
  // what's on the TV, with the count it's at.
  private async phoneState(phone: unknown): Promise<object> {
    const viewer = await this.profiles.active();
    const pin = this.pin.status(viewer.locked);
    const setup = await this.setup();
    return {
      ok: true,
      version: this.phoneVersion,
      phone,
      viewer,
      viewers: await this.profiles.list(),
      pin: { set: pin.set, locked: pin.locked },
      signIn: this.signingIn ? { name: this.signingIn.name } : null,
      update: await this.phoneUpdate(),
      tv: { ...this.tv, view: remoteView(this.tv, this.signingIn !== null) },
      // TV setup's step, while it's on (stage 5): the phone says where it is.
      setup: setup.done ? null : { step: setup.step, part: PARTS[setup.step], muted: setup.muted },
      // What setup's AI step asks of the phone (ADR-023): the provider's
      // terms for an adult to accept, then the key.
      ai: await this.aiAsk(setup),
    };
  }

  private async aiAsk(setup: SetupState): Promise<object | null> {
    if (setup.done || setup.step !== "ai") return null;
    const ai = await this.ai.read();
    if (!ai.provider || !ai.path) return null;
    const key = this.key.status();
    const ask = !ai.accepted ? "terms" : ai.path === "key" && !(key.set && key.provider === ai.provider) ? "key" : null;
    if (!ask) return null;
    const offer = OFFERS[ai.provider];
    return { ask, provider: ai.provider, path: ai.path, name: offer.name, maker: offer.maker, plan: offer.plan.name, terms: offer.terms[ai.path], summary: offer.summary[ai.path], keyUrl: offer.keyUrl };
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

  // The box's address for a phone: the one on the Wi-Fi the setup hotspot
  // joined, since the phone went back to it too, or else its address on the
  // home network.
  private boxAddress(): string | null {
    const joined = this.hotspot.status().joined?.address;
    if (joined && Object.values(networkInterfaces()).some((list) => list?.some((a) => a.address === joined))) return joined;
    return (this.options.address ?? lanAddress)();
  }

  // The code on show, and the address it pairs at.
  private pairing(): { code: string; until: string; url: string | null } | null {
    const showing = this.phones.showing();
    if (!showing) return null;
    const address = this.boxAddress();
    const port = this.lanPort;
    return { ...showing, url: address && port ? `http://${address}:${port}/?code=${showing.code}` : null };
  }

  private qr(text: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(this.options.qrencode ?? "qrencode", ["-t", "SVG", "-m", "1", "-o", "-", text], { timeout: 5000 }, (error, stdout) =>
        resolve(error || !stdout.includes("<svg") ? null : stdout),
      );
    });
  }

  // Omarchy's desktop came or went: the phone's remote opens on the
  // trackpad while it's on.
  private desktopChanged(): void {
    const desktop = this.desktops.size > 0;
    if (desktop === this.tv.desktop) return;
    this.tv = { ...this.tv, desktop };
    this.phonesChanged();
  }

  // The phone's keys and text, to the screen daemon. False with no TV
  // session to take them.
  private remote(event: Record<string, unknown>): boolean {
    if (this.remotes.size === 0) return false;
    for (const stream of this.remotes) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  }

  // The update notice the TV shows, for the phone (S4.8): what there is to
  // install, What's new, and whether it's going in tonight.
  private async phoneUpdate(): Promise<object | null> {
    const state = await this.updates.read();
    const status = state.status as {
      agentv?: { installed?: string | null; available?: string | null };
      omarchy?: { available?: string | null };
      packages?: number;
      waiting?: boolean;
      notes?: { agentv?: string[] };
    } | null;
    const progress = state.progress as { state?: string; at?: string } | null;
    const installing = Boolean(progress && ["running", "restarting", "going-back"].includes(progress.state ?? "") && Date.now() - Date.parse(progress.at ?? "") < 15 * 60_000);
    const ready = Boolean(status && (status.agentv?.available || status.omarchy?.available || (status.packages ?? 0) > 0) && !status.waiting);
    if (!ready && !installing) return null;
    const version = status?.agentv?.available ?? "packages";
    return {
      version,
      installed: status?.agentv?.installed ?? null,
      omarchy: status?.omarchy?.available ?? null,
      notes: status?.notes?.agentv ?? [],
      tonight: state.tonight?.version === version,
      later: state.seen?.later === version,
      installing,
    };
  }

  // --- The setup hotspot's captive page ---------------------------------------

  // Answers on the hotspot's own address and nowhere else. A phone that joins
  // the hotspot asks for a page it knows to find out whether it's online
  // (iOS and Android each have one), and every name points here, so a
  // request for any other name goes to the captive page, which the phone
  // then opens on its own. The page lists the networks the box could see,
  // and hands the one picked, with its password, to root.
  private async handleCaptive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = this.options.hotspotAddress ?? HOTSPOT_ADDRESS;
    if ((request.socket.localAddress ?? "").replace(/^::ffff:/, "") !== address) {
      request.socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://setup");
    const path = url.pathname;
    const method = request.method;
    if (String(request.headers.host ?? "").replace(/:\d+$/, "") !== address) {
      response.writeHead(302, { Location: `http://${address}/`, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const origin = request.headers.origin;
    if (method !== "GET" && origin !== undefined && origin !== `http://${request.headers.host}`) {
      this.json(response, 403, { ok: false, error: "not from the setup page" });
      return;
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      await this.file(response, join("companion-web", "setup.html"));
      return;
    }
    if (method === "GET" && CAPTIVE_FILES.includes(path.slice(1))) {
      await this.file(response, path.slice(1));
      return;
    }
    if (method === "GET" && path === "/api/theme.css") {
      this.send(response, TYPES[".css"], await this.home.theme());
      return;
    }

    // The networks the box could see before it opened its own.
    if (method === "GET" && path === "/api/setup/networks") {
      const hotspot = this.hotspot.status();
      this.json(response, 200, { ok: true, hotspot: hotspot.ssid, networks: this.hotspot.networks() });
      return;
    }

    // How joining goes, for a phone back on the hotspot after a wrong
    // password.
    if (method === "GET" && path === "/api/setup/state") {
      const { on, joining, joined, error } = this.hotspot.status();
      this.json(response, 200, { ok: true, on, joining, joined, error });
      return;
    }

    // The home Wi-Fi to join. Its password goes to root and nowhere else.
    if (method === "POST" && path === "/api/setup/wifi") {
      const body = (await this.body(request)) as { ssid?: unknown; password?: unknown } | undefined;
      const why = this.hotspot.join(body?.ssid, body?.password ?? "");
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      this.log(`a phone on the setup hotspot asked to join ${String(body?.ssid)}`);
      this.json(response, 200, { ok: true, joining: body?.ssid });
      return;
    }

    this.json(response, 404, { ok: false, error: "not found" });
  }

  // --- The phone companion, on the home network ------------------------------

  // Only the companion's page and its requests are here, never the TV's own.
  // Past pairing, every request needs the phone's token. A request that
  // changes something has to come from the companion's own page.
  private async handlePhone(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://phone");
    const path = url.pathname;
    const method = request.method;
    const origin = request.headers.origin;
    if (method !== "GET" && origin !== undefined && origin !== `http://${request.headers.host}`) {
      this.json(response, 403, { ok: false, error: "not from the phone companion's page" });
      return;
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      await this.file(response, join("companion-web", "index.html"));
      return;
    }
    // The home screen's grid, which arrange home shares with the TV, and
    // the icons both draw.
    if (method === "GET" && (path === "/launcher/layout.ts" || path === "/launcher/glyphs.ts")) {
      await this.file(response, join("launcher", path.slice("/launcher/".length)));
      return;
    }
    if (method === "GET" && path.startsWith("/companion-web/")) {
      let relative: string;
      try {
        relative = normalize(decodeURIComponent(path)).replace(/^\/+/, "");
      } catch {
        this.json(response, 400, { ok: false, error: "that address isn't valid" });
        return;
      }
      if (relative.split(sep)[0] === "companion-web" && !relative.split(sep).includes("..")) {
        await this.file(response, relative);
        return;
      }
    }

    // The Omarchy theme's colours, as on the TV.
    if (method === "GET" && path === "/api/theme.css") {
      this.send(response, TYPES[".css"], await this.home.theme());
      return;
    }

    if (method === "POST" && path === "/api/phone/pair") {
      const body = (await this.body(request)) as { code?: unknown; name?: unknown } | undefined;
      const paired = this.phones.pair(body?.code, body?.name);
      if ("error" in paired) {
        this.log("a phone sent a wrong pairing code");
        this.json(response, 403, { ok: false, error: paired.error });
        return;
      }
      this.log(`${paired.phone.name} is paired`);
      this.broadcast("phones", { paired: paired.phone.name });
      this.json(response, 200, { ok: true, token: paired.token, phone: paired.phone });
      return;
    }

    const auth = String(request.headers.authorization ?? "");
    const phone = this.phones.who(auth.startsWith("Bearer ") ? auth.slice(7) : undefined);
    if (!phone) {
      this.json(response, 401, { ok: false, error: "this phone isn't paired: pair it from the tv", pair: true });
      return;
    }

    // The phone asks with the count it has, and the answer waits until
    // something changes or 25 s go by, so what changes on the TV reaches it
    // within a second (ADR-037). With no count, it answers at once.
    if (method === "GET" && path === "/api/phone/state") {
      const since = Number(url.searchParams.get("since"));
      if (since === this.phoneVersion) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            this.phoneWaiters.delete(wake);
            resolve();
          }, this.options.phoneWaitMs ?? PHONE_WAIT_MS);
          this.phoneWaiters.add(wake);
          request.on("close", () => {
            this.phoneWaiters.delete(wake);
            clearTimeout(timer);
            resolve();
          });
        });
        if (response.destroyed) return;
      }
      this.json(response, 200, await this.phoneState(phone));
      return;
    }

    // The Settings button beside Home and Back (ADR-037): Settings opens on
    // the TV, which asks for the PIN for each adult action in it, as always.
    // A child's profile doesn't have it.
    if (method === "POST" && path === "/api/phone/settings") {
      if ((await this.profiles.active()).role !== "adult") {
        this.json(response, 403, { ok: false, error: "settings aren't on a child's profile" });
        return;
      }
      this.broadcast("page", { route: "settings" });
      this.json(response, 200, { ok: true });
      return;
    }

    // Arrange home (S4.7): the viewer's grid and the apps that can go on it.
    if (method === "GET" && path === "/api/phone/home") {
      const viewer = await this.profiles.active();
      const [apps, layout] = await Promise.all([this.home.apps(viewer), this.home.layout(viewer.id, viewer.role)]);
      this.json(response, 200, {
        ok: true,
        viewer,
        appsTile: APPS_TILE,
        apps: apps.map((app) => ({ id: app.id, name: app.name, sizes: app.sizes })),
        layout,
      });
      return;
    }

    // A tile moved, resized, pinned or unpinned on the phone: the TV follows
    // within a second. A child's home is an adult's to arrange, past the PIN.
    if (method === "PUT" && path === "/api/phone/layout") {
      if (!(await this.adult(request, response, "arranging home from a phone"))) return;
      const body = (await this.body(request)) as { layout?: unknown } | undefined;
      const viewer = await this.profiles.active();
      const why = await this.home.saveLayout(viewer.id, body?.layout, viewer.role);
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      const layout = await this.home.layout(viewer.id, viewer.role);
      this.broadcast("layout", { viewer: viewer.id, layout });
      this.json(response, 200, { ok: true, layout });
      return;
    }

    // The setup soundtrack, muted or playing again from the phone (S5.4),
    // while setup is on.
    if (method === "POST" && path === "/api/phone/setup-music") {
      if ((await this.setup()).done) {
        this.json(response, 409, { ok: false, error: "setup is done" });
        return;
      }
      const result = await this.setupState.setMuted(((await this.body(request)) as { muted?: unknown } | undefined)?.muted);
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.broadcast("setup", result.state);
      this.json(response, 200, { ok: true, muted: result.state.muted });
      return;
    }

    // Share → TV (ADR-012, S5.3): a photo from the phone becomes the TV's
    // background, with the credit line it came with. Not from a child's
    // profile, which doesn't change the TV's look (ADR-009).
    if (method === "POST" && path === "/api/phone/background") {
      const viewer = await this.profiles.active();
      if (viewer.role !== "adult") {
        this.json(response, 403, { ok: false, error: "an adult changes the tv's background" });
        return;
      }
      let body: Buffer;
      try {
        body = await this.raw(request, MAX_PHOTO);
      } catch (error) {
        this.json(response, 413, { ok: false, error: (error as Error).message });
        return;
      }
      const result = await this.backgrounds.add(body, { text: url.searchParams.get("credit"), from: `${viewer.name.toLowerCase()} on ${phone.name}` });
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.log(`${phone.name} sent a photo for the background`);
      this.broadcast("background", result.state);
      this.json(response, 200, { ok: true, background: result.item });
      return;
    }

    // AgenTV's sign-in screen (ADR-032, S4.9): the name and the password the
    // phone's password manager filled, typed into the service's form on the
    // TV, with Tab between them and Enter after. Never logged.
    if (method === "POST" && path === "/api/phone/sign-in") {
      const body = (await this.body(request)) as { username?: unknown; password?: unknown } | undefined;
      if (!this.signingIn) {
        this.json(response, 409, { ok: false, error: "nothing is signing in on the tv" });
        return;
      }
      const fits = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200;
      if (!fits(body?.username) || !fits(body?.password)) {
        this.json(response, 400, { ok: false, error: "a name and a password, of up to 200 characters each" });
        return;
      }
      const sent = [{ text: body!.username }, { key: "tab" }, { text: body!.password }, { key: "enter" }].every((event) => this.remote(event as Record<string, unknown>));
      if (!sent) {
        this.json(response, 503, { ok: false, error: "the tv session isn't on" });
        return;
      }
      this.json(response, 200, { ok: true });
      return;
    }

    // The update notice (S4.8): Install tonight and Install now are an
    // adult's, past the PIN once there is one; Later isn't.
    if (method === "POST" && path === "/api/phone/updates/tonight") {
      const change = (await this.body(request)) as { version?: unknown } | undefined;
      if (change?.version !== null && !this.guarded(request, response, "install tonight from a phone")) return;
      const why = await this.updates.setTonight(change);
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      this.broadcast("updates", await this.updates.read());
      this.log(change?.version === null ? `tonight's install is off, from ${phone.name}` : `the update installs tonight, from ${phone.name}`);
      this.json(response, 200, { ok: true, update: await this.phoneUpdate() });
      return;
    }

    if (method === "POST" && path === "/api/phone/updates/install") {
      if (!this.guarded(request, response, "install now from a phone")) return;
      if (!this.remote({ cmd: "update-install" })) {
        this.json(response, 503, { ok: false, error: "the tv session isn't on" });
        return;
      }
      this.log(`the update installs now, from ${phone.name}`);
      this.json(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && path === "/api/phone/updates/later") {
      const update = (await this.phoneUpdate()) as { version: string } | null;
      if (!update) {
        this.json(response, 404, { ok: false, error: "there's no update" });
        return;
      }
      await this.updates.setTonight({ version: null });
      await this.updates.markSeen({ later: update.version });
      this.broadcast("updates", await this.updates.read());
      this.json(response, 200, { ok: true, update: await this.phoneUpdate() });
      return;
    }

    // The d-pad and the keyboard: keys, held keys and text for the virtual
    // input device, through the screen daemon. What's typed is never logged.
    if (method === "POST" && path === "/api/phone/remote") {
      const body = ((await this.body(request)) ?? {}) as Record<string, unknown>;
      let event: Record<string, unknown> | null = null;
      const whole = (value: unknown, most: number) => Number.isInteger(value) && Math.abs(value as number) <= most;
      if (typeof body.key === "string" && /^[a-z0-9-]{1,12}$/.test(body.key)) event = { key: body.key };
      else if (typeof body.hold === "string" && /^[a-z0-9-]{1,12}$/.test(body.hold)) event = { hold: body.hold, ms: Math.max(100, Math.min(3000, Number(body.ms) || 1200)) };
      else if (typeof body.text === "string" && body.text.length > 0 && body.text.length <= 500) event = { text: body.text };
      // The trackpad (ADR-008, ADR-037): moves, clicks and scrolls.
      else if (Array.isArray(body.move) && body.move.length === 2 && body.move.every((d) => whole(d, 2000))) event = { move: body.move };
      else if (body.click === "left" || body.click === "right" || body.click === "middle") event = { click: body.click };
      else if (whole(body.scroll, 50) && body.scroll !== 0) event = { scroll: body.scroll };
      if (!event) {
        this.json(response, 400, { ok: false, error: "a key, a held key, text of up to 500 characters, or a move, click or scroll" });
        return;
      }
      if (!this.remote(event)) {
        this.json(response, 503, { ok: false, error: "the tv session isn't on" });
        return;
      }
      this.json(response, 200, { ok: true });
      return;
    }

    // Who's watching, from the phone (S4.2): from a child's profile to an
    // adult's needs the PIN, entered on the phone.
    if (method === "POST" && path === "/api/phone/viewer") {
      const body = (await this.body(request)) as { id?: unknown } | undefined;
      const target = (await this.profiles.list()).find((p) => p.id === body?.id);
      if (!target) {
        this.json(response, 404, { ok: false, error: "there's no such profile" });
        return;
      }
      const now = await this.profiles.active();
      if (this.switchNeedsPin(now, target) && !this.guarded(request, response, `switching to ${target.locked ? "a locked profile" : "an adult"} from a phone`)) return;
      const locked = this.pin.status(now.locked).locked;
      await this.profiles.switchTo(target.id);
      if (now.id !== target.id) this.log(`${target.name} is watching now, from ${phone.name}`);
      this.broadcast("viewer", { id: target.id, role: target.role });
      await this.lockChanged(locked);
      this.json(response, 200, { ok: true, viewer: target });
      return;
    }

    // Setup's AI step (ADR-023): an adult accepts the provider's terms on
    // the phone before anything of it installs, past the PIN once there is
    // one. The box records who, on which phone, and when.
    if (method === "POST" && path === "/api/phone/terms") {
      const viewer = await this.profiles.active();
      if (viewer.role !== "adult") {
        this.json(response, 403, { ok: false, error: "an adult accepts the terms" });
        return;
      }
      if (!this.guarded(request, response, "accepting the provider's terms from a phone")) return;
      const body = (await this.body(request)) as { provider?: unknown; path?: unknown } | undefined;
      const result = await this.ai.accept(body?.provider, body?.path, { phone: phone.name, viewer: viewer.name });
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.log(`${viewer.name} accepted ${result.state.provider}'s terms for ${result.state.path === "plan" ? "a plan" : "a key"}, on ${phone.name}`);
      this.broadcast("ai", result.state);
      this.json(response, 200, { ok: true, accepted: result.state.accepted });
      return;
    }

    // The key, pasted on the phone (board 05), once its terms are accepted:
    // root's alone, as from Settings → AI (S4.6).
    if (method === "POST" && path === "/api/phone/key") {
      if ((await this.profiles.active()).role !== "adult") {
        this.json(response, 403, { ok: false, error: "the key is an adult's" });
        return;
      }
      if (!this.guarded(request, response, "the provider key from a phone")) return;
      const ai = await this.ai.read();
      if (!ai.provider || !ai.accepted) {
        this.json(response, 409, { ok: false, error: "accept the provider's terms first" });
        return;
      }
      const body = (await this.body(request)) as { key?: unknown } | undefined;
      const why = await this.key.store(ai.provider, body?.key);
      if (why) {
        this.log(`the provider key from ${phone.name} wasn't kept: ${why}`);
        this.json(response, why.startsWith("the key couldn't") ? 500 : 400, { ok: false, error: why });
        return;
      }
      this.log(`a key for ${ai.provider} is kept, root's alone, from ${phone.name}`);
      this.broadcast("key", { set: true, provider: ai.provider });
      this.json(response, 200, { ok: true, provider: ai.provider });
      return;
    }

    // The adult PIN, entered on the phone: a grant, and the TV unlocked.
    if (method === "POST" && path === "/api/phone/pin") {
      const locked = (await this.pinStatus()).locked;
      const body = (await this.body(request)) as { pin?: unknown } | undefined;
      const checked = this.pin.check(body?.pin);
      if (!checked.ok) {
        this.log(checked.wait ? `a wrong pin from ${phone.name}; the next try waits ${checked.wait} s` : `a wrong pin from ${phone.name}`);
        this.json(response, 403, checked);
        return;
      }
      if (locked) {
        this.log(`the tv is unlocked from ${phone.name}`);
        this.broadcast("pin", await this.pinStatus());
      }
      this.json(response, 200, checked);
      return;
    }

    this.json(response, 404, { ok: false, error: "not found" });
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

  // The grant a page got for the PIN, sent with a guarded request.
  private grant(request: IncomingMessage): string | undefined {
    const grant = request.headers["x-agentv-grant"];
    return typeof grant === "string" ? grant : undefined;
  }

  // A guarded request without a good grant gets this, and false.
  private guarded(request: IncomingMessage, response: ServerResponse, what: string): boolean {
    if (this.pin.allows(this.grant(request))) return true;
    this.log(`refused ${what}: it needs the pin`);
    this.json(response, 403, { ok: false, error: "that needs the pin", pin: true });
    return false;
  }

  // Switching needs the PIN from a child's profile to an adult's, and to a
  // profile that asks for it to open (ADR-034).
  private switchNeedsPin(now: Profile, target: Profile): boolean {
    if (now.id === target.id) return false;
    return target.locked || (now.role === "child" && target.role === "adult");
  }

  // Whether the TV is locked, for the profile on screen.
  private async pinStatus(): Promise<PinStatus> {
    return this.pin.status((await this.profiles.active()).locked);
  }

  // The TV and the phones hear when someone else watching, or a profile's
  // lock, locked or unlocked the TV.
  private async lockChanged(before: boolean): Promise<void> {
    const status = await this.pinStatus();
    if (status.locked !== before) {
      this.log(status.locked ? "the tv is locked" : "the tv is unlocked");
      this.broadcast("pin", status);
    }
  }

  // On a child's profile, Settings and home's layout are an adult's, past the
  // PIN (ADR-009, ADR-015).
  private async adult(request: IncomingMessage, response: ServerResponse, what: string): Promise<boolean> {
    if ((await this.profiles.active()).role !== "child") return true;
    return this.guarded(request, response, `${what} on a child's profile`);
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

  // A body that isn't JSON, such as a photo, up to limit bytes.
  private async raw(request: IncomingMessage, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new Error(`that's too big: ${Math.round(limit / 1024 / 1024)} mb at most`);
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
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
        // The setup step on the TV, while setup isn't done.
        setup_step: setup.done ? null : setup.step,
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
      const setup = await this.setupState.mark(body.done);
      this.log(body.done ? "setup marked done" : "setup reset");
      // The setup hotspot closes as setup ends.
      if (body.done && this.hotspot.status().on) this.hotspot.stop();
      this.broadcast("setup", setup);
      this.json(response, 200, { ok: true, setup });
      return;
    }

    // --- TV setup (stage 5) -------------------------------------------------

    // Where setup is, how the box is online, the setup hotspot and the
    // phones paired, for the setup screens.
    if (method === "GET" && path === "/api/setup") {
      const hotspot = this.hotspot.status();
      this.json(response, 200, {
        ok: true,
        // The AgenTV this box has now, which getting ready brings up to date,
        // and the package this daemon runs, with its release: an update
        // restarts it on the new one.
        version: (await this.settings()).AGENTV_VERSION,
        running: this.running,
        setup: await this.setup(),
        steps: STEPS,
        parts: PARTS,
        network: network(hotspot, this.options.interfaces?.()),
        hotspot,
        phones: this.phones.list().map((phone) => phone.name),
        pin: this.pin.status().set,
      });
      return;
    }

    // The setup screens moving on: to a step, a step finished, what the TV
    // is for, and how bringing the box up to date goes. Not once setup is
    // done.
    const setupChange = /^\/api\/setup\/(step|finish|goal|ready)$/.exec(path);
    if (method === "POST" && setupChange) {
      if ((await this.setup()).done) {
        this.json(response, 409, { ok: false, error: "setup is done" });
        return;
      }
      const body = ((await this.body(request)) ?? {}) as Record<string, unknown>;
      const what = setupChange[1];
      const result =
        what === "step"
          ? await this.setupState.go(body.step)
          : what === "finish"
            ? await this.setupState.finish(body.step, { keyboard: body.keyboard })
            : what === "goal"
              ? await this.setupState.setGoal(body.goal)
              : await this.setupState.setReady(body);
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      if (what === "finish") this.log(`setup: ${String(body.step)} is finished, on to ${result.state.step}`);
      this.broadcast("setup", result.state);
      this.json(response, 200, { ok: true, setup: result.state });
      return;
    }

    // Setup's apps (board 09): the official apps, the goal's first, and how
    // the ones picked are installing, with the apps asked for at "+ add your
    // own". Picking goes past the PIN once there is one.
    if (method === "GET" && path === "/api/setup/apps") {
      const setup = await this.setup();
      const list = await this.setupApps.list(setup.goal, await this.home.apps());
      this.json(response, 200, { ok: true, goal: setup.goal, wishes: setup.wishes, ...list });
      return;
    }

    // The setup soundtrack muted with the TV's M, or playing again.
    if (method === "POST" && path === "/api/setup/music") {
      if ((await this.setup()).done) {
        this.json(response, 409, { ok: false, error: "setup is done" });
        return;
      }
      const result = await this.setupState.setMuted(((await this.body(request)) as { muted?: unknown } | undefined)?.muted);
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.broadcast("setup", result.state);
      this.json(response, 200, { ok: true, setup: result.state });
      return;
    }

    if (method === "POST" && (path === "/api/setup/apps" || path === "/api/setup/wish")) {
      if ((await this.setup()).done) {
        this.json(response, 409, { ok: false, error: "setup is done" });
        return;
      }
      const body = ((await this.body(request)) ?? {}) as { install?: unknown; text?: unknown };
      if (path === "/api/setup/wish") {
        const result = await this.setupState.wish(body.text);
        if (!result.state) {
          this.json(response, 400, { ok: false, error: result.error });
          return;
        }
        this.broadcast("setup", result.state);
        this.json(response, 200, { ok: true, setup: result.state });
        return;
      }
      if (!this.guarded(request, response, "installing apps")) return;
      const why = await this.setupApps.install(body.install);
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      this.log(`setup: installing ${(body.install as string[]).join(", ")}`);
      this.json(response, 200, { ok: true, apps: this.setupApps.status() });
      return;
    }

    // The keyboard's way onto the home Wi-Fi at the welcome screen, with no
    // phone: the networks the setup hotspot saw, and the one picked, which
    // goes to root as the captive page's does.
    if (method === "GET" && path === "/api/setup/networks") {
      this.json(response, 200, { ok: true, hotspot: this.hotspot.status().ssid, networks: this.hotspot.networks() });
      return;
    }

    if (method === "POST" && path === "/api/setup/wifi") {
      const body = (await this.body(request)) as { ssid?: unknown; password?: unknown } | undefined;
      const why = this.hotspot.join(body?.ssid, body?.password ?? "");
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      this.log(`the tv's keyboard asked to join ${String(body?.ssid)}`);
      this.json(response, 200, { ok: true, joining: body?.ssid });
      return;
    }

    // --- The home screen ---------------------------------------------------

    if (method === "GET" && path === "/api/home") {
      const viewer = await this.profiles.active();
      const pin = this.pin.status(viewer.locked);
      const [info, setup, apps, layout, settings, viewers] = await Promise.all([
        this.settings(),
        this.setup(),
        this.home.apps(viewer),
        this.home.layout(viewer.id, viewer.role),
        this.home.settings(),
        this.profiles.list(),
      ]);
      this.json(response, 200, {
        ok: true,
        version: info.AGENTV_VERSION,
        channel: info.AGENTV_CHANNEL,
        setup,
        viewer,
        viewers,
        apps,
        appsTile: APPS_TILE,
        layout,
        settings,
        pin: { set: pin.set, locked: pin.locked },
      });
      return;
    }

    if (method === "PUT" && path === "/api/layout") {
      if (!(await this.adult(request, response, "changing home"))) return;
      const body = (await this.body(request)) as { layout?: unknown } | undefined;
      const viewer = await this.profiles.active();
      const why = await this.home.saveLayout(viewer.id, body?.layout, viewer.role);
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      const layout = await this.home.layout(viewer.id, viewer.role);
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
      const change = await this.body(request);
      // Choosing to install is an adult's, and needs the PIN; the screen
      // daemon clears it once the night's install is done.
      if ((change as { version?: unknown } | undefined)?.version !== null && !this.guarded(request, response, "install tonight")) return;
      const why = await this.updates.setTonight(change);
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
      if (!(await this.adult(request, response, "settings"))) return;
      const change = await this.body(request);
      // Updating overnight installs on its own, so it needs the PIN too.
      const overnight = (change as { updateOvernight?: unknown } | undefined)?.updateOvernight;
      if (typeof overnight === "boolean" && overnight !== (await this.home.settings()).updateOvernight && !this.guarded(request, response, "updating overnight")) return;
      const why = await this.home.saveSettings(change);
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      const settings = await this.home.settings();
      this.broadcast("settings", settings);
      this.json(response, 200, { ok: true, settings });
      return;
    }

    // --- The adult PIN (ADR-009, S4.5) ------------------------------------

    if (method === "GET" && path === "/api/pin") {
      this.json(response, 200, { ok: true, ...(await this.pinStatus()) });
      return;
    }

    // The PIN, entered on the TV: a grant for the guarded actions, and the TV
    // unlocked. The PIN itself is never logged.
    if (method === "POST" && path === "/api/pin/check") {
      const locked = (await this.pinStatus()).locked;
      const body = (await this.body(request)) as { pin?: unknown } | undefined;
      const checked = this.pin.check(body?.pin);
      if (!checked.ok) {
        this.log(checked.wait ? `a wrong pin; the next try waits ${checked.wait} s` : "a wrong pin");
        this.json(response, 403, checked);
        return;
      }
      if (locked) {
        this.log("the tv is unlocked");
        this.broadcast("pin", await this.pinStatus());
      }
      this.json(response, 200, checked);
      return;
    }

    // Whether a grant is good, for the screen daemon and agentv-pin-check.
    if (method === "POST" && path === "/api/pin/allows") {
      const body = (await this.body(request)) as { grant?: unknown } | undefined;
      if (!this.pin.allows(body?.grant)) {
        this.json(response, 403, { ok: false, error: "that needs the pin", pin: true });
        return;
      }
      this.json(response, 200, { ok: true });
      return;
    }

    // Settings → Adult PIN: a PIN, or another one, which needs a grant from
    // the one before.
    if ((method === "PUT" || method === "DELETE") && path === "/api/pin") {
      const body = (await this.body(request)) as { pin?: unknown } | undefined;
      const why = method === "PUT" ? this.pin.set(body?.pin, this.grant(request)) : this.pin.remove(this.grant(request), await this.profiles.needPin());
      if (why) {
        this.json(response, why === "that needs the pin" ? 403 : 400, { ok: false, error: why });
        return;
      }
      this.log(method === "PUT" ? "the pin was set" : "the pin was taken off");
      const status = await this.pinStatus();
      this.broadcast("pin", status);
      this.json(response, 200, { ok: true, ...status });
      return;
    }

    // The TV locks: by hand from Settings → Adult PIN, whoever's watching,
    // and from the screen daemon once the TV has been off long enough for its
    // apps to close ("tv-off"), for a profile that asks for the PIN to open.
    if (method === "POST" && path === "/api/pin/lock") {
      const body = (await this.body(request)) as { reason?: unknown } | undefined;
      const locked = (await this.pinStatus()).locked;
      this.pin.lock(body?.reason !== "tv-off");
      await this.lockChanged(locked);
      this.json(response, 200, { ok: true, ...(await this.pinStatus()) });
      return;
    }

    // --- The setup hotspot (stage 4) ----------------------------------------

    // For the welcome screen: the hotspot's name and password, which the TV
    // shows, and how joining the home Wi-Fi went.
    if (method === "GET" && path === "/api/hotspot") {
      this.json(response, 200, { ok: true, ...this.hotspot.status() });
      return;
    }

    // The QR code a phone's camera joins the hotspot with.
    if (method === "GET" && path === "/api/hotspot/qr") {
      const hotspot = this.hotspot.status();
      const svg = hotspot.on && hotspot.ssid ? await this.qr(wifiQr(hotspot.ssid, hotspot.password)) : null;
      if (!svg) {
        this.json(response, 404, { ok: false, error: hotspot.on ? "there's no qr code without qrencode" : "the setup hotspot isn't on" });
        return;
      }
      this.send(response, TYPES[".svg"], svg, { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
      return;
    }

    // --- Phones (stage 4) --------------------------------------------------

    // Settings → Phones: the paired phones, and the code on show.
    if (method === "GET" && path === "/api/phones") {
      this.json(response, 200, { ok: true, phones: this.phones.list(), pairing: this.pairing() });
      return;
    }

    // Pair a phone: a new code, and the address the QR code takes a phone to.
    if (method === "POST" && path === "/api/phones/pair") {
      this.phones.code();
      this.json(response, 200, { ok: true, pairing: this.pairing() });
      return;
    }

    // The pairing QR code, drawn by qrencode.
    if (method === "GET" && path === "/api/phones/qr") {
      const pairing = this.pairing();
      const svg = pairing?.url ? await this.qr(pairing.url) : null;
      if (!svg) {
        this.json(response, 404, { ok: false, error: pairing ? "there's no qr code without qrencode or an address" : "there's no code on show" });
        return;
      }
      this.send(response, TYPES[".svg"], svg, { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
      return;
    }

    const phone = /^\/api\/phones\/(p-[0-9a-f]{8})$/.exec(path);
    if (method === "DELETE" && phone) {
      if (!this.phones.forget(phone[1])) {
        this.json(response, 404, { ok: false, error: "there's no such phone" });
        return;
      }
      this.log("a phone was forgotten");
      this.broadcast("phones", {});
      this.json(response, 200, { ok: true, phones: this.phones.list() });
      return;
    }

    // The screen daemon, as AgenTV's sign-in screen comes and goes.
    if (method === "POST" && path === "/api/sign-in-screen") {
      const body = (await this.body(request)) as { app?: unknown; name?: unknown } | undefined;
      this.signingIn = typeof body?.app === "string" ? { app: body.app, name: typeof body.name === "string" ? body.name : body.app } : null;
      this.phonesChanged();
      this.json(response, 200, { ok: true });
      return;
    }

    // What's on the TV (ADR-037), from the TV's page or the screen daemon,
    // for the phone's remote to follow. No digit of the PIN is in it.
    if (method === "POST" && path === "/api/tv/context") {
      const body = (await this.body(request)) as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object") {
        this.json(response, 400, { ok: false, error: "what's on the tv, as json" });
        return;
      }
      this.tvChanged(body);
      this.json(response, 200, { ok: true });
      return;
    }

    // The screen daemon's stream of the phone's keys and text, or Omarchy's
    // desktop's, which takes the trackpad and the keys while the desktop is
    // on. A page can't open it: it needs a header no browser sends to
    // another site.
    if (method === "GET" && path === "/api/remote") {
      const who = request.headers["x-agentv-screen"];
      if (who !== "1" && who !== "desktop") {
        this.json(response, 403, { ok: false, error: "only the screen daemon takes the phone's keys" });
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      response.write(": agentv remote\n\n");
      this.remotes.add(response);
      if (who === "desktop") {
        this.desktops.add(response);
        this.desktopChanged();
      }
      const beat = setInterval(() => response.write(": beat\n\n"), 25_000);
      request.on("close", () => {
        clearInterval(beat);
        this.remotes.delete(response);
        if (this.desktops.delete(response)) this.desktopChanged();
      });
      return;
    }

    // --- The provider key (ADR-009, S4.6) ------------------------------------

    // Which provider has a key. The key itself never comes back.
    if (method === "GET" && path === "/api/key") {
      const { set, provider, error } = this.key.status();
      this.json(response, 200, { ok: true, set, provider, ...(error ? { error } : {}) });
      return;
    }

    // Settings → AI: a key for a provider, kept where only root can read it,
    // or taken off. An adult's, past the PIN.
    if ((method === "PUT" || method === "DELETE") && path === "/api/key") {
      if (!this.guarded(request, response, "the provider key") || !(await this.adult(request, response, "the provider key"))) return;
      const body = (method === "PUT" ? await this.body(request) : {}) as { provider?: unknown; key?: unknown } | undefined;
      const provider = method === "DELETE" ? null : (body?.provider ?? "");
      const why = await this.key.store(provider, body?.key);
      if (why) {
        this.log(`the provider key wasn't kept: ${why}`);
        this.json(response, why.startsWith("the key couldn't") ? 500 : 400, { ok: false, error: why });
        return;
      }
      const { set } = this.key.status();
      this.log(set ? `a key for ${provider} is kept, root's alone` : "the provider key is off");
      this.broadcast("key", { set, provider: this.key.status().provider });
      this.json(response, 200, { ok: true, set, provider: this.key.status().provider });
      return;
    }

    // --- The AI provider and its terms (ADR-022, ADR-023) --------------------

    // Which provider, by plan or key, whether its terms are accepted, how the
    // first run of its CLI went, and what each provider offers.
    if (method === "GET" && path === "/api/ai") {
      const { set, provider } = this.key.status();
      this.json(response, 200, { ok: true, ...(await this.ai.read()), offers: OFFERS, read: TERMS_READ, key: { set, provider } });
      return;
    }

    // The provider and path picked on the TV, or none, to pick again. A
    // child's profile can't, past the PIN.
    if (method === "POST" && path === "/api/ai") {
      if (!(await this.adult(request, response, "the ai provider"))) return;
      const body = (await this.body(request)) as { provider?: unknown; path?: unknown } | undefined;
      const result = await this.ai.choose(body?.provider ?? null, body?.path);
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.broadcast("ai", result.state);
      this.json(response, 200, { ok: true, ...result.state });
      return;
    }

    // How the CLI's first run goes, from the screen daemon, which runs it only
    // once the terms are accepted.
    if (method === "POST" && path === "/api/ai/cli") {
      const result = await this.ai.setCli(await this.body(request));
      if (!result.state) {
        this.json(response, 409, { ok: false, error: result.error });
        return;
      }
      this.broadcast("ai", result.state);
      this.json(response, 200, { ok: true, cli: result.state.cli });
      return;
    }

    // --- Profiles (ADR-009, S4.2) -------------------------------------------

    // Who's watching now, for the screen daemon's ledger and sign-ins.
    if (method === "GET" && path === "/api/viewer") {
      this.json(response, 200, { ok: true, viewer: await this.profiles.active() });
      return;
    }

    if (method === "GET" && path === "/api/viewers") {
      this.json(response, 200, { ok: true, viewers: await this.profiles.list(), active: (await this.profiles.active()).id });
      return;
    }

    // Someone else watching: everything on the TV is theirs within a second.
    // From a child's profile to an adult's needs the PIN.
    if (method === "POST" && path === "/api/viewer") {
      const body = (await this.body(request)) as { id?: unknown } | undefined;
      const all = await this.profiles.list();
      const target = all.find((p) => p.id === body?.id);
      if (!target) {
        this.json(response, 404, { ok: false, error: "there's no such profile" });
        return;
      }
      const now = await this.profiles.active();
      if (this.switchNeedsPin(now, target) && !this.guarded(request, response, `switching to ${target.locked ? "a locked profile" : "an adult"}`)) return;
      const locked = this.pin.status(now.locked).locked;
      await this.profiles.switchTo(target.id);
      if (now.id !== target.id) this.log(`${target.name} is watching now`);
      this.broadcast("viewer", { id: target.id, role: target.role });
      await this.lockChanged(locked);
      this.json(response, 200, { ok: true, viewer: target });
      return;
    }

    // Settings → Profiles: adding, changing and taking off profiles needs
    // the PIN once there is one, and a child's profile, or one that asks for
    // the PIN to open, needs one to exist.
    const one = /^\/api\/viewers\/([a-z0-9._-]+)$/.exec(path);
    if ((method === "POST" && path === "/api/viewers") || ((method === "PUT" || method === "DELETE") && one)) {
      if (!this.guarded(request, response, "changing profiles")) return;
      const body = ((await this.body(request)) ?? {}) as Record<string, unknown>;
      if (method !== "DELETE" && body.role === "child" && !this.pin.status().set) {
        this.json(response, 400, { ok: false, error: "a child's profile needs an adult pin. set one in settings → adult pin first" });
        return;
      }
      if (method !== "DELETE" && body.locked === true && !this.pin.status().set) {
        this.json(response, 400, { ok: false, error: "a locked profile needs an adult pin. set one in settings → adult pin first" });
        return;
      }
      const locked = (await this.pinStatus()).locked;
      let error: string | null | undefined;
      let profile;
      if (method === "POST") ({ profile, error } = await this.profiles.add(body));
      else if (method === "PUT") ({ profile, error } = await this.profiles.edit(one![1], body));
      else {
        error = await this.profiles.remove(one![1]);
        if (!error) await this.home.forgetViewer(one![1]);
      }
      if (error) {
        this.json(response, error === "there's no such profile" ? 404 : 400, { ok: false, error });
        return;
      }
      this.log(method === "POST" ? `a profile was added, ${profile!.role === "child" ? "a child" : "an adult"}` : method === "PUT" ? "a profile was changed" : "a profile was taken off");
      this.broadcast("viewers", {});
      await this.lockChanged(locked);
      this.json(response, 200, { ok: true, ...(profile ? { profile } : {}), viewers: await this.profiles.list(), active: (await this.profiles.active()).id });
      return;
    }

    // An app ticked for children, or unticked, from its details.
    const forChildren = /^\/api\/apps\/([a-z0-9.-]+)\/for-children$/.exec(path);
    if (method === "POST" && forChildren) {
      if (!this.guarded(request, response, "children's apps") || !(await this.adult(request, response, "children's apps"))) return;
      const body = (await this.body(request)) as { allowed?: unknown } | undefined;
      if (typeof body?.allowed !== "boolean") {
        this.json(response, 400, { ok: false, error: "allowed is true or false" });
        return;
      }
      if (!(await this.home.setForChildren(forChildren[1], body.allowed))) {
        this.json(response, 404, { ok: false, error: "that isn't an app here" });
        return;
      }
      this.broadcast("apps", {});
      this.json(response, 200, { ok: true });
      return;
    }

    // An app's own setup, from its tile ("Setup flow"): its fields, such as a
    // server's address, then the sign-in. Filling them in is an adult's,
    // past the PIN once there is one, since it says where the app goes.
    const appSetup = /^\/api\/apps\/([a-z0-9.-]+)\/setup$/.exec(path);
    if (method === "GET" && appSetup) {
      const setup = await this.home.appSetup(appSetup[1]);
      if (!setup) {
        this.json(response, 404, { ok: false, error: "that isn't an app here with a setup" });
        return;
      }
      this.json(response, 200, { ok: true, setup });
      return;
    }
    if (method === "POST" && appSetup) {
      if (!this.guarded(request, response, "setting up an app") || !(await this.adult(request, response, "setting up an app"))) return;
      const body = (await this.body(request)) as { values?: unknown } | undefined;
      const why = await this.home.saveAppSetup(appSetup[1], body?.values);
      if (why) {
        this.json(response, why.startsWith("that isn't") ? 404 : 400, { ok: false, error: why });
        return;
      }
      this.log(`${appSetup[1]}: its setup fields are filled in`);
      this.broadcast("apps", {});
      this.json(response, 200, { ok: true, setup: await this.home.appSetup(appSetup[1]) });
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

    // An app's service's own profiles (ADR-009): the screen daemon reads
    // them, and the one picked for children, as the app opens, and hands
    // over the list the app gave it. An adult picks the one for children,
    // past the PIN, from the app's details.
    const profiles = /^\/api\/apps\/([a-z0-9.-]+)\/profiles$/.exec(path);
    if (method === "GET" && profiles) {
      const found = await this.home.serviceProfiles(profiles[1]);
      if (!found) {
        this.json(response, 404, { ok: false, error: "that isn't an app here with profiles" });
        return;
      }
      this.json(response, 200, { ok: true, ...found });
      return;
    }
    if (method === "POST" && profiles) {
      const body = (await this.body(request)) as { names?: unknown } | undefined;
      const why = await this.home.listedProfiles(profiles[1], body?.names);
      this.json(response, why ? 400 : 200, why ? { ok: false, error: why } : { ok: true });
      return;
    }
    const childProfile = /^\/api\/apps\/([a-z0-9.-]+)\/child-profile$/.exec(path);
    if (method === "PUT" && childProfile) {
      if (!this.guarded(request, response, "the profile for children") || !(await this.adult(request, response, "the profile for children"))) return;
      const body = (await this.body(request)) as { name?: unknown } | undefined;
      const why = body && "name" in body ? await this.home.setChildProfile(childProfile[1], body.name) : "name is a profile, or null";
      this.json(response, why ? 400 : 200, why ? { ok: false, error: why } : { ok: true });
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
      if (!(await this.adult(request, response, "settings"))) return;
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
      const content = await this.home.tile(tile[1], tile[2] as Size, await this.home.viewer(), url.searchParams.has("fresh"));
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
      const target = await this.home.launch(launch[1], await this.profiles.active());
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

    // The backgrounds (ADR-012, board 13): which source the TV shows, the
    // photos with their credits, and each picture.
    if (method === "GET" && path === "/api/backgrounds") {
      this.json(response, 200, { ok: true, ...(await this.backgrounds.read()) });
      return;
    }

    const picture = /^\/api\/backgrounds\/([0-9a-f]{16})$/.exec(path);
    if (method === "GET" && picture) {
      const found = await this.backgrounds.file(picture[1]);
      const body = found ? await readFile(found.path).catch(() => null) : null;
      if (!found || !body) {
        this.json(response, 404, { ok: false, error: "no such picture" });
        return;
      }
      this.send(response, found.type, body, { "Cache-Control": "private, max-age=86400" });
      return;
    }

    if (method === "POST" && path === "/api/backgrounds") {
      const body = ((await this.body(request)) ?? {}) as { source?: unknown; current?: unknown };
      const result = await this.backgrounds.choose(body.source, body.current);
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.broadcast("background", result.state);
      this.json(response, 200, { ok: true, ...result.state });
      return;
    }

    // Art from museum archives (ADR-012): the archives, a search of one, a
    // work's thumbnail through the daemon, and a work picked as the
    // background, which the daemon fetches whole and keeps with its credit.
    if (method === "GET" && path === "/api/art") {
      this.json(response, 200, { ok: true, archives: ARCHIVES });
      return;
    }

    if (method === "GET" && path === "/api/art/search") {
      const result = await this.art.search(url.searchParams.get("archive"), url.searchParams.get("q"));
      if (!result.items) {
        this.json(response, result.error?.includes("didn't answer") ? 502 : 400, { ok: false, error: result.error });
        return;
      }
      this.json(response, 200, { ok: true, items: result.items });
      return;
    }

    const artThumb = /^\/api\/art\/([a-z]+)\/(\d{1,12})\/thumb$/.exec(path);
    if (method === "GET" && artThumb) {
      const found = await this.art.thumb(artThumb[1], artThumb[2]);
      if (!found) {
        this.json(response, 404, { ok: false, error: "no such picture" });
        return;
      }
      this.send(response, found.type, found.body, { "Cache-Control": "private, max-age=86400" });
      return;
    }

    if (method === "POST" && path === "/api/backgrounds/art") {
      if (!(await this.adult(request, response, "the background"))) return;
      const body = ((await this.body(request)) ?? {}) as { archive?: unknown; id?: unknown };
      const work = await this.art.whole(body.archive, body.id);
      if (!work.body || !work.art) {
        this.json(response, 502, { ok: false, error: work.error });
        return;
      }
      const name = ARCHIVES.find((one) => one.id === work.art!.archive)!.name;
      const result = await this.backgrounds.add(work.body, { text: work.art.credit, from: name }, "art");
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.log(`background: ${work.art.archive} ${work.art.id}, from ${name}`);
      this.broadcast("background", result.state);
      this.json(response, 200, { ok: true, background: result.item, ...result.state });
      return;
    }

    if (method === "DELETE" && picture) {
      if (!this.guarded(request, response, "taking a photo off the tv")) return;
      const result = await this.backgrounds.remove(picture[1]);
      if (!result.state) {
        this.json(response, 404, { ok: false, error: result.error });
        return;
      }
      this.broadcast("background", result.state);
      this.json(response, 200, { ok: true, ...result.state });
      return;
    }

    // The looks setup and Settings offer (board 12), with the colours their
    // previews draw, and which one the TV has.
    if (method === "GET" && path === "/api/themes") {
      const looks = await previews(this.options.omarchy ?? process.env.OMARCHY_PATH ?? "/usr/share/omarchy");
      this.json(response, 200, { ok: true, themes: looks, current: currentTheme(await this.home.theme(), looks) });
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
      await this.file(response, setup.done && hasHome ? home : join("setup", "index.html"));
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
    lanPort: process.env.AGENTV_LAN_PORT === "off" ? undefined : Number(process.env.AGENTV_LAN_PORT ?? 3001),
    setupPort: process.env.AGENTV_SETUP_PORT === "off" ? undefined : Number(process.env.AGENTV_SETUP_PORT ?? 3002),
  });
  const listening = await daemon.listen();
  const phones = daemon.lanPort ? `, for phones on port ${daemon.lanPort}` : "";
  const captive = daemon.setupPort ? `, and for the setup hotspot on port ${daemon.setupPort}` : "";
  console.log(`agentv daemon on http://127.0.0.1:${listening}/${phones}${captive}`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void daemon.close().then(() => process.exit(0)));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main();
