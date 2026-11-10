// Settings → country (ADR-055): the box's country, which setup confirmed,
// and a page to pick another. The time zone and new this week follow it.

import { daemon, type Country, type CountryState } from "../api.ts";
import { countryPicker } from "../country-picker.ts";
import { h } from "../dom.ts";
import { loadingMark } from "../loading.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

// Kept between visits so Settings draws at once, and asked for again each
// time it opens.
export let countryState: (CountryState & { countries: Country[] }) | null = null;

export async function loadCountry(): Promise<void> {
  countryState = await daemon.country().catch(() => countryState);
}

export function countryValue(): string {
  return countryState?.name?.toLowerCase() ?? "";
}

// The zone's city, as Clock writes it: "Europe/Oslo" is oslo.
export function zoneCity(zone: string): string {
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ").toLowerCase();
}

export function countryPanel(ctx: Ctx): HTMLElement[] {
  const state = countryState;
  if (!state) return [h("div", { class: "panel-big" }, loadingMark())];
  return [
    h("div", { class: "panel-title" }, "this tv is in"),
    h("div", { class: "panel-big" }, state.name?.toLowerCase() ?? "no country yet"),
    h("button", { class: "button primary", "data-focus": true, "data-action": "country", onclick: () => ctx.go("country") }, "another country →"),
    h("p", { class: "panel-note" }, `the time is ${zoneCity(state.zone)}'s, and new this week comes from here. another country moves both.`),
  ];
}

// The picker as a page of its own, from Settings. An adult's, past the PIN
// once there is one.
export function countryPage(ctx: Ctx): View {
  const state = countryState;
  const pick = async (country: Country) => {
    const grant = await ctx.grant("the country");
    if (grant === null) return;
    try {
      const set = await daemon.setCountry(country.code, grant || undefined);
      countryState = state ? { ...state, ...set } : null;
    } catch (error) {
      if ((error as Error).message === "that needs the pin") ctx.forgetGrant();
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast(`this tv is in ${country.name.toLowerCase()} now`, "ok");
    ctx.back();
  };
  const picker = countryPicker(state?.countries ?? [], state?.code ?? null, (country) => void pick(country));
  const el = h(
    "div",
    { class: "screen" },
    h("div", { class: "page profile" }, ...heading("tv settings · country", "where's this tv?"), picker.el, h("p", { class: "panel-note" }, "the time and new this week follow the country.")),
    bar(ctx, "settings", "↑↓ move · ↵ pick · esc back"),
  );
  return { el, first: picker.first, act: () => false };
}
