// Profiles on the TV (ADR-009, S4.2, board 06): Settings → Profiles lists who
// watches, each with their avatar, and a profile's own page switches to it,
// renames it, makes it an adult or a kid, picks its colour or takes it off.
// The phone does the same once it's paired. Changing profiles needs the PIN
// once there is one, and a kid's profile needs one to exist.

import { daemon, type Viewer } from "../api.ts";
import { h } from "../dom.ts";
import { glyph } from "../glyphs.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

// The theme's colours an avatar can be, in the daemon's order.
export const AVATARS = ["blue", "green", "magenta", "yellow", "cyan", "orange", "red"];

// The name's first letter on its colour.
export function avatar(viewer: Pick<Viewer, "name" | "avatar">, big = false): HTMLElement {
  return h("span", { class: `avatar avatar-${AVATARS.includes(viewer.avatar) ? viewer.avatar : "blue"}${big ? " big" : ""}`, "aria-hidden": "true" }, viewer.name.slice(0, 1).toLowerCase());
}

export function profilesPanel(ctx: Ctx): HTMLElement[] {
  return [
    h("div", { class: "panel-title" }, "who watches?"),
    ...ctx.state.viewers.map((viewer) =>
      h(
        "button",
        { class: "button profile-row", "data-focus": true, "data-action": `viewer-${viewer.id}`, onclick: () => ctx.go(`profile/${viewer.id}`) },
        h("span", { class: "profile-who" }, avatar(viewer), h("span", {}, viewer.name)),
        h("span", { class: "button-value" }, [viewer.role === "kid" ? "kid" : "", viewer.id === ctx.state.viewer.id ? "watching" : ""].filter(Boolean).join(" · ")),
      ),
    ),
    h("button", { class: "button", "data-focus": true, "data-action": "add-profile", onclick: () => ctx.go("profile/new") }, h("span", { class: "with-icon" }, glyph("plus", 28), h("span", {}, "add a profile"))),
    h("p", { class: "panel-note" }, "a kid's profile needs the parent pin, and sees only the apps ticked for kids in their details."),
  ];
}

export function profile(ctx: Ctx, id: string): View {
  const fresh = id === "new";
  const found = ctx.state.viewers.find((v) => v.id === id);
  if (!fresh && !found) {
    return { el: h("div", { class: "screen" }, h("div", { class: "page" }, h("p", { class: "empty" }, "that profile isn't here any more")), bar(ctx, "settings")) };
  }
  const draft = { name: found?.name ?? "", role: found?.role ?? ("adult" as Viewer["role"]), avatar: found?.avatar ?? AVATARS.find((a) => !ctx.state.viewers.some((v) => v.avatar === a)) ?? "blue" };
  const watching = found?.id === ctx.state.viewer.id;

  const name = h("input", { class: "music-search profile-name", "data-focus": true, "data-action": "name", type: "text", value: draft.name, maxlength: "20", placeholder: "their name", "aria-label": "their name", autocomplete: "off" }) as HTMLInputElement;
  const value = (text: string) => h("span", { class: "button-value" }, text);
  const roleValue = value("");
  const colourValue = value("");
  const preview = h("span", {});
  const draw = () => {
    roleValue.textContent = `‹ ${draft.role} ›`;
    colourValue.textContent = `‹ ${draft.avatar} ›`;
    preview.replaceChildren(avatar({ name: name.value.trim() || "?", avatar: draft.avatar }, true));
  };
  name.addEventListener("input", draw);
  const step = (what: "role" | "avatar", by: number) => {
    if (what === "role") draft.role = draft.role === "adult" ? "kid" : "adult";
    else draft.avatar = AVATARS[(AVATARS.indexOf(draft.avatar) + by + AVATARS.length) % AVATARS.length];
    ctx.sounds.play("move");
    draw();
  };
  const role = h("button", { class: "button", "data-focus": true, "data-action": "role", "data-adjust": "role", onclick: () => step("role", 1) }, h("span", {}, "role"), roleValue);
  const colour = h("button", { class: "button", "data-focus": true, "data-action": "avatar", "data-adjust": "avatar", onclick: () => step("avatar", 1) }, h("span", {}, "colour"), colourValue);

  const failed = (error: unknown) => {
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
  };
  // Changing profiles needs the PIN once there is one.
  const save = async () => {
    const grant = await ctx.grant("changing profiles");
    if (grant === null) return;
    const change = { name: name.value.trim(), role: draft.role, avatar: draft.avatar };
    try {
      if (fresh) await daemon.addViewer(change, grant || undefined);
      else await daemon.editViewer(id, change, grant || undefined);
    } catch (error) {
      if ((error as Error).message === "that needs the pin") ctx.forgetGrant();
      return failed(error);
    }
    ctx.sounds.play("confirm");
    ctx.toast(fresh ? `${change.name} is here now` : `${change.name} is saved`, "ok");
    ctx.back();
  };
  const remove = async () => {
    const grant = await ctx.grant("changing profiles");
    if (grant === null) return;
    try {
      await daemon.removeViewer(id, grant || undefined);
    } catch (error) {
      return failed(error);
    }
    ctx.sounds.play("confirm");
    ctx.toast(`${found!.name} is gone, with what they watched`, "ok");
    ctx.back();
  };
  // Watching as someone else: from a kid's profile to an adult's needs the
  // PIN.
  const watch = async () => {
    const grant = ctx.state.viewer.role === "kid" && found?.role === "adult" ? await ctx.grant(`watching as ${found.name}`) : "";
    if (grant === null) return;
    try {
      await daemon.switchViewer(id, grant || undefined);
    } catch (error) {
      return failed(error);
    }
    ctx.sounds.play("confirm");
  };

  const buttons = [
    !fresh && !watching ? h("button", { class: "button primary", "data-focus": true, "data-action": "watch", onclick: () => void watch() }, `watch as ${found!.name}`) : null,
    h("button", { class: `button${fresh || watching ? " primary" : ""}`, "data-focus": true, "data-action": "save", onclick: () => void save() }, fresh ? "add" : "save"),
    !fresh ? h("button", { class: "button", "data-focus": true, "data-action": "remove", onclick: () => void remove() }, `take ${found!.name} off`) : null,
  ].filter((el): el is HTMLButtonElement => el !== null);
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page profile" },
      h("div", { class: "profile-head" }, preview, h("div", {}, ...heading("tv settings · profiles", fresh ? "a new profile" : found!.name))),
      h("div", { class: "profile-form" }, name, role, colour, h("div", { class: "check-actions" }, ...buttons)),
      h("p", { class: "panel-note" }, watching ? "watching now." : "a kid sees only the apps ticked for kids."),
    ),
    bar(ctx, "settings", "←→ change · ↵ select · esc back"),
  );
  draw();
  return {
    el,
    first: fresh ? name : buttons[0],
    act(action) {
      const current = ctx.focus.get();
      if ((action === "left" || action === "right") && (current === role || current === colour)) {
        step(current === role ? "role" : "avatar", action === "right" ? 1 : -1);
        return true;
      }
      return false;
    },
  };
}
