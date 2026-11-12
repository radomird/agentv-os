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
import { currentGrid } from "../looks/looks.ts";
import type { Ctx, View } from "../main.ts";
import { logo, placeTile } from "./home.ts";
import { bar, heading } from "./parts.ts";
import { askBuilds, askWith, confirmLine } from "./ask.ts";

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
    if (b.state === "approve") ctx.toast(`${name} is ready. Approve on your phone.`, "ok");
    else if (b.state === "plan") ctx.toast(`Check the steps for ${name} on your phone`, "ok");
    // With the Ask box, the build's page opens by itself (said.ts).
    else if (b.state === "confirm" && !askBuilds()) ctx.toast("Got it. Check the details in Apps.", "ok");
    else if (b.state === "plan-sign-in") ctx.toast(b.ranOut ? `Sign in to ${AI[b.provider]} again to finish ${name}` : `Sign in to ${AI[b.provider]} to make ${name}`, "ok");
    else if (b.state === "installed" && was === "approve") ctx.toast(madeTheme(b) ? `${name} is your theme now` : `${name} is on your home`, "ok");
    else if (b.state === "failed") ctx.toast(`Couldn't make ${name}`, "fail");
  }
}

function nameOf(b: BuildView): string {
  return b.name ?? b.sentence;
}

// Each AI by its name.
const AI: Record<BuildView["provider"], string> = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", grok: "Grok", muse: "Muse" };

// Why it couldn't be made, in the daemon's one plain line.
const WENT_WRONG = "Something went wrong";

// A step as it's drawn: its label, or for a step with none, its id as words.
type StepView = BuildView["steps"][number] & { label?: string };

function stepName(step: StepView): string {
  if (step.label) return step.label;
  const words = step.id.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// A theme your agent made (S6.4), rather than an app.
function madeTheme(b: BuildView): boolean {
  return b.understood?.recipe === "theme";
}

function money(dollars: number): string {
  return dollars < 10 ? `$${dollars.toFixed(2)}` : `$${Math.round(dollars)}`;
}

// What a build says on its tile: the word at its top and the line under it.
function tileWords(b: BuildView): { label: string; line: string; bad?: boolean } {
  const done = b.steps.filter((s) => s.state === "done").length;
  switch (b.state) {
    case "starting":
      return { label: "Making", line: "Getting started" };
    case "running":
      if (b.phase === "understand") return { label: "Making", line: "Getting started" };
      if (b.phase === "plan") return { label: "Making", line: "Writing the steps" };
      if (b.phase === "stage-b") return { label: "Making", line: b.steps.length ? `Learning it · ${done} of ${b.steps.length}` : "Learning it" };
      // With the Ask box (D5): the step it's on, by its number and its name.
      if (askBuilds() && b.steps.length) return { label: `Step ${Math.min(done + 1, b.steps.length)} of ${b.steps.length}`, line: stepName(b.steps.find((s) => s.state === "running") ?? b.steps[done] ?? b.steps[0]) };
      return { label: "Making", line: b.steps.length ? `${done} of ${b.steps.length} steps` : "Getting started" };
    case "confirm":
      if (askBuilds()) return { label: "Check it", line: `Make ${nameOf(b)}?` };
      return { label: "Check it", line: "Is this what you meant?" };
    case "plan":
      return { label: "Steps", line: "Approve the steps on your phone" };
    case "approve":
      return { label: "● Ready", line: "Approve on your phone" };
    case "sign-in":
      return { label: "Sign in", line: "Sign in to continue" };
    case "plan-sign-in":
      return { label: "Sign in", line: `Sign in to ${AI[b.provider]}${b.ranOut ? " again" : ""}` };
    case "failed":
      return { label: "Couldn't make it", line: b.reason ?? WENT_WRONG, bad: true };
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
  const place = firstFree(ctx.state.layout, "s", "", currentGrid());
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
  if (b.state === "approve") return `${name} is ready · approve on your phone`;
  if (b.state === "plan") return `Steps for ${name} · approve on your phone`;
  if (b.state === "plan-sign-in") return `${name} · sign in to ${AI[b.provider]}${b.ranOut ? " again" : ""}`;
  if (b.state === "failed") return `Couldn't make ${name}`;
  if (b.state === "running" || b.state === "starting") return `Making ${name}`;
  return "";
}

// --- What to make ------------------------------------------------------------

// For a theme, from Look's "describe your own" (S6.4), the words say what
// it looks like, and the builder hears that it's a theme.
export function buildAsk(ctx: Ctx, kind?: "theme"): View {
  const theme = kind === "theme";
  const field = h("input", {
    class: "music-search build-ask",
    "data-focus": true,
    "data-field": "sentence",
    type: "text",
    maxlength: "300",
    placeholder: theme ? "a calm forest at dusk" : "a puzzle game, or a slideshow of my photos",
    "aria-label": theme ? "What it looks like" : "What to make",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const wishes = state?.wishes ?? [];
  let asking = false;
  const ask = async (said?: string) => {
    const words = (said ?? field.value).trim();
    if (!words || asking) {
      if (!words) ctx.toast("Describe it first", "fail");
      return;
    }
    const sentence = theme && said === undefined && !/\btheme\b/i.test(words) ? `a theme: ${words}` : words;
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
      ...heading(theme ? "omarchy theme build" : "tv app build", theme ? "What should your theme look like?" : "What do you want to build?"),
      h("div", { class: "panel-title" }, theme ? "Your theme" : "Your app"),
      field,
      h("p", { class: "panel-note" }, theme ? "You get colours and a background or two" : "Keep watching while it's made"),
      h("div", { class: "check-actions" }, h("button", { class: "button primary", "data-focus": true, "data-action": "ask", onclick: () => void ask() }, "Ask")),
      // What setup kept for later: each one asked with one press.
      ...(wishes.length
        ? [
            h("div", { class: "panel-title build-wishes" }, "Saved from setup"),
            h("div", { class: "check-actions" }, ...wishes.map((wish) => h("button", { class: "button", "data-focus": true, "data-wish": wish, onclick: () => void ask(wish) }, wish))),
          ]
        : []),
    ),
    bar(ctx, "apps"),
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
    ...b.steps.map((s: StepView) => h("div", { class: `updating-step${s.state === "running" ? " now" : ""}${s.state === "failed" ? " bad" : ""}` }, h("b", {}, MARKS[s.state]), ` ${stepName(s)}`)),
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
  if (b.path === "plan") return `Uses your ${AI[b.provider]} plan`;
  const cap = state?.settings.cap.build;
  const range = b.cost ? `About ${money(b.cost.low)} to ${money(b.cost.high)}` : `Uses your ${AI[b.provider]} key`;
  return cap ? `${range}, never more than ${money(cap)}` : range;
}

// A row of facts. An address or a list of sites or names keeps its capitals
// in every look.
function row(ok: boolean, label: string, value: string, ownCase = false): HTMLElement {
  return h("div", { class: `check-row${ok ? "" : " bad"}` }, h("b", {}, ok ? "✓" : "✗"), ` ${label}  `, h("span", { class: "build-value", "data-own-case": ownCase }, value));
}

export function buildPage(ctx: Ctx, which: string): View {
  const b = builds().find((x) => x.build === which);
  if (!b) {
    // Not heard of yet, or put away: asked for once more.
    const el = h("div", { class: "screen" }, h("div", { class: "page profile" }, ...heading("tv app build", "…")), bar(ctx, "apps"));
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
  switch (b.state) {
    case "starting":
    case "running":
      if (b.phase === "understand") {
        title = "Getting started";
        body = [h("div", { class: "prompt build-said" }, `"${b.sentence}"`), note("Working out what you'd like")];
      } else if (b.phase === "plan") {
        title = `Steps for ${name}`;
        body = [note("This one's new, so you check the steps on your phone first")];
      } else if (b.phase === "stage-b") {
        // A streaming service's stage B, after the household signed in (ADR-011).
        title = `Learning ${name}`;
        body = [
          progress(b),
          steps(b),
          // What the signed-in look reads, and where it goes (Q263).
          note(`To finish, your TV looks at a few pages of ${name} while you're signed in, and sends what it reads to ${AI[b.provider]}`),
          b.path === "key" && b.spent !== undefined ? note(`${money(b.spent)} so far`) : null,
        ];
      } else if (askBuilds()) {
        // D5: the steps, and one line.
        title = `Making ${name}`;
        body = [progress(b), steps(b), note("You can keep watching")];
      } else {
        title = `Making ${name}`;
        body = [
          progress(b),
          steps(b),
          note(`${b.minutes ? `About ${b.minutes} minutes` : "You can keep watching"}. Approve on your phone after.`),
          b.path === "key" && b.spent !== undefined ? note(`${money(b.spent)} so far`) : null,
        ];
      }
      buttons = [button("Stop", "stop", () => void act(() => daemon.stopBuild(), `Stopped ${name}`))];
      break;
    case "confirm": {
      const u = b.understood!;
      if (askBuilds()) {
        // D5: what it'll make, and that it stays here or has steps for your
        // ok first (ADR-046), in one line.
        title = `Make ${u.name}?`;
        const cost = b.path === "key" && b.cost ? ` · about ${money(b.cost.low)} to ${money(b.cost.high)}` : "";
        body = [note(`${confirmLine(u.recipe)}${cost}`), u.address ? h("div", { class: "check-rows" }, row(true, "Site", u.address, true)) : null, b.steps.length ? steps(b) : null];
        buttons = [button("Make it", "confirm", () => void act(() => daemon.confirm(b.build)).then((ok) => ok && ctx.render(`build/${b.build}`)), true), button("Not this", "forget", () => void forget())];
        break;
      }
      title = "Is this what you meant?";
      body = [
        h("div", { class: "prompt build-said" }, `"${b.sentence}"`),
        h(
          "div",
          { class: "check-rows" },
          row(true, "Name", u.name),
          row(true, "Kind", u.recipe ? u.recipe : "New, so you check the steps first"),
          u.address ? row(true, "Site", u.address, true) : null,
          row(true, "It'll be", u.says),
          row(true, "Cost", costLine(b)),
          b.minutes ? row(true, "Time", `About ${b.minutes} minutes`) : null,
        ),
        note("Made in the background. You approve it before it's on home."),
      ];
      buttons = [button("Make it", "confirm", () => void act(() => daemon.confirm(b.build)).then((ok) => ok && ctx.render(`build/${b.build}`)), true), button("Not this", "forget", () => void forget())];
      break;
    }
    case "plan": {
      const p = b.plan!;
      const online = p.permissions.origins.length > 0;
      title = `Steps for ${name}`;
      body = [
        note(p.says),
        h("div", { class: "updating-steps build-steps" }, ...p.steps.map((s, i) => h("div", { class: "updating-step" }, h("b", {}, `${i + 1}.`), ` ${s.does}`))),
        h(
          "div",
          { class: "check-rows" },
          row(true, "Connects to", online ? p.permissions.origins.join(", ") : "Nothing online", online),
          row(true, "Uses", p.packages.length ? p.packages.map((x) => x.name).join(", ") : "Nothing extra", p.packages.length > 0),
          row(true, "Cost", costLine(b)),
        ),
        note("Approve on your phone to start"),
      ];
      buttons = [button("Not this", "forget", () => void forget())];
      break;
    }
    case "approve":
      title = `${name} is ready`;
      body = [
        note(b.phase === "stage-b" ? `${name} can now search and play. Approve on your phone to update it.` : madeTheme(b) ? "Your theme is ready. Approve on your phone to use it." : "Tested and ready. Approve on your phone to add it to home."),
        steps(b),
      ];
      // Stage B's app is on home already, as stage A made it.
      buttons = [b.phase === "stage-b" ? button("Remove", "remove-built", () => void removeBuilt(ctx, b.id, name)) : button("Not this", "forget", () => void forget())];
      break;
    case "plan-sign-in": {
      // The plan's sign-in (ADR-040): the CLI's own link, as a QR code for
      // the phone's camera, and the code to enter on its page, or the code
      // its page gives to paste on the phone. The same again when the
      // plan's sign-in ran out.
      const s = b.signIn;
      title = `Sign in to ${AI[b.provider]}${b.ranOut ? " again" : ""}`;
      if (s?.state === "waiting" && s.url) {
        const image = h("img", { src: `/api/builds/${b.build}/qr?at=${encodeURIComponent(b.at)}`, alt: `A QR code to sign in to ${AI[b.provider]}` });
        const qr = h("div", { class: "pair-qr build-qr" }, image);
        image.addEventListener("error", () => qr.classList.add("hidden"));
        body = [
          note(b.ranOut ? `Your ${AI[b.provider]} sign-in expired. Sign in again to finish ${name}.` : `Sign in to ${AI[b.provider]} to make ${name}. You only do this once.`),
          qr,
          s.code ? h("div", { class: "pair-code build-code" }, s.code) : null,
          note(s.code ? "Scan it with your phone, sign in and enter the code" : "Scan it with your phone and sign in. Then paste the code it gives you."),
        ];
      } else if (s?.state === "done") {
        body = [note(`You're signed in. Making ${name} now.`)];
      } else {
        body = [note("Starting the sign-in…")];
      }
      buttons = [button("Stop", "stop", () => void act(() => daemon.stopBuild(), `Stopped ${name}`))];
      break;
    }
    case "sign-in":
      title = `Sign in to ${name}`;
      body = [note("Waiting for you to sign in on your TV")];
      buttons = [button("Stop", "stop", () => void act(() => daemon.stopBuild(), `Stopped ${name}`))];
      break;
    case "failed":
      if (askBuilds() && b.phase !== "stage-b") {
        // D5: why, and that nothing changed on the tv. Changing what was
        // asked starts the Ask box with it.
        title = `Couldn't make ${name}`;
        // Why, in one line. A reason that already says what to do stands alone.
        const why = b.reason ?? WENT_WRONG;
        body = [note(why.includes(". ") ? why : `${why.replace(/\.$/, "")}. Nothing was installed.`)];
        buttons = [
          button("Try again", "retry", () => void act(() => daemon.retry(b.build)).then((ok) => ok && ctx.render(`build/${b.build}`)), true),
          button("Change my request", "ask-again", () => askWith(ctx, `make ${b.sentence}`)),
          button("Remove", "forget", () => void forget()),
        ];
        break;
      }
      title = `Couldn't make ${name}`;
      body = [h("div", { class: "check-rows" }, row(false, "", b.reason ?? WENT_WRONG)), b.steps.length ? steps(b) : null];
      buttons = [
        button("Try again", "retry", () => void act(() => daemon.retry(b.build)).then((ok) => ok && ctx.render(`build/${b.build}`)), true),
        b.phase === "stage-b" ? button("Remove", "remove-built", () => void removeBuilt(ctx, b.id, name)) : button("Remove", "forget", () => void forget()),
      ];
      break;
    default:
      if (madeTheme(b)) {
        // On the TV and the desktop once the screen daemon handed it to
        // Omarchy, or why it couldn't.
        const set = state?.themes?.[b.id];
        title = `${name} is your theme`;
        body = [note(set?.error ? "Couldn't switch to it" : set?.version === b.version ? "It's on your TV and Omarchy's desktop" : "Switching to it…")];
        buttons = [button("Remove", "remove-built", () => void removeBuilt(ctx, b.id, name))];
      } else {
        title = `${name} is on your home`;
        body = [note("Open it from home or Apps")];
      }
  }

  const el = h(
    "div",
    { class: "screen" },
    h("div", { class: "page profile build-page", "data-state": b.state }, ...heading(askBuilds() && b.state === "confirm" ? `agentv make "${b.sentence}"` : `tv app build ${b.id.replace(/^local\./, "")}`, title), ...body.filter((x): x is HTMLElement => x !== null), buttons.length ? h("div", { class: "check-actions" }, ...buttons) : null),
    bar(ctx, "apps"),
  );
  return {
    el,
    act(action) {
      // Delete puts a failed build away, as its tile says.
      if (action === "remove" && b.state === "failed") {
        void (b.phase === "stage-b" ? removeBuilt(ctx, b.id, name) : forget());
        return true;
      }
      return false;
    },
  };
}

// --- An app your agent built ------------------------------------------------

// Its details' buttons (Q117): a change in words, the same app built again
// from its recipe, the version before back, Export to the phone (ADR-045),
// or the app gone. Each new version goes through the same gates and
// approval. Nothing for an app the builder didn't make, or for a child, and
// no Export for one that drives a service's own site.
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
      ctx.toast(`${name} is back on ${kept!.version}`, "ok");
    } catch (error) {
      ctx.forgetGrant();
      fail(error);
    }
  };
  const exported = async () => {
    try {
      await daemon.exportApp(id);
      ctx.sounds.play("confirm");
      ctx.toast(`Open your phone to save ${name}`, "ok");
    } catch (error) {
      fail(error);
    }
  };
  const web = ctx.state.apps.find((app) => app.id === id)?.runtime === "web";
  const button = (label: string, action: string, onclick: () => void) => h("button", { class: "button", "data-focus": true, "data-action": action, onclick }, label);
  return [
    // With the Ask box, the change is said in it (D5): "change blocks: ...".
    button("Change it", "change", () => (askBuilds() ? askWith(ctx, `change ${name.toLowerCase()}: `) : ctx.go(`change/${id}`))),
    button("Make it again", "rebuild", () => void again()),
    ...(kept ? [button(`Back to ${kept.version}`, "rollback", () => void back())] : []),
    ...(web ? [] : [button("Save a copy", "export", () => void exported())]),
    button("Remove", "remove-built", () => void removeBuilt(ctx, id, name)),
  ];
}

// An app the agent built, and every version of it, gone, past the PIN.
async function removeBuilt(ctx: Ctx, id: string, name: string): Promise<void> {
  const grant = await ctx.grant(`removing ${name}`);
  if (grant === null) return;
  try {
    await daemon.removeBuilt(id, grant || undefined);
    ctx.sounds.play("confirm");
    ctx.toast(`Removed ${name}`, "ok");
    await loadBuilds(ctx);
    ctx.back();
  } catch (error) {
    ctx.forgetGrant();
    ctx.sounds.play("failure");
    ctx.toast((error as Error).message, "fail");
  }
}

// A change to an app your agent built, in words: a new version from the one
// on home.
export function buildChange(ctx: Ctx, id: string): View {
  const now = builds().find((b) => b.id === id && b.state === "installed");
  const name = now ? nameOf(now) : (ctx.state.apps.find((app) => app.id === id)?.name ?? id);
  const field = h("input", {
    class: "music-search build-ask",
    "data-focus": true,
    "data-field": "change",
    type: "text",
    maxlength: "300",
    placeholder: "slower blocks, and a bigger score",
    "aria-label": `What should change in ${name}`,
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  let asking = false;
  const ask = async () => {
    const text = field.value.trim();
    if (!text || asking) {
      if (!text) ctx.toast("Describe the change first", "fail");
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
      ...heading(`tv app change ${id.replace(/^local\./, "")}`, `What should change in ${name}?`),
      h("div", { class: "panel-title" }, "The change"),
      field,
      h("p", { class: "panel-note" }, "You approve the new version on your phone. Home keeps the old one until then."),
      h("div", { class: "check-actions" }, h("button", { class: "button primary", "data-focus": true, "data-action": "ask", onclick: () => void ask() }, "Ask")),
    ),
    bar(ctx, "apps"),
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
