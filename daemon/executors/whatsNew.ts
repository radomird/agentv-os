// What's new (ADR-003, ADR-013): what came out on the household's services
// since the last visit, from TMDB's discover for setup's region. That's
// stage 8's (S8.1). Until then the router still routes it, and the TV says
// plainly that it can't tell yet, rather than showing something else.

import type { Route } from "../router.ts";

export function whatsNew(_route: Route): { say: string } {
  return { say: "i can't tell you what's new yet" };
}
