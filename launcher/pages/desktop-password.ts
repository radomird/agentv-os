// The desktop's first password, with setup's own switch on. A box set up
// from the USB stick's first screen has an account nobody knows the
// password of, so SSH takes keys only and the desktop can't run anything
// that asks for it. The first time you switch to Omarchy's desktop from
// Settings, this asks for one, typed on the phone's keyboard into the two
// fields here, sets it and switches. The phone keeps a password field's
// text to itself, and its password manager can fill it. After that, the
// password changes on the desktop, with Omarchy's own Update › Password ›
// User, which asks for the one before.

import { screen } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";
import { pinAsked } from "./pin.ts";

interface PasswordState {
  managed: boolean;
  name: string | null;
  known: boolean;
}

const MIN = 8;

// What the daemon said last, kept between visits so the panel draws at once.
// Null while setup's own switch is off, or before it answers.
let password: PasswordState | null = null;

async function call(method: string, body?: unknown, grant?: string): Promise<{ password?: PasswordState }> {
  const response = await fetch("/api/desktop/password", {
    method,
    cache: "no-store",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "Couldn't set the password");
  return data;
}

// Whether setup's own switch is on, as the launcher marks it on the page.
function switchOn(): boolean {
  return (document.documentElement.dataset.features ?? "").split(" ").includes("setup2");
}

// Asks again, for Settings to draw. With the switch off it doesn't ask,
// since the daemon has nothing to say.
export async function loadDesktopPassword(): Promise<void> {
  if (!switchOn()) {
    password = null;
    return;
  }
  password = (await call("GET").catch(() => ({}) as { password?: PasswordState })).password ?? null;
}

// Whether switching asks for the first password before it goes.
export function needsPassword(): boolean {
  return password?.managed === true && !password.known;
}

// The desktop page's line, while switching still asks for a first
// password. None once it's known, on a box whose password was typed into
// Omarchy's installer, or with the switch off: the page then says how to
// come back.
export function desktopPasswordNote(): HTMLElement[] {
  if (!password?.managed || password.known) return [];
  return [h("p", { class: "panel-note", "data-note": "desktop-password" }, "The first time, you set a password on your phone")];
}

export function desktopPasswordPage(ctx: Ctx): View {
  const field = (action: string, label: string) =>
    h("input", { class: "music-search", type: "password", "data-focus": true, "data-action": action, "aria-label": label, placeholder: label, autocomplete: "new-password", spellcheck: "false" }) as HTMLInputElement;
  const first = field("password", "Password");
  const again = field("password-again", "Password again");
  const set = h("button", { class: "button primary", "data-focus": true, "data-action": "set-password", onclick: () => void send() }, "Set and switch");
  const line = h("p", { class: "panel-note", "data-line": "desktop-password" }, `For admin tasks there. ${MIN} characters or more.`);
  let sending = false;

  const send = async () => {
    if (sending) return;
    const typed = first.value;
    if ([...typed].length < MIN) {
      ctx.sounds.play("failure");
      ctx.toast(`The password needs ${MIN} characters or more`, "fail");
      return;
    }
    if (typed !== again.value) {
      ctx.sounds.play("failure");
      ctx.toast("Those don't match", "fail");
      again.value = "";
      return;
    }
    const grant = await ctx.grant("Omarchy's desktop");
    if (grant === null) return;
    sending = true;
    try {
      password = (await call("PUT", { password: typed }, grant || undefined)).password ?? password;
      first.value = "";
      again.value = "";
      ctx.sounds.play("confirm");
      ctx.toast("Password set", "ok");
      ctx.back();
      // Then on to the desktop, as the switch was asked for, with the same
      // grant.
      const reply = await screen.desktop(grant);
      if (reply.pin) ctx.forgetGrant();
      if (!reply.ok) ctx.toast(reply.error ?? "Couldn't open the desktop", "fail");
    } catch (error) {
      if (pinAsked(error)) ctx.forgetGrant();
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
    } finally {
      sending = false;
    }
  };
  for (const input of [first, again]) {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (input === first && !again.value) again.focus();
      else void send();
    });
  }

  const el = h(
    "div",
    { class: "screen" },
    h("div", { class: "page profile desktop-password" }, ...heading("tv settings · omarchy desktop", "A password for the desktop"), line, h("div", { class: "profile-form" }, first, again, h("div", { class: "check-actions" }, set))),
    bar(ctx, "settings"),
  );
  return { el, first };
}
