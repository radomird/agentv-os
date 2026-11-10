// Settings → new this week (stage 8, S8.1): the household's TMDB key, the
// region, and which of TMDB's services each streaming app here is. The key
// is typed or pasted on the TV with the phone's keyboard, handed to root
// and never shown again, as the provider's is. The region is the box's
// country, which setup confirmed and Settings → country changes (ADR-055).
// What's new comes from TMDB, and where a title is on from JustWatch,
// through TMDB, which the panel and Settings → About credit.

import { daemon, type Country, type NewsState } from "../api.ts";
import { h } from "../dom.ts";
import { loadingMark } from "../loading.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

// Kept between visits so Settings draws at once, and asked for again each
// time it opens.
export let newsState: NewsState | null = null;
let countries: Country[] = [];

export async function loadNews(): Promise<void> {
  newsState = await daemon.news().catch(() => newsState);
  if (!countries.length) countries = await daemon.country().then((c) => c.countries, () => []);
}

function regionName(code: string | null): string {
  if (!code) return "no country yet";
  return (countries.find((c) => c.code === code)?.name ?? code).toLowerCase();
}

export function newsValue(): string {
  if (!newsState) return "";
  return newsState.key.set ? regionName(newsState.region) : "no key";
}

// What each streaming app is on TMDB: "kino: kino, kino kids".
function serviceLine(service: NewsState["services"] extends (infer S)[] | undefined ? S : never): string {
  const names = service.providers.map((p) => p.name.toLowerCase());
  return `${service.name.toLowerCase()}: ${names.length ? names.join(", ") : "nothing on tmdb by that name"}`;
}

export function newsPanel(ctx: Ctx): HTMLElement[] {
  const note = (text: string) => h("p", { class: "panel-note" }, text);
  if (!newsState) return [h("div", { class: "panel-big" }, loadingMark())];
  const state = newsState;
  const button = (action: string, label: string, onclick: () => void, primary = false) => h("button", { class: `button${primary ? " primary" : ""}`, "data-focus": true, "data-action": action, onclick }, label);
  const credit = note("what's new comes from tmdb, and where to watch from justwatch.");
  if (!state.key.set) {
    return [
      h("div", { class: "panel-title" }, "what came out this week"),
      h("div", { class: "panel-big" }, "no key yet"),
      note("new this week asks tmdb, with a key from your own tmdb account: themoviedb.org → settings → api, on your phone."),
      button("tmdb-key", "add a tmdb key →", () => ctx.go("tmdb-key"), true),
      credit,
    ];
  }
  const removeKey = async () => {
    const grant = await ctx.grant("the tmdb key");
    if (grant === null) return;
    try {
      newsState = await daemon.removeTmdbKey(grant || undefined);
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast("the tmdb key is off", "ok");
    ctx.render("settings/tmdb", "tmdb-key");
  };
  return [
    h("div", { class: "panel-title" }, "what came out this week in"),
    h("div", { class: "panel-big" }, regionName(state.region)),
    button("country", "another country →", () => ctx.go("country")),
    ...(state.services ?? []).map((service) => note(serviceLine(service))),
    ...(state.services && !state.services.length ? [note("there's no streaming app on this tv yet.")] : []),
    ...(state.error ? [note(`tmdb didn't answer: ${state.error}`)] : []),
    button("tmdb-key", "replace the key →", () => ctx.go("tmdb-key")),
    button("remove-tmdb-key", "take the key off", () => void removeKey()),
    note("the country is the tv's own, so the time follows it too. the key is only the system's, and it's never shown again."),
    credit,
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
    placeholder: "paste the key",
    "aria-label": "the tmdb key",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const save = async () => {
    const key = field.value.trim();
    if (!key) {
      ctx.toast("paste the key first", "fail");
      return;
    }
    const grant = await ctx.grant("the tmdb key");
    if (grant === null) return;
    try {
      newsState = await daemon.saveTmdbKey(key, grant || undefined);
    } catch (error) {
      if ((error as Error).message === "that needs the pin") ctx.forgetGrant();
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    field.value = "";
    ctx.sounds.play("confirm");
    ctx.toast("the tmdb key is kept", "ok");
    ctx.back();
  };
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page profile" },
      ...heading("tv settings · new this week", "add a tmdb key"),
      h(
        "div",
        { class: "profile-form" },
        field,
        h("div", { class: "check-actions" }, h("button", { class: "button primary", "data-focus": true, "data-action": "save", onclick: () => void save() }, "save")),
      ),
      h("p", { class: "panel-note" }, "the api key or the read access token, from themoviedb.org → settings → api. only the system can read it, and it's never shown again."),
    ),
    bar(ctx, "settings", "↵ select · esc back"),
  );
  return { el, first: field, act: () => false };
}
