// The router (ADR-003, ADR-013, ADR-023, ADR-068): one sentence said to the
// TV, as the phone's dictation typed it, turned into one of six requests
// with its slots, or into none. Four of them play or tell (continue, play,
// what's new, new episodes), and two ask the box's agent to build: make,
// for an app that isn't here yet, and change, for one the agent made. The
// provider's model only reads the sentence. It never acts and there's no
// agent loop: the executors do what the route says (daemon/executors/),
// and a sentence that can't be routed gets "I didn't get that", never a
// guess.
//
// Every provider gets the same brief and the same schema (daemon/providers/):
// through its API with structured output when the household gave a key, or
// through its own CLI once per sentence, with no tools, on a plan.

import type { Provider } from "./ai.ts";
import type { Usage } from "../builder/sandbox/prices.ts";

export const INTENTS = ["continue", "play", "whats_new", "new_episode", "make", "change"] as const;
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
  // make: the app to make, as said. change: the change, as said. Else null.
  what: string | null;
}

export const NONE: Route = { intent: "none", query: null, kind: null, app: null, season: null, episode: null, what: null };

// An app on the box, as the router tells the model about it. made: the box's
// agent built it, so it's one a change can be asked of.
export interface RouterApp {
  id: string;
  name: string;
  category: string;
  made?: boolean;
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
    what: nullable({ type: "string" }, "for make, the app to make; for change, the change to make; as the person said it"),
  },
  required: ["intent", "query", "kind", "app", "season", "episode", "what"],
  additionalProperties: false,
} as const;

// The brief, the same for every sentence and every box, so a provider can
// cache it. What changes, the box's apps and the sentence, comes after it.
export const BRIEF = `You are the router of AgenTV, a TV box. Someone said one sentence to the TV, typed by their phone's dictation. Turn it into one of six requests with its slots, or into none. You only read the sentence and answer with JSON. You never act, never chat and never explain.

The six requests:
- continue: carry on with something they were watching or listening to, from where they got to. "continue my show", "carry on where I left off", "resume Severance", "keep watching", "next episode please". query is the title when they name one, else null.
- play: start something by its name, or open an app. A film, a show, an episode, a song, an album, a playlist, an artist, photos or a game. "play Frozen", "put on the Frozen soundtrack", "watch season 2 episode 3 of Severance", "let's play Portal 2", "show me the photos from Lisbon", "open Steam". query is what to find. When they only name an app and nothing in it ("open Steam", "put Jellyfin on"), query is null and app is set. Opening or playing an app the agent made is play too.
- whats_new: what's new or just came out to watch or listen to. "what's new", "anything new on Plex", "what came out this week". query is null.
- new_episode: whether a show has a new episode or season out yet, or when it will. "is there a new episode of Severance", "has the new season of Bluey come out", "when does the new season start", "any new episodes of my show". query is the show, or null when they don't name one.
- make: build a new app or game for this TV, one that isn't on it yet, from what they describe. "make me a game like Tetris", "build an app for the photos on my NAS", "can you make a better weather app", "I'd like a quiz game for the kids". what is the app they describe, in their own words, without the request's own words such as make me, build, can you or please: "a game like Tetris". app is null.
- change: change an app the agent made, one marked "made by the agent" in the list below. "make the jump higher in Blocks", "change Blocks so the pieces fall faster", "add a high score to the quiz", "make it slower". what is the change, in their own words, without the app's name: "make the jump higher". app is the made app they named, or null when they don't name one.

The slots:
- query: the title, name or words to find, as they said them, in their own language. Leave out the request's own words, such as play, watch, the film, the series, the soundtrack, season 2, on Jellyfin, for me, please. Keep the title's own words: "The Bear" stays "The Bear", and "Making a Murderer" stays "Making a Murderer".
- kind: only when they say what kind it is. "film" (a film or movie), "series" (a show, or a season or episode of one), "video" (they said watch, but not which of the two), "track" (a song), "album" (an album or a soundtrack), "playlist", "artist" (music by an artist or band), "music" (they said listen, but not which), "photo-album" (photos or pictures), "game". When they don't say, kind is null, even for a title that's best known as one kind: "play Frozen" could be the film or its soundtrack, so its kind is null.
- app: when they name an app from the list below, its id. When they name an app that isn't on the list, its name as they said it. Else null.
- season and episode: numbers they said, such as season 2 or the third episode. Else null.
- what: for make and change only, as above. Else null.

Make and change are only ever about an app. Making or changing anything else isn't one of them: "make a playlist", "make it louder", "change the channel", "change who's watching" and "change the theme" are none. A title with make or change in it is play: "watch The Making of Dune", "play the song Changes".

Answer none, with every slot null, for anything else, and whenever you aren't sure:
- controls such as pause, stop, skip, louder, quieter, turn it off, go home, go back or switch who's watching;
- any other question, chat, the weather, the news, the time, shopping, lights, messages or settings;
- installing, adding or buying an app by its name, such as "install Steam", rather than describing one to make;
- two requests in one sentence;
- a sentence that's cut off, makes no sense, or isn't a request.
Never fill in a title, an app, a number or a change they didn't say.`;

// The rest of what the model reads: this box's apps, and the sentence, as
// a JSON string so nothing in it reads as part of the brief.
export function routeInput(sentence: string, apps: RouterApp[]): string {
  const listed = apps.length ? apps.map((app) => `- ${app.id}: ${app.name} (${app.category}${app.made ? ", made by the agent" : ""})`).join("\n") : "- none";
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
// find and no app, or a make or a change with nothing said to make or
// change. A make or a change has only its own slots; the others have no
// what.
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
    what: text(v.what, 300),
  };
  if (route.intent === "make" || route.intent === "change") {
    if (!route.what) return { ...NONE };
    return { ...NONE, intent: route.intent, what: route.what, app: route.intent === "change" ? route.app : null };
  }
  route.what = null;
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
