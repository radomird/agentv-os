// Where the TV is (ADR-055): one step that confirms the country, so it's
// usually one press of OK. It starts on the country of the time zone
// Omarchy's installer set. Another country is picked from the tz database's,
// with the phone's keyboard or the arrows, and the box's time zone and New
// this week's region follow it, with nothing else to answer. Settings →
// country changes the same setting later. A box whose time zone has no
// country, such as UTC, goes straight to picking one.

import type { Country } from "../launcher/api.ts";
import { countryPicker } from "../launcher/country-picker.ts";
import { h } from "../launcher/dom.ts";
import { setup } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

// Kept while setup is on this step, so the pick page draws at once.
let known: { code: string | null; name: string | null; countries: Country[] } | null = null;

async function load(): Promise<NonNullable<typeof known>> {
  known = await setup.country();
  return known;
}

// The country confirmed or picked, then on to the next step.
async function choose(ctx: Ctx, code: string): Promise<void> {
  try {
    if (!(await ctx.guarded("changing location", (grant) => setup.setCountry(code, grant)))) return;
  } catch (error) {
    ctx.toast((error as Error).message, "fail");
    ctx.sounds.play("failure");
    return;
  }
  await ctx.finish("country");
}

export async function country(ctx: Ctx): Promise<View> {
  const state = await load().catch(() => null);
  if (!state?.code || !state.name) return pick(ctx);
  const code = state.code;
  const name = state.name;
  const ok = h("button", { class: "button primary", "data-focus": true, "data-action": "continue", onclick: () => void choose(ctx, code) }, "Yes");
  const other = h("button", { class: "button", "data-focus": true, "data-action": "country-other", onclick: () => ctx.open("country/pick") }, "Another location");
  const top = heading("tv location", `${name}?`, ctx.reduced());
  if (name.length > 14) top[1].classList.add("long");
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", { class: "setup-top" }, h("div", {}, ...top), ok),
    h("div", { class: "setup-foot country-foot" }, h("span", { class: "setup-note" }, "It sets your clock and what's new"), other),
  );
  return { el, first: ok };
}

export async function pick(ctx: Ctx): Promise<View> {
  const state = known ?? (await load().catch(() => null));
  const picker = countryPicker(state?.countries ?? [], state?.code ?? null, (c) => void choose(ctx, c.code));
  const top = heading("tv location --pick", "Pick your location", ctx.reduced());
  const el = h("div", { class: "setup-page" }, h("div", {}, ...top), picker.el, h("span", { class: "setup-note" }, "Type on your phone, or use the arrows"));
  return { el, first: picker.first };
}
