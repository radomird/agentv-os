// Settings → Omarchy desktop's password, with setup's own switch on. A box
// set up from the USB stick's first screen has an account nobody knows the
// password of, so SSH takes keys only and the desktop can't run anything
// that asks for it. This sets one, typed on the phone's keyboard into the
// two fields here. The phone keeps a password field's text to itself, and
// its password manager can fill it.

import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

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
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "that didn't work");
  return data;
}

// Asks again, for Settings to draw. Nothing with the switch off.
export async function loadDesktopPassword(): Promise<void> {
  password = (await call("GET").catch(() => ({}) as { password?: PasswordState })).password ?? null;
}

// The desktop panel's rows for it: none on a box whose password was typed
// into Omarchy's installer, or with the switch off.
export function desktopPasswordRows(ctx: Ctx): HTMLElement[] {
  if (!password?.managed) return [];
  return [
    h(
      "p",
      { class: "panel-note", "data-note": "desktop-password" },
      password.known ? "its password is set. you can change it here." : "it has no password you know yet, so ssh takes keys only, and sudo can't run there.",
    ),
    h(
      "button",
      { class: "button", "data-focus": true, "data-action": "desktop-password", onclick: () => ctx.go("desktop-password") },
      password.known ? "change its password →" : "set its password →",
    ),
  ];
}

export function desktopPasswordPage(ctx: Ctx): View {
  const field = (action: string, label: string) =>
    h("input", { class: "music-search", type: "password", "data-focus": true, "data-action": action, "aria-label": label, placeholder: label, autocomplete: "new-password", spellcheck: "false" }) as HTMLInputElement;
  const first = field("password", "a password");
  const again = field("password-again", "the same again");
  const set = h("button", { class: "button primary", "data-focus": true, "data-action": "set-password", onclick: () => void send() }, "set it");
  const line = h("p", { class: "panel-note", "data-line": "desktop-password" }, `type it on your phone, ${MIN} characters or more. you'll need it for sudo and for ssh.`);
  let sending = false;

  const send = async () => {
    if (sending) return;
    const typed = first.value;
    if ([...typed].length < MIN) {
      ctx.sounds.play("failure");
      ctx.toast(`the password needs ${MIN} characters or more`, "fail");
      return;
    }
    if (typed !== again.value) {
      ctx.sounds.play("failure");
      ctx.toast("the two don't match", "fail");
      again.value = "";
      return;
    }
    const grant = await ctx.grant("omarchy's desktop");
    if (grant === null) return;
    sending = true;
    try {
      password = (await call("PUT", { password: typed }, grant || undefined)).password ?? password;
      first.value = "";
      again.value = "";
      ctx.sounds.play("confirm");
      ctx.toast("the desktop's password is set", "ok");
      ctx.back();
    } catch (error) {
      if ((error as Error).message === "that needs the pin") ctx.forgetGrant();
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
    h("div", { class: "page profile desktop-password" }, ...heading("tv settings · omarchy desktop", password?.known ? "a new password" : "a password for the desktop"), line, h("div", { class: "profile-form" }, first, again, h("div", { class: "check-actions" }, set))),
    bar(ctx, "settings", ""),
  );
  return { el, first };
}
