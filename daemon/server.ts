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
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize, resolve, sep } from "node:path";
import { APPS_TILE, gridNamed, Home, type TileAnswer } from "./home.ts";
import { agentvOwner, installedPackage, userAgent } from "./identity.ts";
import { Ai, OFFERS, planRefused, PROVIDER_LIST, TERMS_READ, type Provider } from "./ai.ts";
import { ARCHIVES, ArtArchives, type ArtOptions } from "./art.ts";
import { MAX_VIDEO, Shared, type Share } from "./shared.ts";
import { Backgrounds, imageType, MAX_BYTES as MAX_PHOTO } from "./backgrounds.ts";
import { ImmichAlbum } from "./immich-album.ts";
import type { IndexEntry } from "./apps/index.ts";
import { badState, kindOf, Ledger } from "./ledger.ts";
import { Builds, type Provider as BuildProvider } from "./builds.ts";
import { Asks } from "./asks.ts";
import { exportRefusal, packageFiles, zipFolder } from "./export.ts";
import { cleanGitHub, type GitHubAnswer, type GitHubAsk, parseRepo, repoRefusal, type SignIn } from "./github.ts";
import { cleanTheme, madeThemes, type ThemeAnswer, type ThemeAsk, THEMES } from "./made-themes.ts";
import { ANSWER_MAX, PageAsks } from "./page-asks.ts";
import { HOTSPOT_ADDRESS, Hotspot, wifiQr } from "./hotspot.ts";
import { TvNetwork } from "./network.ts";
import { networkRoute } from "./routes/network.ts";
import { ProviderKey } from "./key.ts";
import { boxZone, cityOf, clockZone } from "./place.ts";
import { News, ROUTER_GONE, tmdbViaRouter, type TmdbGet } from "./tmdb.ts";
import { countries, CountryPlace } from "./country.ts";
import { TmdbKey } from "./tmdb-key.ts";
import { Voice, type Clip, type VoiceOptions } from "./voice.ts";
import { PhoneChannel } from "./phone-channel.ts";
import { Phones, type PairRequest, type Phone } from "./phones.ts";
import { Features, type FeatureMap } from "./features.ts";
import { Box, type BoxOptions } from "./box.ts";
import { boxRoute, phoneBoxRoute, type BoxRoutes } from "./routes/box.ts";
import { featureRoutes, type FeatureRoutes } from "./routes/features.ts";
import { backgroundVideoRoutes } from "./routes/backgrounds.ts";
import { askRoutes, askView, type AskRoutes } from "./routes/ask.ts";
import { NO_AI } from "./executors/index.ts";
import { NEEDS_PIN, NOT_READY, NO_APP, WENT_WRONG, needsPin } from "./notices.ts";
import type { ExecBuilds } from "./executors/make.ts";
import { Pin, type PinStatus } from "./pin.ts";
import { NO_PROFILE, Profiles, type Profile } from "./profiles.ts";
import { NetFilter } from "./net-filter.ts";
import { pageAppId, PageApps } from "./page-apps.ts";
import { network, Setup, type SetupState } from "./setup.ts";
import { SetupRoutes } from "./routes/setup.ts";
import { AiIcons, type PROVIDER_SITES } from "./ai-icons.ts";
import { PlanSignIn } from "./plan-sign-in.ts";
import { SetupApps } from "./setup-apps.ts";
import { cleanFound, currentTheme, previews, THEME_NAME, type ThemePreview } from "./themes.ts";
import { ControllerRoutes } from "./routes/controllers.ts";
import { currentLook, lookRoute } from "./routes/look.ts";
import { desktopPasswordRoute } from "./routes/desktop-password.ts";
import { DesktopPassword } from "./desktop-password.ts";
import { Updates } from "./updates.ts";
import { NONE, type Route, type Routed, type RouterApp } from "./router.ts";
import { newItem } from "./executors/whatsNew.ts";
import { boxRouter } from "./router-client.ts";
import { cleanSayAnswer, Say, type SayAnswer, type SayAsk } from "./say.ts";
import { Listening } from "./listening.ts";
import { cleanField, type Field } from "./remote-text.ts";
import { nowPlaying, PhoneRemote } from "./routes/remote.ts";
import { MUSIC as MUSIC_APP } from "./music.ts";
import type { Size } from "../launcher/layout.ts";
import type { Viewer } from "./apps/loader.ts";
import { Discover, type DiscoverOptions } from "./discover.ts";
import { discoverRoute, serverPickRoute } from "./routes/discover.ts";
import { ServerPicks } from "./server-picks.ts";
import { DisplayRoutes } from "./routes/display.ts";
import { Inhibitor } from "./inhibit.ts";

export interface DaemonOptions {
  root: string; // AgenTV's files: /usr/share/agentv, or a checkout
  // Keeps the box awake while a build runs (daemon/inhibit.ts, ADR-072).
  inhibitor?: (why: string) => { set(on: boolean): void };
  state: string; // the daemon's own state: /var/lib/agentv/daemon
  apps?: string; // the box's apps: /var/lib/agentv/apps
  // Only for a test harness (daemon/apps/loader.ts): the box never sets it,
  // and nothing reads it from a file or the environment.
  harness?: { thisBox?: boolean; noSandbox?: boolean };
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
  // The first screen's account note, and root's side of the desktop
  // password's hand-over, for tests.
  accountMarker?: string;
  passwordSocket?: string;
  keyWaitMs?: number;
  // The channel `agentv channel` sets: /etc/agentv/channel (ADR-053).
  channelFile?: string;
  // Setup's apps: what agentv-setup-apps writes as it installs them
  // (/run/agentv-setup-apps/state.json), how long it may take to start, and
  // the official apps in the index, in place of the signed index itself.
  setupAppsStatus?: string;
  setupAppsWaitMs?: number;
  setupCatalog?: (source: string) => Promise<IndexEntry[]>;
  // Omarchy's own files, whose themes setup previews: /usr/share/omarchy.
  omarchy?: string;
  // The themes your agent made, as root put them: /var/lib/agentv/themes.
  themes?: string;
  // Where packages put their desktop entries and icons, for a native app's
  // icon: /usr/local/share, /usr/share and flatpak's.
  dataDirs?: string[];
  // The backgrounds and their credits: /var/lib/agentv/backgrounds.
  backgrounds?: string;
  // What phones shared to the TV (ADR-050): /var/lib/agentv/shared.
  shared?: string;
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
  // The filter home's Chromium goes through (ADR-043): its port, 3005 on
  // the box, or none. Only the origins page apps declared get through.
  homeProxyPort?: number;
  // The builder (ADR-011): its builds, root's answers, the spend and the
  // nightly package check, where root and the builder write them.
  builds?: string; // /var/lib/agentv/build
  buildRun?: string; // /run/agentv-build
  spend?: string; // /var/lib/agentv/spend/spend.json
  npmWarnings?: string; // /var/lib/agentv/npm-check/warnings.json
  // The router (ADR-013, ADR-023): one sentence and the apps who's watching
  // can open, into a route, through the provider's API or a plan's CLI.
  router?: (sentence: string, apps: RouterApp[]) => Promise<Routed>;
  // Where each AI provider's icon is fetched from: their own sites, unless a
  // test stands them in.
  aiSites?: Partial<typeof PROVIDER_SITES>;
  // TMDB, through the router's service, which holds the household's TMDB
  // key, and /etc/agentv/tmdb.json, which says whether there's one (stage 8).
  tmdb?: TmdbGet;
  tmdbStatus?: string;
  // The clock what's new goes by, for tests that pin the day.
  newsNow?: () => Date;
  // The TV's spoken answers (stage 8): where its own voice is, and stand-ins
  // for the provider's voice and the TV's own, for tests.
  voice?: Partial<Pick<VoiceOptions, "dir" | "provider" | "own">>;
  // The box's country (ADR-055): a stand-in for its time zone, and how long
  // a pick waits for root to set it, for tests.
  country?: { zone?: () => Promise<string>; waitMs?: number };
  // How long the listening bar waits for new words before it goes (20 s).
  listenIdleMs?: number;
  // Servers and shares on the home network: stand-ins' ports, for tests.
  discover?: DiscoverOptions;
  // The box check (ADR-061): stand-ins for the machine it reads, for tests.
  box?: Omit<BoxOptions, "state">;
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
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
};

// The folders the TV's pages come from, by their first path segment.
const STATIC = ["launcher", "setup"];
// All the captive page needs, and all a phone on the setup hotspot gets.
// lib.ts brings the paired phone's channel and its arithmetic with it, which
// the captive page loads and never uses: nothing pairs there.
const CAPTIVE_FILES = ["companion-web/setup.ts", "companion-web/lib.ts", "companion-web/channel.ts", "companion-web/seal.ts", "companion-web/companion.css", "launcher/glyphs.ts"];
const MAX_BODY = 64 * 1024;
// How long a phone's ask for the state waits for something to change.
const PHONE_WAIT_MS = 25_000;

// An app the TV offered for Export (ADR-045), for ten minutes, with the
// person's GitHub sign-in when they have one.
interface ExportOffer {
  id: string;
  name: string;
  version: string;
  until: number;
  github: SignIn | null;
}

// What's on the TV, for the phone's remote to follow (ADR-037). The TV's page
// says what it shows: the PIN pad, what asks for it and how many digits are
// in, a text field with the focus and its kind, and home, a menu or the
// ambient screen. The screen daemon says what's in front and whether
// something plays, and the field with the focus in an app's page, with the
// app (ADR-065). The field is home's or the app's, whichever is in front.
// The desktop's relay says when Omarchy's desktop is on.
export interface TvContext {
  pin: { title: string; for: string; digits: number; error: string | null } | null;
  field: (Omit<Field, "label"> & { label?: string; app?: string }) | null;
  screen: "home" | "menu" | "ambient";
  // The focus is on an app's tile on home or Apps, where a hold opens its
  // details (ADR-089).
  details: boolean;
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

// Whether a key's refusal is the TV's own trouble saving it, and not the
// key that was typed.
function notSaved(why: string): boolean {
  return why.toLowerCase().startsWith("couldn't save the key");
}

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
}

export class Daemon {
  readonly server: Server;
  // The port it listens on, kept from listen(): once close() starts, the
  // server has no address, and a request on a connection still open would
  // have none to check its Host against.
  private port = 0;
  // Set once close() starts: a request after that is turned away.
  private closing = false;
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
  // The TMDB key, and what's new and new episodes from TMDB (stage 8).
  readonly tmdbKey: TmdbKey;
  readonly country: CountryPlace;
  // The feature switches every phase 2 track's screens hide behind.
  readonly features: Features;
  // What the box is (ADR-061).
  readonly box: Box;
  // The TV's size (ADR-062): /api/display and the screen daemon's asks.
  readonly displayRoutes: DisplayRoutes;
  // Settings, controllers (ADR-084): Bluetooth game controllers.
  readonly controllerRoutes: ControllerRoutes;
  readonly news: News;
  // The TV's spoken answers (stage 8), and the last few clips, by number,
  // for the TV session to fetch and play.
  readonly voice: Voice;
  private clips = new Map<number, Clip>();
  private clipCount = 0;
  private lastSpoken: { clip: number; by: Clip["by"]; ms: number; played?: boolean; error?: string; at: string } | null = null;
  readonly phones: Phones;
  // The paired phones' sessions: what checks and opens their requests.
  private phoneChannel: PhoneChannel<Phone>;
  // The phone whose session signed each request on the phone's port.
  private signedBy = new WeakMap<IncomingMessage, string>();
  readonly hotspot: Hotspot;
  // Settings, network: the Wi-Fi nearby and joining one (ADR-084).
  readonly network: TvNetwork;
  readonly setupState: Setup;
  // Settings → Omarchy desktop's password (daemon/desktop-password.ts).
  readonly desktopPassword: DesktopPassword;
  // Setup's own routes (daemon/routes/setup.ts), and what they may use.
  private setupRoutes = new SetupRoutes({
    setup: () => this.setupState,
    country: () => this.country,
    json: (response, status, data) => this.json(response, status, data),
    body: (request) => this.body(request),
    broadcast: (event, data) => this.broadcast(event, data),
    log: (line) => this.log(line),
    adult: async (request, response, what) => this.guarded(request, response, what) && (await this.adult(request, response, what)),
    ai: () => this.ai,
    aiIcons: () => this.aiIcons,
    planSignIn: () => this.planSignIn,
    qr: (text) => this.qr(text),
    send: (response, type, body, headers) => this.send(response, type, body, headers),
  });
  // The AI providers' icons (ADR-069), and a plan's sign-in from setup
  // (ADR-070).
  readonly aiIcons: AiIcons;
  readonly planSignIn: PlanSignIn;
  readonly ai: Ai;
  readonly setupApps: SetupApps;
  readonly backgrounds: Backgrounds;
  readonly shared: Shared;
  readonly pageApps: PageApps;
  readonly builds: Builds;
  // Stage B's asks of the services' Chromium, for the screen daemon.
  readonly pageAsks = new PageAsks();
  // Export's asks of the person's GitHub sign-in, for the screen daemon.
  readonly exportAsks = new Asks<GitHubAsk, GitHubAnswer>({ clean: cleanGitHub, late: { ok: false, error: NOT_READY } });
  // A made theme's asks, for the screen daemon to hand it to Omarchy (S6.4).
  readonly themeAsks = new Asks<ThemeAsk, ThemeAnswer>({ clean: cleanTheme, late: { ok: false, error: NOT_READY, late: true } });
  // A sentence's asks of the TV session: looking X up in the apps, and
  // opening what was chosen (daemon/say.ts).
  readonly sayAsks = new Asks<SayAsk, SayAnswer>({ clean: cleanSayAnswer, late: { ok: false, error: NOT_READY } });
  // What was said to the TV, routed and done (ADR-023).
  readonly say: Say;
  // The phone's box, open and its words, as the TV shows them (ADR-054).
  readonly listening: Listening;
  private routing?: (sentence: string, apps: RouterApp[]) => Promise<Routed>;
  // What it asked already, by theme, build and version, so a pass that read
  // the record before the last answer came doesn't ask again.
  private themesAsked = new Set<string>();
  private buildsSeen = "";
  private buildsTimer?: ReturnType<typeof setInterval>;
  private buildAwake: { set(on: boolean): void };
  // What home's Chromium reaches the internet through.
  readonly homeProxy?: NetFilter;
  private art: ArtArchives;
  private immich: ImmichAlbum;
  private immichBusy = false;
  readonly discover: Discover;
  readonly serverPicks: ServerPicks;
  // The phone companion's listener, on the home network.
  readonly lan?: Server;
  // The new remote's typing and playback (ADR-065).
  readonly phoneRemote: PhoneRemote;
  // The field with the focus on home, and in the app in front.
  private homeField: Field | null = null;
  private appField: (Field & { app: string }) | null = null;
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
  private tv: TvContext = { pin: null, field: null, screen: "home", details: false, front: "home", playing: false, desktop: false };
  private phoneVersion = 1;
  private phoneWaiters = new Set<() => void>();
  // The provider whose terms a key from Settings → AI waits for (Q104), which
  // the phones show for an adult to accept.
  private keyTerms: Provider | null = null;
  // The provider whose terms a plan picked in Settings → AI waits for (Q143),
  // the same way.
  private planTerms: Provider | null = null;
  // The last few page apps' notices, for the phones (ADR-043).
  private notices: { app: string; name: string; text: string; at: string }[] = [];
  // An app the TV offered for Export, for an adult's phone to save, or to
  // push when the person's account here is signed in to GitHub (ADR-045).
  private exportOffer: ExportOffer | null = null;
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
      harness: options.harness,
      viewer: () => this.profiles.active(),
      goal: async () => (await this.setup()).goal,
      looks: () => this.features.on("looks"),
      changed: (event) => this.broadcast(event, {}),
      pageTile: (id) => this.pageApps.tile(id),
      newTile: (viewer, size) => this.newTile(viewer, size),
      log: this.log,
      dataDirs: options.dataDirs,
    });
    // A sentence said to the TV: routed for who's watching, with only the
    // apps they can open, and done through the TV session.
    // The listening bar: each change to the TV's pages and, for over an
    // app, the TV session. Nothing of the words stays (ADR-054).
    this.phoneRemote = new PhoneRemote({
      send: (event) => this.remote(event as Record<string, unknown>),
      tv: () => this.tv,
      viewer: () => this.profiles.active(),
      toPages: (event, data) => this.toPages(event, data),
      json: (response, status, data) => this.json(response, status, data),
      body: (request) => this.body(request),
    });
    this.listening = new Listening({
      idleMs: options.listenIdleMs,
      changed: (heard) => {
        this.toPages("listening", heard);
        void this.sayAsks.ask({ kind: "live", state: heard.state, text: heard.text }, 3000);
      },
    });
    this.say = new Say({
      bar: { sent: (from) => this.listening.sent(from), listening: () => this.listening.up, show: (state, text) => void this.sayAsks.ask({ kind: "live", state, text }, 5000) },
      route: options.router ?? ((sentence, apps) => this.boxRoute(sentence, apps)),
      viewer: () => this.profiles.active(),
      apps: async (viewer) => {
        const allowed = new Set((await this.home.apps(viewer)).map((app) => app.id));
        return (await this.home.manifests())
          .filter(({ manifest }) => allowed.has(manifest.id))
          .map(({ manifest, tier }) => ({
            id: manifest.id,
            name: manifest.name,
            category: manifest.tv.category,
            // An app the agent made, which a change can be asked of.
            ...(tier === "local" ? { made: true } : {}),
            // Music looks in the library in the TV session rather than in a
            // worker, so it can, though its manifest doesn't say so.
            capabilities: manifest.id === MUSIC_APP ? [...manifest.tv.capabilities, "search"] : [...manifest.tv.capabilities],
          }));
      },
      rows: (viewer) => this.ledger.recent(viewer, { limit: 50 }),
      speak: (text) => void this.speak(text),
      news: (viewer, apps) => {
        const ids = apps.map((app) => app.id);
        return {
          whatsNew: (only) => this.news.forViewer(viewer.role, ids, only),
          episode: (query) => this.news.episode(query, this.ledger.recent(viewer.id, { limit: 200 }), viewer.role, ids),
        };
      },
      // Make and change, while the askbuilds switch is on (ADR-068).
      builds: async (viewer) => ((await this.features.on("askbuilds")) ? this.execBuilds(viewer) : undefined),
      ask: (ask, ms) => this.sayAsks.ask(ask, ms),
      changed: (said) => this.broadcast("said", said),
      log: this.log,
    });
    // Page apps (ADR-043): each on an origin of its own, and the kit's calls
    // checked against its manifest.
    this.pageApps = new PageApps({
      state: options.state,
      root: options.root,
      find: async (id) => {
        const found = (await this.home.manifests()).find(({ manifest }) => manifest.id === id && manifest.tv.runtime === "page");
        return found ? { manifest: found.manifest, dir: found.dir } : null;
      },
      viewer: async () => {
        const viewer = await this.profiles.active();
        return { id: viewer.id, name: viewer.name, role: viewer.role };
      },
      notice: (app, text) => {
        this.log(`${app.id} sent a notice`);
        this.notices = [{ app: app.id, name: app.name, text, at: now() }, ...this.notices].slice(0, 5);
        this.broadcast("notice", { app: app.id, name: app.name, text });
      },
      tileChanged: (id) => this.broadcast("tiles", { app: id }),
      log: this.log,
    });
    if (options.homeProxyPort !== undefined) {
      this.homeProxy = new NetFilter({
        // The origins the page apps on the box declared, as they are now.
        policy: async (host, port, scheme) => {
          const origin = new URL(`${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}`).origin;
          for (const { manifest } of await this.home.manifests()) {
            if (manifest.tv.runtime === "page" && (manifest.tv.origins ?? []).includes(origin)) return true;
          }
          return false;
        },
        log: (line) => this.log(`home's proxy: ${line}`),
      });
    }
    this.updates = new Updates({ dir: options.updates ?? "/var/lib/agentv/update", state: options.state });
    this.profiles = new Profiles({ ledger: () => this.ledger, state: options.state, pinSet: () => this.pin.status().set });
    this.key = new ProviderKey({ state: options.state, status: options.keyStatus, waitMs: options.keyWaitMs });
    this.tmdbKey = new TmdbKey({ state: options.state, status: options.tmdbStatus, waitMs: options.keyWaitMs });
    this.country = new CountryPlace({ state: options.state, ...options.country, log: this.log });
    this.features = new Features({ state: options.state, channel: () => this.channel() });
    this.box = new Box({ state: options.state, ...options.box });
    this.controllerRoutes = new ControllerRoutes({ pads: () => this.box.pads(), json: (q, status, data) => this.json(q, status, data), body: (q) => this.body(q), broadcast: (event, data) => this.boxKit().broadcast(event, data), log: (line) => this.log(line), adult: async (q, s, what) => this.guarded(q, s, what) && (await this.adult(q, s, what)) });
    this.displayRoutes = new DisplayRoutes({
      state: options.state,
      sizes: () => this.features.on("sizes"),
      fourKSmooth: async () => {
        const smooth = await this.box.smooth();
        return smooth.result ? smooth.passed : null;
      },
      json: (response, status, data) => this.json(response, status, data),
      body: (request) => this.body(request),
      broadcast: (event, data) => this.broadcast(event, data),
      log: this.log,
      adult: (request, response, what) => this.adult(request, response, what),
    });
    this.desktopPassword = new DesktopPassword({ marker: options.accountMarker, socket: options.passwordSocket });
    this.voice = new Voice({
      ...options.voice,
      ai: () => this.ai.read(),
      key: () => this.key.status(),
      spoken: async () => (await this.home.settings()).spoken,
      log: this.log,
    });
    this.news = new News({
      get: options.tmdb ?? tmdbViaRouter(),
      state: options.state,
      keySet: () => this.tmdbKey.status().set,
      region: () => this.region(),
      // Every app on the box but AgenTV's own.
      apps: async () => (await this.home.manifests()).filter(({ tier }) => tier !== "built-in").map(({ manifest }) => ({ id: manifest.id, name: manifest.name, category: manifest.tv.category })),
      now: options.newsNow,
      log: this.log,
    });
    this.phones = new Phones({ path: join(options.state, "phones.json") });
    this.phoneChannel = new PhoneChannel({ phone: (id) => this.phones.key(id) });
    this.hotspot = new Hotspot({ state: options.state, run: options.hotspotRun });
    this.network = new TvNetwork({ hotspot: this.hotspot, run: options.hotspotRun, interfaces: options.interfaces, changed: (state) => this.toPages("network", state) });
    this.setupState = new Setup({ path: join(options.state, "setup.json"), on: (feature) => this.features.on(feature) });
    this.ai = new Ai({ state: options.state, channel: () => this.channel() });
    this.aiIcons = new AiIcons({ state: options.state, userAgent: userAgent(options.root), sites: options.aiSites, log: this.log });
    this.planSignIn = new PlanSignIn({ state: options.state, drop: join(options.state, "build-drop"), run: options.buildRun ?? "/run/agentv-build" });
    this.buildAwake = options.inhibitor?.("building an app") ?? { set: () => {} };
    this.builds = new Builds({ state: options.state, drop: join(options.state, "build-drop"), builds: options.builds, run: options.buildRun, spend: options.spend, warnings: options.npmWarnings });
    this.backgrounds = new Backgrounds({ dir: options.backgrounds ?? "/var/lib/agentv/backgrounds" });
    this.shared = new Shared({ dir: options.shared ?? "/var/lib/agentv/shared" });
    this.art = new ArtArchives({ cache: options.state, userAgent: userAgent(options.root), ...options.art });
    this.immich = new ImmichAlbum({ userAgent: userAgent(options.root) });
    this.discover = new Discover({ log: this.log, changed: (state) => this.toPages("discover", state), screen: () => this.phonesChanged(), picked: (key) => this.toPages("discover-pick", { key }), ...options.discover });
    this.serverPicks = new ServerPicks({ state: options.state, home: this.home, saved: () => this.broadcast("apps", {}), log: this.log, own: options.harness?.thisBox ? () => null : undefined });
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
        void this.serverPicks.settle(Object.keys(apps).filter((id) => apps[id].state === "failed"));
      },
    });
    if (options.lanPort !== undefined) {
      this.lan = createServer((request, response) => {
        this.handlePhone(request, response).catch((error: Error) => {
          this.log(`error: phone ${request.method} ${new URL(request.url ?? "/", "http://phone").pathname}: ${error.message}`);
          if (!response.headersSent) this.json(response, 500, { ok: false, error: WENT_WRONG });
          else response.end();
        });
      });
    }
    if (options.setupPort !== undefined) {
      this.captive = createServer((request, response) => {
        this.handleCaptive(request, response).catch((error: Error) => {
          this.log(`error: setup page ${request.method} ${new URL(request.url ?? "/", "http://setup").pathname}: ${error.message}`);
          if (!response.headersSent) this.json(response, 500, { ok: false, error: WENT_WRONG });
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
      // A client that reconnects at once, as the screen daemon does, would
      // otherwise open a new long wait the stop then has to sit out.
      if (this.closing) {
        response.writeHead(503, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
        response.end(JSON.stringify({ ok: false, error: "the TV's server is stopping" }));
        return;
      }
      this.handle(request, response).catch((error: Error) => {
        this.log(`error: ${request.method} ${request.url}: ${error.message}`);
        if (!response.headersSent) this.json(response, 500, { ok: false, error: WENT_WRONG });
        else response.end();
      });
    });
  }

  listen(): Promise<number> {
    // The builds, looked at every two seconds: the TV and the phones hear
    // when one moves on.
    this.buildsTimer = setInterval(() => void this.watchBuilds(), 2000);
    this.buildsTimer.unref();
    void this.fetchAiCli("the daemon started");
    const lan = this.lan;
    const captive = this.captive;
    const phones = Promise.all([
      lan ? new Promise<void>((resolve) => lan.listen(this.options.lanPort, this.options.lanHost ?? "0.0.0.0", () => resolve())) : null,
      captive ? new Promise<void>((resolve) => captive.listen(this.options.setupPort, this.options.setupHost ?? "0.0.0.0", () => resolve())) : null,
      this.homeProxy?.listen(this.options.homeProxyPort, "127.0.0.1"),
    ]);
    return phones.then(
      () =>
        new Promise((resolve) => {
          this.server.listen(this.options.port, this.options.host ?? "127.0.0.1", () => {
            this.port = (this.server.address() as { port: number }).port;
            resolve(this.port);
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

  // systemd gives the daemon 5 s to stop (agentv-daemon.service). Idle
  // connections go at once; one still busy, such as a phone's or the screen
  // daemon's long wait, gets a second to finish, and is then cut.
  close(graceMs = 1000): Promise<void> {
    this.closing = true;
    clearInterval(this.buildsTimer);
    this.discover.close();
    for (const stream of this.streams) stream.end();
    for (const stream of this.remotes) stream.end();
    for (const server of [this.lan, this.captive]) if (server) void stopServer(server, graceMs);
    void this.homeProxy?.close();
    this.home.stop();
    this.updates.stop();
    this.setupApps.stop();
    this.openLedger?.close();
    this.pageAsks.close();
    this.phoneRemote.close();
    this.sayAsks.close();
    this.exportAsks.close();
    this.themeAsks.close();
    this.displayRoutes.close();
    this.network.close();
    this.controllerRoutes.close();
    return stopServer(this.server, graceMs);
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

  // Settings → AI's state: which provider has a key (never the key), the
  // plans on offer (ADR-087), and what builds use now, by
  // plan or key, and whether its terms are accepted (Q143).
  private async keyState(): Promise<object> {
    const { set, provider } = this.key.status();
    const plans = Object.values(await this.ai.offers()).filter((offer) => offer.plan.offered).map((offer) => ({ provider: offer.provider, name: offer.plan.name }));
    const ai = await this.ai.read();
    return { set, provider, plans, ai: { provider: ai.provider, path: ai.path, accepted: ai.accepted !== null } };
  }

  // The channel this box updates from, as `agentv channel` says it: the one
  // /etc/agentv/channel names, or else the one its package was built for.
  // A checkout's daemon, with neither, is on stable.
  private async channel(): Promise<string> {
    const chosen = (await readFile(this.options.channelFile ?? "/etc/agentv/channel", "utf8").catch(() => "")).split("\n")[0].trim();
    if (chosen) return chosen;
    const built = (await this.settings()).AGENTV_CHANNEL;
    return built === "dev" ? "stable" : built || "stable";
  }

  setup(): Promise<SetupState> {
    return this.setupState.read();
  }

  // --- The builder (ADR-011, ADR-043 to ADR-046) ---------------------------

  private async watchBuilds(): Promise<void> {
    // A build waiting for its plan's sign-in gets one, and goes on after it,
    // and a streaming service's app learns the rest once it's signed in.
    await this.builds.tend({ signedIn: (id) => this.home.isSignedIn(id) }).catch(() => false);
    await this.tendThemes().catch(() => {});
    const now = JSON.stringify([await this.builds.list().catch(() => []), await this.madeApplied()]);
    if (now === this.buildsSeen) return;
    this.buildsSeen = now;
    this.broadcast("builds", {});
    // A build keeps the box awake while it runs (ADR-072).
    this.buildAwake.set(await this.builds.running().catch(() => false));
  }

  private async buildsState() {
    return {
      builds: await this.builds.list(),
      settings: await this.builds.settings(),
      spend: await this.builds.spend(),
      warnings: this.builds.warnings(),
      // What setup's "+ add your own" kept for the builder.
      wishes: (await this.setup()).wishes,
      // Each made theme the TV has handed to Omarchy, or why it couldn't.
      themes: await this.madeApplied(),
    };
  }

  // --- Themes your agent made (S6.4) ---------------------------------------

  private get themesDir(): string {
    return this.options.themes ?? THEMES;
  }

  // Which version of each made theme the screen daemon handed to Omarchy,
  // or why it couldn't. Each version goes once, so a theme the person
  // changed from isn't set again.
  private async madeApplied(): Promise<Record<string, { version: string; name?: string; error?: string }>> {
    try {
      return JSON.parse(await readFile(join(this.options.state, "made-themes.json"), "utf8"));
    } catch {
      return {};
    }
  }

  // A change to that record, one after another, so two answers at once
  // don't write over each other.
  private changeApplied(change: (applied: Record<string, { version: string; name?: string; error?: string }>) => void): Promise<void> {
    this.appliedChanging = this.appliedChanging.then(async () => {
      const applied = await this.madeApplied();
      change(applied);
      await mkdir(this.options.state, { recursive: true });
      await writeFile(join(this.options.state, "made-themes.json.next"), JSON.stringify(applied, null, 2));
      await rename(join(this.options.state, "made-themes.json.next"), join(this.options.state, "made-themes.json"));
    });
    return this.appliedChanging;
  }

  private appliedChanging: Promise<void> = Promise.resolve();

  // A theme an adult approved, once root put it in place: the screen daemon,
  // as the person, hands it to Omarchy and sets it, so the TV and the desktop
  // change together. One that's removed goes from Omarchy too.
  private async tendThemes(): Promise<void> {
    const applied = await this.madeApplied();
    const placed = new Map(madeThemes(this.themesDir).map((theme) => [theme.app, theme.version]));
    const asks: { id: string; key: string; ask: ThemeAsk; version?: string }[] = [];
    for (const view of await this.builds.list()) {
      if (view.state !== "installed" || view.understood?.recipe !== "theme") continue;
      if (placed.get(view.id) !== view.version || applied[view.id]?.version === view.version) continue;
      asks.push({ id: view.id, key: `take ${view.id} ${view.build} ${view.version}`, ask: { kind: "take", id: view.id }, version: view.version });
    }
    for (const id of Object.keys(applied)) if (!placed.has(id)) asks.push({ id, key: `drop ${id}`, ask: { kind: "drop", id } });
    for (const { id, key, ask, version } of asks) {
      if (this.themesAsked.has(key)) continue;
      this.themesAsked.add(key);
      void this.themeAsks
        .ask(ask, 120_000)
        .then(async (said) => {
          // The TV didn't answer: the next pass asks again.
          if (said.late) return void this.themesAsked.delete(key);
          await this.changeApplied((now) => {
            if (ask.kind === "drop") delete now[id];
            else now[id] = { version: version!, ...(said.ok ? { name: said.name } : { error: said.error }) };
          });
          for (const asked of [...this.themesAsked]) if (asked.startsWith(ask.kind === "drop" ? `take ${id} ` : `drop ${id}`)) this.themesAsked.delete(asked);
          this.log(ask.kind === "drop" ? `${id} is gone from omarchy's themes` : said.ok ? `${id} ${version} is the theme now, on the tv and the desktop` : `${id} ${version} couldn't be set: ${said.error}`);
          void this.watchBuilds();
        })
        .catch((error: Error) => {
          this.themesAsked.delete(key);
          this.log(`made themes: ${error.message}`);
        });
    }
  }

  // The AI a build runs on: picked, its terms accepted, and a key there for
  // a key's path.
  private async builderAi(): Promise<{ ai?: { provider: BuildProvider; path: "plan" | "key" }; error?: string }> {
    const ai = await this.ai.read();
    if (!ai.provider || !ai.path || !ai.accepted) return { error: "Set up AI in Settings first" };
    if (ai.path === "key") {
      const key = this.key.status();
      if (!key.set || key.provider !== ai.provider) return { error: "Add an API key in Settings first" };
    }
    return { ai: { provider: ai.provider, path: ai.path } };
  }

  // The TV's asks of the builder, and the phone's when phone is given. True
  // when it was one.
  private async builderApi(method: string | undefined, path: string, request: IncomingMessage, response: ServerResponse, phone?: { name: string }): Promise<boolean> {
    const base = phone ? "/api/phone/builds" : "/api/builds";
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    const answer = (result: { build?: unknown; error?: string }, done?: string) => {
      if (result.error) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      if (done) this.log(done);
      void this.watchBuilds();
      this.json(response, 200, { ok: true, ...(result.build ? { build: result.build } : {}) });
    };
    const viewer = await this.profiles.active();
    if (viewer.role !== "adult") {
      this.json(response, 403, { ok: false, error: "Only adults can build apps" });
      return true;
    }
    if (method === "GET" && path === base) {
      this.json(response, 200, { ok: true, ...(await this.buildsState()) });
      return true;
    }
    const [, build, action] = /^\/api\/(?:phone\/)?builds\/([a-z0-9-]+)(?:\/([a-z]+))?$/.exec(path) ?? [];
    const app = /^\/api\/builds\/apps\/(local\.[a-z0-9-]+)\/([a-z]+)$/.exec(path);

    if (phone) {
      if (method === "GET" && action === "shot") {
        const view = await this.builds.find(build);
        const png = view?.shot ? await readFile(this.builds.shot(view)).catch(() => null) : null;
        if (!png) {
          this.json(response, 404, { ok: false, error: "there's no screenshot" });
          return true;
        }
        response.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "no-store" });
        response.end(png);
        return true;
      }
      // The code the plan's sign-in page gave, for the CLI's prompt, behind
      // the PIN like the rest of the AI's settings (ADR-040).
      if (method === "POST" && action === "code") {
        if (!this.guarded(request, response, "the plan's sign-in")) return true;
        const body = (await this.body(request)) as { code?: unknown } | undefined;
        answer(await this.builds.signInCode(build, body?.code), `${viewer.name} handed the plan's sign-in a code on ${phone.name}`);
        return true;
      }
      // An adult's yes, behind the PIN: a plan, or the app itself (ADR-043, ADR-046).
      if (method === "POST" && (action === "approve" || action === "plan")) {
        if (!this.guarded(request, response, action === "plan" ? "a build's plan" : "a built app")) return true;
        if (action === "plan") answer(await this.builds.approvePlan(build), `${viewer.name} approved a plan on ${phone.name}`);
        else answer(await this.builds.approve(build), `${viewer.name} approved a built app on ${phone.name}`);
        return true;
      }
      this.json(response, 404, { ok: false, error: "not found" });
      return true;
    }

    if (method === "POST" && path === base) {
      const ai = await this.builderAi();
      if (!ai.ai) return answer({ error: ai.error }), true;
      const body = (await this.body(request)) as { sentence?: unknown } | undefined;
      const installed = (await this.home.manifests()).map(({ manifest }) => manifest.id);
      const result = await this.builds.ask(body?.sentence, ai.ai, installed);
      if (result.build) await this.setupState.asked(result.build.sentence);
      answer(result, `${viewer.name} asked the builder for an app`);
      return true;
    }
    if (method === "POST" && path === `${base}/stop`) {
      await this.builds.stop();
      answer({}, "the build was stopped");
      return true;
    }
    if (method === "PUT" && path === `${base}/settings`) {
      if (!this.guarded(request, response, "the builder's caps and safeguards")) return true;
      const result = await this.builds.setSettings(await this.body(request));
      if (result.error) return answer({ error: result.error }), true;
      this.log(`the builder's settings changed: $${result.settings!.cap.build} a build, $${result.settings!.cap.month} a month, safeguards ${result.settings!.safeguards ? "on" : "off"}`);
      this.json(response, 200, { ok: true, settings: result.settings });
      return true;
    }
    if (method === "POST" && app) {
      const [, id, what] = app;
      if (what === "rollback" || what === "remove") {
        if (!this.guarded(request, response, what === "remove" ? "removing a built app" : "going back a version")) return true;
        if (what === "rollback") answer(await this.builds.rollback(id), `${viewer.name} went back a version of ${id}`);
        else {
          const result = await this.builds.remove(id);
          if (!result.error) await this.pageApps.forget(id);
          answer(result, `${viewer.name} removed ${id}`);
        }
        return true;
      }
      if (what === "change" || what === "rebuild") {
        const ai = await this.builderAi();
        if (!ai.ai) return answer({ error: ai.error }), true;
        const body = (await this.body(request)) as { text?: unknown } | undefined;
        answer(await this.builds.next(id, what === "change" ? (body?.text ?? "") : undefined, ai.ai), `${viewer.name} asked for a new version of ${id}`);
        return true;
      }
    }
    // The plan's sign-in link as a QR code, for the phone's camera.
    if (method === "GET" && build && action === "qr") {
      const url = (await this.builds.find(build))?.signIn?.url;
      const svg = url ? await this.qr(url) : null;
      if (!svg) {
        this.json(response, 404, { ok: false, error: url ? "there's no qr code without qrencode" : "nothing is signing in" });
        return true;
      }
      this.send(response, TYPES[".svg"], svg, { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
      return true;
    }
    if (method === "POST" && build && action === "forget") {
      answer(await this.builds.forget(build), `${viewer.name} put a build away`);
      return true;
    }
    if (method === "POST" && build && (action === "confirm" || action === "retry")) {
      answer(action === "confirm" ? await this.builds.confirm(build) : await this.builds.retry(build), `${viewer.name} ${action === "confirm" ? "confirmed" : "retried"} a build`);
      return true;
    }
    this.json(response, 404, { ok: false, error: "not found" });
    return true;
  }

  // Tells every page that's listening what changed, and the phones too.
  private broadcast(event: string, data: unknown): void {
    this.toPages(event, data);
    this.phonesChanged();
  }

  // To the TV's own pages only, for what the phones needn't hear, such as
  // the listening bar's words, which come from a phone (ADR-054).
  private toPages(event: string, data: unknown): void {
    for (const stream of this.streams) stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
          title: typeof pin.title === "string" ? pin.title.slice(0, 60) : "Enter the adult PIN",
          for: pin.for.slice(0, 120),
          digits: Math.max(0, Math.min(4, Number(pin.digits) || 0)),
          error: typeof pin.error === "string" ? pin.error.slice(0, 120) : null,
        };
      }
    }
    // Home's page says its own field; the screen daemon, with what's in
    // front, the field in the app's page, which it leaves out when there's
    // none.
    if (change.field !== undefined) this.homeField = cleanField(change.field);
    if (change.screen === "home" || change.screen === "menu" || change.screen === "ambient") next.screen = change.screen;
    if (typeof change.details === "boolean") next.details = change.details;
    if (change.front === "home" || change.front === "app") {
      next.front = change.front;
      const field = cleanField(change.appField);
      const app = (change.appField as { app?: unknown } | undefined)?.app;
      this.appField = field && typeof app === "string" ? { ...field, app: app.slice(0, 120) } : null;
    }
    next.field = next.front === "app" ? this.appField : this.homeField;
    if (typeof change.playing === "boolean") next.playing = change.playing;
    if (JSON.stringify(next) === JSON.stringify(this.tv)) return;
    const idle = this.idleHome();
    this.tv = next;
    this.phonesChanged();
    // A share that waited while something played asks now (ADR-050).
    if (!idle && this.idleHome()) void this.shareWaiting().then((share) => share && this.broadcast("shared", {}));
  }

  // Home in front with nothing playing: when the TV may ask about a share.
  private idleHome(): boolean {
    return this.tv.front === "home" && !this.tv.playing && this.tv.screen !== "ambient";
  }

  // The shares someone on this profile sees: an adult sees every one, and a
  // child only those sent to them.
  private async sharesFor(viewer: Profile): Promise<Share[]> {
    const all = await this.shared.list();
    return viewer.role === "adult" ? all : all.filter((share) => share.to === viewer.id);
  }

  // The oldest share sent to who's watching that the TV hasn't had an
  // answer for.
  private async shareWaiting(): Promise<Share | null> {
    const viewer = await this.profiles.active();
    return (await this.shared.list()).filter((share) => share.to === viewer.id && !share.answered).at(-1) ?? null;
  }

  // Who a share from this phone goes to: who's watching, unless it's a
  // child's profile an adult hasn't allowed shares for (ADR-050).
  private async shareTarget(phone: { name: string }): Promise<{ from: string; to: string } | { error: string }> {
    const viewer = await this.profiles.active();
    if (viewer.role === "child" && !(await this.shared.allowed()).includes(viewer.id)) {
      return { error: `${viewer.name}'s profile doesn't accept things from phones` };
    }
    return { from: `${viewer.name} on ${phone.name}`, to: viewer.id };
  }

  // A share is in: the TV asks about it now if nothing's playing, or else
  // once nothing is. The phone hears which.
  private async shareIn(response: ServerResponse, share: Share, phone: { name: string }): Promise<void> {
    this.log(`${phone.name} shared a ${share.kind}`);
    this.broadcast("shared", {});
    this.json(response, 200, { ok: true, share, waits: !this.idleHome() });
  }

  // The phone's state: who's watching, the lock, a sign-in, an update and
  // what's on the TV, with the count it's at.
  private async phoneState(phone: unknown): Promise<object> {
    // The count before anything's read: a change while it's read leaves the
    // phone a count behind, so it asks again at once, and never a count
    // ahead of what it was told, with its next ask waiting 25 s.
    const version = this.phoneVersion;
    const viewer = await this.profiles.active();
    const pin = this.pin.status(viewer.locked);
    const setup = await this.setup();
    const remote2 = await this.features.on("remote2");
    const askbuilds = await this.features.on("askbuilds");
    // The new remote's keyboard follows the field in front, an app's page
    // included, with the app's name; the old one only home's.
    const tv = { ...this.tv, field: remote2 ? await this.named(this.tv.field) : this.homeField && { kind: this.homeField.kind } };
    return {
      ok: true,
      version,
      phone,
      // The feature switches the phone draws by.
      features: { remote2, askbuilds },
      // What the Ask box waits on, for an adult's ok on the phone (ADR-068).
      ...(askbuilds ? { ask: viewer.role === "adult" ? await askView(this.askKit()) : null } : {}),
      // The look the TV is in, for the remote to match it (ADR-063, D4).
      look: (await this.features.on("looks")) ? await currentLook({ root: this.options.root, state: this.options.state }) : null,
      viewer,
      viewers: await this.profiles.list(),
      pin: { set: pin.set, locked: pin.locked },
      signIn: this.signingIn ? { name: this.signingIn.name } : null,
      update: await this.phoneUpdate(),
      tv: { ...tv, view: remoteView(tv, this.signingIn !== null) },
      // What's playing, for the new remote's card.
      nowPlaying: remote2 && tv.playing ? await this.nowPlaying(viewer.id) : null,
      // TV setup's step, while it's on (stage 5): the phone says where it is,
      // and with setup's own switch on, its number of the 12.
      setup: setup.done ? null : await this.phoneSetup(setup),
      // What setup's AI step asks of the phone (ADR-023): the provider's
      // terms for an adult to accept, then the key.
      ai: await this.aiAsk(setup),
      // The list of what's on the network the TV shows, for the phone's line.
      discover: (await this.features.on("discover")) ? this.discover.onScreen() : null,
      // Page apps' notices, as the TV shows them (ADR-043).
      notices: this.notices,
      // The builds an adult follows here too: how each is going, and the
      // ones waiting for their yes (ADR-043, ADR-046).
      builds: viewer.role === "adult" ? await this.phoneBuilds() : [],
      // An app the TV offered for Export, for an adult to save here.
      export: viewer.role === "adult" && this.exportOffer && this.exportOffer.until > Date.now() ? { id: this.exportOffer.id, name: this.exportOffer.name, version: this.exportOffer.version, github: this.exportOffer.github } : null,
      // What was last said to the TV, and what came of it, for ten minutes:
      // the phone shows it under its box, and up to three to choose from.
      said: this.saidNow(),
    };
  }

  // The newest row of the ledger, while it's fresh, with its app's name.
  private async nowPlaying(viewer: string): Promise<object | null> {
    const names = new Map((await this.home.manifests().catch(() => [])).map(({ manifest }) => [manifest.id, manifest.name]));
    try {
      return nowPlaying(this.ledger.recent(viewer, { limit: 1 }), (app) => names.get(app) ?? app);
    } catch {
      return null;
    }
  }

  // A field in an app's page, with the app's name for the phone's keyboard
  // ("<app> · search").
  private async named(field: TvContext["field"]): Promise<(TvContext["field"] & { name?: string }) | null> {
    if (!field?.app) return field;
    const found = (await this.home.manifests().catch(() => [])).find(({ manifest }) => manifest.id === field.app);
    return { ...field, name: found?.manifest.name ?? field.app };
  }

  // The router this box's setup chose (daemon/router-client.ts), through
  // its services' sockets.
  private boxRoute(sentence: string, apps: RouterApp[]): Promise<Routed> {
    this.routing ??= boxRouter({ ai: () => this.ai.read(), key: () => this.key.status(), fetchCli: () => void this.fetchAiCli("an ask found it missing") });
    return this.routing(sentence, apps);
  }

  // The AI's own CLI, which a plan routes through and every build runs,
  // fetched as soon as the AI is connected rather than with the first app
  // that's made: a plan or a key whose terms an adult accepted. Root only
  // fetches it when it's missing (builder/sandbox/hand-over.ts), so asking
  // again at start-up, or after an ask found it missing, costs nothing.
  private async fetchAiCli(why: string): Promise<void> {
    try {
      const ai = await this.ai.read();
      if (await this.planSignIn.fetchCli(ai)) this.log(`asked root for ${OFFERS[ai.provider!].cliName}, if it's missing: ${why}`);
    } catch (error) {
      this.log(`couldn't ask root for the AI's CLI: ${(error as Error).message}`);
    }
  }

  private saidNow(): object | null {
    const said = this.say.current;
    if (!said || Date.now() - Date.parse(said.at) > 10 * 60_000) return null;
    const { route: _route, ...shown } = said;
    return shown;
  }

  // Why the TV won't take a sentence now, or null: setup isn't done, or
  // the TV is locked behind the PIN (ADR-034).
  private async sayRefusal(): Promise<string | null> {
    if (!(await this.setup()).done) return "Finish setup on your TV first";
    if (this.pin.status((await this.profiles.active()).locked).locked) return "Your TV is locked. Unlock it first.";
    return null;
  }

  // A sentence, from the TV or a phone, once it's done.
  private async sayIt(request: IncomingMessage, response: ServerResponse, from: string): Promise<void> {
    const refused = await this.sayRefusal();
    if (refused) {
      this.json(response, 409, { ok: false, error: refused });
      return;
    }
    const body = (await this.body(request)) as { sentence?: unknown } | undefined;
    if (typeof body?.sentence !== "string" || !body.sentence.trim()) {
      this.json(response, 400, { ok: false, error: "Say something" });
      return;
    }
    this.json(response, 200, { ok: true, said: await this.say.hear(body.sentence, from) });
  }

  private async sayPick(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = (await this.body(request)) as { n?: unknown; choice?: unknown } | undefined;
    const picked = await this.say.pick(body?.n, body?.choice);
    this.json(response, picked.said ? 200 : 409, picked.said ? { ok: true, said: picked.said } : { ok: false, error: picked.error });
  }

  private async phoneBuilds(): Promise<object[]> {
    const builds = await this.builds.list().catch(() => []);
    return builds
      .filter((b) => b.state !== "installed" && b.state !== "kept")
      .map((b) => ({
        build: b.build,
        id: b.id,
        name: b.name ?? b.sentence,
        provider: b.provider,
        state: b.state,
        phase: b.phase,
        ...(b.signIn ? { signIn: b.signIn.state } : {}),
        ...(b.ranOut ? { ranOut: true } : {}),
        done: b.steps.filter((step) => step.state === "done").length,
        steps: b.steps.length,
        ...(b.reason ? { reason: b.reason } : {}),
      }));
  }

  private async aiAsk(setup: SetupState): Promise<object | null> {
    if (this.keyTerms) {
      const offer = OFFERS[this.keyTerms];
      return { ask: "terms", provider: this.keyTerms, path: "key", name: offer.name, maker: offer.maker, plan: offer.plan.name, terms: offer.terms.key, summary: offer.summary.key, keyUrl: offer.keyUrl };
    }
    if (this.planTerms) {
      const offer = OFFERS[this.planTerms];
      return { ask: "terms", provider: this.planTerms, path: "plan", name: offer.name, maker: offer.maker, plan: offer.plan.name, terms: offer.terms.plan, summary: offer.summary.plan, keyUrl: offer.keyUrl };
    }
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
    const port = this.port;
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

  // The code on show, and the address a phone types it at.
  private pairing(): { code: string; until: string; url: string | null } | null {
    const showing = this.phones.showing();
    if (!showing) return null;
    const address = this.boxAddress();
    const port = this.lanPort;
    return { ...showing, url: address && port ? `http://${address}:${port}/` : null };
  }

  // What the QR code holds: the address, and after the # the secret that
  // pairs the phone that scans it. A browser keeps that part to itself, so
  // the secret never crosses the network, and it's never on the TV as text.
  private pairingQr(): string | null {
    const url = this.pairing()?.url;
    const secret = this.phones.secret();
    return url && secret ? `${url}#pair=${secret}` : null;
  }

  private qr(text: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(this.options.qrencode ?? "qrencode", ["-t", "SVG", "-m", "1", "-o", "-", "--", text], { timeout: 5000 }, (error, stdout) =>
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
  private async phoneSetup(setup: SetupState): Promise<object> {
    const progress = await this.setupState.progress();
    const n = progress.numbers?.[setup.step];
    return { step: setup.step, part: progress.parts[setup.step] ?? setup.step, ...(n ? { n, of: progress.of } : {}), muted: setup.muted };
  }

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
    // Someone has the page open. A phone asking whether it's online, above,
    // doesn't count: it does that by itself, from a pocket.
    this.hotspot.used();

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      await this.file(response, join("companion-web", "setup.html"));
      return;
    }
    if (await this.setupRoutes.handle("captive", request, response, url)) return;
    if (method === "GET" && CAPTIVE_FILES.includes(path.slice(1))) {
      await this.file(response, path.slice(1));
      return;
    }
    if (method === "GET" && path === "/api/theme.css") {
      this.send(response, TYPES[".css"], await this.home.theme());
      return;
    }

    // The networks the box could see before it opened its own. After
    // setup, the hotspot is open because the TV lost its network, and the
    // page says so and asks for the adult PIN when one is set.
    if (method === "GET" && path === "/api/setup/networks") {
      const hotspot = this.hotspot.status();
      const after = (await this.setup()).done;
      this.json(response, 200, { ok: true, hotspot: hotspot.ssid, networks: this.hotspot.networks(), ...(after ? { after: true, pin: this.pin.status().set } : {}) });
      return;
    }

    // How joining goes, for a phone back on the hotspot after a wrong
    // password. A page that's waiting on its own join names it, and hears
    // whether root has answered that one: an error from the try before
    // isn't this try's.
    if (method === "GET" && path === "/api/setup/state") {
      const { on, joining, joined, error } = this.hotspot.status();
      const ask = url.searchParams.get("ask");
      this.json(response, 200, { ok: true, on, joining, joined, error, ...(ask === null ? {} : { answered: this.hotspot.answered(ask) }) });
      return;
    }

    // The home Wi-Fi to join. Its password goes to root and nowhere else.
    if (method === "POST" && path === "/api/setup/wifi") {
      const body = (await this.body(request)) as { ssid?: unknown; password?: unknown; pin?: unknown } | undefined;
      // A join that can't go ahead is refused before the PIN is looked at,
      // so the right PIN with it changes nothing on the TV.
      const refused = this.hotspot.refuses(body?.ssid, body?.password ?? "");
      if (refused) {
        this.json(response, 400, { ok: false, error: refused });
        return;
      }
      // After setup, changing the TV's Wi-Fi is an adult's: with a PIN set,
      // the page sends it too. Wrong tries from the hotspot's page count on
      // their own, and wait as the TV's pad's do. The PIN there allows the
      // Wi-Fi change and nothing else: a locked TV stays locked, the pad's
      // own wrong tries stand and no grant comes of it.
      if ((await this.setup()).done && this.pin.status().set) {
        const checked = this.pin.right(body?.pin, "hotspot");
        if (!checked.ok) {
          this.log(checked.wait ? "a wrong pin on the hotspot's page; the next try waits" : "a wrong pin on the hotspot's page");
          this.json(response, 403, { ok: false, error: checked.error, pin: true, ...(checked.wait ? { wait: checked.wait } : {}) });
          return;
        }
      }
      const why = this.hotspot.join(body?.ssid, body?.password ?? "");
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      this.log(`a phone on the setup hotspot asked to join ${String(body?.ssid)}`);
      this.json(response, 200, { ok: true, joining: body?.ssid, ask: this.hotspot.asked });
      return;
    }

    this.json(response, 404, { ok: false, error: "not found" });
  }

  // --- The phone companion, on the home network ------------------------------

  // Only the companion's page and its requests are here, never the TV's own.
  // Past pairing, every request is signed with a key of the phone's own, and
  // what it says is sealed (daemon/phone-channel.ts). A request that changes
  // something has to come from the companion's own page.
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
    // The looks' fonts too, for the phone's remote in Glass and Cinema.
    if (method === "GET" && (path === "/launcher/layout.ts" || path === "/launcher/glyphs.ts" || /^\/launcher\/fonts\/[a-z-]+\.woff2$/.test(path))) {
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
      const paired = this.phones.pair((await this.body(request)) as PairRequest | undefined);
      if ("error" in paired) {
        this.log("a phone sent a wrong pairing code");
        this.json(response, 403, { ok: false, error: paired.error });
        return;
      }
      this.log(`${paired.phone.name} is paired`);
      this.broadcast("phones", { paired: paired.phone.name });
      this.json(response, 200, { ok: true, ...paired });
      return;
    }

    // A paired phone opening a session. Nothing in it is secret.
    if (method === "POST" && path === "/api/phone/hello") {
      const hello = this.phoneChannel.hello(await this.body(request));
      if (hello) this.json(response, 200, { ok: true, ...hello });
      else this.json(response, 401, { ok: false, error: "This phone isn't paired. Pair it from your TV.", pair: true });
      return;
    }

    // Everything past here is a paired phone's: the signature is checked,
    // a sealed body is opened for the routes to read, and JSON answers are
    // sealed on their way out.
    const opened = await this.phoneChannel.open(request, response);
    if (!opened) return;
    request = opened.request;
    const phone = opened.phone;
    this.signedBy.set(request, phone.id);
    this.phones.saw(phone.id);
    if (await this.phoneRemote.phone(method ?? "", path, request, response)) return;

    // Routes in files of their own (daemon/routes/), one line each.
    if (path === "/api/phone/features" && (await featureRoutes(this.featureKit(), request, response, path))) return;
    if (await discoverRoute(this.discover, method, path, url, response, true, request)) return;
    if (await phoneBoxRoute(this.boxKit(), method, path, response)) return;

    if (await this.setupRoutes.handle("phone", request, response, url)) return;
    if (path.startsWith("/api/phone/ask") && (await askRoutes(this.askKit(), request, response, path))) return;

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
        this.json(response, 403, { ok: false, error: "A child's profile has no settings" });
        return;
      }
      this.broadcast("page", { route: "settings" });
      // Over an app, home comes in front first (ADR-065).
      this.remote({ cmd: "settings" });
      this.json(response, 200, { ok: true });
      return;
    }

    // A sentence for the TV (ADR-023): the phone keyboard's dictation, or
    // what was typed, and one of up to three to choose from.
    if (method === "POST" && path === "/api/phone/say") {
      await this.sayIt(request, response, phone.name);
      return;
    }
    if (method === "POST" && path === "/api/phone/say/pick") {
      await this.sayPick(request, response);
      return;
    }
    // The box's words as the phone's dictation fills it in, or that it
    // opened or closed (ADR-054). Kept nowhere: they go on to the TV.
    if (method === "POST" && path === "/api/phone/say/live") {
      const refused = await this.sayRefusal();
      if (refused) {
        this.json(response, 409, { ok: false, error: refused });
        return;
      }
      const why = this.listening.change(phone.name, await this.body(request));
      this.json(response, why ? 400 : 200, why ? { ok: false, error: why } : { ok: true });
      return;
    }
    if (method === "POST" && path === "/api/phone/say/dismiss") {
      this.json(response, 200, { ok: this.say.dismiss(((await this.body(request)) as { n?: unknown } | undefined)?.n) });
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
        this.json(response, 409, { ok: false, error: "Setup is done" });
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
        this.json(response, 403, { ok: false, error: "Only adults can change the background" });
        return;
      }
      let body: Buffer;
      try {
        body = await this.raw(request, MAX_PHOTO);
      } catch (error) {
        this.json(response, 413, { ok: false, error: (error as Error).message });
        return;
      }
      const result = await this.backgrounds.add(body, { text: url.searchParams.get("credit"), from: `${viewer.name} on ${phone.name}` });
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.log(`${phone.name} sent a photo for the background`);
      this.broadcast("background", result.state);
      this.json(response, 200, { ok: true, background: result.item });
      return;
    }

    // Share to the TV (ADR-050, S5.10): a link, a photo or a video, for
    // who's watching. The TV asks before it shows any of them.
    const sharing = /^\/api\/phone\/share\/(link|photo|video)$/.exec(path);
    if (method === "POST" && sharing) {
      const target = await this.shareTarget(phone);
      if ("error" in target) {
        this.json(response, 403, { ok: false, error: target.error });
        return;
      }
      let result: { share?: Share; error?: string };
      if (sharing[1] === "link") {
        result = await this.shared.addLink(((await this.body(request)) as { url?: unknown } | undefined)?.url, target);
      } else if (sharing[1] === "photo") {
        let body: Buffer;
        try {
          body = await this.raw(request, MAX_PHOTO);
        } catch (error) {
          this.json(response, 413, { ok: false, error: (error as Error).message });
          return;
        }
        result = await this.shared.addPhoto(body, url.searchParams.get("credit"), target);
      } else {
        if (Number(request.headers["content-length"]) > MAX_VIDEO) {
          this.json(response, 413, { ok: false, error: `That video is too big. ${MAX_VIDEO / 1024 ** 3} GB at most.` });
          return;
        }
        result = await this.shared.addVideo(request, url.searchParams.get("name"), target);
      }
      if (!result.share) {
        this.json(response, result.error?.includes("too big") ? 413 : 400, { ok: false, error: result.error });
        return;
      }
      await this.shareIn(response, result.share, phone);
      return;
    }

    // AgenTV's sign-in screen (ADR-032, S4.9): the name and the password the
    // phone's password manager filled, typed into the service's form on the
    // TV, with Tab between them and Enter after. Never logged.
    if (method === "POST" && path === "/api/phone/sign-in") {
      const body = (await this.body(request)) as { username?: unknown; password?: unknown } | undefined;
      if (!this.signingIn) {
        this.json(response, 409, { ok: false, error: "Nothing is signing in on your TV" });
        return;
      }
      const fits = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200;
      if (!fits(body?.username) || !fits(body?.password)) {
        this.json(response, 400, { ok: false, error: "Names and passwords can be up to 200 characters" });
        return;
      }
      const sent = [{ text: body!.username }, { key: "tab" }, { text: body!.password }, { key: "enter" }].every((event) => this.remote(event as Record<string, unknown>));
      if (!sent) {
        this.json(response, 503, { ok: false, error: NOT_READY });
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
        this.json(response, 503, { ok: false, error: NOT_READY });
        return;
      }
      this.log(`the update installs now, from ${phone.name}`);
      this.json(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && path === "/api/phone/updates/later") {
      const update = (await this.phoneUpdate()) as { version: string } | null;
      if (!update) {
        this.json(response, 404, { ok: false, error: "Couldn't find that update" });
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
        this.json(response, 503, { ok: false, error: NOT_READY });
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
        this.json(response, 404, { ok: false, error: NO_PROFILE });
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
        this.json(response, 403, { ok: false, error: "Only adults can accept the terms" });
        return;
      }
      if (!this.guarded(request, response, "accepting the provider's terms from a phone")) return;
      const body = (await this.body(request)) as { provider?: unknown; path?: unknown } | undefined;
      // Settings → AI's key, waiting for its provider's terms (Q104).
      if (this.keyTerms && body?.provider === this.keyTerms && body?.path === "key") {
        const provider = this.keyTerms;
        const recorded = await this.ai.record(provider, "key", { phone: phone.name, viewer: viewer.name });
        if (!recorded.acceptance) {
          this.json(response, 400, { ok: false, error: recorded.error });
          return;
        }
        this.keyTerms = null;
        this.log(`${viewer.name} accepted ${provider}'s terms for a key, on ${phone.name}, for settings`);
        this.broadcast("terms", { provider, path: "key", accepted: recorded.acceptance });
        this.json(response, 200, { ok: true, accepted: recorded.acceptance });
        return;
      }
      // Settings → AI's plan, waiting for its provider's terms (Q143).
      if (this.planTerms && body?.provider === this.planTerms && body?.path === "plan") {
        const provider = this.planTerms;
        const recorded = await this.ai.record(provider, "plan", { phone: phone.name, viewer: viewer.name });
        if (!recorded.acceptance) {
          this.json(response, 400, { ok: false, error: recorded.error });
          return;
        }
        this.planTerms = null;
        this.log(`${viewer.name} accepted ${provider}'s terms for a plan, on ${phone.name}, for settings`);
        this.broadcast("terms", { provider, path: "plan", accepted: recorded.acceptance });
        this.json(response, 200, { ok: true, accepted: recorded.acceptance });
        return;
      }
      const result = await this.ai.accept(body?.provider, body?.path, { phone: phone.name, viewer: viewer.name });
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.log(`${viewer.name} accepted ${result.state.provider}'s terms for ${result.state.path === "plan" ? "a plan" : "a key"}, on ${phone.name}`);
      this.broadcast("ai", result.state);
      void this.fetchAiCli("its terms were accepted");
      this.json(response, 200, { ok: true, accepted: result.state.accepted });
      return;
    }

    // The key, pasted on the phone (board 05), once its terms are accepted:
    // root's alone, as from Settings → AI (S4.6).
    if (method === "POST" && path === "/api/phone/key") {
      if ((await this.profiles.active()).role !== "adult") {
        this.json(response, 403, { ok: false, error: "Only adults can change the key" });
        return;
      }
      if (!this.guarded(request, response, "the provider key from a phone")) return;
      const ai = await this.ai.read();
      if (!ai.provider || !ai.accepted) {
        this.json(response, 409, { ok: false, error: ai.provider ? `Accept ${OFFERS[ai.provider].name}'s terms first` : "Set up AI in Settings first" });
        return;
      }
      const body = (await this.body(request)) as { key?: unknown } | undefined;
      const why = await this.key.store(ai.provider, body?.key);
      if (why) {
        this.log(`the provider key from ${phone.name} wasn't kept: ${why}`);
        this.json(response, notSaved(why) ? 500 : 400, { ok: false, error: why });
        return;
      }
      this.log(`a key for ${ai.provider} is kept, root's alone, from ${phone.name}`);
      this.broadcast("key", { set: true, provider: ai.provider });
      void this.fetchAiCli("a key was kept");
      this.json(response, 200, { ok: true, provider: ai.provider });
      return;
    }

    if (await this.builderApi(method, path, request, response, phone)) return;

    // Export (ADR-045): the app the TV offered, as a .zip for this phone, an
    // adult's, and never one that drives a service's own site.
    const exporting = /^\/api\/phone\/apps\/(local\.[a-z0-9-]+)\/export$/.exec(path);
    if (method === "GET" && exporting) {
      if ((await this.profiles.active()).role !== "adult") {
        this.json(response, 403, { ok: false, error: "Only adults can save a copy" });
        return;
      }
      // Only the app the TV is offering now, as the push below.
      if (this.exportOffer?.id !== exporting[1] || this.exportOffer.until <= Date.now()) {
        this.json(response, 403, { ok: false, error: "Save a copy from its details on your TV first" });
        return;
      }
      const found = (await this.home.manifests()).find(({ manifest }) => manifest.id === exporting[1]);
      const refusal = found ? exportRefusal(found.manifest, found.tier) : NO_APP;
      if (!found || refusal) {
        this.json(response, 400, { ok: false, error: refusal });
        return;
      }
      const zip = zipFolder(found.dir, `${found.manifest.id}-${found.manifest.version}`);
      this.exportOffer = null;
      this.phonesChanged();
      this.log(`${found.manifest.id} was exported to ${phone.name}`);
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": zip.length,
        "Content-Disposition": `attachment; filename="${found.manifest.id}-${found.manifest.version}.zip"`,
        "Cache-Control": "no-store",
      });
      response.end(zip);
      return;
    }

    // The push to a repo of the person's own, asked here each time behind
    // the PIN, and done by the screen daemon as the person, with their own
    // GitHub sign-in. AgenTV's own repos are refused (ADR-045).
    const pushing = /^\/api\/phone\/apps\/(local\.[a-z0-9-]+)\/push$/.exec(path);
    if (method === "POST" && pushing) {
      const viewer = await this.profiles.active();
      if (viewer.role !== "adult") {
        this.json(response, 403, { ok: false, error: "Only adults can save a copy" });
        return;
      }
      if (!this.guarded(request, response, "pushing an app to GitHub")) return;
      const offer = this.exportOffer;
      if (!offer || offer.id !== pushing[1] || offer.until <= Date.now()) {
        this.json(response, 400, { ok: false, error: "Save a copy from its details on your TV first" });
        return;
      }
      if (!offer.github) {
        this.json(response, 400, { ok: false, error: "This TV isn't signed in to GitHub" });
        return;
      }
      const found = (await this.home.manifests()).find(({ manifest }) => manifest.id === offer.id);
      const refusal = found ? exportRefusal(found.manifest, found.tier) : NO_APP;
      if (!found || refusal) {
        this.json(response, 400, { ok: false, error: refusal });
        return;
      }
      const body = (await this.body(request)) as { repo?: unknown } | undefined;
      const repo = parseRepo(body?.repo, offer.github.login);
      const refused = "error" in repo ? repo.error : repoRefusal(repo, agentvOwner());
      if (refused || "error" in repo) {
        this.json(response, 400, { ok: false, error: refused });
        return;
      }
      const files = packageFiles(found.dir).map(({ path, data }) => ({ path, data: data.toString("base64") }));
      this.log(`${viewer.name} pushes ${offer.id} to github.com/${repo.owner}/${repo.name} from ${phone.name}`);
      const said = await this.exportAsks.ask({ kind: "push", id: offer.id, name: offer.name, version: offer.version, repo, files }, 5 * 60_000);
      if (!said.ok) {
        this.log(`${offer.id} wasn't pushed: ${[said.error, said.detail].filter(Boolean).join(": ")}`);
        this.json(response, 502, { ok: false, error: said.error });
        return;
      }
      this.log(`${offer.id} is on github.com/${repo.owner}/${repo.name}${said.pushed === false ? ", which had it already" : ""}`);
      if (this.exportOffer === offer) {
        this.exportOffer = null;
        this.phonesChanged();
      }
      this.json(response, 200, { ok: true, url: said.url, pushed: said.pushed });
      return;
    }

    // The adult PIN, entered on the phone: a grant, and the TV unlocked.
    if (method === "POST" && path === "/api/phone/pin") {
      const locked = (await this.pinStatus()).locked;
      const body = (await this.body(request)) as { pin?: unknown } | undefined;
      const checked = this.pin.check(body?.pin, phone.id);
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

  // The builder for make and change from the Ask box (ADR-068), for who's
  // watching: adults only, with the AI set up the way a build needs it.
  private execBuilds(viewer: { id: string; role: "adult" | "child" }): ExecBuilds {
    return {
      adult: viewer.role === "adult",
      ready: async () => {
        const ai = await this.ai.read();
        if (!ai.provider || !ai.path) return NO_AI;
        if (!ai.accepted) return `Accept ${OFFERS[ai.provider].name}'s terms first`;
        const key = this.key.status();
        if (ai.path === "key" && !(key.set && key.provider === ai.provider)) return `Add your ${OFFERS[ai.provider].name} key in Settings first`;
        return null;
      },
      make: async (what) => {
        const ai = await this.builderAi();
        if (!ai.ai) return { error: ai.error };
        const installed = (await this.home.manifests()).map(({ manifest }) => manifest.id);
        const asked = await this.builds.ask(what, ai.ai, installed);
        if (!asked.build) return { error: asked.error };
        void this.watchBuilds();
        this.log(`${viewer.id} asked the builder for an app from the ask box`);
        return { build: asked.build.build };
      },
      recipe: async (app) => (await this.builds.list()).find((b) => b.id === app && b.state === "installed")?.understood?.recipe ?? null,
    };
  }

  // What the Ask box's routes need of the daemon.
  private askKit(): AskRoutes {
    return {
      on: () => this.features.on("askbuilds"),
      adult: async () => (await this.profiles.active()).role === "adult",
      said: () => this.say.current,
      find: (build) => this.builds.find(build),
      confirm: async (build) => {
        const done = await this.builds.confirm(build);
        void this.watchBuilds();
        return done;
      },
      forget: async (build) => {
        const done = await this.builds.forget(build);
        void this.watchBuilds();
        return done;
      },
      change: async (app, what) => {
        const ai = await this.builderAi();
        if (!ai.ai) return { error: ai.error };
        const made = await this.builds.next(app, what, ai.ai);
        void this.watchBuilds();
        return made;
      },
      settle: (n, outcome) => this.say.settle(n, outcome),
      dismiss: (n) => this.say.dismiss(n),
      body: (request) => this.body(request),
      json: (response, status, data) => this.json(response, status, data),
      log: this.log,
    };
  }

  // What the box check's routes need of the daemon.
  private boxKit(): BoxRoutes {
    // Its news moves the TV to 1080p output when the box can't keep 4K
    // smooth (ADR-062).
    const broadcast = (event: string, data: unknown) => {
      this.broadcast(event, data);
      if (event === "box") void this.displayRoutes.follow();
    };
    return { box: this.box, json: (response, status, data) => this.json(response, status, data), body: (request) => this.body(request), broadcast, log: this.log };
  }

  // What the switches' routes need of the daemon.
  private featureKit(): FeatureRoutes {
    // The TV's size follows the sizes switch at once (ADR-062).
    const changed = (all: FeatureMap) => {
      this.broadcast("features", all);
      void this.displayRoutes.switched(all.sizes);
    };
    return { features: this.features, body: (request) => this.body(request), json: (response, status, data) => this.json(response, status, data), changed, log: this.log };
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

  // Whether the person's account here is signed in to GitHub, asked of the
  // screen daemon, which runs as them. If it is, the phone offers a push too.
  private async offerPush(offer: ExportOffer): Promise<void> {
    const said = await this.exportAsks.ask({ kind: "sign-in" }, 30_000);
    if (this.exportOffer !== offer || !said.ok || !said.via || !said.login) return;
    offer.github = { via: said.via, login: said.login };
    this.phonesChanged();
  }

  // The grant a page got for the PIN, sent with a guarded request.
  private grant(request: IncomingMessage): string | undefined {
    const grant = request.headers["x-agentv-grant"];
    return typeof grant === "string" ? grant : undefined;
  }

  // A guarded request without a good grant gets this, and false. The grant
  // has to be the asker's own: a phone's request needs the grant that phone
  // got for the PIN, and the TV's pages need one the TV got.
  private guarded(request: IncomingMessage, response: ServerResponse, what: string): boolean {
    if (this.pin.allows(this.grant(request), this.signedBy.get(request))) return true;
    this.log(`refused ${what}: it needs the pin`);
    this.json(response, 403, { ok: false, error: NEEDS_PIN, pin: true });
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
    // A locked TV takes no words, so a listening bar goes (ADR-054).
    if (status.locked) this.listening.close();
  }

  // On a child's profile, Settings and home's layout are an adult's, past the
  // PIN (ADR-009, ADR-015).
  // --- Spoken answers (stage 8) ------------------------------------------------

  // An answer, said aloud over HDMI: made into a clip here, and played by
  // the TV session, which fetches it. The log says which voice and how long,
  // never the words.
  private async speak(text: string): Promise<void> {
    const clip = await this.voice.make(text);
    if (!clip) return;
    const n = ++this.clipCount;
    this.clips.set(n, clip);
    for (const old of this.clips.keys()) if (old <= n - 3) this.clips.delete(old);
    this.lastSpoken = { clip: n, by: clip.by, ms: clip.ms, at: new Date().toISOString() };
    const played = await this.sayAsks.ask({ kind: "speak", clip: n }, 60_000);
    if (this.lastSpoken.clip === n) Object.assign(this.lastSpoken, { played: played.ok, ...(played.error ? { error: played.error } : {}) });
    this.log(`the tv said its answer with ${clip.by === "provider" ? `${clip.provider}'s voice` : "its own voice"}, made in ${clip.ms} ms${played.ok ? "" : `, but it didn't play: ${played.error ?? "no answer"}`}`);
  }

  // --- What's new (stage 8) ---------------------------------------------------

  // TMDB's region is the box's country (ADR-055): the one setup confirmed,
  // or Settings picked, or else its time zone's.
  private async region(): Promise<string | null> {
    return (await this.country.read()).code;
  }

  // What Settings → new this week shows: whether there's a key, the region and
  // the household's services, as TMDB matches the apps on the box.
  private async whatsNewState(): Promise<{ error?: string } & Record<string, unknown>> {
    const { error, ...key } = this.tmdbKey.status();
    const region = await this.region();
    const found = key.set && region ? await this.news.services(region) : null;
    return {
      key: { ...key, ...(error ? { error } : {}) },
      region,
      ...(found ? { services: found.services, ...(found.ok ? {} : { error: found.error }) } : {}),
    };
  }

  // New this week's tile (S8.1): this week's titles on the apps who's
  // watching can open, each with its poster, its app and its new season, or
  // what it needs first.
  private async newTile(viewer: Viewer, size: Size): Promise<TileAnswer> {
    const tile = await this.newTileContent(viewer, size);
    // TMDB not answering, with nothing kept from this week, is a wait:
    // home shows that it's loading and asks again.
    return { tile: tile.content, waiting: tile.failed };
  }

  private async newTileContent(viewer: Viewer, size: Size): Promise<{ content: unknown; failed: boolean }> {
    const apps = await this.home.apps(viewer);
    const feed = await this.news.forViewer(viewer.role, apps.map((app) => app.id));
    const name = (id: string) => apps.find((app) => app.id === id)?.name ?? id;
    // The location by its name, as on the right of the tile's head.
    const region = feed.region ? ((await this.news.regions()).regions.find((r) => r.code === feed.region)?.name ?? feed.region) : "";
    if (!feed.ok) {
      const adult = viewer.role === "adult";
      const why: Record<string, string> = {
        "no-key": adult ? "Set up New this week in Settings" : "Ask an adult to set up New this week",
        "no-region": adult ? "Pick your location in Settings" : "Ask an adult to pick your location",
        "no-services": region ? `Can't see what's new on your apps in ${region}` : "Can't see what's new on your apps here",
      };
      return { content: { headline: { label: "", caption: why[feed.why ?? ""] ?? "Couldn't check just now" }, refreshMins: 30 }, failed: feed.why === "failed" };
    }
    if (!feed.titles.length) return { content: { headline: { label: region, caption: "Nothing new on your apps this week" }, refreshMins: 180 }, failed: false };
    if (size === "s") return { content: { headline: { label: "", value: String(feed.titles.length) }, refreshMins: 180 }, failed: false };
    const content = {
      headline: { label: region },
      entries: feed.titles.slice(0, 8).map((title) => ({
        label: title.title,
        caption: `${name(title.app)}${title.season ? ` · season ${title.season}` : ""}`,
        ...(title.poster ? { image: title.poster } : {}),
        item: newItem(title),
      })),
      refreshMins: 180,
    };
    return { content, failed: false };
  }

  private async adult(request: IncomingMessage, response: ServerResponse, what: string): Promise<boolean> {
    if ((await this.profiles.active()).role !== "child") return true;
    return this.guarded(request, response, `${what} on a child's profile`);
  }

  // Every theme Omarchy has, as the screen daemon handed them over, or the
  // ones Omarchy ships until it has (ADR-048).
  private async looks(): Promise<ThemePreview[]> {
    const handed = await readFile(join(this.options.state, "themes.json"), "utf8").then((text) => cleanFound({ themes: JSON.parse(text) }), () => null);
    return handed?.length ? handed : previews(this.options.omarchy ?? process.env.OMARCHY_PATH ?? "/usr/share/omarchy");
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
      if (size > limit) throw new Error(`That's too big. ${Math.round(limit / 1024 / 1024)} MB at most.`);
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

  // A shared photo or video, in parts when the player asks for them, as a
  // video's seeking does.
  private async sendShared(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const file = await this.shared.file(id);
    if (!file) {
      this.json(response, 404, { ok: false, error: "That's no longer on your TV" });
      return;
    }
    const headers = { "Content-Type": file.type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, file.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
      if (start >= file.size || start > end) {
        response.writeHead(416, { "Content-Range": `bytes */${file.size}` });
        response.end();
        return;
      }
      response.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${file.size}`, "Content-Length": end - start + 1 });
      createReadStream(file.path, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, "Content-Length": file.size });
    createReadStream(file.path).pipe(response);
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

  // A file from the TV's pages. HEAD says whether it's there, as setup's page
  // asks of its soundtrack, and a range sends part of one, as an audio
  // element asks for to seek or loop.
  private async file(response: ServerResponse, relative: string, request?: IncomingMessage): Promise<void> {
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
    const headers: Record<string, string | number> = { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    let status = 200;
    if (Buffer.isBuffer(body)) {
      headers["Accept-Ranges"] = "bytes";
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(request?.headers.range ?? ""));
      if (range && (range[1] || range[2])) {
        const size = body.length;
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          response.writeHead(416, { "Content-Range": `bytes */${size}` });
          response.end();
          return;
        }
        body = body.subarray(start, end + 1);
        status = 206;
        headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      }
    }
    headers["Content-Length"] = Buffer.byteLength(body);
    response.writeHead(status, headers);
    response.end(request?.method === "HEAD" ? undefined : body);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // A page app's own origin gets its files and the kit, and nothing else
    // of the daemon's (ADR-043).
    const port = this.port;
    const page = pageAppId(request.headers.host, port);
    if (page) {
      await this.pageApps.serve(page, request, response, port);
      return;
    }
    const allowed = this.allowed(request);
    if (!allowed.ok) {
      this.log(`refused ${request.method} ${request.url}: ${allowed.why}`);
      this.json(response, 403, { ok: false, error: "not allowed" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = request.method;

    // Routes in files of their own (daemon/routes/), one line each.
    if (await featureRoutes(this.featureKit(), request, response, path)) return;
    if (await lookRoute({ root: this.options.root, state: this.options.state, broadcast: (event, data) => this.broadcast(event, data), adult: (q, s, what) => this.adult(q, s, what) }, request, response)) return;
    if (await desktopPasswordRoute({ setup2: () => this.features.on("setup2"), password: this.desktopPassword, json: (q, status, data) => this.json(q, status, data), body: (q) => this.body(q), log: (text) => this.log(text), grant: (q) => this.grant(q), adult: async (q, s, what) => this.guarded(q, s, what) && (await this.adult(q, s, what)) }, request, response, path)) return;
    if (await this.setupRoutes.handle("tv", request, response, url)) return;
    if (path.startsWith("/api/ask") && (await askRoutes(this.askKit(), request, response, path))) return;
    if (await boxRoute(this.boxKit(), method, path, request, response)) return;
    if (await networkRoute({ network: this.network, json: (q, status, data) => this.json(q, status, data), body: (q) => this.body(q), log: this.log, child: async () => (await this.profiles.active()).role === "child", guarded: (q, s, what) => this.guarded(q, s, what) }, method, path, request, response)) return;
    if (await this.displayRoutes.handle(method ?? "", path, request, response)) return;
    if (await this.controllerRoutes.handle(method, path, request, response)) return;
    if (await backgroundVideoRoutes({ backgrounds: this.backgrounds, body: (q) => this.body(q), json: (q, status, data) => this.json(q, status, data) }, request, response, path)) return;

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
        // The time zone the daemon's clock goes by, which follows the box's
        // when the country moves it.
        zone: clockZone(),
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

    if (await discoverRoute(this.discover, method, path, url, response, false, request)) return;
    if (await serverPickRoute({ picks: this.serverPicks, allowed: async (asked, answer) => this.guarded(asked, answer, "setting up an app") && (await this.adult(asked, answer, "setting up an app")) }, method, path, request, response)) return;

    if (method === "GET" && path === "/api/state") {
      const [info, setup] = await Promise.all([this.settings(), this.setup()]);
      this.json(response, 200, { ok: true, version: info.AGENTV_VERSION, channel: info.AGENTV_CHANNEL, setup });
      return;
    }

    if (method === "POST" && path === "/api/setup") {
      const body = (await this.body(request)) as { done?: unknown; pin?: unknown } | undefined;
      if (typeof body?.done !== "boolean") {
        this.json(response, 400, { ok: false, error: 'send {"done": true} or {"done": false} as JSON' });
        return;
      }
      const was = (await this.setup()).done;
      // agentv setup reset sends the PIN with its ask. It allows this and
      // nothing more: no grant comes of it, a locked TV stays locked and the
      // pad's own wrong tries stand, as on the hotspot's page.
      const byPin = was && !body.done && body.pin !== undefined && this.pin.status().set ? this.pin.right(body.pin, "setup-reset") : null;
      if (byPin && !byPin.ok) {
        this.log("a wrong pin for starting setup again");
        this.json(response, 403, { ok: false, error: byPin.error, pin: true, wrong: true });
        return;
      }
      // Starting setup again is an adult's, past the PIN when one is set,
      // because a TV in setup asks for less: its pages pair a phone and
      // change the Wi-Fi with no PIN. Without this, "not done" would be a
      // way round the PIN for anything on the TV that can ask.
      if (was && !body.done && !byPin && (!this.guarded(request, response, "starting setup again") || !(await this.adult(request, response, "starting setup again")))) return;
      const setup = await this.setupState.mark(body.done);
      this.log(body.done ? "setup marked done" : "setup reset");
      // The setup hotspot closes as setup ends. Root is asked even when it's
      // closed already, as after a join, because root also takes away the
      // network the installer handed over, which is for setup only.
      if (body.done && (!was || this.hotspot.status().on)) this.hotspot.stop();
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
        // The steps shown, in order, and what the status bar says for each.
        ...(await this.setupState.progress()),
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
        this.json(response, 409, { ok: false, error: "Setup is done" });
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
    // own", and the starter pack with its switch on. Picking goes past the
    // PIN once there is one.
    if (method === "GET" && path === "/api/setup/apps") {
      const setup = await this.setup();
      const list = await this.setupApps.list(setup.goal, await this.home.apps(), await this.features.on("starter"));
      this.json(response, 200, { ok: true, goal: setup.goal, wishes: setup.wishes, ...list });
      return;
    }

    // The setup soundtrack muted with the TV's M, or playing again.
    if (method === "POST" && path === "/api/setup/music") {
      if ((await this.setup()).done) {
        this.json(response, 409, { ok: false, error: "Setup is done" });
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
        this.json(response, 409, { ok: false, error: "Setup is done" });
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
    // goes to root as the captive page's does. They're setup's alone. Once
    // setup is done the hotspot is open because the TV lost its network,
    // and the TV changes its Wi-Fi in Settings, where a child's profile
    // can't and a join needs the PIN (/api/network).
    if ((path === "/api/setup/networks" || path === "/api/setup/wifi") && (await this.setup()).done) {
      this.log(`refused ${method} ${path}: setup is done`);
      this.json(response, 403, { ok: false, error: "Setup is done. Change Wi-Fi in Settings." });
      return;
    }

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
        // Terminal at more on screen asks for its 5 × 4 grid's layout.
        this.home.layout(viewer.id, viewer.role, gridNamed(url.searchParams.get("grid"))),
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
      const body = (await this.body(request)) as { layout?: unknown; grid?: unknown } | undefined;
      const viewer = await this.profiles.active();
      const grid = gridNamed(body?.grid);
      const why = await this.home.saveLayout(viewer.id, body?.layout, viewer.role, grid);
      if (why) {
        this.json(response, 400, { ok: false, error: why });
        return;
      }
      const layout = await this.home.layout(viewer.id, viewer.role, grid);
      this.broadcast("layout", { viewer: viewer.id, layout, grid: `${grid.columns}x${grid.rows}` });
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

    // The night's update waited for a game, or it has installed since
    // (ADR-084): the screen daemon says so, and Settings shows it.
    if (method === "POST" && path === "/api/updates/held") {
      const body = (await this.body(request)) as { held?: unknown } | undefined;
      if (typeof body?.held !== "boolean") {
        this.json(response, 400, { ok: false, error: 'send {"held": true} or {"held": false} as JSON' });
        return;
      }
      await this.updates.setHeld(body.held);
      this.broadcast("updates", await this.updates.read());
      this.json(response, 200, { ok: true });
      return;
    }

    // Apps → add an app (ADR-042): the official apps that aren't on the TV,
    // and one picked, handed to root as setup's are, past the PIN once there
    // is one. A child's profile doesn't add apps.
    if (path === "/api/apps/add" && (method === "GET" || method === "POST")) {
      if ((await this.profiles.active()).role === "child") {
        this.json(response, 403, { ok: false, error: "Only adults can add apps" });
        return;
      }
      if (method === "POST") {
        if (!this.guarded(request, response, "adding an app")) return;
        const id = ((await this.body(request)) as { id?: unknown } | undefined)?.id;
        const why = await this.setupApps.add(id, await this.home.apps());
        if (why) {
          this.json(response, 400, { ok: false, error: why });
          return;
        }
        this.log(`apps: adding ${String(id)}`);
      }
      this.json(response, 200, { ok: true, ...(await this.setupApps.available(await this.home.apps())) });
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
      // And sleep, which leaves the box where the phone can't wake it.
      const sleep = (change as { sleepWhenOff?: unknown } | undefined)?.sleepWhenOff;
      if (typeof sleep === "boolean" && sleep !== (await this.home.settings()).sleepWhenOff && !this.guarded(request, response, "sleep")) return;
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
        this.json(response, 403, { ok: false, error: NEEDS_PIN, pin: true });
        return;
      }
      this.json(response, 200, { ok: true });
      return;
    }

    // Settings → Adult PIN: a PIN, or another one, which needs a grant from
    // the one before.
    if ((method === "PUT" || method === "DELETE") && path === "/api/pin") {
      const body = (await this.body(request)) as { pin?: unknown } | undefined;
      const first = method === "PUT" && !this.pin.status().set;
      const why = method === "PUT" ? this.pin.set(body?.pin, this.grant(request)) : this.pin.remove(this.grant(request), await this.profiles.needPin());
      if (why) {
        this.json(response, needsPin(why) ? 403 : 400, { ok: false, error: why });
        return;
      }
      // A first PIN starts with no profile locked (ADR-087).
      if (first) await this.profiles.unlockAll();
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
    // An adult's, behind the PIN when one is set, as changing profiles is:
    // a paired phone is a remote for good. Setup's screens show a code by
    // themselves and keep it fresh, so until setup is done it comes without.
    if (method === "POST" && path === "/api/phones/pair") {
      if ((await this.setup()).done && (!this.guarded(request, response, "pairing a phone") || !(await this.adult(request, response, "pairing a phone")))) return;
      this.phones.code();
      this.json(response, 200, { ok: true, pairing: this.pairing() });
      return;
    }

    // The pairing QR code, drawn by qrencode.
    if (method === "GET" && path === "/api/phones/qr") {
      const pairing = this.pairing();
      const address = this.pairingQr();
      const svg = address ? await this.qr(address) : null;
      if (!svg) {
        this.json(response, 404, { ok: false, error: pairing ? "there's no qr code without qrencode or an address" : "there's no code on show" });
        return;
      }
      this.send(response, TYPES[".svg"], svg, { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
      return;
    }

    const phone = /^\/api\/phones\/(p-[0-9a-f]{8})$/.exec(path);
    if (method === "DELETE" && phone) {
      if (!this.guarded(request, response, "forgetting a phone") || !(await this.adult(request, response, "forgetting a phone"))) return;
      if (!this.phones.forget(phone[1])) {
        this.json(response, 404, { ok: false, error: "Couldn't find that phone" });
        return;
      }
      this.phoneChannel.forget(phone[1]);
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
    if (await this.phoneRemote.local(method ?? "", path, request, response)) return;
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
      const { error } = this.key.status();
      this.json(response, 200, { ok: true, ...(await this.keyState()), ...(error ? { error } : {}) });
      return;
    }

    // Settings → AI: a key for a provider, kept where only root can read it,
    // or taken off. An adult's, past the PIN.
    if ((method === "PUT" || method === "DELETE") && path === "/api/key") {
      if (!this.guarded(request, response, "the provider key") || !(await this.adult(request, response, "the provider key"))) return;
      const body = (method === "PUT" ? await this.body(request) : {}) as { provider?: unknown; key?: unknown } | undefined;
      const provider = method === "DELETE" ? null : (body?.provider ?? "");
      // A key for a provider whose terms nobody here has accepted waits for
      // them (Q104, ADR-023): the phones show them, and an adult accepts.
      if (typeof provider === "string" && Object.hasOwn(OFFERS, provider) && !this.key.check(provider, body?.key) && !(await this.ai.acceptance(provider as Provider, "key"))) {
        const offer = OFFERS[provider as Provider];
        if (this.keyTerms !== provider) {
          this.keyTerms = provider as Provider;
          this.phonesChanged();
        }
        this.json(response, 409, { ok: false, error: `Accept ${offer.name}'s terms first`, terms: { provider, name: offer.name, maker: offer.maker, terms: offer.terms.key, summary: offer.summary.key } });
        return;
      }
      const why = await this.key.store(provider, body?.key);
      if (why) {
        this.log(`the provider key wasn't kept: ${why}`);
        this.json(response, notSaved(why) ? 500 : 400, { ok: false, error: why });
        return;
      }
      const { set } = this.key.status();
      this.log(set ? `a key for ${provider} is kept, root's alone` : "the provider key is off");
      // A key kept from Settings → AI is what builds use from now on, its
      // terms accepted first (Q104, Q143), in place of a plan picked before.
      if (set && typeof provider === "string" && Object.hasOwn(OFFERS, provider)) {
        const chosen = await this.ai.choose(provider, "key");
        if (chosen.state) this.broadcast("ai", chosen.state);
        void this.fetchAiCli("a key was kept");
      }
      this.broadcast("key", { set, provider: this.key.status().provider });
      this.json(response, 200, { ok: true, ...(await this.keyState()) });
      return;
    }

    // Settings → AI stopped waiting for a key's terms: the phones stop asking.
    if (method === "DELETE" && path === "/api/key/terms") {
      if (this.keyTerms) {
        this.keyTerms = null;
        this.phonesChanged();
      }
      this.json(response, 200, { ok: true });
      return;
    }

    // --- The AI provider and its terms (ADR-022, ADR-023) --------------------

    // Settings → AI: the household's plan for builds, in place of a key
    // (Q143). An adult's, past the PIN. A plan whose terms nobody here has
    // accepted waits for them, as a key does: the phones show them, an adult
    // accepts, and the TV asks again. Only a plan that's on offer
    // (ADR-053).
    if (method === "PUT" && path === "/api/ai/plan") {
      if (!this.guarded(request, response, "the ai plan") || !(await this.adult(request, response, "the ai plan"))) return;
      const body = (await this.body(request)) as { provider?: unknown } | undefined;
      const provider = body?.provider;
      if (typeof provider !== "string" || !Object.hasOwn(OFFERS, provider)) {
        this.json(response, 400, { ok: false, error: PROVIDER_LIST });
        return;
      }
      const offer = (await this.ai.offers())[provider as Provider];
      if (!offer.plan.offered) {
        this.json(response, 400, { ok: false, error: planRefused(offer) });
        return;
      }
      if (!(await this.ai.acceptance(provider as Provider, "plan"))) {
        if (this.planTerms !== provider) {
          this.planTerms = provider as Provider;
          this.phonesChanged();
        }
        this.json(response, 409, { ok: false, error: `Accept ${offer.name}'s terms first`, terms: { provider, name: offer.name, maker: offer.maker, terms: offer.terms.plan, summary: offer.summary.plan } });
        return;
      }
      const chosen = await this.ai.choose(provider, "plan");
      if (!chosen.state) {
        this.json(response, 400, { ok: false, error: chosen.error });
        return;
      }
      this.log(`builds use the ${provider} plan now, from settings`);
      this.broadcast("ai", chosen.state);
      void this.fetchAiCli("a plan was picked");
      this.json(response, 200, { ok: true, ...chosen.state });
      return;
    }

    // Settings → AI stopped waiting for a plan's terms: the phones stop asking.
    if (method === "DELETE" && path === "/api/ai/plan/terms") {
      if (this.planTerms) {
        this.planTerms = null;
        this.phonesChanged();
      }
      this.json(response, 200, { ok: true });
      return;
    }

    // Which provider, by plan or key, whether its terms are accepted, how the
    // first run of its CLI went, and what each provider offers.
    if (method === "GET" && path === "/api/ai") {
      const { set, provider } = this.key.status();
      this.json(response, 200, { ok: true, ...(await this.ai.read()), offers: await this.ai.offers(), channel: await this.channel(), read: TERMS_READ, key: { set, provider } });
      return;
    }

    // The provider and path picked on the TV, or none, to pick again. Past
    // the PIN, once there is one, and a child's profile can't.
    if (method === "POST" && path === "/api/ai") {
      if (!this.guarded(request, response, "the ai provider") || !(await this.adult(request, response, "the ai provider"))) return;
      const body = (await this.body(request)) as { provider?: unknown; path?: unknown } | undefined;
      const result = await this.ai.choose(body?.provider ?? null, body?.path);
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.broadcast("ai", result.state);
      void this.fetchAiCli("an AI was picked");
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
        this.json(response, 404, { ok: false, error: NO_PROFILE });
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
        this.json(response, 400, { ok: false, error: "Set an adult PIN first. A child's profile needs one." });
        return;
      }
      if (method !== "DELETE" && body.locked === true && !this.pin.status().set) {
        this.json(response, 400, { ok: false, error: "Set an adult PIN first. A locked profile needs one." });
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
        if (!error) await this.shared.forget(one![1]);
      }
      // Whether a child's profile takes shares from phones (ADR-050). An
      // adult's always does.
      if (profile && !error && (typeof body.shares === "boolean" || profile.role === "adult")) {
        await this.shared.allow(profile.id, profile.role === "child" && body.shares === true);
      }
      if (error) {
        this.json(response, error === NO_PROFILE ? 404 : 400, { ok: false, error });
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
        this.json(response, 404, { ok: false, error: NO_APP });
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
        this.json(response, 404, { ok: false, error: NO_APP });
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
        this.json(response, /^(that isn't|couldn't find)/i.test(why) ? 404 : 400, { ok: false, error: why });
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
    // Export from an app's details (ADR-045): the phone of an adult who's
    // watching saves it, so the TV offers it there for ten minutes.
    const offer = /^\/api\/apps\/(local\.[a-z0-9-]+)\/export$/.exec(path);
    if (method === "POST" && offer) {
      if (!(await this.adult(request, response, "exporting an app"))) return;
      const found = (await this.home.manifests()).find(({ manifest }) => manifest.id === offer[1]);
      const refusal = found ? exportRefusal(found.manifest, found.tier) : NO_APP;
      if (!found || refusal) {
        this.json(response, 400, { ok: false, error: refusal });
        return;
      }
      this.exportOffer = { id: found.manifest.id, name: found.manifest.name, version: found.manifest.version, until: Date.now() + 10 * 60_000, github: null };
      this.phonesChanged();
      void this.offerPush(this.exportOffer);
      this.json(response, 200, { ok: true });
      return;
    }

    const signedIn = /^\/api\/apps\/([a-z0-9.-]+)\/signed-in$/.exec(path);
    if (method === "POST" && signedIn) {
      const body = (await this.body(request)) as { signedIn?: unknown } | undefined;
      if (typeof body?.signedIn !== "boolean") {
        this.json(response, 400, { ok: false, error: "signedIn is true or false" });
        return;
      }
      if (!(await this.home.signedIn(signedIn[1], body.signedIn))) {
        this.json(response, 404, { ok: false, error: NO_APP });
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
        this.json(response, 404, { ok: false, error: NO_APP });
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
      const answer = await this.home.tileAnswer(tile[1], tile[2] as Size, await this.home.viewer(), url.searchParams.has("fresh"));
      this.json(response, 200, { ok: true, tile: answer.tile, ...(answer.waiting ? { waiting: true } : {}) });
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

    if (await this.builderApi(method, path, request, response)) return;

    // Stage B (ADR-011): a page of the service the running build is
    // learning, as the signed-in browser shows it, from the builder's way
    // out. Only while the build is in stage B, on the origins an adult
    // approved with its app.
    if (method === "POST" && path === "/api/builder/page") {
      const running = this.builds.stageB();
      if (!running) {
        this.json(response, 409, { ok: false, error: "no build is learning a service now" });
        return;
      }
      const body = (await this.body(request)) as { url?: unknown } | undefined;
      let url: URL;
      try {
        url = new URL(String(body?.url));
      } catch {
        this.json(response, 400, { ok: false, error: "an address like https://service.example/" });
        return;
      }
      if (url.protocol !== "https:" || !running.origins.includes(url.origin)) {
        this.json(response, 403, { ok: false, error: `${url.origin} isn't one of the origins approved with ${running.id}` });
        return;
      }
      // Only the pages the recipe names: where a title is found and played,
      // never the account's own pages.
      const notOne = "that isn't a page a build looks at while signed in: only the service's start page and the pages a title is found and played on";
      if (!running.looksAt(url)) {
        this.json(response, 403, { ok: false, error: notOne });
        return;
      }
      const seen = await this.pageAsks.ask(url.href, running.origins);
      // And not one the service sent the browser on to instead.
      let ended: URL | null = null;
      try {
        ended = new URL(String(seen.url));
      } catch {}
      this.json(response, 200, seen.ok && !(ended && running.looksAt(ended)) ? { ok: false, error: `the service went on to another page. ${notOne}` } : seen);
      return;
    }
    // The screen daemon takes each ask, and answers it.
    if (method === "GET" && path === "/api/builder/page-ask") {
      this.json(response, 200, { ok: true, ask: await this.pageAsks.take() });
      return;
    }
    const pageAnswer = /^\/api\/builder\/page-ask\/(\d+)$/.exec(path);
    if (method === "POST" && pageAnswer) {
      // A page's copy is bigger than any other body the daemon takes.
      let said: unknown;
      try {
        said = JSON.parse((await this.raw(request, ANSWER_MAX)).toString("utf8"));
      } catch (error) {
        said = { ok: false, error: `the TV's answer couldn't be read: ${(error as Error).message}` };
      }
      const known = this.pageAsks.answer(Number(pageAnswer[1]), said);
      this.json(response, known ? 200 : 404, known ? { ok: true } : { ok: false, error: "that ask isn't waiting" });
      return;
    }
    // A sentence said to the TV (ADR-023), here from the box itself, such
    // as agentv selftest; and the TV's own pick and Back.
    if (method === "GET" && path === "/api/say") {
      this.json(response, 200, { ok: true, said: this.say.current });
      return;
    }
    if (method === "POST" && path === "/api/say") {
      await this.sayIt(request, response, "the tv");
      return;
    }
    if (method === "POST" && path === "/api/say/pick") {
      await this.sayPick(request, response);
      return;
    }
    // Back on the TV, with the listening bar up.
    if (method === "POST" && path === "/api/say/live/close") {
      this.listening.close();
      this.json(response, 200, { ok: true });
      return;
    }
    if (method === "POST" && path === "/api/say/dismiss") {
      this.json(response, 200, { ok: this.say.dismiss(((await this.body(request)) as { n?: unknown } | undefined)?.n) });
      return;
    }
    // The router alone, with apps it's told of and nothing done, as the box
    // routes: agentv selftest S7.4 runs the eval set through it.
    if (method === "POST" && path === "/api/router/route") {
      const body = (await this.body(request)) as { sentence?: unknown; apps?: unknown } | undefined;
      const apps = Array.isArray(body?.apps) ? (body.apps as RouterApp[]).slice(0, 100) : [];
      if (typeof body?.sentence !== "string") {
        this.json(response, 400, { ok: false, error: "which sentence" });
        return;
      }
      const route = this.options.router ?? ((sentence: string, list: RouterApp[]) => this.boxRoute(sentence, list));
      this.json(response, 200, { ok: true, routed: await route(body.sentence.slice(0, 300), apps) });
      return;
    }
    // What's new on the household's services, for who's watching (S8.1):
    // only titles on the apps they can open.
    if (method === "GET" && path === "/api/whats-new") {
      const viewer = await this.profiles.active();
      const apps = (await this.home.apps(viewer)).map((app) => app.id);
      const fresh = new URL(request.url ?? "/", "http://box").searchParams.get("fresh") === "1";
      if (fresh) await this.news.feed(viewer.role, true);
      this.json(response, 200, { ok: true, feed: await this.news.forViewer(viewer.role, apps) });
      return;
    }
    // Whether there's a new episode of a show, for who's watching, as the
    // router's new_episode does, with nothing routed (S8.2's selftest).
    if (method === "POST" && path === "/api/whats-new/episode") {
      const body = (await this.body(request)) as { query?: unknown } | undefined;
      const viewer = await this.profiles.active();
      const apps = (await this.home.apps(viewer)).map((app) => app.id);
      const query = typeof body?.query === "string" ? body.query.slice(0, 120) : null;
      this.json(response, 200, { ok: true, answer: await this.news.episode(query, this.ledger.recent(viewer.id, { limit: 200 }), viewer.role, apps) });
      return;
    }
    // A title on New this week, chosen on home: looked up in its app and
    // played, as a sentence would, and the TV and the phones hear how it went.
    if (method === "POST" && path === "/api/whats-new/open") {
      const body = (await this.body(request)) as { id?: unknown } | undefined;
      const viewer = await this.profiles.active();
      const apps = (await this.home.apps(viewer)).map((app) => app.id);
      const title = (await this.news.forViewer(viewer.role, apps)).titles.find((t) => `tmdb:${t.kind}:${t.id}` === body?.id);
      if (!title) {
        this.json(response, 404, { ok: false, error: "That isn't new this week any more" });
        return;
      }
      const route: Route = { ...NONE, intent: "play", query: title.title, kind: title.kind, app: title.app, season: title.season ?? null };
      this.json(response, 200, { ok: true, said: await this.say.act(route, "the tv", title.title) });
      return;
    }
    // The TV's spoken answers (stage 8): which voice says them, whether
    // the TV has one of its own, and how the last one went.
    if (method === "GET" && path === "/api/voice") {
      this.json(response, 200, { ok: true, ...(await this.voice.state()), last: this.lastSpoken });
      return;
    }
    // A clip, for the TV session to play: here only, on the TV's own port.
    const voiceClip = /^\/api\/voice\/(\d+)$/.exec(path);
    if (method === "GET" && voiceClip) {
      const clip = this.clips.get(Number(voiceClip[1]));
      if (!clip) {
        this.json(response, 404, { ok: false, error: "that clip has gone" });
        return;
      }
      response.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": clip.wav.length, "Cache-Control": "no-store" });
      response.end(clip.wav);
      return;
    }
    if (method === "GET" && path === "/api/whats-new/settings") {
      this.json(response, 200, { ok: true, ...(await this.whatsNewState()) });
      return;
    }
    // The box's country (ADR-055): what it is, and the countries to pick
    // from, for setup's country step and Settings → country.
    if (method === "GET" && path === "/api/country") {
      this.json(response, 200, { ok: true, ...(await this.country.read()), countries: await countries() });
      return;
    }
    // Another country, or the same one confirmed: an adult's, past the PIN
    // once there is one. TMDB's region follows, and the time zone moves
    // when the box's isn't in that country.
    if (method === "PUT" && path === "/api/country") {
      if (!this.guarded(request, response, "the country") || !(await this.adult(request, response, "the country"))) return;
      const body = (await this.body(request)) as { code?: unknown } | undefined;
      const set = await this.country.set(body?.code);
      if (set.error) {
        this.json(response, 400, { ok: false, error: set.error });
        return;
      }
      this.broadcast("country", set.state);
      this.broadcast("whats-new", {});
      this.json(response, 200, { ok: true, ...set.state });
      return;
    }
    // The TMDB key, kept where only root can read it, or taken off. An
    // adult's, past the PIN, as the provider key is.
    if ((method === "PUT" || method === "DELETE") && path === "/api/tmdb-key") {
      if (!this.guarded(request, response, "the tmdb key") || !(await this.adult(request, response, "the tmdb key"))) return;
      const body = (method === "PUT" ? await this.body(request) : {}) as { key?: unknown } | undefined;
      const why = await this.tmdbKey.store(method === "DELETE" ? null : (body?.key ?? ""));
      if (why) {
        this.log(`the tmdb key wasn't kept: ${why}`);
        this.json(response, notSaved(why) ? 500 : 400, { ok: false, error: why });
        return;
      }
      const kept = this.tmdbKey.status().set;
      this.log(kept ? "a tmdb key is kept, root's alone" : "the tmdb key is off");
      // Root starts the router's service again with the key: Settings shows
      // the services once it has it. The old one can answer that it's ready
      // just before it stops, as it can with a key it had before, so a
      // router gone by the time the services are asked for is waited for
      // once more.
      let state: { error?: string } = {};
      if (kept) {
        await this.news.ready();
        state = await this.whatsNewState();
        if (state.error === ROUTER_GONE && (await this.news.ready())) state = await this.whatsNewState();
      } else state = await this.whatsNewState();
      this.broadcast("whats-new", {});
      this.json(response, 200, { ok: true, ...state });
      return;
    }
    // A sentence's asks of the TV session: the screen daemon looks things up
    // in the apps and opens them, as the person.
    if (method === "GET" && path === "/api/say/ask") {
      this.json(response, 200, { ok: true, ask: await this.sayAsks.take() });
      return;
    }
    const sayAnswer = /^\/api\/say\/ask\/(\d+)$/.exec(path);
    if (method === "POST" && sayAnswer) {
      const known = this.sayAsks.answer(Number(sayAnswer[1]), await this.body(request));
      this.json(response, known ? 200 : 404, known ? { ok: true } : { ok: false, error: "that ask isn't waiting" });
      return;
    }
    // Export's asks of the person's GitHub sign-in: the screen daemon, which
    // runs as them, takes each and answers it (ADR-045).
    if (method === "GET" && path === "/api/export/ask") {
      this.json(response, 200, { ok: true, ask: await this.exportAsks.take() });
      return;
    }
    const exportAnswer = /^\/api\/export\/ask\/(\d+)$/.exec(path);
    if (method === "POST" && exportAnswer) {
      const known = this.exportAsks.answer(Number(exportAnswer[1]), await this.body(request));
      this.json(response, known ? 200 : 404, known ? { ok: true } : { ok: false, error: "that ask isn't waiting" });
      return;
    }
    // A made theme's asks: the screen daemon, as the person, hands it to
    // Omarchy and sets it, or takes it away (S6.4).
    if (method === "GET" && path === "/api/themes/ask") {
      this.json(response, 200, { ok: true, ask: await this.themeAsks.take() });
      return;
    }
    const themeAnswer = /^\/api\/themes\/ask\/(\d+)$/.exec(path);
    if (method === "POST" && themeAnswer) {
      const known = this.themeAsks.answer(Number(themeAnswer[1]), await this.body(request));
      this.json(response, known ? 200 : 404, known ? { ok: true } : { ok: false, error: "that ask isn't waiting" });
      return;
    }

    // A page app's kit call from home, for the app whose frame it came
    // from: checked against its manifest, then done (ADR-043).
    if (method === "POST" && path === "/api/kit") {
      const body = ((await this.body(request)) ?? {}) as { app?: unknown; call?: unknown; args?: unknown };
      const result = await this.pageApps.call(body.app, body.call, Array.isArray(body.args) ? body.args : []);
      if (result.error) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.json(response, 200, { ok: true, value: result.value ?? null });
      return;
    }

    // The TV session asks before it reads a page app's photos or music.
    const kit = /^\/api\/apps\/([a-z0-9.-]+)\/kit$/.exec(path);
    if (method === "GET" && kit) {
      const why = await this.pageApps.allows(kit[1], url.searchParams.get("call"));
      this.json(response, why ? 403 : 200, why ? { ok: false, error: why } : { ok: true });
      return;
    }

    const launch = /^\/api\/apps\/([a-z0-9.-]+)\/launch$/.exec(path);
    if (method === "GET" && launch) {
      const target = await this.home.launch(launch[1], await this.profiles.active());
      if (!target) {
        this.json(response, 404, { ok: false, error: "Can't open that app yet" });
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
    // Shared to the TV (ADR-050, S5.10): what's here for who's watching, the
    // one to ask about now, if home's in front with nothing playing, and
    // which children's profiles take shares.
    if (method === "GET" && path === "/api/shared") {
      const waiting = this.idleHome() ? await this.shareWaiting() : null;
      this.json(response, 200, { ok: true, shares: await this.sharesFor(await this.profiles.active()), ask: waiting?.id ?? null, allowed: await this.shared.allowed() });
      return;
    }

    // One of them: its file, Open or Not now, a photo as the background, a
    // link's app, or taken off the box. Only one who's watching sees.
    const shared = /^\/api\/shared\/([0-9a-f]{16})(?:\/(file|answer|background|target))?$/.exec(path);
    if (shared) {
      const share = (await this.sharesFor(await this.profiles.active())).find((one) => one.id === shared[1]);
      if (!share) {
        this.json(response, 404, { ok: false, error: "That's no longer on your TV" });
        return;
      }
      if (method === "GET" && shared[2] === "file") {
        await this.sendShared(request, response, share.id);
        return;
      }
      // Where a link opens, for the screen daemon: the app that declares its
      // site, if who's watching may open one, or else a browser page of its
      // own.
      if (method === "GET" && shared[2] === "target") {
        if (share.kind !== "link" || !share.url) {
          this.json(response, 400, { ok: false, error: "only a link opens in an app" });
          return;
        }
        const app = await this.home.appForUrl(share.url, await this.profiles.active());
        this.json(response, 200, { ok: true, url: share.url, ...(app ? { app } : {}) });
        return;
      }
      if (method === "POST" && shared[2] === "answer") {
        await this.shared.answer(share.id);
        this.broadcast("shared", {});
        this.json(response, 200, { ok: true });
        return;
      }
      if (method === "POST" && shared[2] === "background") {
        if (!(await this.adult(request, response, "a shared photo as the background"))) return;
        const file = await this.shared.file(share.id);
        const result = share.kind === "photo" && file ? await this.backgrounds.add(await readFile(file.path), { text: share.credit ?? null, from: share.from }) : { error: "Only a photo can be the background" };
        if (!result.state) {
          this.json(response, 400, { ok: false, error: result.error });
          return;
        }
        this.log("a shared photo is the background");
        this.broadcast("background", result.state);
        this.json(response, 200, { ok: true, background: result.item });
        return;
      }
      if (method === "DELETE" && !shared[2]) {
        if (!(await this.adult(request, response, "taking a share off"))) return;
        await this.shared.remove(share.id);
        this.broadcast("shared", {});
        this.json(response, 200, { ok: true });
        return;
      }
    }

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

    // From the screen daemon (ADR-048): the theme Omarchy has now, which of
    // its backgrounds Omarchy shows, and the pictures, each only once. The
    // answer says which it should send.
    if (method === "PUT" && path === "/api/backgrounds/theme") {
      const result = await this.backgrounds.offerTheme(await this.body(request));
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.broadcast("background", result.state);
      this.json(response, 200, { ok: true, need: result.need });
      return;
    }

    const own = /^\/api\/backgrounds\/theme\/([0-9a-f]{16})$/.exec(path);
    if (method === "POST" && own) {
      let body: Buffer;
      try {
        body = await this.raw(request, MAX_PHOTO);
      } catch (error) {
        this.json(response, 413, { ok: false, error: (error as Error).message });
        return;
      }
      const result = await this.backgrounds.addThemeFile(own[1], body);
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.broadcast("background", result.state);
      this.json(response, 200, { ok: true });
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
        this.json(response, result.error?.startsWith("Couldn't reach") ? 502 : 400, { ok: false, error: result.error });
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

    // A folder's pictures, from the TV session, which can read the folders,
    // USB drives and shares (picture-folder.ts): the first of a folder puts
    // away the pictures of the one before.
    if (method === "POST" && path === "/api/backgrounds/folder") {
      if (!(await this.adult(request, response, "the background"))) return;
      let body: Buffer;
      try {
        body = await this.raw(request, MAX_PHOTO);
      } catch (error) {
        this.json(response, 413, { ok: false, error: (error as Error).message });
        return;
      }
      // Put away the folder before only for a picture that can take its place.
      if (url.searchParams.get("first") === "1" && imageType(body)) await this.backgrounds.clear("folder");
      const result = await this.backgrounds.add(body, { from: url.searchParams.get("from") ?? "a folder" }, "folder");
      if (!result.state) {
        this.json(response, 400, { ok: false, error: result.error });
        return;
      }
      this.broadcast("background", result.state);
      this.json(response, 200, { ok: true, background: result.item, ...result.state });
      return;
    }

    // An Immich album through the link its owner shared it with: its photos
    // take the place of a folder's, credited to the album. The link isn't
    // kept. One album at a time.
    if (method === "POST" && path === "/api/backgrounds/immich") {
      if (!(await this.adult(request, response, "the background"))) return;
      if (this.immichBusy) {
        this.json(response, 409, { ok: false, error: "Still getting the last album's photos" });
        return;
      }
      const body = ((await this.body(request)) ?? {}) as { link?: unknown };
      this.immichBusy = true;
      let first = true;
      try {
        const result = await this.immich.pictures(body.link, async ({ body: picture, album }) => {
          if (!imageType(picture)) return false;
          if (first) await this.backgrounds.clear("folder");
          first = false;
          return Boolean((await this.backgrounds.add(picture, { from: `${album} · immich` }, "folder")).state);
        });
        if (!result.count) {
          this.json(response, 400, { ok: false, error: result.error });
          return;
        }
        this.log(`background: ${result.count} photos from immich`);
        const state = await this.backgrounds.read();
        this.broadcast("background", state);
        this.json(response, 200, { ok: true, album: result.album, count: result.count, ...state });
      } finally {
        this.immichBusy = false;
      }
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

    // The looks setup and Settings offer (ADR-048, board 12): every theme
    // Omarchy has, with the colours their previews draw, and which one the
    // TV has.
    if (method === "GET" && path === "/api/themes") {
      // Omarchy's, the person's own among them, then each your agent made
      // that's handed to Omarchy, in place of the person's copy of it.
      const applied = await this.madeApplied();
      const made = madeThemes(this.themesDir).filter((theme) => applied[theme.app] && !applied[theme.app]!.error);
      const looks = [...(await this.looks()).filter((look) => !made.some((one) => one.id === look.id)), ...made];
      this.json(response, 200, { ok: true, themes: looks, current: currentTheme(await this.home.theme(), looks, await this.home.themeName()) });
      return;
    }

    // From the screen daemon, which can read the person's own themes: every
    // theme Omarchy has, when the TV session starts and whenever one is
    // installed or removed on the desktop.
    if (method === "PUT" && path === "/api/themes") {
      const body = await this.body(request);
      const looks = cleanFound(body);
      if (!looks) {
        this.json(response, 400, { ok: false, error: "a list of omarchy's themes" });
        return;
      }
      // As it came, and checked again each time it's read.
      await mkdir(this.options.state, { recursive: true });
      await writeFile(join(this.options.state, "themes.json.next"), JSON.stringify((body as { themes: unknown[] }).themes));
      await rename(join(this.options.state, "themes.json.next"), join(this.options.state, "themes.json"));
      this.broadcast("themes", {});
      this.json(response, 200, { ok: true, count: looks.length });
      return;
    }

    // From Omarchy's theme-set hook, on this box: the theme's launcher.css,
    // and the theme's name.
    if (method === "POST" && path === "/api/theme") {
      const name = url.searchParams.get("name");
      if (!(await this.home.saveTheme(await this.text(request), name && THEME_NAME.test(name) ? name : null))) {
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
      // A look's preview is home itself, read-only, even while setup runs,
      // since setup's look step shows it (ADR-063).
      const preview = url.searchParams.has("preview");
      await this.file(response, (setup.done || preview) && hasHome ? home : join("setup", "index.html"));
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
    if ((method === "GET" || method === "HEAD") && STATIC.includes(relative.split(sep)[0]) && !relative.split(sep).includes("..")) {
      await this.file(response, relative, request);
      return;
    }

    this.json(response, 404, { ok: false, error: "not found" });
  }
}

// A server's close, which waits for every connection: idle ones are closed
// at once, and busy ones after graceMs.
function stopServer(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const cut = setTimeout(() => server.closeAllConnections(), graceMs);
    server.close(() => {
      clearTimeout(cut);
      resolve();
    });
    server.closeIdleConnections();
  });
}

// One line for the log on the way out. A signal doesn't say who sent it;
// an update from the TV says it's running in its progress, and the rest
// (an update from a terminal, a restart, a shutdown) looks the same here.
async function stopping(daemon: Daemon, signal: string): Promise<void> {
  const progress = (await daemon.updates.read().catch(() => null))?.progress as { state?: unknown } | null | undefined;
  const why = progress?.state === "running" ? ", while an update installs" : progress?.state === "restarting" ? ", as an update restarts the TV" : "";
  console.log(`agentv daemon stopping on ${signal}${why}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf("--port");
  const port = at >= 0 ? Number(args[at + 1]) : Number(process.env.AGENTV_PORT ?? 3000);
  const daemon = new Daemon({
    root: process.env.AGENTV_PATH ?? "/usr/share/agentv",
    inhibitor: (why) => new Inhibitor(why),
    state: process.env.AGENTV_DAEMON_STATE ?? "/var/lib/agentv/daemon",
    apps: process.env.AGENTV_APPS ?? "/var/lib/agentv/apps",
    updates: process.env.AGENTV_UPDATE_STATE ?? "/var/lib/agentv/update",
    port,
    lanPort: process.env.AGENTV_LAN_PORT === "off" ? undefined : Number(process.env.AGENTV_LAN_PORT ?? 3001),
    setupPort: process.env.AGENTV_SETUP_PORT === "off" ? undefined : Number(process.env.AGENTV_SETUP_PORT ?? 3002),
    homeProxyPort: process.env.AGENTV_HOME_PROXY_PORT === "off" ? undefined : Number(process.env.AGENTV_HOME_PROXY_PORT ?? 3005),
  });
  const listening = await daemon.listen();
  const phones = daemon.lanPort ? `, for phones on port ${daemon.lanPort}` : "";
  const captive = daemon.setupPort ? `, and for the setup hotspot on port ${daemon.setupPort}` : "";
  console.log(`agentv daemon on http://127.0.0.1:${listening}/${phones}${captive}`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void stopping(daemon, signal).then(() => daemon.close().then(() => process.exit(0))));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main();
