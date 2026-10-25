// Updates on the TV (ADR-025, boards 29 to 33): Settings → Updates, What's
// new, the notice on home, the Updating screen, and Go back when the check
// after an update finds something off. The daemon passes on what the daily
// check found, how an install is going and what the check after it found;
// installing runs as root in agentv-update-tv.service, and going back in
// agentv-go-back.service, which the screen daemon starts.

import { daemon, screen, type AfterCheck, type GoBack, type UpdateProgress, type Updates, type UpdateStatus } from "../api.ts";
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

// Go back's snapshot, while it's for the agentv the box has now.
export function goBack(updates: Updates): GoBack | null {
  const go = updates.goBack;
  const now = updates.status?.agentv.installed;
  return go && now && go.to.agentv === now ? go : null;
}

// The check after the last update found something off, there's a snapshot
// to go back to, and nobody chose to keep this version.
export function off(updates: Updates): AfterCheck | null {
  const after = updates.after;
  if (!after || after.ok || updates.seen?.kept === after.at) return null;
  return goBack(updates)?.to.agentv === after.agentv ? after : null;
}

async function goBackNow(ctx: Ctx): Promise<void> {
  const reply = await screen.goBack();
  if (!reply.ok) {
    ctx.sounds.play("failure");
    ctx.toast(reply.error ?? "couldn't go back", "fail");
  } else ctx.sounds.play("confirm");
}

// An install from the TV, or going back from one, is running: the Updating
// screen is up, and nothing turns the box off (ADR-025, ADR-033).
export function installing(updates: Updates): boolean {
  const progress = updates.progress;
  if (!progress || Date.now() - new Date(progress.at).getTime() >= 15 * 60_000) return false;
  return progress.state === "running" || progress.state === "restarting" || progress.state === "going-back";
}

// Anything new: AgenTV, Omarchy or system packages.
export function pending(status: UpdateStatus | null): boolean {
  return Boolean(status && (status.agentv.available || status.omarchy.available || status.packages > 0));
}

// Anything new that can be installed now.
function ready(status: UpdateStatus | null): boolean {
  return pending(status) && !status?.waiting;
}

// What Tonight and Later name: the AgenTV release, or "packages" when only
// Omarchy's or the system's are new.
function what(status: UpdateStatus | null): string {
  return status?.agentv.available ?? "packages";
}

// Tonight was chosen, here or on the phone (S4.8), and there's still
// something to install. The screen daemon installs it between 02:00 and
// 05:00, once nothing has played for half an hour.
export function tonight(updates: Updates): boolean {
  return Boolean(updates.tonight) && ready(updates.status);
}

// Later was chosen for this release, so home doesn't say it's ready.
export function later(updates: Updates): boolean {
  return pending(updates.status) && updates.seen?.later === what(updates.status);
}

async function chooseTonight(ctx: Ctx, route: string): Promise<void> {
  const version = what(ctx.updates.status);
  try {
    await daemon.tonight(version);
  } catch (error) {
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
    return;
  }
  ctx.updates.tonight = { version, at: new Date().toISOString() };
  ctx.sounds.play("confirm");
  ctx.toast("it installs tonight, between 2 and 5", "ok");
  ctx.render(route, "later");
}

// Not now: Tonight is off again, home stops saying it's ready, and it waits
// in Settings → Updates.
async function chooseLater(ctx: Ctx, leave: boolean): Promise<void> {
  const version = what(ctx.updates.status);
  try {
    if (ctx.updates.tonight) await daemon.tonight(null);
    await daemon.seen({ later: version });
  } catch (error) {
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
    return;
  }
  ctx.updates.tonight = null;
  ctx.updates.seen = { kept: null, wentBack: null, ...ctx.updates.seen, later: version };
  ctx.toast("later, then. it's here in settings → updates.", "ok");
  if (leave) ctx.back();
  else {
    ctx.sounds.play("confirm");
    ctx.render("settings/updates", "tonight");
  }
}

// Install now, Tonight and Later, for Settings → Updates and What's new.
function choices(ctx: Ctx, route: string): HTMLElement[] {
  if (!ready(ctx.updates.status)) return [];
  const on = tonight(ctx.updates);
  const parts: (HTMLElement | null)[] = [
    h("button", { class: "button primary", "data-focus": true, "data-action": "install", onclick: () => void install(ctx) }, "↵ install now"),
    on ? null : h("button", { class: "button", "data-focus": true, "data-action": "tonight", onclick: () => void chooseTonight(ctx, route) }, "tonight"),
    h("button", { class: "button", "data-focus": true, "data-action": "later", onclick: () => void chooseLater(ctx, route === "whats-new") }, "later"),
  ];
  return parts.filter((part): part is HTMLElement => part !== null);
}

function tonightNote(ctx: Ctx): HTMLElement | null {
  if (!tonight(ctx.updates)) return null;
  return h("div", { class: "panel-note tonight-note" }, "it installs tonight, between 2 and 5, once nothing has played for half an hour. later takes that back.");
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
  const go = goBack(ctx.updates);
  const parts: (HTMLElement | null)[] = [
    h("div", { class: `panel-title${status.security ? " security" : ""}` }, status.security ? `${title} · security` : title),
    h(
      "div",
      { class: "update-rows" },
      row("agentv", status.agentv.installed, status.agentv.available),
      row("omarchy", status.omarchy.installed, status.omarchy.available),
    ),
    h("div", { class: "panel-note" }, status.packages > 0 ? `plus ${status.packages} system package${status.packages === 1 ? "" : "s"} · ${tested}` : tested),
    h(
      "div",
      { class: "update-choices" },
      ...choices(ctx, "settings/updates"),
      status.notes.agentv.length || status.notes.omarchy.length
        ? h("button", { class: "button", "data-focus": true, "data-action": "whats-new", onclick: () => ctx.go("whats-new") }, "what's new ›")
        : null,
    ),
    tonightNote(ctx),
    status.waiting && pending(status)
      ? h("div", { class: "panel-note" }, "it waits until agentv's nightly run has tested it. the box looks again tomorrow.")
      : null,
    go ? h("button", { class: "button", "data-focus": true, "data-action": "go-back", onclick: () => void goBackNow(ctx) }, `go back to ${shown(go.from.agentv)}`) : null,
    go ? h("div", { class: "panel-note" }, "kept until the next update.") : null,
    h(
      "button",
      { class: "button wide", "data-focus": true, "data-action": "overnight", onclick: () => void overnight(ctx) },
      h("span", {}, "update overnight on its own"),
      h("span", { class: "button-value" }, ctx.state.settings.updateOvernight ? "[x]" : "[ ]"),
    ),
    ctx.state.settings.updateOvernight
      ? h("div", { class: "panel-note" }, "tested updates install between 2 and 5, once nothing has played for half an hour.")
      : null,
    h("div", { class: "panel-note" }, `last checked ${when(status.checked_at)}${status.ok ? "" : ", and it couldn't look"}.`),
    h("button", { class: "button", "data-focus": true, "data-action": "check", onclick: () => void check(ctx) }, "check now"),
  ];
  return parts.filter((part): part is HTMLElement => part !== null);
}

async function overnight(ctx: Ctx): Promise<void> {
  try {
    await ctx.saveSettings({ updateOvernight: !ctx.state.settings.updateOvernight });
  } catch (error) {
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
    return;
  }
  ctx.sounds.play("confirm");
  ctx.render("settings/updates", "overnight");
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
      ready(status) ? h("div", { class: "update-choices notes-choices" }, ...choices(ctx, "whats-new"), tonightNote(ctx)) : null,
    ),
    bar(ctx, "settings", "↵ select · esc back"),
  );
  return { el, first: el.querySelector<HTMLElement>(".page [data-focus]") ?? undefined };
}

// Something's off after an update (board 33): what the check found, then Go
// back to the version from before, or keep this one.
export function checkView(ctx: Ctx): View {
  const after = off(ctx.updates);
  const go = goBack(ctx.updates);
  const wrong = (after?.checks ?? []).filter((check) => !check.ok).map((check) => check.detail || `${check.name} isn't right`);
  const keep = async () => {
    if (after) {
      ctx.updates.seen = { wentBack: null, ...ctx.updates.seen, kept: after.at };
      await daemon.seen({ kept: after.at }).catch(() => {});
    }
    ctx.back();
  };
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page" },
      ...heading("tv updates check", "something's off."),
      h("div", { class: "panel-note check-summary" }, `the update finished, but ${wrong.join(" and ") || "something isn't right"}. go back to ${shown(go?.from.agentv)}?`),
      h(
        "div",
        { class: "check-rows" },
        ...(after?.checks ?? []).map((check) =>
          h("div", { class: `check-row${check.ok ? "" : " bad"}` }, h("b", {}, check.ok ? "[x]" : "[!]"), ` ${check.ok ? check.name : check.detail || check.name}`),
        ),
      ),
      h(
        "div",
        { class: "check-actions" },
        h("button", { class: "button primary", "data-focus": true, "data-action": "go-back", onclick: () => void goBackNow(ctx) }, `↵ go back to ${shown(go?.from.agentv)}`),
        h("button", { class: "button", "data-focus": true, "data-action": "keep", onclick: () => void keep() }, `keep ${shown(after?.agentv)}`),
      ),
    ),
    bar(ctx, "updates", "↵ select"),
  );
  return { el, first: el.querySelector<HTMLElement>('[data-action="go-back"]') ?? undefined };
}

const STEPS: { step: UpdateProgress["step"]; label: (p: UpdateProgress) => string }[] = [
  { step: "snapshot", label: (p) => `snapshot of ${shown(p.from.agentv)} saved` },
  { step: "packages", label: (p) => (p.step === "packages" && p.detail ? `installing packages · ${p.detail}` : "installing packages") },
  { step: "migrations", label: () => "agentv migrations" },
  { step: "restart", label: () => "restart and check" },
];

// The Updating screen (board 32), drawn into el. Going back after an update
// uses it too, with no steps.
export function drawUpdating(el: HTMLElement, progress: UpdateProgress): void {
  const failed = progress.state === "failed";
  const back = progress.what === "go-back";
  const at = Math.max(
    0,
    STEPS.findIndex((s) => s.step === progress.step),
  );
  const title = back
    ? failed
      ? `couldn't go back: ${progress.detail}.`
      : `going back to agentv ${shown(progress.to.agentv)}`
    : failed
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
        back
          ? failed
            ? "nothing changed. any key for home."
            : "restarting. back in a moment. leave the box on."
          : failed
            ? progress.detail === "not tested yet"
              ? "agentv's nightly run hasn't passed it yet. any key to go back."
              : progress.detail === "nothing changed"
                ? "any key to go back. you can try again from settings → updates."
                : "agentv update on the box says more. any key to go back."
            : progress.state === "restarting"
              ? "restarting. back in a moment."
              : "back in a few minutes. leave the box on.",
      ),
      failed || back
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
