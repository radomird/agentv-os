// AI's spending rows in Settings (ADR-044, ADR-045, D10): what was spent this
// month with a key, as a row with a bar that fills toward the month's limit,
// then the limit for one app, the limit for the month, and npm's safeguards
// for the packages an app adds. Every change is an adult's, past the PIN once
// there is one. The spending row opens a page with that line and the nightly
// package check's warnings.
//
// A plan has its own limits, and shows how much of them is used instead
// (ADR-103, Q313): a row with a bar for each window the provider says, the
// 5 hours and the week, and never a dollar amount. While the plan's limits
// are paused, the last numbers show with when they were read ("As of 8
// hours ago"). Where the TV can't see any, the row says it's using the
// plan, and where the plan's sign-in ran out, it offers signing in again.
// The caps are a key's only.

import { daemon, type BuilderSettings, type PlanUsageState } from "../api.ts";
import { h } from "../dom.ts";
import { loadingMark } from "../loading.ts";
import type { Ctx } from "../main.ts";
import { buildsState, loadBuilds } from "./build.ts";
import { keyState, providerName } from "./key.ts";
import { pinAsked } from "./pin.ts";

// How much of the plan is used, asked for when Settings, AI opens.
let planState: PlanUsageState | null = null;

// What a plan's rows show, or null when no plan is in use: Settings draws
// AI again only when this changes, so a key's rows aren't drawn again under
// the viewer for nothing.
export function planUsageShown(): PlanUsageState | null {
  return onPlan() ? planState : null;
}

export async function loadPlanUsage(): Promise<void> {
  try {
    planState = await daemon.planUsage();
  } catch {}
}

function onPlan(): boolean {
  return keyState?.ai?.path === "plan" && keyState.ai.accepted === true;
}

type Window = NonNullable<PlanUsageState["usage"]>["windows"][number];

const windowName = (w: Window) => (w.window === "hours" ? `${w.hours ?? 5}-hour limit` : w.window === "week" ? "Weekly limit" : "Monthly limit");

// A bar for how much of a window is used.
function bar(percent: number): HTMLElement {
  const fill = h("span", {});
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  return h("span", { class: "button-value meter", role: "img", "aria-label": `${percent} percent used` }, fill);
}

// When a window starts over: a time today, or the day and time.
export function startsOver(iso: string | undefined, now = new Date()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return `Starts over at ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (at.toDateString() === tomorrow.toDateString()) return `Starts over tomorrow at ${time}`;
  return `Starts over ${at.toLocaleDateString("en-GB", { weekday: "long" })} at ${time}`;
}

// What a plan's row says when its sign-in is what's missing.
const signInSaid = (signIn: "expired" | "none") => (signIn === "expired" ? "Sign in again" : "Sign in");

// How long ago kept numbers were read, as a line under them.
export function asOfLine(iso: string | undefined, now = Date.now()): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return null;
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "As of just now";
  if (minutes < 60) return `As of ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `As of ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `As of ${Math.round(hours / 24)} days ago`;
}

// A plan's rows: a bar for each window, with when they were read when
// they're kept ones, one that offers signing in where that's what's
// missing, or one line when there's nothing to show.
function planRows(ctx: Ctx, open: () => void): HTMLElement[] {
  const windows = planState?.usage?.windows ?? [];
  const signIn = planState?.usage?.signIn;
  if (!windows.length && signIn) {
    return [h("button", { class: "button", "data-focus": true, "data-action": "usage-sign-in", onclick: () => ctx.go("plan-sign-in") }, h("span", {}, "Limits"), h("span", { class: "button-value" }, signInSaid(signIn)))];
  }
  if (!windows.length) {
    return [h("button", { class: "button", "data-focus": true, "data-action": "usage", onclick: open }, h("span", {}, "Limits"), h("span", { class: "button-value" }, planState ? "Using your plan" : loadingMark()))];
  }
  const rows = windows.map((w) => h("button", { class: "button metered", "data-focus": true, "data-action": `plan-${w.window}`, onclick: open }, h("span", {}, windowName(w)), h("span", { class: "button-value" }, `${w.percent}%`), bar(w.percent)));
  const age = asOfLine(planState?.usage?.asOf);
  return age ? [...rows, h("p", { class: "panel-note plan-age" }, age)] : rows;
}

// The caps left and right step through, in dollars.
export const BUILD_CAPS = [1, 2, 5, 10, 20, 50];
export const MONTH_CAPS = [5, 10, 20, 50, 100, 200];

// Whole dollars from $100 up, so "spent of limit" stays on its row's one line.
const money = (dollars: number) => (Number.isInteger(dollars) || dollars >= 100 ? `$${Math.round(dollars)}` : `$${dollars.toFixed(2)}`);

export function usageValue(): string {
  const spend = buildsState()?.spend;
  return spend ? `${money(spend.spent)} of ${money(spend.cap.month)}` : "";
}

// The bar: how much of the month's limit is spent. It's drawn in the
// colour of a row's value, so every look and theme has its own.
function meter(): HTMLElement {
  const spend = buildsState()?.spend;
  const part = spend && spend.cap.month > 0 ? Math.max(0, Math.min(1, spend.spent / spend.cap.month)) : 0;
  const fill = h("span", {});
  fill.style.width = `${Math.round(part * 100)}%`;
  return h("span", { class: "button-value meter", role: "img", "aria-label": `${Math.round(part * 100)} percent of the month's limit` }, fill);
}

// One step up or down from where a cap is, on its list.
export function stepCap(caps: number[], now: number, by: 1 | -1): number {
  const at = caps.findIndex((c) => c >= now);
  if (at < 0) return by > 0 ? now : caps[caps.length - 1];
  const from = caps[at] === now ? at : by > 0 ? at - 1 : at;
  return caps[Math.max(0, Math.min(caps.length - 1, from + by))];
}

export async function changeBuilder(ctx: Ctx, change: Partial<BuilderSettings>, action: string): Promise<void> {
  const grant = await ctx.grant("spending");
  if (grant === null) return;
  try {
    await daemon.builderSettings(change, grant || undefined);
  } catch (error) {
    if (pinAsked(error)) ctx.forgetGrant();
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
    return;
  }
  ctx.sounds.play("confirm");
  await loadBuilds(ctx);
  ctx.render("settings/ai", action);
}

// The rows in AI: spending with its bar, the two limits and the safety
// checks. Left and right change a limit, and OK on the spending row opens
// its page.
export function usageRows(ctx: Ctx, open: () => void): HTMLElement[] {
  const state = buildsState();
  if (!state) return [];
  const { settings } = state;
  const safeguards = h(
    "button",
    { class: "button", "data-focus": true, "data-action": "safeguards", onclick: () => void changeBuilder(ctx, { safeguards: !settings.safeguards }, "safeguards") },
    h("span", {}, "Extra safety checks"),
    h("span", { class: "button-value" }, settings.safeguards ? "On" : "Off"),
  );
  if (onPlan()) return [...planRows(ctx, open), safeguards];
  const limit = (label: string, value: number, adjust: string) =>
    h(
      "button",
      { class: "button", "data-focus": true, "data-action": adjust, "data-adjust": adjust, onclick: () => void 0 },
      h("span", {}, label),
      h("span", { class: "button-value" }, money(value)),
    );
  return [
    h("button", { class: "button metered", "data-focus": true, "data-action": "usage", onclick: open }, h("span", {}, "Spent this month"), h("span", { class: "button-value" }, usageValue()), meter()),
    limit("Limit per app", settings.cap.build, "cap-build"),
    limit("Limit per month", settings.cap.month, "cap-month"),
    safeguards,
  ];
}

// The spending row's page: the same number and bar, one line about it, and
// what the nightly check found, when it found something.
export function usagePanel(ctx: Ctx): HTMLElement[] {
  const note = (text: string) => h("p", { class: "panel-note" }, text);
  const state = buildsState();
  if (ctx.state.viewer.role !== "adult") return [note("Only an adult can see spending")];
  if (!state) return [h("div", { class: "panel-big" }, loadingMark())];
  const { settings, warnings } = state;
  // A plan: how much of each window is used, and when it starts over.
  const windows = planState?.usage?.windows ?? [];
  const signIn = planState?.usage?.signIn;
  const name = providerName(keyState?.ai?.provider);
  const plan = onPlan()
    ? [
        h("div", { class: "panel-title" }, `Your ${name} plan`),
        ...(!windows.length && signIn
          ? [
              h("div", { class: "panel-big" }, signInSaid(signIn)),
              note(signIn === "expired" ? `Your ${name} sign-in ran out` : "Sign in to see how much of your plan is used"),
              h("button", { class: "button primary", "data-focus": true, "data-action": "usage-sign-in", onclick: () => ctx.go("plan-sign-in") }, "Sign in"),
            ]
          : windows.length
          ? [
              ...windows.flatMap((w) => {
                const over = startsOver(w.resets);
                return [h("div", { class: "panel-note plan-window" }, windowName(w)), h("div", { class: "panel-big" }, `${w.percent}% used`), h("div", { class: "metered" }, bar(w.percent)), ...(over ? [note(over)] : [])];
              }),
              ...[asOfLine(planState?.usage?.asOf)].filter((age): age is string => age !== null).map((age) => h("p", { class: "panel-note plan-age" }, age)),
            ]
          : [h("div", { class: "panel-big" }, planState ? "Using your plan" : loadingMark()), note("A plan has its own limits")]),
      ]
    : [
        h("div", { class: "panel-title" }, "Spent this month"),
        h("div", { class: "panel-big" }, usageValue()),
        h("div", { class: "metered" }, meter()),
        note(settings.safeguards ? "Making an app stops at its limit" : "Safety checks are off. Known malware is still blocked."),
      ];
  return [
    ...plan,
    ...(warnings.length
      ? [
          h("div", { class: "panel-title security" }, "Problems found"),
          ...warnings.map((w) => note(`${w.id.replace(/^local\./, "")} ${w.version}: ${[...w.malware.map((m) => `${m}, known malware`), ...w.serious.map((x) => `${x}, a serious problem`)].join("; ")}. Remove it or make it again from its details.`)),
        ]
      : []),
  ];
}
