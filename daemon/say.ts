// A sentence said to the TV (ADR-023): the phone's dictation, or what was
// typed, routed (daemon/router.ts) and done (daemon/executors/). The TV and
// every paired phone hear it as it goes: the sentence as heard at once,
// then what came of it. When there's more than one match, the TV and the
// phone both show up to three, and either one picks.
//
// Searching apps and opening them need the TV session, so they're asks the
// screen daemon takes, as the person, the way Export's push is
// (daemon/asks.ts). Who's watching decides which apps the router hears of,
// so a child's profile only routes to children's apps.
//
// Make and change (ADR-068) ask the box's agent to build, for an adult,
// when the askbuilds switch is on (daemon/executors/make.ts). A change
// waits for an adult's ok on the TV or a phone, which settle() takes.
//
// What was said is never logged: only which request it was and how long
// the router took.

import type { Item } from "../apps/contract/contract.ts";
import type { Viewer } from "./apps/loader.ts";
import { execute, run, type ExecApp, type ExecContext, type ExecNews, type Opened, type Outcome } from "./executors/index.ts";
import type { ExecBuilds } from "./executors/make.ts";
import type { Found } from "./executors/play.ts";
import { fromWhatsNew } from "./executors/whatsNew.ts";
import type { WatchRow } from "./ledger.ts";
import { cleanSentence, NONE, type Route, type Routed, type RouterApp } from "./router.ts";

// What the daemon asks of the screen daemon for a sentence: X looked up,
// what was chosen opened, or a line shown over the app in front, since
// home's own page shows it only while home is in front.
// And the listening bar over the app in front (ADR-054), as the phone's
// box opens, its words come, the sentence is thought about and what came
// of it, or it goes away. And what came of it said aloud (stage 8): the
// daemon's clip, played through the box's sound output.
export type LiveState = "open" | "words" | "closed" | "thinking" | "said";
export type SayAsk =
  | { kind: "search"; query: string; apps: string[]; viewer: Viewer }
  | { kind: "open"; app: string; item?: Item }
  | { kind: "tell"; text: string }
  | { kind: "live"; state: LiveState; text: string }
  | { kind: "speak"; clip: number };

export interface SayAnswer {
  ok: boolean;
  error?: string;
  found?: Found[];
}

const line = (value: unknown, max = 160) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : undefined);

// An item as the daemon takes it from an app's search, within bounds.
export function cleanItem(value: unknown): Item | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const kinds = ["film", "series", "episode", "track", "album", "playlist", "photo-album", "game"];
  if (typeof v.id !== "string" || typeof v.title !== "string" || !kinds.includes(v.kind as string)) return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 && x < 10_000 ? x : undefined);
  const url = (x: unknown) => (typeof x === "string" && /^https?:\/\//.test(x) && x.length < 2000 ? x : undefined);
  const item: Item = { id: v.id.slice(0, 200), kind: v.kind as Item["kind"], title: line(v.title, 200)! };
  if (n(v.season) !== undefined) item.season = n(v.season);
  if (n(v.episode) !== undefined) item.episode = n(v.episode);
  if (line(v.subtitle)) item.subtitle = line(v.subtitle);
  if (url(v.poster)) item.poster = url(v.poster);
  if (url(v.still)) item.still = url(v.still);
  return item;
}

// The screen daemon's answer, only what an answer has.
export function cleanSayAnswer(said: unknown): SayAnswer {
  const s = (typeof said === "object" && said !== null ? said : {}) as Record<string, unknown>;
  const answer: SayAnswer = { ok: s.ok === true };
  if (line(s.error)) answer.error = line(s.error);
  if (Array.isArray(s.found)) {
    answer.found = s.found.slice(0, 50).flatMap((f): Found[] => {
      if (typeof f !== "object" || f === null || typeof (f as Found).app !== "string") return [];
      const items = Array.isArray((f as Found).items) ? (f as Found).items.slice(0, 20).map(cleanItem).filter((i): i is Item => i !== null) : [];
      return [{ app: (f as Found).app, items, ...(line((f as Found).error) ? { error: line((f as Found).error) } : {}) }];
    });
  }
  return answer;
}

// One sentence, as the TV and the phones show it.
export interface Said {
  n: number;
  sentence: string;
  from: string; // "the tv", or the phone's name
  viewer: string;
  state: "routing" | "done";
  route?: Route;
  outcome?: Outcome;
  at: string;
}

export interface SayOptions {
  route: (sentence: string, apps: RouterApp[]) => Promise<Routed>;
  viewer: () => Promise<Viewer & { name: string }>;
  apps: (viewer: Viewer) => Promise<ExecApp[]>;
  rows: (viewer: string) => WatchRow[];
  // What's new and a show's air dates, from TMDB, for who's watching and the
  // apps they can open (stage 8).
  news?: (viewer: Viewer, apps: ExecApp[]) => ExecNews;
  // The builder for who's watching, for make and change, or nothing while
  // the askbuilds switch is off.
  builds?: (viewer: Viewer) => Promise<ExecBuilds | undefined>;
  ask: (ask: SayAsk, ms: number) => Promise<SayAnswer>;
  changed: (said: Said | null) => void; // null: put away
  // What came of a sentence, said aloud over HDMI (stage 8, Q146): the
  // outcome's own line, "Didn't get that" too.
  speak?: (text: string) => void;
  // The listening bar (ADR-054): whether one was up for this sentence,
  // which what came of it then takes over, whether a new box has it now,
  // and the bar over an app.
  bar?: { sent: (from: string) => boolean; listening: () => boolean; show: (state: "thinking" | "said", text: string) => void };
  log?: (line: string) => void;
  now?: () => Date;
}

// How long the TV session has: an app's search takes up to 10 s, and its
// playback.open up to 30 s.
const SEARCH_MS = 15_000;
const OPEN_MS = 40_000;

export class Say {
  private o: SayOptions;
  private next = 1;
  // The newest sentence, as it stands.
  current: Said | null = null;
  // The sentences the listening bar took over, by number.
  private barred = new Set<number>();

  constructor(options: SayOptions) {
    this.o = options;
  }

  private now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  private show(said: Said): void {
    if (this.current?.n === said.n) this.o.changed(said);
  }

  private async search(query: string, apps: string[], viewer: Viewer): Promise<Found[]> {
    const answer = await this.o.ask({ kind: "search", query, apps, viewer }, SEARCH_MS);
    if (!answer.ok) return apps.map((app) => ({ app, items: [], error: answer.error ?? "Couldn't search" }));
    return answer.found ?? [];
  }

  private async open(app: string, item?: Item): Promise<Opened> {
    const answer = await this.o.ask({ kind: "open", app, ...(item ? { item } : {}) }, OPEN_MS);
    return answer.ok ? { ok: true } : { ok: false, error: answer.error };
  }

  // A sentence, routed and done. It answers once it's done, and the TV and
  // the phones hear each step. A newer sentence takes the TV over from it.
  async hear(sentence: unknown, from: string): Promise<Said> {
    const viewer = await this.o.viewer();
    const said: Said = { n: this.next++, sentence: cleanSentence(sentence), from, viewer: viewer.id, state: "routing", at: this.now() };
    this.current = said;
    if (this.o.bar?.sent(from)) {
      this.barred.add(said.n);
      this.o.bar.show("thinking", said.sentence);
    }
    this.show(said);
    const apps = await this.o.apps(viewer);
    // The apps that play something; Clock and Weather open from home. And
    // every app the agent made, which a change can name.
    const heard = apps.filter((app) => app.category !== "utility" || app.made).map(({ id, name, category, made }) => ({ id, name, category, ...(made ? { made } : {}) }));
    const routed = await this.o.route(said.sentence, heard);
    this.o.log?.(`heard from ${from}: ${routed.route.intent}${routed.none ? ` (${routed.none})` : ""}, routed by ${routed.provider} in ${routed.ms} ms`);
    said.route = routed.route;
    said.outcome = this.plain(await execute(routed, this.context(viewer, apps, await this.o.builds?.(viewer))));
    said.state = "done";
    said.at = this.now();
    this.show(said);
    this.tell(said);
    return said;
  }

  // A route the TV chose itself, such as a title on New this week (S8.1):
  // done as a sentence's would be, with nothing routed, and the TV and the
  // phones hear how it went. words is what they see as heard.
  async act(route: Route, from: string, words: string): Promise<Said> {
    const viewer = await this.o.viewer();
    const said: Said = { n: this.next++, sentence: cleanSentence(words), from, viewer: viewer.id, state: "routing", route, at: this.now() };
    this.current = said;
    this.show(said);
    said.outcome = this.plain(await run(route, this.context(viewer, await this.o.apps(viewer))));
    said.state = "done";
    said.at = this.now();
    this.show(said);
    this.tell(said);
    return said;
  }

  // What came of it, as a screen gets it: the one line, and never the raw
  // reason behind it, which goes in the log. A reason is an app's or the
  // AI's own error. It never holds what was said.
  private plain(outcome: Outcome): Outcome {
    if (outcome.kind !== "none" || outcome.detail === undefined) return outcome;
    const { detail, ...shown } = outcome;
    this.o.log?.(`nothing came of it (${outcome.why}): ${detail}`);
    return shown;
  }

  // What the executors may do for who's watching.
  private context(viewer: Viewer, apps: ExecApp[], builds?: ExecBuilds): ExecContext {
    return {
      apps,
      rows: () => this.o.rows(viewer.id),
      search: (query, ids) => this.search(query, ids, viewer),
      open: (app, item) => this.open(app, item),
      ...(this.o.news ? { news: this.o.news(viewer, apps) } : {}),
      ...(builds ? { builds } : {}),
    };
  }

  // What came of the sentence, settled: a change an adult said ok to on
  // the TV or a phone, or a make they turned down. The TV and the phones
  // hear it, and the TV says it.
  settle(n: number, outcome: Outcome): Said | null {
    const said = this.current;
    if (!said || said.n !== n) return null;
    said.outcome = outcome;
    said.at = this.now();
    this.show(said);
    this.o.speak?.(outcome.say);
    return said;
  }

  // What came of it, over the app in front: on the listening bar when it
  // was up, or else as a toast. An app that opened says so by being there,
  // unless the bar was waiting to say it. A box opened again since has the
  // bar for its own words.
  private tell(said: Said): void {
    const outcome = said.outcome;
    if (!outcome || this.current?.n !== said.n) return;
    this.o.speak?.(outcome.say);
    const text = outcome.kind === "choose" ? `${outcome.say}${outcome.say.endsWith("?") ? " " : ". "}Pick on your phone.` : outcome.say;
    if (this.barred.delete(said.n) && !this.o.bar?.listening()) {
      this.o.bar?.show("said", text);
      return;
    }
    if (outcome.kind === "opened") return;
    void this.o.ask({ kind: "tell", text }, 5000);
  }

  // One of the things to choose from, picked on the TV or a phone.
  async pick(n: unknown, choice: unknown): Promise<{ said?: Said; error?: string }> {
    const said = this.current;
    if (!said || said.n !== n || said.outcome?.kind !== "choose") return { error: "There's nothing to choose from now" };
    const candidate = Number.isInteger(choice) ? said.outcome.candidates[choice as number] : undefined;
    if (!candidate) return { error: "That's not one of them" };
    const viewer = await this.o.viewer();
    const apps = await this.o.apps(viewer);
    const app = apps.find((a) => a.id === candidate.app);
    if (!app || viewer.id !== said.viewer) return { error: "Someone else is watching now" };
    // A title from what's new is TMDB's, not the app's: it's looked up in
    // its app and played, as "play it on that app" would.
    if (fromWhatsNew(candidate.item)) {
      const item = candidate.item;
      const route: Route = { ...NONE, intent: "play", query: item.title, kind: item.kind === "film" ? "film" : "series", app: app.id, season: item.season ?? null };
      said.outcome = this.plain(await run(route, this.context(viewer, apps)));
      said.at = this.now();
      this.show(said);
      this.o.speak?.(said.outcome.say);
      return { said };
    }
    const opened = await this.open(app.id, candidate.item);
    said.outcome = this.plain(
      opened.ok
        ? { kind: "opened", app: app.id, item: candidate.item, say: `${candidate.item.title}, on ${app.name}` }
        : { kind: "none", why: "not-opened", say: `Couldn't open ${candidate.item.title}`, ...(opened.error ? { detail: opened.error } : {}) },
    );
    said.at = this.now();
    this.show(said);
    this.o.speak?.(said.outcome.say);
    return { said };
  }

  // The TV put it away, with Back, or a phone did.
  dismiss(n: unknown): boolean {
    if (!this.current || this.current.n !== n) return false;
    this.current = null;
    this.o.changed(null);
    return true;
  }
}
