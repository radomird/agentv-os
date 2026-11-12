// A sentence said to the TV (ADR-023), as home shows it: what was heard,
// at once, then what came of it, as a toast. With more than one match, a
// card over the page offers up to three to choose from, as the phone does
// too, and what's new offers its top three the same way (S8.1). Back, or
// "none of these", puts it away. A sentence the router couldn't route is "i
// didn't get that", and nothing else happens (S7.3). A make or a change
// from the Ask box opens its page (ADR-068).

import { daemon, type Candidate, type Said } from "./api.ts";
import { h } from "./dom.ts";
import { barTakes, cardClosed } from "./listening.ts";
import type { Ctx } from "./main.ts";
import { askBuilds, askHeard, askShowing, changeWaiting } from "./pages/ask.ts";

// What a kind is, beside a title, as the daemon says it.
const KIND_WORDS: Record<string, string> = { film: "film", series: "show", episode: "episode", track: "song", album: "album", playlist: "playlist", "photo-album": "photos", game: "game" };

function label(c: Candidate): string {
  const at = [c.item.season !== undefined ? `S${c.item.season}` : "", c.item.episode !== undefined ? `E${c.item.episode}` : ""].filter(Boolean).join(" ");
  return [`${c.item.title}${at ? ` ${at}` : ""}`, KIND_WORDS[c.item.kind] ?? c.item.kind, c.name].join(" · ");
}

let el: HTMLElement | null = null;
let open: { n: number; before: HTMLElement | undefined } | null = null;
let heard = 0; // the newest sentence toasted, so a redraw doesn't toast it again
let opened = ""; // the page the Ask box last opened, so it opens once
let restore: () => void = () => {};
let ctx: Ctx;

export function setupSaid(c: Ctx, back: () => void): void {
  ctx = c;
  restore = back;
  el = h("div", { id: "said", "aria-live": "polite" });
  document.body.append(el);
  // As home loads: a choice still waiting comes back, but an outcome from
  // before isn't a toast again.
  void daemon.said().then((said) => said?.state === "done" && said.outcome?.kind === "choose" && saidHeard(said), () => {});
}

export function saidOpen(): boolean {
  return open !== null;
}

// The page under the card was drawn again, as home is when something
// changes elsewhere. The card keeps the keys, and the focus goes back to the
// same tile in the new page once the card is put away.
export function saidPageDrawn(find: (was: string | undefined) => HTMLElement | null | undefined): void {
  if (!open) return;
  const was = open.before?.dataset.action ?? open.before?.dataset.id;
  open.before = find(was) ?? undefined;
}

// Puts the card away. A bar waiting on it goes too, unless a pick went
// through: then the outcome takes the bar's place, whether its event comes
// before the pick's reply or after it (Q162).
function close(picked = false): void {
  if (!el) return;
  const before = open?.before;
  open = null;
  if (!picked) cardClosed();
  el.classList.remove("on");
  el.replaceChildren();
  restore();
  if (before?.isConnected) ctx.focus.set(before);
}

// What the daemon says about the newest sentence, or null once it's away.
// With the listening bar up, the bar shows what was heard and what came of
// it in place of the toasts (ADR-054).
export function saidHeard(said: Said | null): void {
  // The Ask page says what came of it in its own line (ADR-068).
  if (said) askHeard(said);
  const barred = barTakes(said) || askShowing();
  if (!said) {
    if (open) close();
    return;
  }
  if (open && open.n !== said.n) close();
  if (said.state === "routing") {
    if (said.n > heard && !barred) ctx.toast(`"${said.sentence}"`);
    heard = Math.max(heard, said.n);
    return;
  }
  const outcome = said.outcome;
  if (!outcome) return;
  if (outcome.kind === "opened") {
    if (open) close();
    ctx.sounds.play("confirm");
    if (!barred) ctx.toast(outcome.say, "ok");
    return;
  }
  // From the Ask box (ADR-068): a make opens its build's page, where what
  // your agent understood waits for you to confirm, and a change waits for
  // an adult's ok on a page of its own. Each opens once, whether it was
  // asked here or on a phone.
  if ((outcome.kind === "build" || outcome.kind === "change") && askBuilds()) {
    if (open) close();
    const page = outcome.kind === "build" ? `build/${outcome.build}` : `ask-change/${said.n}`;
    if (page === opened) return;
    opened = page;
    ctx.sounds.play("forward");
    if (outcome.kind === "change") changeWaiting(said.n, outcome);
    ctx.go(outcome.kind === "build" ? page : "ask-change");
    return;
  }
  // An answer, such as whether there's a new episode (S8.2): told, and
  // nothing else happens. With the Ask box off, a build or a change says
  // what it is the same way.
  if (outcome.kind === "told" || outcome.kind === "build" || outcome.kind === "change") {
    if (open) close();
    ctx.sounds.play("confirm");
    if (!barred) ctx.toast(outcome.say, "ok");
    return;
  }
  if (outcome.kind === "none") {
    if (open) close();
    ctx.sounds.play("failure");
    if (!barred) ctx.toast(outcome.say, "fail");
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
      close();
      return;
    }
    close(true);
  };
  const buttons = outcome.candidates.map((c, i) => h("button", { class: "button said-choice", "data-focus": true, "data-action": "said-pick", "data-choice": String(i), onclick: () => void pick(i) }, label(c)));
  const none = h("button", { class: "button", "data-focus": true, "data-action": "said-none", onclick: () => dismiss() }, "None of these");
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
