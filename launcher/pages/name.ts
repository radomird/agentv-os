// The TV's name (daemon/announce.ts): what phones find it under on the home
// network and show for it. A first row in Settings, System, and the page it
// opens to change it. Both are only there while the TV announces itself,
// which is the announce switch.

import { daemon } from "../api.ts";
import { asWritten, h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";
import { pinAsked } from "./pin.ts";

// What every TV is called until somebody names it.
const UNNAMED = "OrigaiTV";

// Kept between visits so Settings draws at once, and asked for again each
// time it opens. Null while the switch is off, when the daemon has no name
// to give: then there's no row and no page.
export let tvName: string | null = null;

export async function loadName(): Promise<void> {
  tvName = await daemon.name().then(
    (found) => found.name,
    () => null,
  );
}

// The daemon said the name changed, from here or from a phone.
export function nameHeard(data: unknown): void {
  const name = (data as { name?: unknown } | null)?.name;
  if (typeof name === "string" && tvName !== null) tvName = name;
}

// The value of System's "Name" row, as it was typed in every look.
export function nameValue(): HTMLElement {
  return asWritten(tvName ?? "");
}

// "Name this TV": one field, which the phone's keyboard types into, and
// Save. An adult's, past the PIN once there is one.
export function namePage(ctx: Ctx): View {
  const field = h("input", {
    class: "music-search",
    "data-focus": true,
    "data-action": "name-field",
    type: "text",
    // A TV nobody has named shows the example, not "OrigaiTV" to rub out.
    value: tvName && tvName !== UNNAMED ? tvName : "",
    placeholder: "Living room",
    "aria-label": "Name",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const save = async () => {
    const grant = await ctx.grant("changing the name");
    if (grant === null) return;
    try {
      tvName = (await daemon.setName(field.value, grant || undefined)).name;
    } catch (error) {
      if (pinAsked(error)) ctx.forgetGrant();
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast("Saved", "ok");
    ctx.back();
  };
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page profile" },
      ...heading("tv settings · name", "Name this TV"),
      h("div", { class: "profile-form" }, field, h("div", { class: "check-actions" }, h("button", { class: "button primary", "data-focus": true, "data-action": "save", onclick: () => void save() }, "Save"))),
    ),
    bar(ctx, "settings"),
  );
  return { el, first: field, act: () => false };
}
