// Your agent's builds on the TV (ADR-043 to ADR-046, boards 10, 17 and 20):
// an adult says what they'd like, typed here or on the phone, and the agent
// says what it understood, with roughly what it costs and how long it takes.
// Once it's confirmed, the build runs in the background while the TV is used
// as usual, its steps showing here and on its tile. A finished app, or a plan
// for a request no recipe fits, waits for an adult's yes on the phone, behind
// the PIN. One that failed can be tried again or put away.
//
// The tiles for builds that aren't on home yet show in Apps, and the newest
// on home in its first free cell. The TV says when one moves on.

import { daemon, type App, type BuildsState, type BuildView } from "../api.ts";
import { h } from "../dom.ts";
import { firstFree } from "../layout.ts";
import type { Ctx, View } from "../main.ts";
import { logo, placeTile } from "./home.ts";
import { bar, heading } from "./parts.ts";

// Kept between visits so the pages draw at once, and asked for again as a
// build moves on.
let state: BuildsState | null = null;
// Each build's state when last heard, so a move is told once.
const heard = new Map<string, string>();

export function builds(): BuildView[] {
  return state?.builds ?? [];
}

export function buildsState(): BuildsState | null {
  return state;
}

// The builds that aren't on home: going, waiting for someone, or failed.
export function underway(): BuildView[] {
  return builds().filter((b) => b.state !== "installed" && b.state !== "kept");
}

export async function loadBuilds(ctx: Ctx): Promise<void> {
  if (ctx.state.viewer.role !== "adult") {
    state = null;
    return;
  }
  try {
    state = await daemon.builds();
  } catch {
    return;
  }
  for (const b of state.builds) {
    const was = heard.get(b.build);
    heard.set(b.build, b.state);
    if (was === undefined || was === b.state) continue;
    const name = nameOf(b);
    if (b.state === "approve") ctx.toast(`${name} is ready: approve it on your phone`, "ok");
    else if (b.state === "plan") ctx.toast(`your agent has a plan for ${name}: approve it on your phone`, "ok");
    else if (b.state === "confirm") ctx.toast(`your agent read what you asked: check it in apps`, "ok");
    else if (b.state === "plan-sign-in") ctx.toast(`sign in to your ${b.provider} plan to build ${name}`, "ok");
    else if (b.state === "installed" && was === "approve") ctx.toast(`${name} is on your home`, "ok");
    else if (b.state === "failed") ctx.toast(`couldn't build ${name}`, "fail");
  }
}

function nameOf(b: BuildView): string {
  return (b.name ?? b.sentence).toLowerCase();
}

function money(dollars: number): string {
  return dollars < 10 ? `$${dollars.toFixed(2)}` : `$${Math.round(dollars)}`;
}

// What a build says on its tile: the word at its top and the line under it.
function tileWords(b: BuildView): { label: string; line: string; bad?: boolean } {
  const done = b.steps.filter((s) => s.state === "done").length;
  switch (b.state) {
    case "starting":
      return { label: "building", line: "starting" };
    case "running":
      if (b.phase === "understand") return { label: "building", line: "reading what you asked" };
      if (b.phase === "plan") return { label: "building", line: "making a plan" };
      return { label: "building", line: b.steps.length ? `${done} of ${b.steps.length} steps` : "starting" };
    case "confirm":
      return { label: "check it", line: "is this what you meant?" };
    case "plan":
      return { label: "plan", line: "approve the plan on your phone" };
    case "approve":
      return { label: "● ready", line: "approve it on your phone" };
    case "sign-in":
      return { label: "sign in", line: "it needs your sign-in" };
    case "plan-sign-in":
      return { label: "sign in", line: `sign in to your ${b.provider} plan` };
    case "failed":
      return { label: "couldn't build", line: `✗ ${b.reason ?? "it stopped"}`, bad: true };
    default:
      return { label: "", line: "" };
  }
}

export function buildTile(ctx: Ctx, b: BuildView): HTMLElement {
  const words = tileWords(b);
  return h(
    "button",
    {
      class: "tile size-s build-tile",
      "data-focus": true,
      "data-build": b.build,
      "aria-label": nameOf(b),
      onclick: () => ctx.go(`build/${b.build}`),
    },
    h("div", { class: "tile-top" }, logo({ id: b.id, name: b.name ?? b.sentence } as App), h("span", { class: `tile-label${words.bad ? " tile-quit" : ""}` }, words.label)),
    h("span", { class: "tile-name" }, nameOf(b)),
    h("span", { class: `tile-line${words.bad ? " tile-quit" : " tile-state"}` }, words.line),
  );
}

// The newest build that isn't on home, in home's first free cell, when there
// is one. Not part of the layout: it goes once the app is on home.
export function homeBuildTile(ctx: Ctx): HTMLElement | null {
  const b = underway()[0];
  if (!b) return null;
  const place = firstFree(ctx.state.layout, "s");
  if (!place) return null;
  const el = buildTile(ctx, b);
  placeTile(el, { id: b.build, size: "s", ...place });
  return el;
}

// What home's bar says about the newest build, when one is waiting or going.
export function buildNotice(): string {
  const b = underway()[0];
  if (!b) return "";
  const name = nameOf(b);
  if (b.state === "approve") return `${name} is ready · approve it on your phone`;
  if (b.state === "plan") return `a plan for ${name} · approve it on your phone`;
  if (b.state === "plan-sign-in") return `${name} · sign in to your ${b.provider} plan`;
  if (b.state === "failed") return `couldn't build ${name}`;
  if (b.state === "running" || b.state === "starting") return `building ${name}`;
  return "";
}

// --- What to make ------------------------------------------------------------

export function buildAsk(ctx: Ctx): View {
  const field = h("input", {
    class: "music-search build-ask",
    "data-focus": true,
    "data-field": "sentence",
    type: "text",
    maxlength: "300",
    placeholder: "a game like tetris, or the photos on my nas",
    "aria-label": "what should your agent make",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const wishes = state?.wishes ?? [];
  let asking = false;
  const ask = async (said?: string) => {
    const sentence = (said ?? field.value).trim();
    if (!sentence || asking) {
      if (!sentence) ctx.toast("say what you'd like first", "fail");
      return;
    }
    asking = true;
    let made: BuildView;
    try {
      made = await daemon.ask(sentence);
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return;
    } finally {
      asking = false;
    }
    ctx.sounds.play("confirm");
    heard.set(made.build, made.state);
    state = state ? { ...state, builds: [made, ...state.builds], wishes: state.wishes.filter((w) => w.toLowerCase() !== sentence.toLowerCase()) } : state;
    ctx.back();
    ctx.go(`build/${made.build}`);
  };
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page profile" },
      ...heading("tv app build", "what should i make?"),
      h("div", { class: "panel-title" }, "app to make"),
      field,
      h("p", { class: "panel-note" }, "type here, or on your phone. your agent builds it in the background, and you can keep using the tv."),
      h("div", { class: "check-actions" }, h("button", { class: "button primary", "data-focus": true, "data-action": "ask", onclick: () => void ask() }, "ask")),
      // What setup kept for later: each one asked with one press.
      ...(wishes.length
        ? [
            h("div", { class: "panel-title build-wishes" }, "kept from setup"),
            h("div", { class: "check-actions" }, ...wishes.map((wish) => h("button", { class: "button", "data-focus": true, "data-wish": wish, onclick: () => void ask(wish) }, wish.toLowerCase()))),
          ]
        : []),
    ),
    bar(ctx, "apps", "↵ ask · esc back"),
  );
  return {
    el,
    first: field,
    act(action) {
      if (action !== "ok" || ctx.focus.get() !== field) return false;
      void ask();
      return true;
    },
  };
}

// --- One build -----------------------------------------------------------------

const MARKS: Record<BuildView["steps"][number]["state"], string> = { done: "[x]", running: "[~]", waiting: "[ ]", failed: "[!]" };

function steps(b: BuildView): HTMLElement {
  return h(
    "div",
    { class: "updating-steps build-steps" },
    ...b.steps.map((s) => h("div", { class: `updating-step${s.state === "running" ? " now" : ""}${s.state === "failed" ? " bad" : ""}` }, h("b", {}, MARKS[s.state]), ` ${s.id.replace(/-/g, " ")}`)),
  );
}

function progress(b: BuildView): HTMLElement {
  const done = b.steps.filter((s) => s.state === "done").length;
  const fill = h("div", { class: "updating-fill" });
  fill.style.transform = `scaleX(${Math.max(0.02, b.steps.length ? done / b.steps.length : 0)})`;
  return h("div", { class: "updating-bar build-bar", role: "img", "aria-label": `${done} of ${b.steps.length} steps done` }, fill);
}

// What it'll cost, in the words the confirm step uses.
function costLine(b: BuildView): string {
  if (b.path === "plan") return `on your ${b.provider} plan, within its own limits`;
  const cap = state?.settings.cap.build;
  const range = b.cost ? `about ${money(b.cost.low)} to ${money(b.cost.high)} on your ${b.provider} key` : `on your ${b.provider} key`;
  return cap ? `${range}, and never more than ${money(cap)}` : range;
}

function row(ok: boolean, label: string, value: string): HTMLElement {
  return h("div", { class: `check-row${ok ? "" : " bad"}` }, h("b", {}, ok ? "✓" : "✗"), ` ${label}  `, h("span", { class: "build-value" }, value));
}

export function buildPage(ctx: Ctx, which: string): View {
  const b = builds().find((x) => x.build === which);
  if (!b) {
    // Not heard of yet, or put away: asked for once more.
    const el = h("div", { class: "screen" }, h("div", { class: "page profile" }, ...heading("tv app build", "…")), bar(ctx, "apps", "esc back"));
    void loadBuilds(ctx).then(() => {
      if (!el.isConnected) return;
      if (builds().some((x) => x.build === which)) ctx.render(`build/${which}`);
      else ctx.back();
    });
    return { el };
  }
  const name = nameOf(b);
  const act = async (what: () => Promise<unknown>, done?: string) => {
    try {
      await what();
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
      return false;
    }
    ctx.sounds.play("confirm");
    if (done) ctx.toast(done, "ok");
    await loadBuilds(ctx);
    return true;
  };
  const forget = async () => {
    if (await act(() => daemon.forget(b.build))) ctx.back();
  };
  const button = (label: string, action: string, onclick: () => void, primary = false) =>
    h("button", { class: `button${primary ? " primary" : ""}`, "data-focus": true, "data-action": action, onclick }, label);
  const note = (text: string) => h("p", { class: "panel-note" }, text);

  let title: string;
  let body: (HTMLElement | null)[] = [];
  let buttons: HTMLElement[] = [];
  let keys = "esc back";
  switch (b.state) {
    case "starting":
    case "running":
      if (b.phase === "understand") {
        title = "reading what you asked.";
        body = [h("div", { class: "prompt build-said" }, `"${b.sentence}"`), note("your agent is working out what you'd like. it takes a moment.")];
      } else if (b.phase === "plan") {
        title = `a plan for ${name}.`;
        body = [note("no recipe fits this, so your agent is writing a plan first. you'll approve it on your phone before anything is built.")];
      } else {
        title = `building ${name}.`;
        const minutes = b.minutes ? ` it takes about ${b.minutes} minutes.` : "";
        body = [
          progress(b),
          steps(b),
          note(`you can keep using the tv.${minutes} when it's done, approve ${name} on your phone.`),
          b.path === "key" && b.spent !== undefined ? note(`${money(b.spent)} so far.`) : null,
        ];
      }
      buttons = [button("stop", "stop", () => void act(() => daemon.stopBuild(), `stopped ${name}`))];
      break;
    case "confirm": {
      const u = b.understood!;
      title = "is this what you meant?";
      body = [
        h("div", { class: "prompt build-said" }, `"${b.sentence}"`),
        h(
          "div",
          { class: "check-rows" },
          row(true, "name", u.name.toLowerCase()),
          row(true, "kind", u.recipe ? u.recipe : "no recipe fits: a plan first, for you to approve on your phone"),
          u.address ? row(true, "site", u.address) : null,
          row(true, "it'll be", u.says.toLowerCase()),
          row(true, "cost", costLine(b)),
          b.minutes ? row(true, "time", `about ${b.minutes} minutes`) : null,
        ),
        note("it's built in the background, and approved on your phone before it's on your home."),
      ];
      buttons = [button("build it", "confirm", () => void act(() => daemon.confirm(b.build)).then((ok) => ok && ctx.render(`build/${b.build}`)), true), button("not this", "forget", () => void forget())];
      keys = "↵ build it · esc back";
      break;
    }
    case "plan": {
      const p = b.plan!;
      const reach = p.permissions.origins.length ? p.permissions.origins.join(", ") : "nothing on the internet";
      title = `a plan for ${name}.`;
      body = [
        note(p.says.toLowerCase()),
        h("div", { class: "updating-steps build-steps" }, ...p.steps.map((s, i) => h("div", { class: "updating-step" }, h("b", {}, `${i + 1}.`), ` ${s.does}`))),
        h("div", { class: "check-rows" }, row(true, "reaches", reach), row(true, "packages", p.packages.length ? p.packages.map((x) => x.name).join(", ") : "none"), row(true, "cost", costLine(b))),
        note("approve it on your phone, with the pin, and your agent builds it."),
      ];
      buttons = [button("not this", "forget", () => void forget())];
      break;
    }
    case "approve":
      title = `${name} is ready.`;
      body = [note(`your agent built it, and its checks passed. approve it on your phone, with the pin, to put ${name} on your home.`), steps(b)];
      buttons = [button("not this", "forget", () => void forget())];
      break;
    case "plan-sign-in": {
      // The plan's sign-in (ADR-040): the CLI's own link, as a QR code for
      // the phone's camera, and the code to enter on its page, or the code
      // its page gives to paste on the phone.
      const s = b.signIn;
      title = `sign in to your ${b.provider} plan.`;
      if (s?.state === "waiting" && s.url) {
        const image = h("img", { src: `/api/builds/${b.build}/qr?at=${encodeURIComponent(b.at)}`, alt: `a qr code to sign in to ${b.provider}` });
        const qr = h("div", { class: "pair-qr build-qr" }, image);
        image.addEventListener("error", () => qr.classList.add("hidden"));
        body = [
          note(`${name} is built on your ${b.provider} plan, and your agent isn't signed in to it yet. you sign in once.`),
          qr,
          s.code ? h("div", { class: "pair-code build-code" }, s.code) : null,
          note(s.code ? `scan it with your phone's camera, sign in, and enter the code there.` : "scan it with your phone's camera and sign in. then paste the code the page gives you on your phone's agentv page."),
        ];
      } else if (s?.state === "done") {
        body = [note(`you're signed in. your agent goes on with ${name}.`)];
      } else {
        body = [note(`starting the sign-in. ${name} is built on your ${b.provider} plan, and you sign in to it once, with your phone.`)];
      }
      buttons = [button("stop", "stop", () => void act(() => daemon.stopBuild(), `stopped ${name}`))];
      break;
    }
    case "sign-in":
      title = `${name} needs your sign-in.`;
      body = [note("your agent waits for you to sign in to the service on the tv's sign-in screen.")];
      buttons = [button("stop", "stop", () => void act(() => daemon.stopBuild(), `stopped ${name}`))];
      break;
    case "failed":
      title = `couldn't build ${name}.`;
      body = [h("div", { class: "check-rows" }, row(false, "", b.reason ?? "it stopped")), b.steps.length ? steps(b) : null];
      buttons = [button("try again", "retry", () => void act(() => daemon.retry(b.build)).then((ok) => ok && ctx.render(`build/${b.build}`)), true), button("remove", "forget", () => void forget())];
      keys = "↵ try again · del remove · esc back";
      break;
    default:
      title = `${name} is on your home.`;
      body = [note("open it from home or apps.")];
  }

  const el = h(
    "div",
    { class: "screen" },
    h("div", { class: "page profile build-page", "data-state": b.state }, ...heading(`tv app build ${b.id.replace(/^local\./, "")}`, title), ...body.filter((x): x is HTMLElement => x !== null), buttons.length ? h("div", { class: "check-actions" }, ...buttons) : null),
    bar(ctx, "apps", keys),
  );
  return {
    el,
    act(action) {
      // Delete puts a failed build away, as its tile says.
      if (action === "remove" && b.state === "failed") {
        void forget();
        return true;
      }
      return false;
    },
  };
}

// --- An app your agent built ------------------------------------------------

// Its details' buttons (Q117): a change in words, the same app built again
// from its recipe, the version before back, or the app gone. Each new
// version goes through the same gates and approval. Nothing for an app the
// builder didn't make, or for a child.
export function builtActions(ctx: Ctx, id: string): HTMLElement[] {
  if (ctx.state.viewer.role !== "adult") return [];
  const mine = builds().filter((b) => b.id === id);
  const now = mine.find((b) => b.state === "installed");
  if (!now) return [];
  const kept = mine.find((b) => b.state === "kept");
  const name = nameOf(now);
  const fail = (error: unknown) => {
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
  };
  const again = async () => {
    try {
      const made = await daemon.rebuildApp(id);
      ctx.sounds.play("confirm");
      await loadBuilds(ctx);
      ctx.go(`build/${made.build}`);
    } catch (error) {
      fail(error);
    }
  };
  const back = async () => {
    const grant = await ctx.grant(`going back a version of ${name}`);
    if (grant === null) return;
    try {
      await daemon.rollbackApp(id, grant || undefined);
      ctx.sounds.play("confirm");
      ctx.toast(`${name} goes back to ${kept!.version}`, "ok");
    } catch (error) {
      ctx.forgetGrant();
      fail(error);
    }
  };
  const remove = async () => {
    const grant = await ctx.grant(`removing ${name}`);
    if (grant === null) return;
    try {
      await daemon.removeBuilt(id, grant || undefined);
      ctx.sounds.play("confirm");
      ctx.toast(`${name} is gone, with every version of it`, "ok");
      await loadBuilds(ctx);
      ctx.back();
    } catch (error) {
      ctx.forgetGrant();
      fail(error);
    }
  };
  const button = (label: string, action: string, onclick: () => void) => h("button", { class: "button", "data-focus": true, "data-action": action, onclick }, label);
  return [
    button("change it →", "change", () => ctx.go(`change/${id}`)),
    button("build it again", "rebuild", () => void again()),
    ...(kept ? [button(`go back to ${kept.version}`, "rollback", () => void back())] : []),
    button("remove", "remove-built", () => void remove()),
  ];
}

// A change to an app your agent built, in words: a new version from the one
// on home.
export function buildChange(ctx: Ctx, id: string): View {
  const now = builds().find((b) => b.id === id && b.state === "installed");
  const name = now ? nameOf(now) : id;
  const field = h("input", {
    class: "music-search build-ask",
    "data-focus": true,
    "data-field": "change",
    type: "text",
    maxlength: "300",
    placeholder: "slower blocks, and a bigger score",
    "aria-label": `what should change in ${name}`,
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  let asking = false;
  const ask = async () => {
    const text = field.value.trim();
    if (!text || asking) {
      if (!text) ctx.toast("say what should change first", "fail");
      return;
    }
    asking = true;
    try {
      const made = await daemon.changeApp(id, text);
      ctx.sounds.play("confirm");
      await loadBuilds(ctx);
      ctx.back();
      ctx.go(`build/${made.build}`);
    } catch (error) {
      ctx.sounds.play("failure");
      ctx.toast((error as Error).message, "fail");
    } finally {
      asking = false;
    }
  };
  const el = h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "page profile" },
      ...heading(`tv app change ${id.replace(/^local\./, "")}`, `what should change in ${name}?`),
      h("div", { class: "panel-title" }, "the change"),
      field,
      h("p", { class: "panel-note" }, `your agent builds a new version of ${name} with it, through the same checks, and you approve it on your phone. the version on home stays until then, and one press brings it back after.`),
      h("div", { class: "check-actions" }, h("button", { class: "button primary", "data-focus": true, "data-action": "ask", onclick: () => void ask() }, "ask")),
    ),
    bar(ctx, "apps", "↵ ask · esc back"),
  );
  return {
    el,
    first: field,
    act(action) {
      if (action !== "ok" || ctx.focus.get() !== field) return false;
      void ask();
      return true;
    },
  };
}

// A build moved on: the page showing again, if it's one this file draws.
export function buildsMoved(ctx: Ctx, route: string, redraw: () => void): void {
  void loadBuilds(ctx).then(() => {
    if (route === "home" || route === "apps" || route.startsWith("build/")) redraw();
  });
}
