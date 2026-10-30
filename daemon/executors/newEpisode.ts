// Is there a new episode of X (ADR-003): the ledger's episode against
// TMDB's air dates, answered yes or no with the next date. That's stage 8's
// (S8.2), with its spoken answer. Until then the router still routes it,
// and the TV says plainly that it can't check yet.

import type { Route } from "../router.ts";

export function newEpisode(_route: Route): { say: string } {
  return { say: "i can't check for new episodes yet" };
}
