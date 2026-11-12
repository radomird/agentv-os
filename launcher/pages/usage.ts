// AI's spending rows in Settings (ADR-044, ADR-045, D10): what was spent this
// month with a key, as a row with a bar that fills toward the month's limit,
// then the limit for one app, the limit for the month, and npm's safeguards
// for the packages an app adds. Every change is an adult's, past the PIN once
// there is one. A plan has its own limits, which aren't counted here. The
// spending row opens a page with that line and the nightly package check's
// warnings.

import { daemon, type BuilderSettings } from "../api.ts";
import { h } from "../dom.ts";
import { loadingMark } from "../loading.ts";
import type { Ctx } from "../main.ts";
import { buildsState, loadBuilds } from "./build.ts";
import { keyState } from "./key.ts";
import { pinAsked } from "./pin.ts";

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
    h(
      "button",
      { class: "button", "data-focus": true, "data-action": "safeguards", onclick: () => void changeBuilder(ctx, { safeguards: !settings.safeguards }, "safeguards") },
      h("span", {}, "Extra safety checks"),
      h("span", { class: "button-value" }, settings.safeguards ? "On" : "Off"),
    ),
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
  const onPlan = keyState?.ai?.path === "plan" && keyState.ai.accepted === true;
  return [
    h("div", { class: "panel-title" }, "Spent this month"),
    h("div", { class: "panel-big" }, usageValue()),
    h("div", { class: "metered" }, meter()),
    note(onPlan ? "A plan has its own limits, not counted here" : settings.safeguards ? "Making an app stops at its limit" : "Safety checks are off. Known malware is still blocked."),
    ...(warnings.length
      ? [
          h("div", { class: "panel-title security" }, "Problems found"),
          ...warnings.map((w) => note(`${w.id.replace(/^local\./, "")} ${w.version}: ${[...w.malware.map((m) => `${m}, known malware`), ...w.serious.map((x) => `${x}, a serious problem`)].join("; ")}. Remove it or make it again from its details.`)),
        ]
      : []),
  ];
}
