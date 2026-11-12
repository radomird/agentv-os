// Is there a new episode of X (ADR-003, S8.2): TMDB's air dates against the
// ledger (daemon/tmdb.ts), answered yes or no, with the next air date. The
// TV and the phone show the answer, and the TV says it. Nothing opens.

import type { Route } from "../router.ts";
import type { ExecContext, Outcome } from "./index.ts";

export async function newEpisode(route: Route, ctx: ExecContext): Promise<Outcome> {
  if (!ctx.news) return { kind: "none", why: "soon", say: "Can't check for new episodes yet" };
  const answer = await ctx.news.episode(route.query);
  if (!answer.ok) {
    const why = answer.why === "no-key" || answer.why === "no-region" ? "no-tmdb" : answer.why === "failed" ? "failed" : "not-found";
    return { kind: "none", why, say: answer.say, ...(answer.error ? { detail: answer.error } : {}) };
  }
  return { kind: "told", say: answer.say, episode: answer };
}
