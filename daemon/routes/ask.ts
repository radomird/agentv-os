// The Ask box's builds (ADR-068), for the TV and a paired phone, while the
// askbuilds switch is on (daemon/executors/make.ts):
// - GET /api/ask and /api/phone/ask: what the Ask box is waiting on, if
//   anything, as { ok, ask }. ask is null, or one of:
//   - { kind: "build", ... }: a build the Ask box started. A make while the
//     agent reads what was asked, then what it understood for an adult to
//     confirm, then its steps; or a change an adult said ok to;
//   - { kind: "change", ... }: a change waiting for an adult's ok.
// - POST /api/ask/confirm and /api/phone/ask/confirm with { n }: an adult's
//   ok. A make goes on to its recipe or a plan (the builder's own confirm),
//   and a change starts its new version.
// - POST /api/ask/cancel and /api/phone/ask/cancel with { n }: "not this".
//   A make's build is put away, and a change is dropped.
//
// n is the sentence's number, as the event `said` has it, so an ok can't
// land on a newer sentence. Adults only, as the builder is. Approving what
// was built stays the phone's, past the PIN, as for any build.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { BuildView } from "../builds.ts";
import type { Outcome } from "../executors/index.ts";
import type { Said } from "../say.ts";

export type AskView =
  | {
      kind: "build";
      n: number;
      build: string;
      app: string | null; // the app a change is for, or null for a make
      what: string;
      state: BuildView["state"];
      phase: BuildView["phase"];
      name: string | null; // what the agent called it, once it read the ask
      recipe: string | null; // its recipe's kind, or null for a plan
      says: string | null; // what the agent understood, in a line
      done: number;
      steps: number;
    }
  | { kind: "change"; n: number; app: string; name: string; what: string; recipe: string | null };

export interface AskRoutes {
  on: () => Promise<boolean>;
  adult: () => Promise<boolean>;
  said: () => Said | null;
  find: (build: string) => Promise<BuildView | null>;
  confirm: (build: string) => Promise<{ build?: BuildView; error?: string }>;
  forget: (build: string) => Promise<{ error?: string }>;
  change: (app: string, what: string) => Promise<{ build?: BuildView; error?: string }>;
  settle: (n: number, outcome: Outcome) => Said | null;
  dismiss: (n: number) => boolean;
  body: (request: IncomingMessage) => Promise<unknown>;
  json: (response: ServerResponse, status: number, data: unknown) => void;
  log: (line: string) => void;
}

const CHILD = "ask a grown-up to make apps";

// What the Ask box is waiting on, from the newest sentence.
export async function askView(kit: Pick<AskRoutes, "said" | "find">): Promise<AskView | null> {
  const said = kit.said();
  const outcome = said?.outcome;
  if (!said || !outcome) return null;
  if (outcome.kind === "change") return { kind: "change", n: said.n, app: outcome.app, name: outcome.name, what: outcome.what, recipe: outcome.recipe };
  if (outcome.kind !== "build") return null;
  const b = await kit.find(outcome.build);
  if (!b) return null;
  return {
    kind: "build",
    n: said.n,
    build: b.build,
    app: outcome.app ?? null,
    what: outcome.what,
    state: b.state,
    phase: b.phase,
    name: b.understood?.name ?? b.name ?? null,
    recipe: b.understood?.recipe ?? null,
    says: b.understood?.says ?? null,
    done: b.steps.filter((s) => s.state === "done").length,
    steps: b.steps.length,
  };
}

const lower = (text: string) => text.toLowerCase();

// True when the request was one of these, and has been answered.
export async function askRoutes(kit: AskRoutes, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  const route = /^\/api(?:\/phone)?\/ask(?:\/(confirm|cancel))?$/.exec(path);
  if (!route) return false;
  const method = request.method;
  const action = route[1];
  if (!(await kit.on())) {
    kit.json(response, 404, { ok: false, error: "not found" });
    return true;
  }
  if (!action && method === "GET") {
    kit.json(response, 200, { ok: true, ask: (await kit.adult()) ? await askView(kit) : null });
    return true;
  }
  if (!action || method !== "POST") {
    kit.json(response, 405, { ok: false, error: "GET the ask, or POST confirm or cancel" });
    return true;
  }
  if (!(await kit.adult())) {
    kit.json(response, 403, { ok: false, error: CHILD });
    return true;
  }
  const n = ((await kit.body(request)) as { n?: unknown } | undefined)?.n;
  const ask = await askView(kit);
  if (!ask || ask.n !== n) {
    kit.json(response, 409, { ok: false, error: "that isn't waiting any more" });
    return true;
  }
  const answer = (result: { error?: string }, done: string) => {
    if (result.error) return kit.json(response, 409, { ok: false, error: result.error });
    kit.log(done);
    kit.json(response, 200, { ok: true, ask: null });
  };

  if (ask.kind === "change") {
    if (action === "cancel") {
      kit.dismiss(ask.n);
      return answer({}, "a change from the ask box was turned down"), true;
    }
    const made = await kit.change(ask.app, ask.what);
    if (!made.build) return answer({ error: made.error ?? "your agent couldn't start on it" }, ""), true;
    kit.settle(ask.n, { kind: "build", build: made.build.build, app: ask.app, what: ask.what, say: `building ${lower(ask.name)}` });
    kit.json(response, 200, { ok: true, ask: await askView(kit) });
    kit.log(`a change to ${ask.app} from the ask box is building`);
    return true;
  }

  // A make: the builder's own confirm, once the agent has read the ask.
  if (action === "confirm") {
    if (ask.state !== "confirm") return answer({ error: ask.state === "running" || ask.state === "starting" ? "your agent is still reading it" : "it isn't waiting to be confirmed" }, ""), true;
    const confirmed = await kit.confirm(ask.build);
    if (confirmed.error) return answer(confirmed, ""), true;
    kit.json(response, 200, { ok: true, ask: await askView(kit) });
    kit.log("a make from the ask box was confirmed");
    return true;
  }
  const forgot = await kit.forget(ask.build);
  if (forgot.error) return answer(forgot, ""), true;
  kit.settle(ask.n, { kind: "none", why: "not-built", say: "ok, not that one" });
  return answer({}, "a make from the ask box was turned down"), true;
}
