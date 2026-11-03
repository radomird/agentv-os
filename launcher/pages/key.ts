// The AI on the TV (ADR-009, ADR-022, ADR-047, S4.6): Settings → AI says
// what builds use, a plan or a key. The key page takes a key, typed or
// pasted, for Claude, ChatGPT, Gemini, Grok or Muse. The daemon hands it to
// root and it's never shown again. The plan page picks the household's plan,
// from the ones this box's channel offers (Q143, ADR-053). Either is an
// adult's, past the PIN once there is one. A key or a plan whose provider's
// terms nobody here has accepted waits for them: the page shows them, an
// adult accepts them on a paired phone, and then the key is kept or the plan
// used (Q104, ADR-023).

import { daemon, type KeyState, type KeyTerms } from "../api.ts";
import { h } from "../dom.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";

const PROVIDERS = ["claude", "chatgpt", "gemini", "grok", "muse"];

// Kept between visits so Settings draws at once, and asked for again each
// time it opens.
export let keyState: KeyState | null = null;

export function setKeyState(state: KeyState): void {
  keyState = state;
}

// What the page does once a provider's terms are accepted on a phone, while
// it waits for them.
let termsAccepted: ((data: { provider?: string; path?: string }) => void) | null = null;

export function termsHeard(data: unknown): void {
  termsAccepted?.(data as { provider?: string; path?: string });
}

// The plans this box offers: Claude's everywhere, and ChatGPT's and Grok's
// on edge as best effort (ADR-053).
function plansOf(state: KeyState | null): { provider: string; name?: string; bestEffort: boolean }[] {
  return state?.plans ?? [{ provider: "claude", name: "claude pro or max", bestEffort: false }];
}

// The plan builds use, once its terms are accepted, or null for a key or
// none.
function planInUse(state: KeyState | null): { provider: string; name?: string; bestEffort: boolean } | null {
  const ai = state?.ai;
  if (!ai || ai.path !== "plan" || !ai.accepted || !ai.provider) return null;
  return plansOf(state).find((plan) => plan.provider === ai.provider) ?? { provider: ai.provider, bestEffort: false };
}

export function aiValue(ctx: Ctx): string {
  if (!keyState) return "";
  const guard = ctx.state.pin?.set ? " [pin]" : "";
  const plan = planInUse(keyState);
  if (plan) return `${plan.provider} plan${guard}`;
  return keyState.set ? `${keyState.provider}${guard}` : "no key";
}

// What builds can use here: a key from any provider, or one of the plans this
// box offers.
function waysLine(state: KeyState): string {
  const plans = plansOf(state);
  const named = (bestEffort: boolean) => plans.filter((plan) => plan.bestEffort === bestEffort).map((plan) => `${plan.provider}'s`).join(" or ");
  const sure = named(false);
  const early = named(true);
  const keys = "an api key from claude, chatgpt, gemini, grok or muse";
  if (!sure && !early) return `${keys}. plans are coming soon.`;
  if (!early) return `${keys}, or your plan: ${sure}. more plans are coming soon.`;
  return `${keys}, or your plan: ${[sure, `${early} as best effort`].filter(Boolean).join(", or ")}.`;
}

// A plan's line: its name, best effort or not, and when it's signed in.
function planLine(plan: { provider: string; name?: string; bestEffort: boolean }): string {
  return `${plan.name ?? `${plan.provider}'s plan`}${plan.bestEffort ? ", as best effort" : ""}. you sign in to it on your phone the first time your agent builds an app.`;
}

export function aiPanel(ctx: Ctx): HTMLElement[] {
  const note = (text: string) => h("p", { class: "panel-note" }, text);
  if (!keyState) return [h("div", { class: "panel-big" }, "…")];
  const remove = async () => {
    const grant = await ctx.grant("the ai key");
    if (grant === null) return;
    try {
      setKeyState(await daemon.removeKey(grant || undefined));
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast("the key is off", "ok");
    ctx.render("settings/ai", "add-key");
  };
  const plans = plansOf(keyState).length > 0;
  const button = (action: string, label: string, onclick: () => void, primary = false) => h("button", { class: `button${primary ? " primary" : ""}`, "data-focus": true, "data-action": action, onclick }, label);
  const removeKey = keyState.set ? [button("remove-key", "take the key off", () => void remove())] : [];
  const plan = planInUse(keyState);
  if (plan) {
    return [
      h("div", { class: "panel-title" }, "builds and voice use"),
      h("div", { class: "panel-big" }, `${plan.provider} plan`),
      note(planLine(plan)),
      button("use-plan", "change the plan →", () => ctx.go("plan")),
      button("add-key", "use a key instead →", () => ctx.go("key")),
      ...removeKey,
    ];
  }
  const usePlan = plans ? [button("use-plan", "use my plan instead →", () => ctx.go("plan"))] : [];
  return keyState.set
    ? [
        h("div", { class: "panel-title" }, "builds and voice use"),
        h("div", { class: "panel-big" }, keyState.provider ?? ""),
        note("a key is set. only the system can read it, and it's never shown again."),
        button("add-key", "replace the key →", () => ctx.go("key")),
        ...removeKey,
        ...usePlan,
      ]
    : [
        h("div", { class: "panel-title" }, "builds and voice use"),
        h("div", { class: "panel-big" }, "no key yet"),
        note(waysLine(keyState)),
        button("add-key", "add a key →", () => ctx.go("key"), true),
        ...(plans ? [button("use-plan", "use my plan →", () => ctx.go("plan"))] : []),
      ];
}

// The terms a key or a plan waits for, in place of its page's form, until a
// phone accepts them or the page goes back (Q104, Q143).
function waitForTerms(ctx: Ctx, form: HTMLElement, note: HTMLElement, terms: KeyTerms, path: "key" | "plan", accepted: () => void, back: () => void): void {
  termsAccepted = (data) => {
    if (data.provider !== terms.provider || data.path !== path) return;
    termsAccepted = null;
    accepted();
  };
  const backButton = h("button", { class: "button", "data-focus": true, "data-action": "cancel", onclick: back }, "back");
  form.replaceChildren(
    h("div", { class: "panel-title" }, `${terms.name}'s terms come first`),
    ...terms.terms.map((t) => h("div", { class: "terms-row", "data-terms": t.id }, t.name)),
    h("p", { class: "panel-note" }, terms.summary),
    h("p", { class: "panel-note" }, path === "key" ? "an adult accepts them on a paired phone. the key is kept once they do." : "an adult accepts them on a paired phone. builds use the plan once they do."),
    h("div", { class: "check-actions" }, backButton),
  );
  note.textContent = "no phone yet? pair one in settings → phones.";
  ctx.focus.refresh();
  ctx.focus.set(backButton);
}

export function keyPage(ctx: Ctx): View {
  let provider = keyState?.provider && PROVIDERS.includes(keyState.provider) ? keyState.provider : PROVIDERS[0];
  const value = h("span", { class: "button-value" }, "");
  const draw = () => (value.textContent = `‹ ${provider} ›`);
  const step = (by: number) => {
    provider = PROVIDERS[(PROVIDERS.indexOf(provider) + by + PROVIDERS.length) % PROVIDERS.length];
    ctx.sounds.play("move");
    draw();
  };
  const which = h("button", { class: "button", "data-focus": true, "data-action": "provider", "data-adjust": "provider", onclick: () => step(1) }, h("span", {}, "provider"), value);
  const field = h("input", {
    class: "music-search",
    "data-focus": true,
    "data-action": "key",
    type: "password",
    placeholder: "paste the key",
    "aria-label": "the key",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const form = h(
    "div",
    { class: "profile-form" },
    which,
    field,
    h("div", { class: "check-actions" }, h("button", { class: "button primary", "data-focus": true, "data-action": "save", onclick: () => void save() }, "save")),
  );
  const note = h("p", { class: "panel-note" }, "only the system can read it, and it's never shown again.");
  // The terms the key waits for, in place of the form, until a phone
  // accepts them or the page goes back.
  let waiting = false;
  const stopWaiting = () => {
    if (!waiting) return;
    waiting = false;
    termsAccepted = null;
    void daemon.stopKeyTerms().catch(() => {});
  };
  const showTerms = (terms: KeyTerms, key: string, grant: string | undefined) => {
    waiting = true;
    waitForTerms(
      ctx,
      form,
      note,
      terms,
      "key",
      () => {
        waiting = false;
        void keep(key, grant);
      },
      () => (stopWaiting(), ctx.back()),
    );
  };
  const keep = async (key: string, grant: string | undefined) => {
    let saved: KeyState | { terms: KeyTerms };
    try {
      saved = await daemon.saveKey(provider, key, grant);
    } catch (error) {
      if ((error as Error).message === "that needs the pin") ctx.forgetGrant();
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    if ("terms" in saved) {
      showTerms(saved.terms, key, grant);
      return;
    }
    setKeyState(saved);
    field.value = "";
    ctx.sounds.play("confirm");
    ctx.toast(`the key for ${provider} is kept`, "ok");
    ctx.back();
  };
  const save = async () => {
    const key = field.value.trim();
    if (!key) {
      ctx.toast("paste the key first", "fail");
      return;
    }
    const grant = await ctx.grant("the ai key");
    if (grant === null) return;
    await keep(key, grant || undefined);
  };
  draw();
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page profile" },
      ...heading("tv settings · ai", "add a key"),
      form,
      note,
    ),
    bar(ctx, "settings", "←→ provider · ↵ select · esc back"),
  );
  return {
    el,
    first: which,
    act(action) {
      if (action === "back") stopWaiting();
      if ((action === "left" || action === "right") && ctx.focus.get() === which) {
        step(action === "right" ? 1 : -1);
        return true;
      }
      return false;
    },
  };
}

// The household's plan for builds (Q143): one of the plans this box's
// channel offers, picked with left and right, past the PIN, and its
// provider's terms accepted on a phone first. Its CLI signs in to it the first
// time the builder runs (ADR-040).
export function planPage(ctx: Ctx): View {
  const plans = plansOf(keyState);
  let at = Math.max(0, plans.findIndex((plan) => plan.provider === keyState?.ai?.provider));
  const value = h("span", { class: "button-value" }, "");
  const about = h("p", { class: "panel-note", "data-plan": "about" }, "");
  const draw = () => {
    value.textContent = `‹ ${plans[at].provider} ›`;
    about.textContent = planLine(plans[at]);
  };
  const step = (by: number) => {
    at = (at + by + plans.length) % plans.length;
    ctx.sounds.play("move");
    draw();
  };
  const which = h("button", { class: "button", "data-focus": true, "data-action": "provider", "data-adjust": "provider", onclick: () => step(1) }, h("span", {}, "plan"), value);
  const form = h(
    "div",
    { class: "profile-form" },
    which,
    about,
    h("div", { class: "check-actions" }, h("button", { class: "button primary", "data-focus": true, "data-action": "save", onclick: () => void use() }, "use this plan")),
  );
  const note = h("p", { class: "panel-note" }, "builds then run on your plan, through its own app, within its own limits.");
  let waiting = false;
  const stopWaiting = () => {
    if (!waiting) return;
    waiting = false;
    termsAccepted = null;
    void daemon.stopPlanTerms().catch(() => {});
  };
  const choose = async (grant: string | undefined) => {
    const provider = plans[at].provider;
    let done: { provider: string; path: "plan" } | { terms: KeyTerms };
    try {
      done = await daemon.usePlan(provider, grant);
    } catch (error) {
      if ((error as Error).message === "that needs the pin") ctx.forgetGrant();
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    if ("terms" in done) {
      waiting = true;
      waitForTerms(
        ctx,
        form,
        note,
        done.terms,
        "plan",
        () => {
          waiting = false;
          void choose(grant);
        },
        () => (stopWaiting(), ctx.back()),
      );
      return;
    }
    if (keyState) setKeyState({ ...keyState, ai: { provider, path: "plan", accepted: true } });
    ctx.sounds.play("confirm");
    ctx.toast(`builds use your ${provider} plan now`, "ok");
    ctx.back();
  };
  const use = async () => {
    const grant = await ctx.grant("the ai plan");
    if (grant === null) return;
    await choose(grant || undefined);
  };
  draw();
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page profile" },
      ...heading("tv settings · ai", "use my plan"),
      form,
      note,
    ),
    bar(ctx, "settings", "←→ plan · ↵ select · esc back"),
  );
  return {
    el,
    first: which,
    act(action) {
      if (action === "back") stopWaiting();
      if ((action === "left" || action === "right") && ctx.focus.get() === which) {
        step(action === "right" ? 1 : -1);
        return true;
      }
      return false;
    },
  };
}
