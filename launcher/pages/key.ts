// The AI on the TV (ADR-009, ADR-022, ADR-047, S4.6): Settings, AI has a row
// that says what's in use, a plan or a key, and its page changes it. The key page takes a key, typed or
// pasted, for Claude, ChatGPT, Gemini, Grok or Muse. The daemon hands it to
// root and it's never shown again. The plan page picks the household's plan,
// from the ones this box's channel offers (Q143, ADR-053). Either is an
// adult's, past the PIN once there is one. A key or a plan whose provider's
// terms nobody here has accepted waits for them: the page shows them, an
// adult accepts them on a paired phone, and then the key is kept or the plan
// used (Q104, ADR-023).

import { daemon, type KeyState, type KeyTerms } from "../api.ts";
import { asWritten, h } from "../dom.ts";
import { loadingMark } from "../loading.ts";
import type { Ctx, View } from "../main.ts";
import { bar, heading } from "./parts.ts";
import { pinAsked } from "./pin.ts";

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

// The AI companies' names, as they write them.
const NAMES: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", grok: "Grok", muse: "Muse" };

export function providerName(id: string | null | undefined): string {
  return NAMES[id ?? ""] ?? id ?? "";
}

// The plans on offer: Claude's, ChatGPT's and Grok's, on every TV (ADR-087).
function plansOf(state: KeyState | null): { provider: string; name?: string }[] {
  return state?.plans ?? [{ provider: "claude", name: "Claude Pro or Max" }];
}

// The plan in use, once its terms are accepted, or null for a key or none.
function planInUse(state: KeyState | null): { provider: string; name?: string } | null {
  const ai = state?.ai;
  if (!ai || ai.path !== "plan" || !ai.accepted || !ai.provider) return null;
  return plansOf(state).find((plan) => plan.provider === ai.provider) ?? { provider: ai.provider };
}

// The value of AI's "Your AI" row.
export function aiValue(): string {
  if (!keyState) return "";
  const plan = planInUse(keyState);
  if (plan) return `${providerName(plan.provider)} plan`;
  return keyState.set ? providerName(keyState.provider) : "Not set up";
}

// A plan's name, as its company writes it.
function planName(plan: { provider: string; name?: string }): string {
  return plan.name ?? `${providerName(plan.provider)}'s plan`;
}

// A plan's line: its name, and when it's signed in.
function planLine(plan: { provider: string; name?: string }): string {
  return `${planName(plan)}. You sign in on your phone when you first build an app.`;
}

// The "Your AI" row's page: what's in use, a plan or a key, and changing it.
export function aiPanel(ctx: Ctx): HTMLElement[] {
  const note = (text: string) => h("p", { class: "panel-note" }, text);
  if (!keyState) return [h("div", { class: "panel-big" }, loadingMark())];
  const remove = async () => {
    const grant = await ctx.grant("your AI key");
    if (grant === null) return;
    try {
      setKeyState(await daemon.removeKey(grant || undefined));
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast("Key removed", "ok");
    ctx.render("settings/your-ai", "add-key");
  };
  const plans = plansOf(keyState).length > 0;
  const button = (action: string, label: string, onclick: () => void, primary = false) => h("button", { class: `button${primary ? " primary" : ""}`, "data-focus": true, "data-action": action, onclick }, label);
  const removeKey = keyState.set ? [button("remove-key", "Remove key", () => void remove())] : [];
  const plan = planInUse(keyState);
  if (plan) {
    // With setup's own switch on, the plan's sign-in is here too, for a
    // household that left it for later in setup (ADR-070).
    const signIn = signInHere() ? [button("plan-sign-in", "Sign in to your plan", () => ctx.go("plan-sign-in"))] : [];
    return [
      h("div", { class: "panel-title" }, "Your AI"),
      h("div", { class: "panel-big" }, `${providerName(plan.provider)} plan`),
      note(signIn.length ? "Sign in now to ask your TV things" : planLine(plan)),
      ...signIn,
      button("use-plan", "Change plan", () => ctx.go("plan")),
      button("add-key", "Use a key instead", () => ctx.go("key")),
      ...removeKey,
    ];
  }
  const usePlan = plans ? [button("use-plan", "Use my plan instead", () => ctx.go("plan"))] : [];
  return keyState.set
    ? [
        h("div", { class: "panel-title" }, "Your AI"),
        h("div", { class: "panel-big" }, providerName(keyState.provider)),
        note("Your key is saved. It's never shown again."),
        button("add-key", "Replace key", () => ctx.go("key")),
        ...removeKey,
        ...usePlan,
      ]
    : [
        h("div", { class: "panel-title" }, "Your AI"),
        h("div", { class: "panel-big" }, "Not set up"),
        note(plans ? "An API key, or your plan" : "An API key"),
        button("add-key", "Add an API key", () => ctx.go("key"), true),
        ...(plans ? [button("use-plan", "Use my plan", () => ctx.go("plan"))] : []),
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
  const backButton = h("button", { class: "button", "data-focus": true, "data-action": "cancel", onclick: back }, "Back");
  form.replaceChildren(
    h("div", { class: "panel-title" }, `${providerName(terms.provider) || terms.name}'s terms come first`),
    ...terms.terms.map((t) => h("div", { class: "terms-row", "data-terms": t.id }, t.name)),
    h("p", { class: "panel-note" }, terms.summary),
    h("p", { class: "panel-note" }, "Accept them on your phone"),
    h("div", { class: "check-actions" }, backButton),
  );
  note.textContent = "No phone yet? Pair one in Settings.";
  ctx.focus.refresh();
  ctx.focus.set(backButton);
}

export function keyPage(ctx: Ctx): View {
  let provider = keyState?.provider && PROVIDERS.includes(keyState.provider) ? keyState.provider : PROVIDERS[0];
  const value = h("span", { class: "button-value" }, "");
  const draw = () => (value.textContent = providerName(provider));
  const step = (by: number) => {
    provider = PROVIDERS[(PROVIDERS.indexOf(provider) + by + PROVIDERS.length) % PROVIDERS.length];
    ctx.sounds.play("move");
    draw();
  };
  const which = h("button", { class: "button", "data-focus": true, "data-action": "provider", "data-adjust": "provider", onclick: () => step(1) }, h("span", {}, "AI"), value);
  const field = h("input", {
    class: "music-search",
    "data-focus": true,
    "data-action": "key",
    type: "password",
    placeholder: "Paste the key",
    "aria-label": "The key",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const form = h(
    "div",
    { class: "profile-form" },
    which,
    field,
    h("div", { class: "check-actions" }, h("button", { class: "button primary", "data-focus": true, "data-action": "save", onclick: () => void save() }, "Save")),
  );
  const note = h("p", { class: "panel-note" }, "It's never shown again");
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
      if (pinAsked(error)) ctx.forgetGrant();
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
    ctx.toast(`${providerName(provider)} key saved`, "ok");
    ctx.back();
  };
  const save = async () => {
    const key = field.value.trim();
    if (!key) {
      ctx.toast("Paste the key first", "fail");
      return;
    }
    const grant = await ctx.grant("your AI key");
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
      ...heading("tv settings · ai", "Add an API key"),
      form,
      note,
    ),
    bar(ctx, "settings"),
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

// The household's plan for builds (Q143): one of the plans on offer,
// picked with left and right, past the PIN, and its
// provider's terms accepted on a phone first. Its CLI signs in to it the first
// time the builder runs (ADR-040).
export function planPage(ctx: Ctx): View {
  const plans = plansOf(keyState);
  let at = Math.max(0, plans.findIndex((plan) => plan.provider === keyState?.ai?.provider));
  const value = h("span", { class: "button-value" }, "");
  const about = h("p", { class: "panel-note", "data-plan": "about" }, "");
  const draw = () => {
    value.textContent = providerName(plans[at].provider);
    about.textContent = planLine(plans[at]);
  };
  const step = (by: number) => {
    at = (at + by + plans.length) % plans.length;
    ctx.sounds.play("move");
    draw();
  };
  const which = h("button", { class: "button", "data-focus": true, "data-action": "provider", "data-adjust": "provider", onclick: () => step(1) }, h("span", {}, "Plan"), value);
  const form = h(
    "div",
    { class: "profile-form" },
    which,
    about,
    h("div", { class: "check-actions" }, h("button", { class: "button primary", "data-focus": true, "data-action": "save", onclick: () => void use() }, "Use this plan")),
  );
  // Empty until it waits for the plan's terms: the plan's line above is the
  // page's one line.
  const note = h("p", { class: "panel-note" }, "");
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
      if (pinAsked(error)) ctx.forgetGrant();
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
    ctx.toast(`Now using your ${providerName(provider)} plan`, "ok");
    ctx.back();
  };
  const use = async () => {
    const grant = await ctx.grant("your AI plan");
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
      ...heading("tv settings · ai", "Use my plan"),
      form,
      note,
    ),
    bar(ctx, "settings"),
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

// Whether setup's own switch is on, as the launcher marks it on the page.
function signInHere(): boolean {
  return (document.documentElement.dataset.features ?? "").split(" ").includes("setup2");
}

interface PlanSignIn {
  provider: string;
  signedIn: boolean;
  now?: { state: "starting" | "waiting" | "done" | "failed"; url?: string; code?: string; pastes?: boolean; reason?: string };
}

async function signInCall(method: string, path: string, body?: unknown, grant?: string): Promise<{ signIn?: PlanSignIn | null }> {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(grant ? { "X-AgenTV-Grant": grant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "Couldn't sign in");
  return data;
}

// Settings, AI's sign-in to the household's plan (ADR-070): the same
// sign-in a first build runs, started from here. Its link shows as a QR
// code, and the code its page gives is typed on the phone's keyboard into
// the field. Once it's in, back to Settings.
export function planSignInPage(ctx: Ctx): View {
  const line = h("p", { class: "panel-note", "data-line": "sign-in" }, "Getting the sign-in ready…");
  const qr = h("img", { alt: "The sign-in's code to scan" }) as HTMLImageElement;
  const qrBox = h("div", { class: "pair-qr build-qr hidden" }, qr);
  const field = h("input", { class: "music-search", type: "text", "data-focus": true, "data-action": "sign-in-code", "aria-label": "The code the sign-in gave you", placeholder: "Paste the code", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const send = h("button", { class: "button primary", "data-focus": true, "data-action": "send-code", onclick: () => void sendCode() }, "Send");
  const paste = h("div", { class: "profile-form hidden" }, field, h("div", { class: "check-actions" }, send));
  const again = h("button", { class: "button", "data-focus": true, "data-action": "again", onclick: () => void start() }, "Start over");
  let grant: string | undefined;
  let shown = "";
  let timer = 0;
  let moved = false;

  const draw = (now: PlanSignIn | null) => {
    const state = now?.now?.state;
    // The code to enter keeps its capitals.
    if (!now?.signedIn && state === "waiting" && now?.now?.code) line.replaceChildren("Scan to sign in, then enter ", asWritten(now.now.code));
    else
      line.textContent = now?.signedIn
        ? "You're signed in"
        : state === "waiting" && now?.now?.pastes
          ? "Scan to sign in, then paste the code it gives you"
          : state === "waiting"
            ? "Scan to sign in with your plan"
            : state === "failed"
              ? "Couldn't sign in"
              : "Getting the sign-in ready…";
    const url = state === "waiting" ? now?.now?.url : undefined;
    qrBox.classList.toggle("hidden", !url);
    if (url && url !== shown) {
      shown = url;
      qr.src = `/api/ai/sign-in/qr?at=${Date.now()}`;
    }
    paste.classList.toggle("hidden", !(state === "waiting" && now?.now?.pastes && !now.now.code));
  };

  const look = async () => {
    let now: PlanSignIn | null = null;
    try {
      now = (await signInCall("GET", "/api/ai/sign-in")).signIn ?? null;
    } catch {
      return;
    }
    draw(now);
    if (now?.signedIn && !moved && shown) {
      moved = true;
      clearInterval(timer);
      ctx.sounds.play("confirm");
      ctx.toast("You're signed in", "ok");
      ctx.back();
    }
  };

  const start = async () => {
    const asked = await ctx.grant("your AI plan");
    if (asked === null) return;
    grant = asked || undefined;
    try {
      draw((await signInCall("POST", "/api/ai/sign-in", {}, grant)).signIn ?? null);
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
    }
  };

  const sendCode = async () => {
    const code = field.value.trim();
    if (!code) return;
    field.value = "";
    try {
      await signInCall("POST", "/api/ai/sign-in/code", { code }, grant);
      ctx.toast("Signing in…", "ok");
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
    }
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void sendCode();
    }
  });

  void signInCall("GET", "/api/ai/sign-in").then(
    (answer) => {
      const now = answer.signIn ?? null;
      draw(now);
      if (!now?.signedIn && (!now || now.now?.state === "failed")) void start();
    },
    () => {},
  );
  timer = setInterval(() => {
    if (!line.isConnected) clearInterval(timer);
    else void look();
  }, 1000);

  const el = h(
    "div",
    { class: "screen" },
    h("div", { class: "page profile plan-sign-in" }, ...heading("tv settings · ai", "Sign in to your plan"), line, paste, again, qrBox),
    bar(ctx, "settings"),
  );
  return { el, first: again };
}
