// The provider key on the TV (ADR-009, ADR-022, S4.6): Settings → AI says
// which provider has one, and this page takes a key, typed or pasted, for
// Claude, ChatGPT or Gemini. The daemon hands it to root and it's never
// shown again. An adult's, past the PIN once there is one.

import { daemon, type KeyState } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

const PROVIDERS = ["claude", "chatgpt", "gemini"];

// Kept between visits so Settings draws at once, and asked for again each
// time it opens.
export let keyState: KeyState | null = null;

export function setKeyState(state: KeyState): void {
  keyState = state;
}

export function aiValue(ctx: Ctx): string {
  if (!keyState) return "";
  const guard = ctx.state.pin?.set ? " [pin]" : "";
  return keyState.set ? `${keyState.provider}${guard}` : "no key";
}

export function aiPanel(ctx: Ctx): HTMLElement[] {
  const note = (text: string) => h("p", { class: "panel-note" }, text);
  if (!keyState) return [h("div", { class: "panel-big" }, "…")];
  const remove = async () => {
    const grant = await ctx.grant("the ai key");
    if (grant === null) return;
    try {
      keyState = await daemon.removeKey(grant || undefined);
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast("the key is off", "ok");
    ctx.render("settings/ai", "add-key");
  };
  return keyState.set
    ? [
        h("div", { class: "panel-title" }, "builds and voice use"),
        h("div", { class: "panel-big" }, keyState.provider ?? ""),
        note("a key is set. only the system can read it, and it's never shown again."),
        h("button", { class: "button", "data-focus": true, "data-action": "add-key", onclick: () => ctx.go("key") }, "replace the key →"),
        h("button", { class: "button", "data-focus": true, "data-action": "remove-key", onclick: () => void remove() }, "take the key off"),
      ]
    : [
        h("div", { class: "panel-title" }, "builds and voice use"),
        h("div", { class: "panel-big" }, "no key yet"),
        note("an api key from claude, chatgpt or gemini. using your plan instead comes with tv setup."),
        h("button", { class: "button primary", "data-focus": true, "data-action": "add-key", onclick: () => ctx.go("key") }, "add a key →"),
      ];
}

export function keyPage(ctx: Ctx): View {
  let provider = keyState?.provider && PROVIDERS.includes(keyState.provider) ? keyState.provider : PROVIDERS[0];
  const value = h("span", { class: "button-value" }, "");
  const draw = () => (value.textContent = `‹ ${provider} ›`);
  const step = (by: number) => {
    provider = PROVIDERS[(PROVIDERS.indexOf(provider) + by + PROVIDERS.length) % PROVIDERS.length];
    ctx.sounds.play("move");
    draw();
  };
  const which = h("button", { class: "button", "data-focus": true, "data-action": "provider", "data-adjust": "provider", onclick: () => step(1) }, h("span", {}, "provider"), value);
  const field = h("input", {
    class: "music-search",
    "data-focus": true,
    "data-action": "key",
    type: "password",
    placeholder: "paste the key",
    "aria-label": "the key",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const save = async () => {
    const key = field.value.trim();
    if (!key) {
      ctx.toast("paste the key first", "fail");
      return;
    }
    const grant = await ctx.grant("the ai key");
    if (grant === null) return;
    try {
      keyState = await daemon.saveKey(provider, key, grant || undefined);
    } catch (error) {
      if ((error as Error).message === "that needs the pin") ctx.forgetGrant();
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    field.value = "";
    ctx.sounds.play("confirm");
    ctx.toast(`the key for ${provider} is kept`, "ok");
    ctx.back();
  };
  draw();
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page profile" },
      ...heading("tv settings · ai", "add a key"),
      h(
        "div",
        { class: "profile-form" },
        which,
        field,
        h("div", { class: "check-actions" }, h("button", { class: "button primary", "data-focus": true, "data-action": "save", onclick: () => void save() }, "save")),
      ),
      h("p", { class: "panel-note" }, "only the system can read it, and it's never shown again."),
    ),
    bar(ctx, "settings", "←→ provider · ↵ select · esc back"),
  );
  return {
    el,
    first: which,
    act(action) {
      if ((action === "left" || action === "right") && ctx.focus.get() === which) {
        step(action === "right" ? 1 : -1);
        return true;
      }
      return false;
    },
  };
}
