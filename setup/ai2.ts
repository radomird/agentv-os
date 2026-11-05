// The AI (design page D3, step 6 of 12), with setup's own switch on. Each
// provider shows its own icon, fetched on the box from its site (ADR-069),
// or its name alone when there's none. Picking one offers its plan's
// sign-in right there (ADR-070), so voice works from the first day: an
// adult accepts the terms on the phone first, as always (ADR-023), then the
// TV shows the provider's own sign-in link as a QR code. A key from the
// phone is the second way, and "later, in settings" leaves it for Settings
// → AI, where a first build still asks too.
//
// With the switch off, setup/ai.ts is the whole step. This one reuses its
// terms, key and done screens.

import { h } from "../launcher/dom.ts";
import { again, done, key, terms } from "./ai.ts";
import { setup, type AiInfo, type PlanSignIn, type Provider } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

const ORDER: Provider[] = ["claude", "chatgpt", "gemini", "grok", "muse"];

// What the bar says on the right: the phone that's helping, if one is.
function info(ctx: Ctx): string {
  return ctx.info.phones.length ? "phone paired" : "";
}

function page(ctx: Ctx, command: string, title: string, line: HTMLElement, ...rest: HTMLElement[]): HTMLElement {
  const [prompt, headline] = heading(command, title, ctx.reduced());
  return h("div", { class: "setup-page d3" }, prompt, headline, line, ...rest);
}

// The provider's own icon, or nothing: then its name stands alone.
function icon(provider: Provider): HTMLElement {
  const img = h("img", { class: "ai-icon", src: `/api/ai/icon/${provider}`, alt: "", "data-icon": provider }) as HTMLImageElement;
  img.addEventListener("error", () => img.remove(), { once: true });
  return img;
}

// Where the step picks up: the providers, the ways in, the terms, the key,
// or the plan's sign-in.
export async function aiStep2(ctx: Ctx): Promise<View> {
  const ai = await setup.ai().catch(() => null);
  if (ai) ctx.ai = ai;
  if (!ai?.provider || !ai.path) return pick(ctx);
  if (!ai.accepted) return terms(ctx, ai);
  if (ai.path === "key") return ai.key.set && ai.key.provider === ai.provider ? done(ctx, ai) : key(ctx, ai);
  return ways(ctx, ai.provider);
}

function pick(ctx: Ctx): View {
  const cards = ORDER.map((provider) => {
    const offer = ctx.ai?.offers[provider];
    return h(
      "button",
      { class: "ai-card", "data-focus": true, "data-provider": provider, onclick: () => ctx.open(`ai/${provider}`) },
      icon(provider),
      h("span", { class: "ai-text" }, h("span", { class: "ai-name" }, offer?.name ?? provider), h("span", { class: "ai-maker" }, offer?.maker ?? "")),
    );
  });
  const el = page(ctx, "agentv ai", "pick your ai.", h("p", { class: "setup-line" }, "it builds your apps and answers what you ask"), h("div", { class: "ai-cards" }, ...cards));
  return { el, first: cards[0], info: info(ctx) };
}

// The one line under the headline, for how the plan's sign-in stands.
function said(offer: AiInfo["offers"][Provider], now: PlanSignIn | null): string {
  if (!offer.plan.offered) return offer.plan.note ?? `${offer.plan.name} is coming soon. a key works now`;
  const state = now?.now?.state;
  if (now?.signedIn) return `you're signed in to ${offer.plan.name}`;
  if (state === "waiting" && now?.now?.code) return `scan to sign in, then enter ${now.now.code}`;
  if (state === "waiting" && now?.now?.pastes) return "scan to sign in, then paste the code it gives you";
  if (state === "waiting") return "scan to sign in with your plan";
  if (state === "starting") return "getting the sign-in ready";
  if (state === "failed") return `that didn't work: ${now?.now?.reason ?? "it stopped"}. try again`;
  return "sign in with your plan, so voice works from today";
}

// The ways in for one provider: its plan, signed in right here, a key from
// the phone, or later. Once its plan is picked and the terms are accepted,
// the sign-in starts by itself, and its link shows as a QR code.
export function ways(ctx: Ctx, provider: Provider): View {
  const offer = ctx.ai!.offers[provider];
  const line = h("p", { class: "setup-line", "data-line": "sign-in" });
  const qr = h("img", { class: "qr", alt: "the sign-in's code to scan" }) as HTMLImageElement;
  const qrBox = h("div", { class: "ai-qr hidden" }, h("span", { class: "qr-box" }, qr));
  const field = h("input", { class: "text-field ai-code", type: "text", "data-focus": true, "data-action": "sign-in-code", "aria-label": "the code the sign-in gave you", placeholder: "paste the code", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const send = h("button", { class: "button primary", "data-focus": true, "data-action": "send-code", onclick: () => void sendCode() }, "↵ send");
  const paste = h("div", { class: "ai-paste hidden" }, field, send);
  let now: PlanSignIn | null = null;
  let timer = 0;
  let moved = false;
  let shown = "";

  const draw = () => {
    line.textContent = said(offer, now);
    const url = now?.now?.state === "waiting" ? now.now.url : undefined;
    qrBox.classList.toggle("hidden", !url);
    if (url && url !== shown) {
      shown = url;
      qr.src = `/api/ai/sign-in/qr?at=${Date.now()}`;
    }
    paste.classList.toggle("hidden", !(now?.now?.state === "waiting" && now.now.pastes && !now.now.code));
  };

  const look = async () => {
    try {
      now = (await setup.signIn()).signIn;
    } catch {
      return;
    }
    draw();
    if (now?.signedIn && !moved) {
      moved = true;
      clearInterval(timer);
      ctx.sounds.play("confirm");
      ctx.toast(`signed in to ${offer.plan.name}`, "ok");
      await ctx.finish("ai");
    }
  };

  const follow = () => {
    clearInterval(timer);
    timer = setInterval(() => {
      if (!line.isConnected) clearInterval(timer);
      else void look();
    }, 1000);
  };

  const start = async () => {
    try {
      const grant = await ctx.grant("the plan's sign-in");
      if (grant === null) return;
      now = (await setup.startSignIn(grant || undefined)).signIn;
    } catch (error) {
      ctx.toast((error as Error).message, "fail");
      ctx.sounds.play("failure");
      return;
    }
    draw();
    follow();
  };

  const sendCode = async () => {
    const code = field.value.trim();
    if (!code) return;
    field.value = "";
    try {
      const grant = await ctx.grant("the plan's sign-in");
      if (grant === null) return;
      await setup.signInCode(code, grant || undefined);
      ctx.toast("signing in…", "ok");
    } catch (error) {
      ctx.toast((error as Error).message, "fail");
      ctx.sounds.play("failure");
    }
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void sendCode();
    }
  });

  // A way picked: the provider and the way kept, then the terms on the
  // phone if they aren't accepted yet, or the sign-in right away.
  const choose = async (how: "plan" | "key") => {
    const ai = ctx.ai!;
    if (ai.provider !== provider || ai.path !== how) {
      try {
        ctx.ai = await setup.choose(provider, how);
      } catch (error) {
        ctx.toast((error as Error).message, "fail");
        ctx.sounds.play("failure");
        return;
      }
    }
    if (how === "key" || !ctx.ai?.accepted) {
      ctx.open("ai");
      return;
    }
    await start();
  };

  const plan = offer.plan.offered ? h("button", { class: "button primary", "data-focus": true, "data-path": "plan", onclick: () => void choose("plan") }, "↵ use my plan") : null;
  const keyButton = h("button", { class: `button${plan ? "" : " primary"}`, "data-focus": true, "data-path": "key", onclick: () => void choose("key") }, "use a key from my phone");
  const later = h("button", { class: "button", "data-focus": true, "data-action": "later", onclick: () => void ctx.finish("ai") }, "later, in settings");
  const options = h("div", { class: "ai-options" }, ...(plan ? [plan] : []), keyButton, later, paste);
  const el = page(ctx, `agentv ai ${offer.name}`, `sign in to ${offer.name}.`, line, options, qrBox);
  draw();

  // Back here with the plan picked and its terms accepted: the sign-in
  // starts by itself, or carries on where it was.
  const ai = ctx.ai!;
  if (ai.provider === provider && ai.path === "plan" && ai.accepted) {
    void setup.signIn().then(
      (answer) => {
        now = answer.signIn;
        draw();
        if (now?.signedIn) void look();
        else if (!now || now.now?.state === "failed") void start();
        else follow();
      },
      () => {},
    );
  }

  return {
    el,
    first: plan ?? keyButton,
    info: info(ctx),
    back: () => again(ctx),
    stop: () => clearInterval(timer),
  };
}
