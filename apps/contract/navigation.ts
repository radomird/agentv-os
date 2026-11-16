// An app's hints for the phone's d-pad (ADR-103, contract.ts's Navigation),
// checked as they come from its worker: a short list of plain objects with
// strings where the contract has them. What the page makes of a selector is
// the page's own business, and one it can't read is passed over there
// (daemon/remote-page.ts).

import type { Navigation } from "./contract.ts";

// The most hints an app gives, rows in one, and characters in one string.
export const MOST_HINTS = 20;
export const MOST_ROWS = 10;
export const MOST_CHARS = 500;

export function checkNavigation(value: unknown, name = "The app"): { hints: Navigation[] } | { problem: string } {
  if (value === undefined || value === null) return { hints: [] };
  const bad = (why: string) => ({ problem: `${name}'s navigation ${why}` });
  if (!Array.isArray(value)) return bad("isn't a list of hints");
  if (value.length > MOST_HINTS) return bad(`has more than ${MOST_HINTS} hints`);
  const text = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= MOST_CHARS && !/[\u0000-\u001f]/.test(v);
  const hints: Navigation[] = [];
  for (const [i, hint] of value.entries()) {
    if (!hint || typeof hint !== "object" || Array.isArray(hint)) return bad(`hint ${i + 1} isn't an object`);
    const h = hint as Record<string, unknown>;
    const extra = Object.keys(h).find((key) => !["url", "items", "skip", "scroller", "rows"].includes(key));
    if (extra) return bad(`hint ${i + 1} has ${extra}, which isn't a hint`);
    const out: Navigation = {};
    for (const key of ["url", "items", "skip", "scroller"] as const) {
      if (h[key] === undefined) continue;
      if (!text(h[key])) return bad(`hint ${i + 1}'s ${key} isn't a selector of up to ${MOST_CHARS} characters`);
      out[key] = h[key] as string;
    }
    if (out.url !== undefined) {
      try {
        new RegExp(out.url);
      } catch {
        return bad(`hint ${i + 1}'s url isn't a regular expression`);
      }
    }
    if (h.rows !== undefined) {
      if (!Array.isArray(h.rows) || h.rows.length > MOST_ROWS) return bad(`hint ${i + 1}'s rows isn't a list of up to ${MOST_ROWS}`);
      out.rows = [];
      for (const row of h.rows as unknown[]) {
        const r = row as Record<string, unknown>;
        if (!r || typeof r !== "object" || !text(r.row) || !text(r.next) || (r.previous !== undefined && !text(r.previous))) return bad(`hint ${i + 1} has a row without its row and next button`);
        out.rows.push({ row: r.row as string, next: r.next as string, ...(r.previous !== undefined ? { previous: r.previous as string } : {}) });
      }
    }
    hints.push(out);
  }
  return { hints };
}
