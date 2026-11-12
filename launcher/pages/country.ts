// The TV's location (ADR-055), which setup confirmed: a row in Settings,
// This TV, and the page it opens to pick another. The time zone and new
// this week follow it.

import { daemon, type Country, type CountryState } from "../api.ts";
import { countryPicker } from "../country-picker.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";
import { pinAsked } from "./pin.ts";

// Kept between visits so Settings draws at once, and asked for again each
// time it opens.
export let countryState: (CountryState & { countries: Country[] }) | null = null;

export async function loadCountry(): Promise<void> {
  countryState = await daemon.country().catch(() => countryState);
}

// The value of This TV's "Location" row.
export function countryValue(): string {
  return countryState ? (countryState.name ?? "No location yet") : "";
}

// The picker as a page of its own, from Settings. An adult's, past the PIN
// once there is one.
export function countryPage(ctx: Ctx): View {
  const state = countryState;
  const pick = async (country: Country) => {
    const grant = await ctx.grant("changing location");
    if (grant === null) return;
    try {
      const set = await daemon.setCountry(country.code, grant || undefined);
      countryState = state ? { ...state, ...set } : null;
    } catch (error) {
      if (pinAsked(error)) ctx.forgetGrant();
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast(`Location set to ${country.name}`, "ok");
    ctx.back();
  };
  const picker = countryPicker(state?.countries ?? [], state?.code ?? null, (country) => void pick(country));
  const el = h(
    "div",
    { class: "screen" },
    h("div", { class: "page profile" }, ...heading("tv settings · location", "Pick your location"), picker.el, h("p", { class: "panel-note" }, "It sets your clock and what's new")),
    bar(ctx, "settings"),
  );
  return { el, first: picker.first, act: () => false };
}
