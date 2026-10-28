// The tools the harness gets from beyond it (ADR-043, ADR-044): the gates,
// npm and the browsers. Each comes as it's built; until then a step that
// lists one is told it isn't on this box yet.

import type { Extra } from "./tools.ts";

export async function extraTools(_dir: string, _step: string): Promise<Extra> {
  return {};
}
