// Profiles on the TV (ADR-009, S4.2, board 06): Settings, Profiles has a row
// for each person, with their avatar, and a profile's own page switches to it,
// renames it, makes it an adult or a child, picks its colour, locks it or
// removes it. The phone does the same once it's paired. Changing profiles needs
// the PIN once there is one, and a child's profile needs one to exist. A
// locked profile (ADR-034) asks for the PIN to open after the box starts,
// after the TV has been off and when someone switches to it, and shows a
// lock beside its name.

import { daemon, type Viewer } from "../api.ts";
import { h } from "../dom.ts";
import { glyph } from "../glyphs.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";
import { pinAsked } from "./pin.ts";
import { loadShared, sharesAllowed } from "./shared.ts";

// The theme's colours an avatar can be, in the daemon's order.
export const AVATARS = ["blue", "green", "magenta", "yellow", "cyan", "orange", "red"];

// The name's first letter on its colour.
export function avatar(viewer: Pick<Viewer, "name" | "avatar">, big = false): HTMLElement {
  return h("span", { class: `avatar avatar-${AVATARS.includes(viewer.avatar) ? viewer.avatar : "blue"}${big ? " big" : ""}`, "aria-hidden": "true" }, viewer.name.slice(0, 1).toUpperCase());
}

// Settings' rows: one a person, with Adult or Child, and adding another.
export function profileRows(ctx: Ctx): HTMLElement[] {
  return [
    ...ctx.state.viewers.map((viewer) =>
      h(
        "button",
        { class: "button profile-row", "data-focus": true, "data-action": `viewer-${viewer.id}`, onclick: () => ctx.go(`profile/${viewer.id}`) },
        h("span", { class: "profile-who" }, avatar(viewer), h("span", {}, viewer.name), viewer.locked ? glyph("lock", 24) : null),
        h("span", { class: "button-value" }, [viewer.role === "child" ? "Child" : "Adult", viewer.id === ctx.state.viewer.id ? "Watching" : ""].filter(Boolean).join(" · ")),
      ),
    ),
    h("button", { class: "button", "data-focus": true, "data-action": "add-profile", onclick: () => ctx.go("profile/new") }, h("span", { class: "with-icon" }, glyph("plus", 28), h("span", {}, "Add a profile"))),
  ];
}

export function profile(ctx: Ctx, id: string): View {
  const fresh = id === "new";
  const found = ctx.state.viewers.find((v) => v.id === id);
  if (!fresh && !found) {
    return { el: h("div", { class: "screen" }, h("div", { class: "page" }, h("p", { class: "empty" }, "That profile was removed")), bar(ctx, "settings")) };
  }
  const draft = {
    name: found?.name ?? "",
    role: found?.role ?? ("adult" as Viewer["role"]),
    avatar: found?.avatar ?? AVATARS.find((a) => !ctx.state.viewers.some((v) => v.avatar === a)) ?? "blue",
    locked: found?.locked ?? false,
    // A child's profile takes what phones share only once an adult allows it (ADR-050).
    shares: found ? sharesAllowed().includes(found.id) : false,
  };
  const watching = found?.id === ctx.state.viewer.id;

  const name = h("input", { class: "music-search profile-name", "data-focus": true, "data-action": "name", type: "text", value: draft.name, maxlength: "20", placeholder: "Name", "aria-label": "Name", autocomplete: "off" }) as HTMLInputElement;
  const value = (text: string) => h("span", { class: "button-value" }, text);
  const roleValue = value("");
  const colourValue = value("");
  const lockValue = value("");
  const sharesValue = value("");
  const preview = h("span", {});
  // Only an adult's profile locks; a child's is guarded already. With no
  // PIN there's nothing to ask for, so the row isn't there (ADR-087).
  const pinSet = ctx.state.pin?.set === true;
  const lock = h(
    "button",
    { class: "button", "data-focus": true, "data-action": "lock", "data-adjust": "lock", onclick: () => step("lock", 1) },
    h("span", { class: "with-icon" }, glyph("lock", 24), h("span", {}, "Lock with PIN")),
    lockValue,
  ) as HTMLButtonElement;
  // Only a child's profile is asked; an adult's always takes them.
  const shares = h(
    "button",
    { class: "button", "data-focus": true, "data-action": "shares", "data-adjust": "shares", onclick: () => step("shares", 1) },
    h("span", { class: "with-icon" }, glyph("phone", 24), h("span", {}, "Accept what phones send")),
    sharesValue,
  ) as HTMLButtonElement;
  const draw = () => {
    roleValue.textContent = draft.role === "child" ? "Child" : "Adult";
    colourValue.textContent = draft.avatar.charAt(0).toUpperCase() + draft.avatar.slice(1);
    lockValue.textContent = draft.locked ? "On" : "Off";
    sharesValue.textContent = draft.shares ? "On" : "Off";
    lock.style.display = draft.role === "child" || !pinSet ? "none" : "";
    shares.style.display = draft.role === "child" ? "" : "none";
    preview.replaceChildren(avatar({ name: name.value.trim() || "?", avatar: draft.avatar }, true));
  };
  name.addEventListener("input", draw);
  const step = (what: "role" | "avatar" | "lock" | "shares", by: number) => {
    if (what === "role") {
      draft.role = draft.role === "adult" ? "child" : "adult";
      if (draft.role === "child") draft.locked = false;
    } else if (what === "lock") draft.locked = !draft.locked;
    else if (what === "shares") draft.shares = !draft.shares;
    else draft.avatar = AVATARS[(AVATARS.indexOf(draft.avatar) + by + AVATARS.length) % AVATARS.length];
    ctx.sounds.play("move");
    draw();
  };
  const role = h("button", { class: "button", "data-focus": true, "data-action": "role", "data-adjust": "role", onclick: () => step("role", 1) }, h("span", {}, "Role"), roleValue);
  const colour = h("button", { class: "button", "data-focus": true, "data-action": "avatar", "data-adjust": "avatar", onclick: () => step("avatar", 1) }, h("span", {}, "Colour"), colourValue);

  const failed = (error: unknown) => {
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
  };
  // Changing profiles needs the PIN once there is one.
  const save = async () => {
    const grant = await ctx.grant("changing profiles");
    if (grant === null) return;
    const change = { name: name.value.trim(), role: draft.role, avatar: draft.avatar, locked: draft.role === "adult" && pinSet && draft.locked, shares: draft.role === "child" && draft.shares };
    try {
      if (fresh) await daemon.addViewer(change, grant || undefined);
      else await daemon.editViewer(id, change, grant || undefined);
    } catch (error) {
      if (pinAsked(error)) ctx.forgetGrant();
      return failed(error);
    }
    await loadShared();
    ctx.sounds.play("confirm");
    ctx.toast(fresh ? `Added ${change.name}` : "Saved", "ok");
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
    ctx.toast(`Removed ${found!.name}`, "ok");
    ctx.back();
  };
  // Watching as someone else: from a child's profile to an adult's, or to a
  // locked profile, needs the PIN.
  const watch = async () => {
    const grant = found?.locked || (ctx.state.viewer.role === "child" && found?.role === "adult") ? await ctx.grant(`watching as ${found!.name}`) : "";
    if (grant === null) return;
    try {
      await daemon.switchViewer(id, grant || undefined);
    } catch (error) {
      return failed(error);
    }
    ctx.sounds.play("confirm");
  };

  const buttons = [
    !fresh && !watching ? h("button", { class: "button primary", "data-focus": true, "data-action": "watch", onclick: () => void watch() }, `Watch as ${found!.name}`) : null,
    h("button", { class: `button${fresh || watching ? " primary" : ""}`, "data-focus": true, "data-action": "save", onclick: () => void save() }, fresh ? "Add" : "Save"),
    !fresh ? h("button", { class: "button", "data-focus": true, "data-action": "remove", onclick: () => void remove() }, `Remove ${found!.name}`) : null,
  ].filter((el): el is HTMLButtonElement => el !== null);
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page profile" },
      h("div", { class: "profile-head" }, preview, h("div", {}, ...heading("tv settings · profiles", fresh ? "A new profile" : found!.name))),
      h("div", { class: "profile-form" }, name, role, colour, lock, shares, h("div", { class: "check-actions" }, ...buttons)),
      h("p", { class: "panel-note" }, watching ? "Watching now" : "A child only sees apps marked For children"),
    ),
    bar(ctx, "settings"),
  );
  draw();
  return {
    el,
    first: fresh ? name : buttons[0],
    act(action) {
      const current = ctx.focus.get();
      if ((action === "left" || action === "right") && (current === role || current === colour || current === lock || current === shares)) {
        step(current === role ? "role" : current === lock ? "lock" : current === shares ? "shares" : "avatar", action === "right" ? 1 : -1);
        return true;
      }
      return false;
    },
  };
}
