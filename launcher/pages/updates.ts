// Updates on the TV (ADR-025, boards 29 to 33): the Updates row in Settings,
// This TV, and its page, What's new, the notice on home, the Updating screen, and Go back when the check
// after an update finds something off. The daemon passes on what the daily
// check found, how an install is going and what the check after it found;
// installing runs as root in agentv-update-tv.service, and going back in
// agentv-go-back.service, which the screen daemon starts.

import { daemon, screen, type AfterCheck, type GoBack, type UpdateProgress, type Updates, type UpdateStatus } from "../api.ts";
import { asWritten, h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

// A package version as people read it: 0.3.0-1 is 0.3.0.
export function shown(version: string | null | undefined): string {
  return (version ?? "?").replace(/-\d+$/, "");
}

// A release's number is worth showing on the Updating screen. An early
// update's is a package version (0.2.0.r479.g7b931248a), which tells a person
// nothing, so that screen leaves it off.
function releaseNumber(version: string | null | undefined): string | null {
  const v = shown(version);
  return /^\d+(\.\d+){1,2}$/.test(v) ? v : null;
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
  const grant = await ctx.grant("going back");
  if (grant === null) return;
  const reply = await screen.goBack(grant);
  if (reply.pin) ctx.forgetGrant();
  if (!reply.ok) {
    ctx.sounds.play("failure");
    ctx.toast(reply.error ?? "Couldn't go back", "fail");
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
  const grant = await ctx.grant("installing tonight");
  if (grant === null) return;
  try {
    await daemon.tonight(version, grant);
  } catch (error) {
    ctx.forgetGrant();
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
    return;
  }
  ctx.updates.tonight = { version, at: new Date().toISOString() };
  ctx.sounds.play("confirm");
  ctx.toast("It installs tonight between 2 and 5", "ok");
  ctx.render(route, "later");
}

// Not now: Tonight is off again, home stops saying it's ready, and it waits
// in Settings.
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
  ctx.toast("OK. It's here when you're ready.", "ok");
  if (leave) ctx.back();
  else {
    ctx.sounds.play("confirm");
    ctx.render("settings/updates", "tonight");
  }
}

// Install now, Tonight and Later, for What's new: its own screen, and its
// page a level under Updates.
function choices(ctx: Ctx, route: string): HTMLElement[] {
  if (!ready(ctx.updates.status)) return [];
  const on = tonight(ctx.updates);
  const parts: (HTMLElement | null)[] = [
    h("button", { class: "button primary", "data-focus": true, "data-action": "install", onclick: () => void install(ctx) }, "Install now"),
    on ? null : h("button", { class: "button", "data-focus": true, "data-action": "tonight", onclick: () => void chooseTonight(ctx, route) }, "Tonight"),
    h("button", { class: "button", "data-focus": true, "data-action": "later", onclick: () => void chooseLater(ctx, route === "whats-new") }, "Later"),
  ];
  return parts.filter((part): part is HTMLElement => part !== null);
}

// The night's update waited because a game was being played. It installs
// the night after, whatever is open.
function held(ctx: Ctx): boolean {
  return Boolean(ctx.updates.held && ready(ctx.updates.status) && (tonight(ctx.updates) || ctx.state.settings.updateOvernight));
}

function tonightNote(ctx: Ctx): HTMLElement | null {
  if (!tonight(ctx.updates)) return null;
  return h("div", { class: "panel-note tonight-note" }, "It installs tonight between 2 and 5");
}

function when(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const at = new Date(iso);
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const today = new Date().toDateString() === at.toDateString();
  return today ? `Today ${time}` : `${at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

async function install(ctx: Ctx): Promise<void> {
  const grant = await ctx.grant("installing the update");
  if (grant === null) return;
  const reply = await screen.installUpdate(grant);
  if (reply.pin) ctx.forgetGrant();
  if (!reply.ok) {
    ctx.sounds.play("failure");
    ctx.toast(reply.error ?? "Couldn't start the update", "fail");
  } else ctx.sounds.play("confirm");
}

// The value of This TV's "Updates" row, and what the page's title says.
export function updatesValue(ctx: Ctx): string {
  const status = ctx.updates.status;
  if (!status) return "Not checked yet";
  if (!status.ok) return "Couldn't check";
  if (status.waiting && pending(status)) return "Still being tested";
  if (status.agentv.available) return "New version";
  return pending(status) ? "Ready" : "Up to date";
}

// The page's one line, only when something is waiting or went wrong.
function line(ctx: Ctx, status: UpdateStatus): string | null {
  if (held(ctx)) return "Waited for your game. Updates tonight.";
  if (tonight(ctx.updates)) return "It installs tonight between 2 and 5";
  if (status.waiting && pending(status)) return "It's still being tested";
  if (!status.ok) return `Last check failed, ${when(status.checked_at)}`;
  return null;
}

// A row of the page: its name, then its value.
function updateRow(action: string, label: string, value: string, onclick?: () => void): HTMLElement {
  const parts = [h("span", {}, label), h("span", { class: "button-value" }, value)];
  if (!onclick) return h("div", { class: "panel-row", "data-row": action }, ...parts);
  return h("button", { class: "button", "data-focus": true, "data-action": action, onclick }, ...parts);
}

// The row the Updates page puts the focus on as it opens: Install now, when
// there's something to install.
export function updatesStart(ctx: Ctx): string | undefined {
  return ready(ctx.updates.status) ? "install" : undefined;
}

// The Updates row's page in Settings: Check now first, the version this TV
// is on, Install now with the new one when there is one, its notes a level
// deeper (open shows a page in the panel), and updating overnight. Nothing
// else, unless something waits or went wrong.
export function updatesPanel(ctx: Ctx, open: (page: string) => void): HTMLElement[] {
  const status = ctx.updates.status;
  const checkNow = (last: string) => updateRow("check", "Check now", last, () => void check(ctx));
  const overnightRow = updateRow("overnight", "Update overnight", ctx.state.settings.updateOvernight ? "On" : "Off", () => void overnight(ctx));
  if (!status) {
    return [h("div", { class: "panel-title" }, "Updates"), checkNow(""), updateRow("version", "Version", shown(ctx.state.version)), h("div", { class: "panel-note" }, "Not checked yet"), overnightRow];
  }
  const value = updatesValue(ctx);
  const title = `Updates · ${value.charAt(0).toLowerCase()}${value.slice(1)}`;
  const go = goBack(ctx.updates);
  const next = status.agentv.available;
  const says = line(ctx, status);
  const parts: (HTMLElement | null)[] = [
    h("div", { class: `panel-title${status.security ? " security" : ""}` }, status.security ? `${title} · security` : title),
    checkNow(status.ok ? when(status.checked_at) : ""),
    updateRow("version", "Version", shown(status.agentv.installed)),
    ready(status) ? updateRow("install", "Install now", next ? shown(next) : "", () => void install(ctx)) : next ? updateRow("new-version", "New version", shown(next)) : null,
    next && status.notes.agentv.length ? updateRow("whats-new", "What's new", "", () => open("whats-new")) : null,
    go ? h("button", { class: "button", "data-focus": true, "data-action": "go-back", onclick: () => void goBackNow(ctx) }, `Go back to ${shown(go.from.agentv)}`) : null,
    says ? h("div", { class: `panel-note${held(ctx) ? " held-note" : tonight(ctx.updates) ? " tonight-note" : ""}`, "data-line": "updates" }, says) : null,
    overnightRow,
  ];
  return parts.filter((part): part is HTMLElement => part !== null);
}

// What's new, a level under Updates: the notes the release carries, then
// Install now, Tonight and Later while it can be installed.
export function notesPanel(ctx: Ctx): HTMLElement[] {
  const status = ctx.updates.status;
  const next = status?.agentv.available;
  const date = status?.notes.agentv_date ? ` · ${new Date(status.notes.agentv_date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}` : "";
  const parts: (HTMLElement | null)[] = [
    h("div", { class: "panel-title" }, "What's new"),
    next ? h("div", { class: "section" }, `AgenTV ${shown(next)}${date}`) : null,
    status?.notes.agentv.length ? h("ul", { class: "notes" }, ...status.notes.agentv.map((item) => h("li", {}, h("b", {}, "+ "), item))) : h("div", { class: "empty" }, "No notes for this one"),
    ready(status) ? h("div", { class: "update-choices notes-choices" }, ...choices(ctx, "settings/whats-new"), tonightNote(ctx)) : null,
  ];
  return parts.filter((part): part is HTMLElement => part !== null);
}

async function overnight(ctx: Ctx): Promise<void> {
  const grant = await ctx.grant("updating overnight");
  if (grant === null) return;
  const on = !ctx.state.settings.updateOvernight;
  try {
    await ctx.saveSettings({ updateOvernight: on }, grant);
  } catch (error) {
    ctx.forgetGrant();
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
    return;
  }
  ctx.sounds.play("confirm");
  // The one line about it, said as it's turned on.
  if (on) ctx.toast("Between 2 and 5, when nothing's playing", "ok");
  ctx.render("settings/updates", "overnight");
}

async function check(ctx: Ctx): Promise<void> {
  const reply = await screen.checkUpdates();
  if (reply.ok) ctx.toast("Checking for updates…", "ok");
  else ctx.toast(reply.error ?? "Couldn't check for updates", "fail");
}

// What's new (board 30).
export function whatsNew(ctx: Ctx): View {
  const status = ctx.updates.status;
  const date = status?.notes.agentv_date
    ? ` · ${new Date(status.notes.agentv_date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`
    : "";
  const lines = (items: string[]) => h("ul", { class: "notes" }, ...items.map((item) => h("li", {}, h("b", {}, "+ "), item)));
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page" },
      ...heading("tv updates whats-new", "What's new"),
      status?.agentv.available ? h("div", { class: "section" }, `AgenTV ${shown(status.agentv.available)}${date}`) : null,
      status?.agentv.available ? (status.notes.agentv.length ? lines(status.notes.agentv) : h("div", { class: "empty" }, "No notes for this one")) : null,
      status?.omarchy.available ? h("div", { class: "section" }, `Omarchy ${shown(status.omarchy.available)}`) : null,
      status?.omarchy.available
        ? status.notes.omarchy.length
          ? lines(status.notes.omarchy)
          : h("div", { class: "empty" }, "Omarchy's notes are at ", asWritten("github.com/omacom/omarchy/releases"))
        : null,
      ready(status) ? h("div", { class: "update-choices notes-choices" }, ...choices(ctx, "whats-new"), tonightNote(ctx)) : null,
    ),
    bar(ctx, "settings"),
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
      ...heading("tv updates check", "Something's off"),
      h("div", { class: "panel-note check-summary" }, `The update finished, but ${wrong.join(" and ") || "something isn't right"}. Go back to ${shown(go?.from.agentv)}?`),
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
        h("button", { class: "button primary", "data-focus": true, "data-action": "go-back", onclick: () => void goBackNow(ctx) }, `Go back to ${shown(go?.from.agentv)}`),
        h("button", { class: "button", "data-focus": true, "data-action": "keep", onclick: () => void keep() }, `Keep ${shown(after?.agentv)}`),
      ),
    ),
    bar(ctx, "updates"),
  );
  return { el, first: el.querySelector<HTMLElement>('[data-action="go-back"]') ?? undefined };
}

const STEPS: { step: UpdateProgress["step"]; label: (p: UpdateProgress) => string }[] = [
  { step: "snapshot", label: (p) => `Backup of ${shown(p.from.agentv)} saved` },
  { step: "packages", label: () => "Installing" },
  { step: "migrations", label: () => "Finishing up" },
  { step: "restart", label: () => "Restart and check" },
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
      ? "Couldn't go back"
      : releaseNumber(progress.to.agentv)
        ? `Going back to AgenTV ${releaseNumber(progress.to.agentv)}`
        : "Going back"
    : failed
      ? progress.detail === "not tested yet"
        ? "Not tested yet. Nothing changed."
        : progress.detail === "nothing changed"
          ? "Couldn't update. Nothing changed."
          : "The update stopped"
      : releaseNumber(progress.to.agentv || progress.from.agentv)
        ? `Updating to AgenTV ${releaseNumber(progress.to.agentv || progress.from.agentv)}`
        : "Updating AgenTV";
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
            ? "Nothing changed. Press OK."
            : "Restarting. Back in a moment."
          : failed
            ? progress.detail === "not tested yet"
              ? "Still being tested. Press OK."
              : progress.detail === "nothing changed"
                ? "Press OK. You can try again in Settings."
                : "Press OK to go back"
            : progress.state === "restarting"
              ? "Restarting. Back in a moment."
              : "Back in a few minutes",
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
