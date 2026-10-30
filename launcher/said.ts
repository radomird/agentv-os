// A sentence said to the TV (ADR-023), as home shows it: what was heard,
// at once, then what came of it, as a toast. With more than one match, a
// card over the page offers up to three to choose from, as the phone does
// too. Back, or "none of these", puts it away. A sentence the router
// couldn't route is "i didn't get that", and nothing else happens (S7.3).

import { daemon, type Candidate, type Said } from "./api.ts";
import { h } from "./dom.ts";
import type { Ctx } from "./main.ts";

// What a kind is, beside a title, as the daemon says it.
const KIND_WORDS: Record<string, string> = { film: "film", series: "show", episode: "episode", track: "song", album: "album", playlist: "playlist", "photo-album": "photos", game: "game" };

function label(c: Candidate): string {
  const at = [c.item.season !== undefined ? `s${c.item.season}` : "", c.item.episode !== undefined ? `e${c.item.episode}` : ""].filter(Boolean).join(" ");
  return [`${c.item.title.toLowerCase()}${at ? ` ${at}` : ""}`, KIND_WORDS[c.item.kind] ?? c.item.kind, c.name.toLowerCase()].join(" · ");
}

let el: HTMLElement | null = null;
let open: { n: number; before: HTMLElement | undefined } | null = null;
let heard = 0; // the newest sentence toasted, so a redraw doesn't toast it again
let restore: () => void = () => {};
let ctx: Ctx;

export function setupSaid(c: Ctx, back: () => void): void {
  ctx = c;
  restore = back;
  el = h("div", { id: "said", "aria-live": "polite" });
  document.body.append(el);
  void daemon.said().then((said) => said && saidHeard(said), () => {});
}

export function saidOpen(): boolean {
  return open !== null;
}

function close(): void {
  if (!el) return;
  const before = open?.before;
  open = null;
  el.classList.remove("on");
  el.replaceChildren();
  restore();
  if (before?.isConnected) ctx.focus.set(before);
}

// What the daemon says about the newest sentence, or null once it's away.
export function saidHeard(said: Said | null): void {
  if (!said) {
    if (open) close();
    return;
  }
  if (open && open.n !== said.n) close();
  if (said.state === "routing") {
    if (said.n > heard) ctx.toast(`"${said.sentence}"`);
    heard = Math.max(heard, said.n);
    return;
  }
  const outcome = said.outcome;
  if (!outcome) return;
  if (outcome.kind === "opened") {
    if (open) close();
    ctx.sounds.play("confirm");
    ctx.toast(outcome.say, "ok");
    return;
  }
  if (outcome.kind === "none") {
    if (open) close();
    ctx.sounds.play("failure");
    ctx.toast(outcome.detail ? `${outcome.say} · ${outcome.detail}` : outcome.say, "fail");
    return;
  }
  if (open?.n === said.n || !el) return;
  const pick = async (choice: number) => {
    ctx.sounds.play("forward");
    try {
      await daemon.pickSaid(said.n, choice);
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
    }
    close();
  };
  const buttons = outcome.candidates.map((c, i) => h("button", { class: "button said-choice", "data-focus": true, "data-action": "said-pick", "data-choice": String(i), onclick: () => void pick(i) }, label(c)));
  const none = h("button", { class: "button", "data-focus": true, "data-action": "said-none", onclick: () => dismiss() }, "none of these");
  const card = h("div", { class: "notice-card" }, h("div", { class: "notice-title" }, outcome.say), h("div", { class: "said-heard" }, `"${said.sentence}"`), h("div", { class: "said-choices" }, ...buttons, none));
  const before = ctx.focus.get();
  before?.classList.remove("focused");
  el.replaceChildren(card);
  el.classList.add("on");
  open = { n: said.n, before };
  ctx.focus.setRoot(card, buttons[0] ?? none);
  ctx.sounds.play("forward");
}

function dismiss(): void {
  const n = open?.n;
  ctx.sounds.play("back");
  close();
  if (n !== undefined) void daemon.dismissSaid(n).catch(() => {});
}

// The keys while the card is up: Back is "none of these".
export function saidAct(action: string): boolean {
  if (!open) return false;
  if (action === "up" || action === "down" || action === "left" || action === "right") ctx.focus.move(action);
  else if (action === "ok") {
    ctx.sounds.play("select");
    ctx.focus.get()?.click();
  } else if (action === "back") dismiss();
  return true;
}
