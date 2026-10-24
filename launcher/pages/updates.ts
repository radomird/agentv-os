// Updates on the TV (ADR-025, boards 29 to 32): Settings → Updates, What's
// new, the notice on home and the Updating screen. The daemon passes on what
// the daily check found and how an install is going; installing runs as root
// in agentv-update-tv.service, which the screen daemon starts.

import { screen, type UpdateProgress, type Updates, type UpdateStatus } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

// A package version as people read it: 0.3.0-1 is 0.3.0.
export function shown(version: string | null | undefined): string {
  return (version ?? "?").replace(/-\d+$/, "");
}

// The new AgenTV release the check found, if any, once it can be installed.
export function release(updates: Updates): string | null {
  const next = updates.status?.agentv.available;
  return next && !updates.status?.waiting ? shown(next) : null;
}

// Anything new: AgenTV, Omarchy or system packages.
export function pending(status: UpdateStatus | null): boolean {
  return Boolean(status && (status.agentv.available || status.omarchy.available || status.packages > 0));
}

// Anything new that can be installed now.
function ready(status: UpdateStatus | null): boolean {
  return pending(status) && !status?.waiting;
}

function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const at = new Date(iso);
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const today = new Date().toDateString() === at.toDateString();
  return today ? `today ${time}` : `${at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).toLowerCase()} ${time}`;
}

async function install(ctx: Ctx): Promise<void> {
  const reply = await screen.installUpdate();
  if (!reply.ok) {
    ctx.sounds.play("failure");
    ctx.toast(reply.error ?? "the update didn't start", "fail");
  } else ctx.sounds.play("confirm");
}

function row(name: string, now: string | null, next: string | null): HTMLElement {
  return h(
    "div",
    { class: "update-row" },
    h("span", { class: "update-name" }, name),
    h("span", {}, shown(now)),
    next ? h("span", { class: "update-arrow" }, "→") : null,
    next ? h("span", { class: "update-next" }, shown(next)) : h("span", { class: "update-same" }, "up to date"),
  );
}

// The Updates panel in Settings.
export function updatesPanel(ctx: Ctx): HTMLElement[] {
  const status = ctx.updates.status;
  if (!status) {
    return [
      h("div", { class: "panel-title" }, "updates"),
      h("div", { class: "panel-big" }, `agentv ${ctx.state.version}`),
      h("div", { class: "panel-note" }, "the box hasn't checked for updates yet. it does a few minutes after it starts, then once a day."),
      h("button", { class: "button", "data-focus": true, "data-action": "check", onclick: () => void check(ctx) }, "check now"),
    ];
  }
  const title = !status.ok
    ? "updates · couldn't check"
    : status.waiting && pending(status)
      ? "updates · waiting for tonight's tests"
      : status.agentv.available
        ? "updates · a new release is out"
        : pending(status)
          ? "updates · ready"
          : "updates · up to date";
  const tested = status.channel === "edge" ? "on edge: every green build" : "tested by agentv's nightly run";
  const parts: (HTMLElement | null)[] = [
    h("div", { class: `panel-title${status.security ? " security" : ""}` }, status.security ? `${title} · security` : title),
    h(
      "div",
      { class: "update-rows" },
      row("agentv", status.agentv.installed, status.agentv.available),
      row("omarchy", status.omarchy.installed, status.omarchy.available),
    ),
    h("div", { class: "panel-note" }, status.packages > 0 ? `plus ${status.packages} system package${status.packages === 1 ? "" : "s"} · ${tested}` : tested),
    ready(status)
      ? h("button", { class: "button primary", "data-focus": true, "data-action": "install", onclick: () => void install(ctx) }, "↵ install now")
      : null,
    status.waiting && pending(status)
      ? h("div", { class: "panel-note" }, "it waits until agentv's nightly run has tested it. the box looks again tomorrow.")
      : null,
    status.notes.agentv.length || status.notes.omarchy.length
      ? h("button", { class: "button", "data-focus": true, "data-action": "whats-new", onclick: () => ctx.go("whats-new") }, "what's new ›")
      : null,
    h("div", { class: "panel-note" }, "tonight, and updating overnight on its own, are coming soon."),
    h("div", { class: "panel-note" }, `last checked ${when(status.checked_at)}${status.ok ? "" : ", and it couldn't look"}.`),
    h("button", { class: "button", "data-focus": true, "data-action": "check", onclick: () => void check(ctx) }, "check now"),
  ];
  return parts.filter((part): part is HTMLElement => part !== null);
}

async function check(ctx: Ctx): Promise<void> {
  const reply = await screen.checkUpdates();
  if (reply.ok) ctx.toast("checking for updates", "ok");
  else ctx.toast(reply.error ?? "couldn't check for updates", "fail");
}

// What's new (board 30).
export function whatsNew(ctx: Ctx): View {
  const status = ctx.updates.status;
  const date = status?.notes.agentv_date
    ? ` · ${new Date(status.notes.agentv_date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).toLowerCase()}`
    : "";
  const lines = (items: string[]) => h("ul", { class: "notes" }, ...items.map((item) => h("li", {}, h("b", {}, "+ "), item)));
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page" },
      ...heading("tv updates whats-new", "what's new."),
      status?.agentv.available ? h("div", { class: "section" }, `agentv ${shown(status.agentv.available)}${date}`) : null,
      status?.agentv.available ? (status.notes.agentv.length ? lines(status.notes.agentv) : h("div", { class: "empty" }, "no notes for this one.")) : null,
      status?.omarchy.available ? h("div", { class: "section" }, `omarchy ${shown(status.omarchy.available)}`) : null,
      status?.omarchy.available
        ? status.notes.omarchy.length
          ? lines(status.notes.omarchy)
          : h("div", { class: "empty" }, "omarchy's own notes are on github.com/omacom/omarchy/releases.")
        : null,
      ready(status)
        ? h("button", { class: "button primary notes-install", "data-focus": true, "data-action": "install", onclick: () => void install(ctx) }, "↵ install now")
        : null,
    ),
    bar(ctx, "settings", "↵ select · esc back"),
  );
  return { el, first: el.querySelector<HTMLElement>(".page [data-focus]") ?? undefined };
}

const STEPS: { step: UpdateProgress["step"]; label: (p: UpdateProgress) => string }[] = [
  { step: "snapshot", label: (p) => `snapshot of ${shown(p.from.agentv)} saved` },
  { step: "packages", label: (p) => (p.step === "packages" && p.detail ? `installing packages · ${p.detail}` : "installing packages") },
  { step: "migrations", label: () => "agentv migrations" },
  { step: "restart", label: () => "restart and check" },
];

// The Updating screen (board 32), drawn into el.
export function drawUpdating(el: HTMLElement, progress: UpdateProgress): void {
  const failed = progress.state === "failed";
  const at = Math.max(
    0,
    STEPS.findIndex((s) => s.step === progress.step),
  );
  const title = failed
    ? progress.detail === "not tested yet"
      ? "not tested yet. nothing changed."
      : progress.detail === "nothing changed"
        ? "couldn't update. nothing changed."
        : "the update stopped."
    : `updating to agentv ${shown(progress.to.agentv || progress.from.agentv)}`;
  const fill = h("div", { class: "updating-fill" });
  fill.style.transform = `scaleX(${Math.max(0.02, Math.min(1, progress.percent / 100))})`;
  el.replaceChildren(
    h(
      "div",
      { class: "updating-box" },
      h("div", { class: "updating-title" }, title),
      failed ? null : h("div", { class: "updating-bar" }, fill),
      h(
        "div",
        { class: "updating-note" },
        failed
          ? progress.detail === "not tested yet"
            ? "agentv's nightly run hasn't passed it yet. any key to go back."
            : progress.detail === "nothing changed"
              ? "any key to go back. you can try again from settings → updates."
              : "agentv update on the box says more. any key to go back."
          : progress.state === "restarting"
            ? "restarting. back in a moment."
            : "back in a few minutes. leave the box on.",
      ),
      failed
        ? null
        : h(
            "div",
            { class: "updating-steps" },
            ...STEPS.map((s, i) => {
              const mark = i < at || progress.state === "done" ? "[x]" : i === at ? "[>]" : "[ ]";
              return h("div", { class: `updating-step${i === at ? " now" : ""}` }, h("b", {}, mark), ` ${s.label(progress)}`);
            }),
          ),
    ),
  );
}
