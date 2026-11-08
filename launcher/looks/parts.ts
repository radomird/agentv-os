// What every look's bar has (ADR-063, D1): home, Apps, Ask and Settings,
// one press away from home in every look. Each look draws them its own way.

import type { Ctx } from "../main.ts";
import { said } from "./looks.ts";
import { askBuilds } from "../pages/ask.ts";

export interface Section {
  key: "home" | "apps" | "ask" | "settings";
  label: string;
  open: () => void;
}

// The bar's sections, in order. Ask is everyone's with the Ask box on
// (ADR-068), and an adult's "make an app" with it off. Settings says when
// an update is ready.
export function sections(ctx: Ctx): Section[] {
  const update = ctx.updates.status?.agentv.available && !ctx.updates.status.waiting;
  const all: Section[] = [
    { key: "home", label: said("home"), open: () => ctx.top("home") },
    { key: "apps", label: said("apps"), open: () => ctx.top("apps") },
    { key: "ask", label: said("ask"), open: () => ctx.top("ask") },
    { key: "settings", label: said(update ? "settings ●" : "settings"), open: () => ctx.top("settings") },
  ];
  return all.filter((section) => section.key !== "ask" || ctx.state.viewer.role === "adult" || askBuilds());
}

// A bar note that only says which keys do what. With the looks, the bar
// leaves those out: the remote's keys always do the same things.
export function keyHints(info: string): boolean {
  return /[↵←→↑↓]|\besc\b/.test(info);
}
