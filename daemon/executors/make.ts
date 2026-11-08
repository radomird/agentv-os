// Make and change (ADR-068): the Ask box asking the box's agent to build.
//
// - A make starts the builder the way Apps → "+ add your own" does. The
//   agent reads what was asked, then the TV and the phone show what it
//   understood, with its recipe or a plan, for an adult to confirm or turn
//   down (ADR-046).
// - A change starts a new version of an app the agent made straight from
//   the one on home (Q117), so it waits for an adult's ok first, on the TV
//   or the phone. Then it goes through the same gates and approval.
//
// The builder's rules stay its own: adults only, the PIN for every
// approval, and the plan's or the key's limits. A child's ask says to ask a
// grown-up, and with no AI set up, the TV says where to set it up. With the
// askbuilds switch off there's no ExecBuilds, and make and change get "i
// didn't get that", as before the router knew them.

import type { Route } from "../router.ts";
import { DIDNT_GET, type ExecApp, type ExecContext, type Outcome } from "./index.ts";

// What the executors may ask of the builder, for who's watching.
export interface ExecBuilds {
  adult: boolean;
  // Why the builder can't run now, as the TV says it, or null when it can.
  ready: () => Promise<string | null>;
  // A new app from what was said: its build, or why not.
  make: (what: string) => Promise<{ build?: string; error?: string }>;
  // The kind of recipe an app the agent made was built from, or null for
  // one built from a plan, or one the builder doesn't know.
  recipe: (app: string) => Promise<string | null>;
}

const lower = (text: string) => text.toLowerCase();

async function refused(ctx: ExecContext, doing: "make" | "change"): Promise<Outcome | null> {
  const builds = ctx.builds;
  if (!builds) return { kind: "none", why: "unroutable", say: DIDNT_GET };
  if (!builds.adult) return { kind: "none", why: "child", say: `ask a grown-up to ${doing} apps` };
  const why = await builds.ready();
  return why ? { kind: "none", why: "no-ai", say: why } : null;
}

export async function make(route: Route, ctx: ExecContext): Promise<Outcome> {
  const no = await refused(ctx, "make");
  if (no) return no;
  const what = route.what!;
  const started = await ctx.builds!.make(what);
  if (!started.build) return { kind: "none", why: "not-built", say: started.error ?? "your agent couldn't start on it" };
  return { kind: "build", build: started.build, what, say: "your agent is reading what you asked" };
}

// The app a change is for: the one they named, or with none named, the
// only one the agent made. app is the one run() found by what they said.
function changing(ctx: ExecContext, app: ExecApp | undefined): ExecApp | Outcome {
  if (app) return app.made ? app : { kind: "none", why: "not-made", say: `your agent didn't make ${lower(app.name)}, so it can't change it` };
  const made = ctx.apps.filter((a) => a.made);
  if (made.length === 1) return made[0];
  if (!made.length) return { kind: "none", why: "not-made", say: "your agent hasn't made any apps yet" };
  return { kind: "none", why: "which", say: "which app? say its name too" };
}

export async function change(route: Route, ctx: ExecContext, named: ExecApp | undefined): Promise<Outcome> {
  const no = await refused(ctx, "change");
  if (no) return no;
  const app = changing(ctx, named);
  if ("kind" in app) return app;
  const what = route.what!;
  return { kind: "change", app: app.id, name: app.name, what, recipe: await ctx.builds!.recipe(app.id), say: `change ${lower(app.name)}: ${lower(what)}?` };
}
