// Getting ready (board 35, ADR-025, S5.6): once the box is online it brings
// itself up to date first, so every screen after this one comes from the
// newest release. It asks the screen daemon for the update check, and when
// there's a newer AgenTV or Omarchy, for the same install Settings → Updates
// runs. The install restarts AgenTV, so this page loads again from the new
// release and carries on here; one that needs the box to restart comes back
// here after it. A check or an install that doesn't work doesn't hold setup
// up: it carries on with the version it has, and Settings → Updates has the
// update later.
//
// With setup's own switch on (D3), it's one headline, one line and one bar,
// with no checklist and no continue: it moves on by itself once the update
// is done or isn't needed. Back to it later, it waits for OK.

import { screen, type UpdateProgress, type UpdateStatus } from "../launcher/api.ts";
import { asWritten, h } from "../launcher/dom.ts";
import { setup, type SetupInfo } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

// How long the check may take before setup carries on without it.
const CHECK_MS = 180_000;
// How long the screen shows it's up to date before moving on.
const ON_MS = 2000;

// A version without pacman's release, to compare.
const bare = (version: string | null) => (version ?? "").replace(/-\d+$/, "");
// A version as people read it: no package release or build after it.
const shown = (version: string | null) => bare(version).replace(/\.r\d+\.g[0-9a-f]+$/, "");

// Two versions as people read them, or as they are when that would look the
// same, as on edge, or for a package built again.
function versions(from: string | null, to: string | null): [string, string] {
  if (from === to || shown(from) !== shown(to)) return [shown(from), shown(to)];
  if (bare(from) !== bare(to)) return [bare(from), bare(to)];
  return [from ?? "", to ?? ""];
}

const fresh = (at: string | undefined, asked: string | null) => Boolean(at && asked && Date.parse(at) >= Date.parse(asked) - 2000);

// A row of the checklist. A network's name comes as its own piece, so it
// keeps its capitals.
function row(mark: "x" | ">" | " " | "!", text: string | (string | Node)[], extra?: HTMLElement): HTMLElement {
  const words = typeof text === "string" ? [text] : text;
  return h("span", { class: `ready-row mark-${mark === " " ? "todo" : mark === "x" ? "done" : mark === ">" ? "now" : "bad"}` }, h("span", {}, h("b", {}, `[${mark}]`), " ", ...words), extra ?? "");
}

// A bar of 16 blocks, as the install dashboard draws one.
function blocks(percent: number): HTMLElement {
  const filled = Math.max(0, Math.min(16, Math.round((percent / 100) * 16)));
  return h("span", { class: "blocks", role: "img", "aria-label": `${Math.round(percent)} percent` }, h("b", {}, "█".repeat(filled)), "█".repeat(16 - filled));
}

// Getting ready as D3 draws it, with setup's own switch on.
export const ready2 = (ctx: Ctx): View => ready(ctx, true);

export function ready(ctx: Ctx, phase2 = false): View {
  const line = h("p", { class: phase2 ? "setup-line" : "ready-line" }, phase2 ? "Checking for updates" : "Updating first");
  const list = h("div", { class: phase2 ? "ready-bar" : "ready-list" });
  const go = h("button", { class: "button primary ready-go hidden", "data-focus": true, "data-action": "continue", onclick: () => void next() }, "Continue");
  const el = phase2
    ? h("div", { class: "setup-page d3 ready2" }, ...heading("agentv update", "Getting ready", ctx.reduced()), line, list)
    : h("div", { class: "setup-page center" }, h("div", { class: "ready-head" }, ...heading("tv setup", "Getting ready", ctx.reduced()), line), list, go);
  // With setup's own switch on, OK moves on once there's nothing left to do.
  let done = false;

  let stopped = false;
  let busy = false;
  // The check is asked for again once when the screen opens on it, as after
  // the page loaded again partway: starting it twice does no harm.
  let askedHere = false;
  let moving = false;
  let leaving = 0;
  let timer = 0;
  // Whether the update ran while this screen was on, so it moves on by
  // itself once it's done. The first time through it moves on by itself
  // too, as after the page loaded again from the new release; back to it
  // later only shows continue.
  let ran = false;

  async function next(): Promise<void> {
    if (moving) return;
    moving = true;
    clearTimeout(leaving);
    await ctx.finish("ready");
  }

  function draw(about: SetupInfo): void {
    if (phase2) {
      draw2(about);
      return;
    }
    const r = about.setup.ready;
    const status = ctx.updates.status as UpdateStatus | null;
    const progress = ctx.updates.progress as UpdateProgress | null;
    const phone = about.phones[about.phones.length - 1];
    const rows = [
      about.network.online
        ? row("x", about.network.via === "ethernet" ? "Cable" : ["Wi-Fi · ", about.network.name ? asWritten(about.network.name) : "on"])
        : row(">", "Waiting for the network"),
      phone ? row("x", `Paired · ${phone}`) : row(" ", "Phone · pair one later in Settings"),
    ];
    const [from, to] = versions(r.from ?? about.running, r.to ?? status?.agentv.available ?? null);
    if (!about.network.online || r.update === null || r.update === "checking") rows.push(row(">", "Checking for updates"));
    else if (r.update === "installing") {
      const now = fresh(progress?.at, r.asked) ? progress : null;
      rows.push(now?.state === "restarting" ? row(">", `AgenTV ${to} · restarting`) : row(">", `AgenTV ${from} to ${to}`, blocks(now?.percent ?? 0)));
    } else if (r.update === "done") rows.push(row("x", `AgenTV ${to}`));
    else if (r.update === "none") rows.push(row("x", `AgenTV ${from} · up to date`));
    else if (r.update === "failed") rows.push(row("!", `AgenTV ${from} · couldn't update`));
    else rows.push(row("x", `AgenTV ${from} · update later in Settings`));
    list.replaceChildren(...rows);

    const finished = r.update !== null && !["checking", "installing"].includes(r.update);
    if (!finished) ran = true;
    line.textContent = !finished
      ? "Updating first"
      : r.update === "failed"
        ? "Couldn't update. Try later in Settings."
        : "Up to date";
    ctx.status(finished ? (phone ? "Phone paired" : "") : phone ? "Phone paired · setup continues after the update" : "Setup continues after the update");
    if (finished && go.classList.contains("hidden")) {
      go.classList.remove("hidden");
      ctx.focus.set(go, false);
      ctx.sounds.play("confirm");
      if (ran || !about.setup.finished.ready) leaving = window.setTimeout(() => void next(), ON_MS);
    }
  }

  // D3's getting ready: what's happening in one line, and one bar. Once
  // it's done, on by itself, the first time through.
  function draw2(about: SetupInfo): void {
    const r = about.setup.ready;
    const status = ctx.updates.status as UpdateStatus | null;
    const progress = ctx.updates.progress as UpdateProgress | null;
    const phone = about.phones[about.phones.length - 1];
    const [from, to] = versions(r.from ?? about.running, r.to ?? status?.agentv.available ?? null);
    const finished = about.network.online && r.update !== null && !["checking", "installing"].includes(r.update);
    let percent = 0;
    if (!about.network.online) line.textContent = "Waiting for the network";
    else if (r.update === null || r.update === "checking") line.textContent = "Checking for updates";
    else if (r.update === "installing") {
      const now = fresh(progress?.at, r.asked) ? progress : null;
      percent = now?.percent ?? 0;
      line.textContent = now?.state === "restarting" ? `AgenTV ${to} installed. Restarting…` : `Updating AgenTV ${from} to ${to}`;
    } else {
      percent = 100;
      line.textContent = r.update === "done" ? `AgenTV ${to} is ready` : r.update === "failed" ? "Couldn't update. Try later in Settings." : `AgenTV ${from} is up to date`;
    }
    list.replaceChildren(blocks(percent));
    if (!finished) ran = true;
    ctx.status(phone ? "Phone paired" : "Setup continues after the update");
    if (finished && !done) {
      done = true;
      ctx.sounds.play("confirm");
      if (ran || !about.setup.finished.ready) leaving = window.setTimeout(() => void next(), ON_MS);
      else ctx.status("Continue");
    }
  }

  // One look at where things are, and the next move.
  async function tick(): Promise<void> {
    if (busy || stopped) return;
    busy = true;
    try {
      const about = await ctx.refresh();
      if (stopped) return;
      const r = about.setup.ready;
      const status = ctx.updates.status as UpdateStatus | null;
      const progress = ctx.updates.progress as UpdateProgress | null;
      if (!about.network.online) {
        // nothing to do until it is
      } else if (r.update === null) {
        if (about.pin) about.setup = await setup.ready({ update: "skipped", from: about.running });
        else {
          askedHere = true;
          about.setup = await setup.ready({ update: "checking", from: about.running, to: null });
          const reply = await screen.checkUpdates();
          if (!reply.ok) about.setup = await setup.ready({ update: "failed" });
        }
      } else if (r.update === "checking") {
        if (!askedHere) {
          askedHere = true;
          about.setup = await setup.ready({ update: "checking" });
          const reply = await screen.checkUpdates();
          if (!reply.ok) about.setup = await setup.ready({ update: "failed" });
        } else if (status && fresh(status.checked_at, r.asked)) {
          const newer = status.ok && !status.waiting && Boolean(status.agentv.available || status.omarchy.available);
          if (!status.ok) about.setup = await setup.ready({ update: "failed", from: status.agentv.installed ?? r.from });
          else if (!newer) about.setup = await setup.ready({ update: "none", from: status.agentv.installed ?? about.running, to: status.agentv.installed ?? about.running });
          else {
            about.setup = await setup.ready({ update: "installing", from: status.agentv.installed ?? about.running, to: status.agentv.available ?? status.agentv.installed });
            const reply = await screen.installUpdate("");
            if (!reply.ok) about.setup = await setup.ready({ update: "failed" });
          }
        } else if (r.asked && Date.now() - Date.parse(r.asked) > CHECK_MS) about.setup = await setup.ready({ update: "failed" });
      } else if (r.update === "installing") {
        // The daemon restarted on the new package, as the install does at its
        // end: it's in.
        if (r.to && about.running === r.to) about.setup = await setup.ready({ update: "done" });
        else if (progress && fresh(progress.at, r.asked) && progress.state === "failed") about.setup = await setup.ready({ update: "failed" });
        else if (progress && fresh(progress.at, r.asked) && progress.state === "done") about.setup = await setup.ready({ update: "done" });
      }
      ctx.info = about;
      draw(about);
    } catch (error) {
      // The daemon restarts during an install; the next look sees it back.
      console.warn(`getting ready: ${(error as Error).message}`);
    } finally {
      busy = false;
    }
  }

  draw(ctx.info);
  void tick();
  timer = window.setInterval(() => void tick(), 1000);

  return {
    el,
    info: "Setup continues after the update",
    // With setup's own switch on, OK carries on once it's done.
    act: phase2
      ? (action) => {
          if (action !== "ok" || !done) return false;
          void next();
          return true;
        }
      : undefined,
    heard(event) {
      if (event === "updates") void tick();
    },
    // Back waits while the box updates itself.
    stay: () => {
      const r = ctx.info.setup.ready;
      return r.update === "checking" || r.update === "installing";
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(leaving);
    },
  };
}
