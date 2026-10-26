// The AI provider (board 04, ADR-022, ADR-023): Claude, ChatGPT or Gemini,
// then the household's plan or an API key. Picking one shows that
// provider's terms for that way in, and nothing of it installs until an
// adult accepts them on the phone, which the box records. A key is then
// pasted on the phone, or typed here; a plan signs in through the provider's
// own CLI when the agent first builds something (stage 6). Either way a
// check mark says so, and the provider's agent CLI arrives in the
// background, through Omarchy's own wrapper.

import { screen } from "../launcher/api.ts";
import { h } from "../launcher/dom.ts";
import { setup, type AiInfo, type Path, type Provider } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

const ORDER: Provider[] = ["claude", "chatgpt", "gemini"];

// What the CLI's first run says, for a line or the status bar.
export function cliLine(ai: AiInfo): string | null {
  if (!ai.provider || !ai.accepted) return null;
  const name = ai.offers[ai.provider].cliName;
  if (!ai.cli || ai.cli.state === "installing") return `${name} installing`;
  if (ai.cli.state === "ready") return `${name} ready`;
  return `${name} didn't install`;
}

// Where the step picks up: the provider to pick, its terms, the key, or a
// check mark, from what the daemon has.
export async function aiStep(ctx: Ctx): Promise<View> {
  const ai = await setup.ai().catch(() => null);
  if (ai) ctx.ai = ai;
  if (!ai?.provider || !ai.path) return pick(ctx);
  if (!ai.accepted) return terms(ctx, ai);
  if (ai.path === "key" && !(ai.key.set && ai.key.provider === ai.provider)) return key(ctx, ai);
  return done(ctx, ai);
}

// Back from any of the provider's pages picks again.
function again(ctx: Ctx): boolean {
  void setup.choose(null).then(() => ctx.open("ai", "back"), () => {});
  return true;
}

function pick(ctx: Ctx): View {
  const cards = ORDER.map((provider, i) => {
    const offer = ctx.ai?.offers[provider];
    return h(
      "button",
      { class: "provider", "data-focus": true, "data-provider": provider, onclick: () => ctx.open(`ai/${provider}`) },
      h("span", { class: "provider-index" }, `0${i + 1}`),
      h("span", { class: "provider-text" }, h("span", { class: "provider-name" }, offer?.name ?? provider), h("span", { class: "provider-maker" }, offer?.maker ?? "")),
    );
  });
  const later = h("button", { class: "button", "data-focus": true, "data-action": "later", onclick: () => void ctx.finish("ai") }, "set it up later");
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", {}, ...heading("which ai do you use?", "pick one.", ctx.reduced())),
    h("div", { class: "providers" }, ...cards),
    h("div", { class: "setup-foot" }, h("span", { class: "setup-note" }, "→ then your plan or an api key, on your phone."), later),
  );
  return { el, first: cards[0], info: "←→ move · ↵ pick" };
}

// The household's plan, or an API key. A plan only where the provider's CLI
// runs one on a box like this (ADR-022).
export function path(ctx: Ctx, provider: Provider): View {
  const offer = ctx.ai!.offers[provider];
  const choose = async (how: Path) => {
    try {
      ctx.ai = await setup.choose(provider, how);
    } catch (error) {
      ctx.toast((error as Error).message, "fail");
      ctx.sounds.play("failure");
      return;
    }
    ctx.open("ai");
  };
  const plan = offer.plan.offered
    ? h(
        "button",
        { class: "provider", "data-focus": true, "data-path": "plan", onclick: () => void choose("plan") },
        h("span", { class: "provider-index" }, "01"),
        h("span", { class: "provider-text" }, h("span", { class: "provider-name" }, "my plan"), h("span", { class: "provider-maker" }, offer.plan.name)),
      )
    : h(
        "div",
        { class: "provider off", "data-path": "plan" },
        h("span", { class: "provider-index" }, "01"),
        h("span", { class: "provider-text" }, h("span", { class: "provider-name" }, "my plan"), h("span", { class: "provider-maker" }, `${offer.plan.name} · coming soon`)),
      );
  const keyCard = h(
    "button",
    { class: "provider", "data-focus": true, "data-path": "key", onclick: () => void choose("key") },
    h("span", { class: "provider-index" }, "02"),
    h("span", { class: "provider-text" }, h("span", { class: "provider-name" }, "an api key"), h("span", { class: "provider-maker" }, `from your ${offer.maker} account`)),
  );
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", {}, ...heading(`${offer.name} --how`, "plan or key?", ctx.reduced())),
    h("div", { class: "providers two" }, plan, keyCard),
    h("span", { class: "setup-note" }, "voice works either way: your phone does the dictation."),
  );
  return { el, first: offer.plan.offered ? (plan as HTMLElement) : keyCard, info: "←→ move · ↵ pick · esc back", back: () => again(ctx) };
}

function termsList(ai: AiInfo, done: boolean): HTMLElement {
  const offer = ai.offers[ai.provider!];
  return h(
    "div",
    { class: "ready-list terms-list" },
    ...offer.terms[ai.path!].map((t) => h("span", { class: `ready-row ${done ? "mark-done" : "mark-todo"}`, "data-terms": t.id }, h("span", {}, h("b", {}, done ? "[x]" : "[ ]"), ` ${t.name}`))),
  );
}

// The terms for this way in: their names, and a QR code for a phone. An
// adult reads them there, with a short summary, and accepts them.
function terms(ctx: Ctx, ai: AiInfo): View {
  const offer = ai.offers[ai.provider!];
  const qr = h("img", { class: "qr", alt: "" }) as HTMLImageElement;
  const label = h("span", { class: "qr-label" });
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", {}, ...heading(`${offer.name} terms`, "the terms first.", ctx.reduced())),
    h(
      "div",
      { class: "terms" },
      h("div", { class: "terms-left" }, termsList(ai, false), h("p", { class: "setup-note" }, "an adult accepts them on the phone. nothing installs before that.")),
      h("div", { class: "welcome-qr small" }, h("span", { class: "qr-box" }, qr), label),
    ),
  );
  // A code that pairs a phone, which then opens on the terms; a phone that's
  // paired already shows them by itself.
  void setup.pair().then((code) => {
    if (code?.url) qr.setAttribute("src", `/api/phones/qr?${code.code}`);
    label.textContent = code ? `pair a phone · code ${code.code}` : "";
  });
  let moved = false;
  return {
    el,
    info: "waiting for an adult on the phone",
    back: () => again(ctx),
    heard(event, data) {
      const next = data as AiInfo;
      if (event !== "ai" || moved || !next.accepted) return;
      moved = true;
      ctx.sounds.play("confirm");
      void screen.cliInstall();
      ctx.open("ai", "forward");
    },
  };
}

// The key: pasted on the phone (board 05), or typed here with a keyboard.
function key(ctx: Ctx, ai: AiInfo): View {
  const offer = ai.offers[ai.provider!];
  const field = h("input", { class: "text-field key-field", type: "password", "data-focus": true, "aria-label": `the ${offer.name} api key`, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const save = async () => {
    if (!field.value) return;
    const typed = field.value;
    field.value = "";
    try {
      await setup.key(ai.provider!, typed);
    } catch (error) {
      ctx.toast((error as Error).message, "fail");
      ctx.sounds.play("failure");
      return;
    }
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    }
  });
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "save-key", onclick: () => void save() }, "↵ save");
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", {}, ...heading(`${offer.name} key`, "paste your key.", ctx.reduced())),
    h("div", { class: "key-row" }, field, go),
    h("span", { class: "setup-note" }, "on your phone, or type it here. it stays on this tv, and nobody sees it again."),
  );
  let moved = false;
  return {
    el,
    first: field,
    info: cliLine(ai) ?? "waiting for the key",
    back: () => again(ctx),
    heard(event, data) {
      const next = data as { set?: boolean; provider?: string };
      if (event !== "key" || moved || !next.set || next.provider !== ai.provider) return;
      moved = true;
      ctx.sounds.play("confirm");
      ctx.open("ai", "forward");
    },
  };
}

// The check mark: what's done, and the CLI arriving.
function done(ctx: Ctx, ai: AiInfo): View {
  const offer = ai.offers[ai.provider!];
  const cli = h("span", { class: "ready-row" });
  const drawCli = (now: AiInfo) => {
    const state = now.cli?.state ?? "installing";
    cli.className = `ready-row ${state === "ready" ? "mark-done" : state === "failed" ? "mark-bad" : "mark-now"}`;
    cli.replaceChildren(h("span", {}, h("b", {}, state === "ready" ? "[x]" : state === "failed" ? "[!]" : "[>]"), ` ${cliLine(now)}${now.cli?.state === "ready" && now.cli.version ? ` · ${now.cli.version}` : ""}`));
  };
  drawCli(ai);
  const accepted = ai.accepted!;
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "continue", onclick: () => void ctx.finish("ai") }, "↵ continue");
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", { class: "setup-top" }, h("div", {}, ...heading(`${offer.name}`, "all set.", ctx.reduced())), go),
    h(
      "div",
      { class: "ready-list" },
      h("span", { class: "ready-row mark-done" }, h("span", {}, h("b", {}, "[x]"), ` terms accepted · ${accepted.by.viewer} on ${accepted.by.phone}`)),
      ai.path === "key"
        ? h("span", { class: "ready-row mark-done" }, h("span", {}, h("b", {}, "[x]"), " key kept · root's alone"))
        : h("span", { class: "ready-row mark-done" }, h("span", {}, h("b", {}, "[x]"), ` ${offer.plan.name} · signs in when your agent first builds an app`)),
      cli,
    ),
  );
  // The CLI's first run, in case it hasn't started: after a restart, say.
  if (!ai.cli || ai.cli.state === "failed") void screen.cliInstall();
  return {
    el,
    first: go,
    info: cliLine(ai) ?? "",
    back: () => again(ctx),
    heard(event, data) {
      if (event !== "ai") return;
      const now = { ...ai, ...(data as Partial<AiInfo>), offers: ai.offers, key: ai.key };
      drawCli(now);
      ctx.status(cliLine(now) ?? "");
    },
  };
}
