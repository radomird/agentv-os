// An app's own setup, from its tile ("Setup flow", ADR-011): the fields its
// package asks for, such as the address of a Jellyfin or Immich server,
// typed here or on the phone's keyboard, then its sign-in (ADR-032). It's an
// adult's, past the PIN once there is one. Which profile is for children
// comes after, from the app's details.

import { daemon, screen, type AppSetup } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

export function appSetup(ctx: Ctx, id: string): View {
  const name = (ctx.state.apps.find((app) => app.id === id)?.name ?? id).toLowerCase();
  const form = h("div", { class: "profile-form" });
  const note = h("p", { class: "panel-note" }, "…");
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "save", onclick: () => void save() }, "save") as HTMLButtonElement;
  let setup: AppSetup | null = null;
  let fields: { key: string; label: string; el: HTMLInputElement }[] = [];
  let saving = false;

  const draw = (found: AppSetup) => {
    setup = found;
    fields = found.fields.map((field) => ({
      key: field.key,
      label: field.label.toLowerCase(),
      el: h("input", {
        class: "music-search",
        "data-focus": true,
        "data-field": field.key,
        type: field.address ? "url" : "text",
        placeholder: field.label.toLowerCase(),
        "aria-label": field.label.toLowerCase(),
        autocomplete: "off",
        spellcheck: "false",
        value: field.value,
      }) as HTMLInputElement,
    }));
    go.textContent = found.signIn ? "save, then sign in" : "save";
    form.replaceChildren(...fields.flatMap((field) => [h("div", { class: "panel-title" }, field.label), field.el]), h("div", { class: "check-actions" }, go));
    note.textContent = found.fields.some((field) => field.address)
      ? "the address your server shows, like http://192.168.1.20:8096. the phone's keyboard works here too."
      : "the phone's keyboard works here too.";
    const empty = fields.find((field) => !field.el.value) ?? fields[0];
    if (empty) ctx.focus.set(empty.el, false);
  };

  const save = async () => {
    if (!setup || saving) return;
    const missing = fields.find((field) => !field.el.value.trim());
    if (missing) {
      ctx.sounds.play("failure");
      ctx.toast(`type the ${missing.label} first`, "fail");
      ctx.focus.set(missing.el, false);
      return;
    }
    const grant = await ctx.grant(`setting up ${name}`);
    if (grant === null) return;
    saving = true;
    try {
      setup = await daemon.saveAppSetup(id, Object.fromEntries(fields.map((field) => [field.key, field.el.value.trim()])), grant || undefined);
    } catch (error) {
      if ((error as Error).message === "that needs the pin") ctx.forgetGrant();
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    } finally {
      saving = false;
    }
    ctx.sounds.play("confirm");
    ctx.back();
    if (!setup.signIn) {
      ctx.toast(`${name} is set up`, "ok");
      return;
    }
    // Its sign-in next: AgenTV's sign-in screen, over the service's own page.
    const reply = await screen.signIn(id);
    if (!reply.ok) ctx.toast(reply.error ?? `${name} can't sign in from here`, "fail");
  };

  void daemon.appSetup(id).then(draw, (error: Error) => {
    note.textContent = error.message;
  });

  const el = h(
    "div",
    { class: "screen" },
    h("div", { class: "page profile" }, ...heading(`tv apps · ${name}`, `set up ${name}`), form, note),
    bar(ctx, "apps", "↑↓ move · ↵ save · esc back"),
  );
  return {
    el,
    act(action) {
      // Enter in a field moves on to the next one, and saves after the last.
      // Enter on the button clicks it, as everywhere.
      const at = fields.findIndex((field) => field.el === ctx.focus.get());
      if (action !== "ok" || at < 0) return false;
      if (at < fields.length - 1) ctx.focus.set(fields[at + 1].el, false);
      else void save();
      return true;
    },
  };
}
