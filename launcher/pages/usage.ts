// Settings → usage (ADR-044, ADR-045): what your agent spent this month on
// the key, and what it may spend, a build's cap and the month's, with npm's
// safeguards for the packages it adds. Every change is an adult's, past the
// PIN once there is one. A plan keeps to its own limits, which the box
// doesn't count. The nightly package check's warnings show here too.

import { daemon, type BuilderSettings } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx } from "../main.ts";
import { buildsState, loadBuilds } from "./build.ts";

// The caps left and right step through, in dollars.
export const BUILD_CAPS = [1, 2, 5, 10, 20, 50];
export const MONTH_CAPS = [5, 10, 20, 50, 100, 200];

const money = (dollars: number) => (Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`);

export function usageValue(): string {
  const spend = buildsState()?.spend;
  return spend ? `${money(spend.spent)} of ${money(spend.cap.month)}` : "";
}

// One step up or down from where a cap is, on its list.
export function stepCap(caps: number[], now: number, by: 1 | -1): number {
  const at = caps.findIndex((c) => c >= now);
  if (at < 0) return by > 0 ? now : caps[caps.length - 1];
  const from = caps[at] === now ? at : by > 0 ? at - 1 : at;
  return caps[Math.max(0, Math.min(caps.length - 1, from + by))];
}

export async function changeBuilder(ctx: Ctx, change: Partial<BuilderSettings>, action: string): Promise<void> {
  const grant = await ctx.grant("your agent's spending and safeguards");
  if (grant === null) return;
  try {
    await daemon.builderSettings(change, grant || undefined);
  } catch (error) {
    if ((error as Error).message === "that needs the pin") ctx.forgetGrant();
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
    return;
  }
  ctx.sounds.play("confirm");
  await loadBuilds(ctx);
  ctx.render("settings/usage", action);
}

export function usagePanel(ctx: Ctx): HTMLElement[] {
  const note = (text: string) => h("p", { class: "panel-note" }, text);
  const state = buildsState();
  if (ctx.state.viewer.role !== "adult") return [h("div", { class: "panel-big" }, "an adult's"), note("your agent's spending is for an adult to see and change.")];
  if (!state) return [h("div", { class: "panel-big" }, "…")];
  const { settings, spend, warnings } = state;
  const capButton = (label: string, value: number, adjust: string) =>
    h(
      "button",
      { class: "button", "data-focus": true, "data-action": adjust, "data-adjust": adjust, onclick: () => void 0 },
      h("span", {}, label),
      h("span", { class: "button-value" }, `‹ ${money(value)} ›`),
    );
  return [
    h("div", { class: "panel-title" }, "this month, with a key"),
    h("div", { class: "panel-big" }, `${money(spend.spent)} of ${money(spend.cap.month)}`),
    note("a plan keeps to its own limits, which the box doesn't count."),
    capButton("a build may spend", settings.cap.build, "cap-build"),
    capButton("a month may spend", settings.cap.month, "cap-month"),
    h(
      "button",
      { class: "button", "data-focus": true, "data-action": "safeguards", onclick: () => void changeBuilder(ctx, { safeguards: !settings.safeguards }, "safeguards") },
      h("span", {}, "npm safeguards"),
      h("span", { class: "button-value" }, settings.safeguards ? "[x]" : "[ ]"),
    ),
    note(
      settings.safeguards
        ? "left and right change a cap. the box stops a build at its cap, and every build at the month's. with safeguards on, your agent adds only packages a week old or more, with no known high or critical problem, and runs none of their install scripts."
        : "left and right change a cap. safeguards are off: your agent may add packages published this week or with known problems, and their install scripts run in a sandbox. known malware is refused either way.",
    ),
    ...(warnings.length
      ? [
          h("div", { class: "panel-title security" }, "the nightly check found"),
          ...warnings.map((w) => note(`${w.id.replace(/^local\./, "")} ${w.version}: ${[...w.malware.map((m) => `${m}, known malware`), ...w.serious.map((x) => `${x}, a serious problem`)].join("; ")}. remove it or build it again from its details.`)),
        ]
      : []),
  ];
}
