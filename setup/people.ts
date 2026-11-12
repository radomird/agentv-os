// Who watches (board 06, ADR-009, ADR-034, ADR-035): the household's
// profiles, each a colour behind the name's first letter, adult or child.
// Adding a child's profile needs the adult PIN, which is chosen here on its
// pad, and the phone's remote shows the pad too (board 07, ADR-037). An
// adult's profile can ask for the PIN to open, and shows a lock when it
// does. Names are typed on the TV, or on the phone's keyboard.
//
// With setup's own switch on, it's one headline and the row: no PIN switch,
// since adding a child asks for the PIN then, and done sits at the end of
// the row instead of a continue under it.

import { daemon, type Viewer } from "../launcher/api.ts";
import { h } from "../launcher/dom.ts";
import { glyph } from "../launcher/glyphs.ts";
import { AVATARS } from "../launcher/pages/profiles.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

interface Household {
  viewers: Viewer[];
  active: string;
}

async function household(): Promise<Household> {
  const reply = await (await fetch("/api/viewers", { cache: "no-store" })).json();
  return { viewers: reply.viewers ?? [], active: reply.active ?? "" };
}

const failed = (ctx: Ctx, error: unknown) => {
  ctx.sounds.play("failure");
  ctx.toast((error as Error).message, "fail");
};

// Chooses the adult PIN on its pad, twice, and keeps the grant it gives for
// the rest of setup. True once it's set.
export async function choosePin(ctx: Ctx, why: string): Promise<boolean> {
  let first = "";
  const chosen = await ctx.pad({
    command: "tv setup · pin",
    title: "Set an adult PIN",
    note: why,
    submit: async (pin) => {
      first = pin;
      return null;
    },
  });
  if (!chosen) return false;
  return ctx.pad({
    command: "tv setup · pin",
    title: "Enter it again",
    note: "So a typo doesn't lock you out",
    submit: async (pin) => {
      if (pin !== first) return "Those don't match";
      await daemon.setPin(pin);
      const reply = await daemon.checkPin(pin);
      ctx.hold(reply.grant, reply.until);
      ctx.info.pin = true;
      return null;
    },
  });
}

// One profile's tile: its colour and first letter, a child tag or a lock,
// and its name under it.
function tile(viewer: Viewer, go: () => void): HTMLElement {
  return h(
    "button",
    { class: "person", "data-focus": true, "data-viewer": viewer.id, onclick: go },
    h(
      "span",
      { class: `person-face avatar-${AVATARS.includes(viewer.avatar) ? viewer.avatar : "blue"}` },
      viewer.name.slice(0, 1).toUpperCase(),
      viewer.role === "child" ? h("span", { class: "person-tag" }, "Child") : null,
      viewer.locked ? h("span", { class: "person-lock" }, glyph("lock", 32)) : null,
    ),
    h("span", { class: "person-name" }, viewer.name),
  );
}

// Who watches as D3 draws it, with setup's own switch on.
export const people2 = (ctx: Ctx): Promise<View> => people(ctx, true);

export async function people(ctx: Ctx, phase2 = false): Promise<View> {
  const home = await household().catch(() => ({ viewers: [], active: "" }) as Household);
  const row = h("div", { class: "people" });
  const pinValue = h("span", { class: "pin-state" });
  const pinButton = h("button", { class: "pin-switch", "data-focus": true, "data-action": "pin", onclick: () => void togglePin() }, pinValue);
  const go = phase2
    ? h("button", { class: "person done", "data-focus": true, "data-action": "done", onclick: () => void ctx.finish("people") }, h("span", { class: "person-face" }, glyph("check", 96)), h("span", { class: "person-name" }, "Done"))
    : h("button", { class: "button primary", "data-focus": true, "data-action": "continue", onclick: () => void ctx.finish("people") }, "Continue");

  const draw = (now: Household) => {
    // The tile with the focus stays focused when the row is drawn again.
    const had = ctx.focus.get();
    const which = had && row.contains(had) ? (had.dataset.viewer ?? had.dataset.action) : null;
    row.replaceChildren(
      ...now.viewers.map((viewer) => tile(viewer, () => ctx.open(`people/${viewer.id}`))),
      h("button", { class: "person add", "data-focus": true, "data-action": "add", onclick: () => ctx.open("people/new") }, h("span", { class: "person-face" }, "+"), h("span", { class: "person-name" }, "Add")),
      phase2 ? go : "",
    );
    pinValue.textContent = ctx.info.pin ? "■ On" : "□ Off";
    pinButton.classList.toggle("on", ctx.info.pin);
    const again = which ? row.querySelector<HTMLElement>(`[data-viewer="${CSS.escape(which)}"], [data-action="${CSS.escape(which)}"]`) : null;
    if (again) ctx.focus.set(again, false);
    else if (which) ctx.focus.set(row.querySelector<HTMLElement>(".person") ?? go, false);
  };

  const togglePin = async () => {
    if (!ctx.info.pin) {
      if (await choosePin(ctx, "4 digits, for settings, new apps and the desktop")) {
        ctx.toast("PIN set", "ok");
        draw(await household());
      }
      return;
    }
    try {
      if (!(await ctx.guarded("removing the PIN", (grant) => daemon.removePin(grant)))) return;
    } catch (error) {
      return failed(ctx, error);
    }
    ctx.info.pin = false;
    ctx.sounds.play("confirm");
    ctx.toast("PIN removed", "ok");
    draw(await household());
  };

  draw(home);
  const el = phase2
    ? h("div", { class: "setup-page d3 people2" }, ...heading("agentv people", "Who's watching?", ctx.reduced()), row)
    : h(
        "div",
        { class: "setup-page" },
        h("div", {}, ...heading("tv setup · who's watching", "Who's watching?", ctx.reduced())),
        row,
        h("div", { class: "setup-foot" }, h("span", { class: "pin-line" }, h("span", {}, "Adult PIN"), pinButton, h("span", { class: "setup-note" }, "Needed for children")), go),
      );
  return {
    el,
    // With setup's own switch on, done has the focus: the household as it
    // is, and on.
    first: phase2 ? go : (row.querySelector<HTMLElement>(".person") ?? go),
    heard(event) {
      if (event === "viewers" || event === "pin") void household().then(draw, () => {});
    },
  };
}

// A profile's own page: its name, adult or child, its colour and, for an
// adult, whether it asks for the PIN to open. Or a new one.
export async function person(ctx: Ctx, id: string): Promise<View> {
  const home = await household().catch(() => ({ viewers: [], active: "" }) as Household);
  const fresh = id === "new";
  const found = home.viewers.find((v) => v.id === id);
  const draft = {
    role: found?.role ?? ("adult" as Viewer["role"]),
    avatar: found?.avatar ?? AVATARS.find((a) => !home.viewers.some((v) => v.avatar === a)) ?? "blue",
    locked: found?.locked ?? false,
  };
  const name = h("input", { class: "text-field person-field", "data-focus": true, "data-action": "name", type: "text", value: found?.name ?? "", maxlength: "20", placeholder: "Their name", "aria-label": "Their name", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const face = h("span", { class: "person-face" });
  const value = () => h("span", { class: "button-value" });
  const roleValue = value();
  const colourValue = value();
  const lockValue = value();
  const role = h("button", { class: "button", "data-focus": true, "data-action": "role", onclick: () => step("role", 1) }, h("span", {}, "Role"), roleValue);
  const colour = h("button", { class: "button", "data-focus": true, "data-action": "avatar", onclick: () => step("avatar", 1) }, h("span", {}, "Colour"), colourValue);
  const lock = h("button", { class: "button", "data-focus": true, "data-action": "lock", onclick: () => step("lock", 1) }, h("span", { class: "with-icon" }, glyph("lock", 24), h("span", {}, "Lock with PIN")), lockValue);

  const draw = () => {
    roleValue.textContent = draft.role === "child" ? "Child" : "Adult";
    colourValue.textContent = draft.avatar.slice(0, 1).toUpperCase() + draft.avatar.slice(1);
    lockValue.textContent = draft.locked ? "Yes" : "No";
    lock.classList.toggle("hidden", draft.role === "child");
    face.className = `person-face avatar-${draft.avatar}`;
    face.textContent = (name.value.trim() || "?").slice(0, 1).toUpperCase();
  };
  name.addEventListener("input", draw);
  // Enter in the name goes on to the role, and goes no further: the page's
  // own Enter would press it.
  name.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      ctx.focus.set(role);
    }
  });
  const step = (what: "role" | "avatar" | "lock", by: number) => {
    if (what === "role") {
      draft.role = draft.role === "adult" ? "child" : "adult";
      if (draft.role === "child") draft.locked = false;
    } else if (what === "lock") draft.locked = !draft.locked;
    else draft.avatar = AVATARS[(AVATARS.indexOf(draft.avatar) + by + AVATARS.length) % AVATARS.length];
    ctx.sounds.play("move");
    draw();
  };

  const save = async () => {
    const change = { name: name.value.trim(), role: draft.role, avatar: draft.avatar, locked: draft.role === "adult" && draft.locked };
    if (!change.name) {
      ctx.toast("A name first", "fail");
      ctx.sounds.play("failure");
      ctx.focus.set(name);
      return;
    }
    // A child's profile, or a locked one, needs the adult PIN to exist.
    if ((change.role === "child" || change.locked) && !ctx.info.pin) {
      const why = change.role === "child" ? "A child's profile needs one. 4 digits." : "A locked profile needs one. 4 digits.";
      if (!(await choosePin(ctx, why))) return;
    }
    try {
      if (!(await ctx.guarded("changing profiles", (grant) => (fresh ? daemon.addViewer(change, grant) : daemon.editViewer(id, change, grant))))) return;
    } catch (error) {
      return failed(ctx, error);
    }
    ctx.sounds.play("confirm");
    ctx.toast(fresh ? `Added ${change.name}` : "Saved", "ok");
    ctx.back();
  };
  const remove = async () => {
    try {
      if (!(await ctx.guarded("changing profiles", (grant) => daemon.removeViewer(id, grant)))) return;
    } catch (error) {
      return failed(ctx, error);
    }
    ctx.sounds.play("confirm");
    ctx.back();
  };

  const add = h("button", { class: "button primary", "data-focus": true, "data-action": "save", onclick: () => void save() }, fresh ? "Add" : "Save");
  const off = !fresh && found && home.viewers.length > 1 ? h("button", { class: "button", "data-focus": true, "data-action": "remove", onclick: () => void remove() }, `Remove ${found.name}`) : null;
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", { class: "person-head" }, face, h("div", {}, ...heading("tv setup · who's watching", fresh ? "New profile" : (found?.name ?? ""), ctx.reduced()))),
    h("div", { class: "person-form" }, name, role, colour, lock, h("div", { class: "person-actions" }, add, off)),
  );
  draw();
  return {
    el,
    first: fresh ? name : add,
    act(action) {
      const current = ctx.focus.get();
      if ((action === "left" || action === "right") && (current === role || current === colour || current === lock)) {
        step(current === role ? "role" : current === lock ? "lock" : "avatar", action === "right" ? 1 : -1);
        return true;
      }
      return false;
    },
  };
}
