// New this week in Settings (stage 8, S8.1): a row in Home and apps, and
// its page, with the household's TMDB key, the location, and which of
// TMDB's services each streaming app here is. The key is typed or pasted on
// the TV with the phone's keyboard, handed to root and never shown again, as
// the AI's is. The location is the TV's own, which setup confirmed and
// Settings, System changes (ADR-055). What's new comes from TMDB, and where
// a title is on from JustWatch, through TMDB, which Settings, About credits.

import { daemon, type Country, type NewsState } from "../api.ts";
import { h } from "../dom.ts";
import { loadingMark } from "../loading.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";
import { pinAsked } from "./pin.ts";

// Kept between visits so Settings draws at once, and asked for again each
// time it opens.
export let newsState: NewsState | null = null;
let countries: Country[] = [];

export async function loadNews(): Promise<void> {
  newsState = await daemon.news().catch(() => newsState);
  if (!countries.length) countries = await daemon.country().then((c) => c.countries, () => []);
}

function regionName(code: string | null): string {
  if (!code) return "No location yet";
  return countries.find((c) => c.code === code)?.name ?? code;
}

// The value of Home and apps' "New this week" row.
export function newsValue(): string {
  if (!newsState) return "";
  return newsState.key.set ? "On" : "Not set up";
}

// The row's page. Each streaming app is a row of its own: its name, then
// what it's called on TMDB.
export function newsPanel(ctx: Ctx): HTMLElement[] {
  const note = (text: string) => h("p", { class: "panel-note" }, text);
  if (!newsState) return [h("div", { class: "panel-big" }, loadingMark())];
  const state = newsState;
  const button = (action: string, label: string, onclick: () => void, primary = false) => h("button", { class: `button${primary ? " primary" : ""}`, "data-focus": true, "data-action": action, onclick }, label);
  if (!state.key.set) {
    return [note("It needs a TMDB key from your own account at themoviedb.org"), button("tmdb-key", "Add a TMDB key", () => ctx.go("tmdb-key"), true)];
  }
  const removeKey = async () => {
    const grant = await ctx.grant("the TMDB key");
    if (grant === null) return;
    try {
      newsState = await daemon.removeTmdbKey(grant || undefined);
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast("TMDB key removed", "ok");
    ctx.render("settings/tmdb", "tmdb-key");
  };
  const line = state.error ? "Couldn't reach TMDB" : state.services && !state.services.length ? "Add a streaming app first" : null;
  return [
    h("button", { class: "button", "data-focus": true, "data-action": "country", onclick: () => ctx.go("country") }, h("span", {}, "Change location"), h("span", { class: "button-value" }, regionName(state.region))),
    ...(state.services ?? []).map((service) =>
      h("div", { class: "panel-row", "data-row": "service" }, h("span", {}, service.name), h("span", { class: "button-value" }, service.providers.map((p) => p.name).join(", ") || "Not on TMDB")),
    ),
    ...(line ? [note(line)] : []),
    button("tmdb-key", "Replace key", () => ctx.go("tmdb-key")),
    button("remove-tmdb-key", "Remove key", () => void removeKey()),
  ];
}

// The key page: a field the phone's keyboard types or pastes into, then
// root keeps it. An adult's, past the PIN once there is one.
export function tmdbKeyPage(ctx: Ctx): View {
  const field = h("input", {
    class: "music-search",
    "data-focus": true,
    "data-action": "tmdb-key-field",
    type: "password",
    placeholder: "Paste the key",
    "aria-label": "The TMDB key",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const save = async () => {
    const key = field.value.trim();
    if (!key) {
      ctx.toast("Paste the key first", "fail");
      return;
    }
    const grant = await ctx.grant("the TMDB key");
    if (grant === null) return;
    try {
      newsState = await daemon.saveTmdbKey(key, grant || undefined);
    } catch (error) {
      if (pinAsked(error)) ctx.forgetGrant();
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    field.value = "";
    ctx.sounds.play("confirm");
    ctx.toast("TMDB key saved", "ok");
    ctx.back();
  };
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page profile" },
      ...heading("tv settings · new this week", "Add a TMDB key"),
      h(
        "div",
        { class: "profile-form" },
        field,
        h("div", { class: "check-actions" }, h("button", { class: "button primary", "data-focus": true, "data-action": "save", onclick: () => void save() }, "Save")),
      ),
      h("p", { class: "panel-note" }, "The API key or read access token from themoviedb.org"),
    ),
    bar(ctx, "settings"),
  );
  return { el, first: field, act: () => false };
}
