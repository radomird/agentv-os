// Apps (board 09): AgenTV's official apps for what the TV is for, then the
// rest under "more", beside the built-in apps that come with AgenTV. OK ticks
// one; continue hands the ticked ones to the box to install in the
// background, from the signed index, and setup carries on while they do. Each
// app's own setup (a server address, a sign-in) comes from its tile on home.
//
// "+ add your own" asks what to add (board 10). The TV's agent will build it
// once it can (stage 6); until then setup keeps the words for it.

import { h } from "../launcher/dom.ts";
import { glyph } from "../launcher/glyphs.ts";
import { setup, type Goal, type Installs, type SetupApp, type SetupApps } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

// A short line for each app and the colour behind its first letter, as on
// the canvas. An app it doesn't know takes its description and the next
// colour.
const NOTES: Record<string, string> = {
  "agentv.jellyfin": "your own server",
  "agentv.plex": "your own server",
  "agentv.immich": "photos",
  "agentv.steam": "games",
  "agentv.music": "local or nas",
};
const COLOURS: Record<string, string> = { "agentv.jellyfin": "magenta", "agentv.plex": "orange", "agentv.music": "green", "agentv.immich": "yellow", "agentv.steam": "cyan" };
const FACES = ["blue", "magenta", "orange", "green", "yellow", "cyan"];
const NAMES: Record<Goal, string> = { streaming: "streaming", music: "music", media: "photos", gaming: "gaming" };

// What an install says in a line: the status bar's, while it runs.
export function installLine(apps: Installs, names: Record<string, string>): string | null {
  const name = (id: string) => (names[id] ?? id.replace(/^agentv\./, "")).toLowerCase();
  const going = Object.keys(apps).filter((id) => apps[id].state === "queued" || apps[id].state === "installing");
  const failed = Object.keys(apps).filter((id) => apps[id].state === "failed");
  if (going.length) return `installing ${going.map(name).join(", ")}`;
  if (failed.length) return `${failed.map(name).join(", ")} didn't install`;
  return null;
}

export async function apps(ctx: Ctx): Promise<View> {
  let list: SetupApps | null = await setup.apps().catch(() => null);
  const ticked = new Set<string>(ctx.picked ?? []);
  const forGoal = h("div", { class: "app-row" });
  const more = h("div", { class: "app-row" });
  const note = h("p", { class: "setup-note app-note" });
  const add = h(
    "button",
    { class: "app-add", "data-focus": true, "data-action": "add", onclick: () => ctx.open("apps/add") },
    glyph("spark", 72),
    h("span", { class: "app-text" }, h("span", { class: "app-name" }, "+ add your own"), h("span", { class: "app-note-line" }, "your tv builds it")),
  );
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "continue", onclick: () => void next() }, "↵ continue");
  const goal = ctx.info.setup.goal;

  const card = (app: SetupApp, i: number): HTMLElement => {
    const on = app.builtin || app.installed || app.state === "installed" || ticked.has(app.id);
    const mark = app.state === "installing" || app.state === "queued" ? "[>]" : app.state === "failed" ? "[!]" : on ? "[x]" : "[ ]";
    const why = app.builtin
      ? (NOTES[app.id] ?? "comes with agentv")
      : app.installed || app.state === "installed"
        ? "on this tv"
        : app.state === "failed"
          ? (app.error ?? "didn't install")
          : (NOTES[app.id] ?? app.description.toLowerCase());
    return h(
      "button",
      { class: `app-pick${on ? " on" : ""}${app.state === "failed" ? " bad" : ""}`, "data-focus": true, "data-app": app.id, onclick: () => toggle(app) },
      h("span", { class: "app-mark" }, mark),
      h("span", { class: `app-face avatar-${COLOURS[app.id] ?? FACES[i % FACES.length]}` }, app.builtin && app.id === "agentv.music" ? glyph("music", 40) : app.name.slice(0, 1).toUpperCase()),
      h("span", { class: "app-text" }, h("span", { class: "app-name" }, app.name.toLowerCase()), h("span", { class: "app-note-line" }, why)),
    );
  };

  const draw = () => {
    const had = ctx.focus.get();
    const which = had?.dataset.app ?? had?.dataset.action;
    const all = [...(list?.for ?? []), ...(list?.more ?? [])];
    forGoal.replaceChildren(add, ...(list?.for ?? []).map((app) => card(app, all.indexOf(app))));
    more.replaceChildren(...(list?.more ?? []).map((app) => card(app, all.indexOf(app))));
    more.parentElement?.classList.toggle("hidden", !list?.more.length);
    const wishes = ctx.info.setup.wishes ?? [];
    note.textContent = list?.error
      ? `the official apps aren't here right now: ${list.error}. add them later from apps.`
      : wishes.length
        ? `kept for later: ${wishes.join(", ").toLowerCase()}`
        : "";
    const again = which ? el.querySelector<HTMLElement>(`[data-app="${CSS.escape(which)}"], [data-action="${CSS.escape(which)}"]`) : null;
    if (again && again !== had) ctx.focus.set(again, false);
  };

  const toggle = (app: SetupApp) => {
    if (app.builtin) {
      ctx.toast(`${app.name.toLowerCase()} comes with agentv`);
      return;
    }
    if (app.installed || app.state === "installed" || app.state === "installing" || app.state === "queued") return;
    if (ticked.has(app.id)) ticked.delete(app.id);
    else ticked.add(app.id);
    ctx.picked = [...ticked];
    draw();
  };

  // The ticked ones go to the box, past the PIN once there is one, and
  // setup moves on while they install.
  const next = async () => {
    const wanted = [...ticked].filter((id) => [...(list?.for ?? []), ...(list?.more ?? [])].some((app) => app.id === id && !app.installed && !app.state));
    if (wanted.length) {
      const grant = await ctx.grant("installing apps");
      if (grant === null) return;
      try {
        ctx.installs = await setup.install(wanted, grant || undefined);
      } catch (error) {
        ctx.toast((error as Error).message, "fail");
        ctx.sounds.play("failure");
        return;
      }
      for (const app of [...(list?.for ?? []), ...(list?.more ?? [])]) ctx.names[app.id] = app.name;
      ctx.picked = [];
    }
    await ctx.finish("apps");
  };

  const el = h(
    "div",
    { class: "setup-page apps-page" },
    h("div", { class: "setup-top" }, h("div", {}, ...heading(`tv apps --for ${goal ?? "everything"}`, "pick your apps.", ctx.reduced())), go),
    h("div", { class: "app-group" }, h("span", { class: "app-head" }, `# for ${goal ? NAMES[goal] : "you"}`), forGoal),
    h("div", { class: "app-group" }, h("span", { class: "app-head" }, "# more"), more),
    note,
  );
  draw();
  return {
    el,
    first: forGoal.querySelector<HTMLElement>(".app-pick") ?? add,
    info: "←↑↓→ move · ↵ tick",
    heard(event, data) {
      if (event !== "setup-apps") return;
      ctx.installs = data as Installs;
      void setup.apps().then((now) => {
        list = now;
        draw();
      }, () => {});
    },
  };
}

// "+ add your own" (board 10): what to add, in a few words, typed here or on
// the phone. The TV's agent will build it once it can; setup keeps it. The
// look step's "describe your own" keeps a theme the same way (S6.4).
export function addYourOwn(ctx: Ctx, kind?: "theme"): View {
  const theme = kind === "theme";
  const field = h("input", {
    class: "text-field wish-field",
    "data-focus": true,
    "data-action": "wish",
    type: "text",
    maxlength: theme ? "70" : "80",
    placeholder: theme ? "a calm forest at dusk" : "app to add",
    "aria-label": theme ? "theme to make" : "app to add",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const keep = async () => {
    const text = field.value.trim();
    if (!text) {
      ctx.toast("a few words first", "fail");
      ctx.sounds.play("failure");
      return;
    }
    try {
      ctx.info.setup = (await setup.wish(theme ? `a theme: ${text}` : text)).setup;
    } catch (error) {
      ctx.toast((error as Error).message, "fail");
      ctx.sounds.play("failure");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.toast(`kept: ${text.toLowerCase()}`, "ok");
    ctx.back();
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void keep();
    }
  });
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "keep", onclick: () => void keep() }, "↵ keep it");
  const not = h("button", { class: "button", "data-focus": true, "data-action": "not", onclick: () => ctx.back() }, "esc not this");
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", {}, ...heading(theme ? "what should it look like?" : "what should I add?", theme ? "describe your own." : "add your own.", ctx.reduced())),
    h("div", { class: "wish-row" }, h("span", { class: "wish-caret" }, ">"), field),
    h("span", { class: "setup-note" }, "type here, or on your phone."),
    h("div", { class: "wish-actions" }, go, not),
    h(
      "p",
      { class: "setup-note" },
      theme ? "your tv's agent will make it soon: its colours and a background or two, for the tv and omarchy's desktop. I'll keep it till then." : "your tv's agent will build it soon, with a $5 cap. I'll keep it till then.",
    ),
  );
  return { el, first: field, info: "↵ keep · esc back" };
}
