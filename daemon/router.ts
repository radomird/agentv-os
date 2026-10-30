// The router (ADR-003, ADR-013, ADR-023): one sentence said to the TV, as
// the phone's dictation typed it, turned into one of four requests with its
// slots, or into none. The provider's model only reads the sentence. It
// never acts and there's no agent loop: the executors do what the route
// says (daemon/executors/), and a sentence that can't be routed gets "I
// didn't get that", never a guess.
//
// Every provider gets the same brief and the same schema (daemon/providers/):
// through its API with structured output when the household gave a key, or
// through its own CLI once per sentence, with no tools, on a plan.

import type { Provider } from "./ai.ts";
import type { Usage } from "../builder/sandbox/prices.ts";

export const INTENTS = ["continue", "play", "whats_new", "new_episode"] as const;
export type Intent = (typeof INTENTS)[number];

// What kind of thing the person asked for, when they said: the contract's
// kinds as a person names them, an artist, and "video" or "music" when they
// said watch or listen but not which.
export const KINDS = ["film", "series", "video", "track", "album", "playlist", "artist", "music", "photo-album", "game"] as const;
export type Kind = (typeof KINDS)[number];

export interface Route {
  intent: Intent | "none";
  query: string | null; // the title or name, as said
  kind: Kind | null;
  app: string | null; // an app on the box by its id, or the name of one that isn't
  season: number | null;
  episode: number | null;
}

export const NONE: Route = { intent: "none", query: null, kind: null, app: null, season: null, episode: null };

// An app on the box, as the router tells the model about it.
export interface RouterApp {
  id: string;
  name: string;
  category: string;
}

// Each slot may be null. anyOf with null, rather than a list of types, is
// the one form all five providers' structured output takes.
const nullable = (schema: Record<string, unknown>, description: string) => ({ anyOf: [schema, { type: "null" }], description });

export const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: [...INTENTS, "none"], description: "the request, or none" },
    query: nullable({ type: "string" }, "the title, name or words to find, as the person said them"),
    kind: nullable({ type: "string", enum: [...KINDS] }, "the kind of thing, only when the person said it"),
    app: nullable({ type: "string" }, "the id of an app on this TV the person named, or the name of one that isn't here"),
    season: nullable({ type: "integer" }, "a season number the person said"),
    episode: nullable({ type: "integer" }, "an episode number the person said"),
  },
  required: ["intent", "query", "kind", "app", "season", "episode"],
  additionalProperties: false,
} as const;

// The brief, the same for every sentence and every box, so a provider can
// cache it. What changes, the box's apps and the sentence, comes after it.
export const BRIEF = `You are the router of AgenTV, a TV box. Someone said one sentence to the TV, typed by their phone's dictation. Turn it into one of four requests with its slots, or into none. You only read the sentence and answer with JSON. You never act, never chat and never explain.

The four requests:
- continue: carry on with something they were watching or listening to, from where they got to. "continue my show", "carry on where I left off", "resume Severance", "keep watching", "next episode please". query is the title when they name one, else null.
- play: start something by its name, or open an app. A film, a show, an episode, a song, an album, a playlist, an artist, photos or a game. "play Frozen", "put on the Frozen soundtrack", "watch season 2 episode 3 of Severance", "let's play Portal 2", "show me the photos from Lisbon", "open Steam". query is what to find. When they only name an app and nothing in it ("open Steam", "put Jellyfin on"), query is null and app is set.
- whats_new: what's new or just came out to watch or listen to. "what's new", "anything new on Plex", "what came out this week". query is null.
- new_episode: whether a show has a new episode or season out yet, or when it will. "is there a new episode of Severance", "has the new season of Bluey come out", "when does the new season start", "any new episodes of my show". query is the show, or null when they don't name one.

The slots:
- query: the title, name or words to find, as they said them, in their own language. Leave out the request's own words, such as play, watch, the film, the series, the soundtrack, season 2, on Jellyfin, for me, please. Keep the title's own words: "The Bear" stays "The Bear".
- kind: only when they say what kind it is. "film" (a film or movie), "series" (a show, or a season or episode of one), "video" (they said watch, but not which of the two), "track" (a song), "album" (an album or a soundtrack), "playlist", "artist" (music by an artist or band), "music" (they said listen, but not which), "photo-album" (photos or pictures), "game". When they don't say, kind is null, even for a title that's best known as one kind: "play Frozen" could be the film or its soundtrack, so its kind is null.
- app: when they name an app from the list below, its id. When they name an app that isn't on the list, its name as they said it. Else null.
- season and episode: numbers they said, such as season 2 or the third episode. Else null.

Answer none, with every slot null, for anything else, and whenever you aren't sure:
- controls such as pause, stop, skip, louder, quieter, turn it off, go home, go back or switch who's watching;
- any other question, chat, the weather, the news, the time, shopping, lights, messages or settings;
- adding, building, buying or installing an app;
- two requests in one sentence;
- a sentence that's cut off, makes no sense, or isn't a request.
Never fill in a title, an app or a number they didn't say.`;

// The rest of what the model reads: this box's apps, and the sentence, as
// a JSON string so nothing in it reads as part of the brief.
export function routeInput(sentence: string, apps: RouterApp[]): string {
  const listed = apps.length ? apps.map((app) => `- ${app.id}: ${app.name} (${app.category})`).join("\n") : "- none";
  return `Apps on this TV:\n${listed}\n\nSentence: ${JSON.stringify(sentence)}`;
}

// The sentence as the router takes it: one line, at most 300 characters.
export function cleanSentence(sentence: unknown): string {
  if (typeof sentence !== "string") return "";
  return sentence.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
};

const number = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1000 ? value : null);

// What the model answered, held to the schema, or null when it doesn't fit
// it. A route the executors couldn't act on is none: a play with nothing to
// find and no app.
export function parseRoute(value: unknown): Route | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.intent === "none") return { ...NONE };
  if (!(INTENTS as readonly unknown[]).includes(v.intent)) return null;
  const route: Route = {
    intent: v.intent as Intent,
    query: text(v.query, 200),
    kind: (KINDS as readonly unknown[]).includes(v.kind) ? (v.kind as Kind) : null,
    app: text(v.app, 80),
    season: number(v.season),
    episode: number(v.episode),
  };
  if (route.intent === "play" && !route.query && !route.app) return { ...NONE };
  if (route.intent === "whats_new") route.query = null;
  return route;
}

// One request to a provider: the brief, what follows it, and the schema the
// answer must take.
export interface Ask {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  name: string; // the schema's name, for providers that ask for one
}

export interface Answer {
  value: unknown; // the JSON the model answered, or its text
  model?: string; // the model that answered, when the provider says
  usage?: Usage;
  spent?: number; // dollars, when the provider or the CLI says
}

// A provider's API with a key, or its CLI on a plan.
export interface Backend {
  provider: Provider;
  via: "api" | "cli";
  model: string | null; // null: the CLI's own default
  ask(ask: Ask): Promise<Answer>;
}

export interface Routed {
  sentence: string;
  route: Route;
  // Why it's none, when it is: the model said so, its answer didn't fit
  // the schema, or the provider didn't answer.
  none?: "unroutable" | "unreadable" | "failed";
  error?: string; // one line, when the provider didn't answer
  provider: Provider;
  via: "api" | "cli";
  model: string | null;
  ms: number;
  usage?: Usage;
  spent?: number;
}

export class Router {
  private backend: Backend;
  private now: () => number;

  constructor(backend: Backend, options: { now?: () => number } = {}) {
    this.backend = backend;
    this.now = options.now ?? (() => performance.now());
  }

  get provider(): Provider {
    return this.backend.provider;
  }

  async route(sentence: unknown, apps: RouterApp[]): Promise<Routed> {
    const said = cleanSentence(sentence);
    const base = { sentence: said, provider: this.backend.provider, via: this.backend.via, model: this.backend.model };
    if (!said) return { ...base, route: { ...NONE }, none: "unroutable", ms: 0 };
    const start = this.now();
    let answer: Answer;
    try {
      answer = await this.backend.ask({ system: BRIEF, user: routeInput(said, apps), schema: ROUTE_SCHEMA as unknown as Record<string, unknown>, name: "route" });
    } catch (error) {
      return { ...base, route: { ...NONE }, none: "failed", error: (error as Error).message.slice(0, 200), ms: Math.round(this.now() - start) };
    }
    const ms = Math.round(this.now() - start);
    const extra = { ms, ...(answer.model ? { model: answer.model } : {}), ...(answer.usage ? { usage: answer.usage } : {}), ...(answer.spent !== undefined ? { spent: answer.spent } : {}) };
    const route = parseRoute(answer.value);
    if (!route) return { ...base, ...extra, route: { ...NONE }, none: "unreadable" };
    return { ...base, ...extra, route, ...(route.intent === "none" ? { none: "unroutable" as const } : {}) };
  }
}
