// Apps (board 09): AgenTV's official apps for what the TV is for, then the
// rest under "more", beside the built-in apps that come with AgenTV. OK ticks
// one; continue hands the ticked ones to the box to install in the
// background, from the signed index, and setup carries on while they do. Each
// app's own setup (a server address, a sign-in) comes from its tile on home.
//
// The last tile of the grid, "Can't find it? Build your own", asks what to
// make (board 10, design page D11): one way to build, at the end of the apps.
// The TV's agent will build it once it can (stage 6); until then setup keeps
// the words for it.
//
// With the starter switch on, the streaming starter pack (ADR-066, D3) is
// the official apps the index says are for streaming. For Streaming it's the
// goal's own group, every app in it ticked, with the servers under "more".
// For every other goal it's one card at the start of "more", and one press
// ticks them all.

import { h } from "../launcher/dom.ts";
import { glyph } from "../launcher/glyphs.ts";
import { setup, type Goal, type Installs, type SetupApp, type SetupApps } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";
import { onNetwork } from "./servers.ts";
import { featureOn } from "../launcher/features.ts";

// What to make, as the examples under "Build your own" say it.
const EXAMPLES = ["a puzzle game", "a slideshow of my photos", "a better weather app"];

// A short line for each app and the colour behind its first letter, as on
// the canvas. An app it doesn't know takes its description and the next
// colour.
const NOTES: Record<string, string> = {
  "agentv.jellyfin": "Your own server",
  "agentv.plex": "Your own server",
  "agentv.immich": "Photos",
  "agentv.steam": "Games",
  "agentv.music": "Your own music",
};
const COLOURS: Record<string, string> = { "agentv.jellyfin": "magenta", "agentv.plex": "orange", "agentv.music": "green", "agentv.immich": "yellow", "agentv.steam": "cyan" };
const FACES = ["blue", "magenta", "orange", "green", "yellow", "cyan"];
const NAMES: Record<Goal, string> = { streaming: "streaming", music: "music", media: "photos", gaming: "gaming" };

// An app that can still be ticked: not built in, not on the TV, not going.
const open = (app: SetupApp) => !app.builtin && !app.installed && !app.state;

// A starter app's note: what its description says after its first sentence,
// such as that it plays in SD here, and nothing when it says no more.
function starterNote(app: SetupApp): string {
  return app.description.split(/(?<=\.)\s+/).slice(1).join(" ").replace(/\.$/, "");
}

// What's in the starter pack, as its card says it: one or two by name, and
// how many when there are more.
function packNames(pack: SetupApp[]): string {
  return pack.length <= 2 ? pack.map((app) => app.name).join(" and ") : `${pack.length} apps`;
}

// What an install says in a line: the status bar's, while it runs.
export function installLine(apps: Installs, names: Record<string, string>): string | null {
  const name = (id: string) => names[id] ?? id.replace(/^agentv\./, "");
  const going = Object.keys(apps).filter((id) => apps[id].state === "queued" || apps[id].state === "installing");
  const failed = Object.keys(apps).filter((id) => apps[id].state === "failed");
  if (going.length) return `Installing ${going.map(name).join(", ")}`;
  if (failed.length) return `Couldn't install ${failed.map(name).join(", ")}`;
  return null;
}

export async function apps(ctx: Ctx): Promise<View> {
  let list: SetupApps | null = await setup.apps().catch(() => null);
  const goal = ctx.info.setup.goal;
  const pack = () => list?.starter ?? [];
  const packed = !!list?.starter?.length;
  // For Streaming, the starter pack starts ticked.
  if (ctx.picked === undefined && packed && goal === "streaming") ctx.picked = pack().filter(open).map((app) => app.id);
  const ticked = new Set<string>(ctx.picked ?? []);
  const listed = () => [...pack(), ...(list?.for ?? []), ...(list?.more ?? [])];
  const forGoal = h("div", { class: "app-row" });
  const starterRow = h("div", { class: "app-row" });
  const more = h("div", { class: "app-row" });
  const note = h("p", { class: "setup-note app-note" });
  // The one way to build from setup: the last tile, shaped like the apps
  // before it, with Ask's sparkle where an app has its letter.
  const add = h(
    "button",
    { class: "app-add", "data-focus": true, "data-action": "add", onclick: () => ctx.open("apps/add") },
    h("span", { class: "app-face avatar-green" }, glyph("spark", 40)),
    h("span", { class: "app-text" }, h("span", { class: "app-ask" }, "Can't find it?"), h("span", { class: "app-name" }, "Build your own")),
  );
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "continue", onclick: () => void next() }, "Continue");

  const card = (app: SetupApp, i: number, starter = false): HTMLElement => {
    const on = app.builtin || app.installed || app.state === "installed" || ticked.has(app.id);
    const mark = app.state === "installing" || app.state === "queued" ? "[>]" : app.state === "failed" ? "[!]" : on ? "[x]" : "[ ]";
    const why = app.builtin
      ? (NOTES[app.id] ?? "Built in")
      : app.installed || app.state === "installed"
        ? "On this TV"
        : app.state === "failed"
          ? "Couldn't install"
          : starter
            ? starterNote(app)
            : (NOTES[app.id] ?? app.description);
    return h(
      "button",
      { class: `app-pick${on ? " on" : ""}${app.state === "failed" ? " bad" : ""}`, "data-focus": true, "data-app": app.id, onclick: () => toggle(app) },
      h("span", { class: "app-mark" }, mark),
      h("span", { class: `app-face avatar-${COLOURS[app.id] ?? FACES[i % FACES.length]}` }, app.builtin && app.id === "agentv.music" ? glyph("music", 40) : app.name.slice(0, 1).toUpperCase()),
      h("span", { class: "app-text" }, h("span", { class: "app-name" }, app.name), h("span", { class: "app-note-line" }, why)),
    );
  };

  // For any goal but Streaming, the whole starter pack as one card.
  const packCard = (): HTMLElement => {
    const can = pack().filter(open);
    const done = pack().every((app) => app.installed || app.state === "installed");
    const going = pack().some((app) => app.state === "installing" || app.state === "queued");
    const on = done || (can.length > 0 && can.every((app) => ticked.has(app.id)));
    return h(
      "button",
      { class: `app-pick${on ? " on" : ""}`, "data-focus": true, "data-app": "starter", onclick: () => togglePack() },
      h("span", { class: "app-mark" }, going ? "[>]" : on ? "[x]" : "[ ]"),
      h("span", { class: `app-face avatar-${FACES[0]}` }, glyph("film", 40)),
      h("span", { class: "app-text" }, h("span", { class: "app-name" }, "Streaming"), h("span", { class: "app-note-line" }, done ? "On this TV" : packNames(pack()))),
    );
  };

  const draw = () => {
    const had = ctx.focus.get();
    const which = had?.dataset.app ?? had?.dataset.action;
    const all = listed();
    const own = packed && goal === "streaming";
    forGoal.replaceChildren(...(list?.for ?? []).map((app) => card(app, all.indexOf(app))));
    forGoal.parentElement?.classList.toggle("hidden", !list?.for.length);
    starterRow.replaceChildren(...(own ? pack().map((app) => card(app, all.indexOf(app), true)) : []));
    // "Build your own" is the last tile of the grid, whatever the goal.
    more.replaceChildren(...(packed && !own ? [packCard()] : []), ...(list?.more ?? []).map((app) => card(app, all.indexOf(app))), add);
    const wishes = ctx.info.setup.wishes ?? [];
    note.textContent = list?.error ? "Couldn't load the apps. Add them later from Apps." : wishes.length ? `Saved for later: ${wishes.join(", ")}` : "";
    const again = which ? el.querySelector<HTMLElement>(`[data-app="${CSS.escape(which)}"], [data-action="${CSS.escape(which)}"]`) : null;
    if (again && again !== had) ctx.focus.set(again, false);
  };

  const toggle = (app: SetupApp) => {
    if (app.builtin) {
      ctx.toast(`${app.name} is built in`);
      return;
    }
    if (app.installed || app.state === "installed" || app.state === "installing" || app.state === "queued") return;
    if (ticked.has(app.id)) ticked.delete(app.id);
    else ticked.add(app.id);
    ctx.picked = [...ticked];
    draw();
  };

  // One press for the whole starter pack: every app in it that can still be
  // ticked, or none of them once they all are.
  const togglePack = () => {
    const can = pack().filter(open);
    if (!can.length) {
      ctx.toast("Streaming apps installed", "ok");
      return;
    }
    const all = can.every((app) => ticked.has(app.id));
    for (const app of can) {
      if (all) ticked.delete(app.id);
      else ticked.add(app.id);
    }
    ctx.picked = [...ticked];
    draw();
  };

  // The ticked ones go to the box, past the PIN once there is one, and
  // setup moves on while they install.
  const next = async () => {
    const wanted = [...ticked].filter((id) => listed().some((app) => app.id === id && !app.installed && !app.state));
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
      for (const app of listed()) ctx.names[app.id] = app.name;
      ctx.picked = [];
    }
    if (await onNetwork(ctx, wanted)) return;
    await ctx.finish("apps");
  };

  const el = h(
    "div",
    { class: `setup-page apps-page${packed ? " d3 pack" : ""}` },
    h(
      "div",
      { class: "setup-top" },
      h(
        "div",
        {},
        ...heading(`tv apps --for ${goal ?? "everything"}`, "Pick your apps", ctx.reduced()),
        ...(packed ? [h("p", { class: "setup-line" }, goal === "streaming" ? "The streaming apps are picked" : "Add all the streaming apps with one press")] : []),
      ),
      go,
    ),
    h("div", { class: "app-group" }, h("span", { class: "app-head" }, `# for ${goal ? NAMES[goal] : "you"}`), forGoal),
    ...(packed && goal === "streaming" ? [h("div", { class: "app-group" }, h("span", { class: "app-head" }, "# streaming"), starterRow)] : []),
    h("div", { class: "app-group" }, h("span", { class: "app-head" }, "# more"), more),
    note,
  );
  draw();
  // With the streaming apps picked already, the first press goes on, and
  // doesn't untick the first of them. The apps are one press down.
  const picked = packed && goal === "streaming" && pack().some((app) => ticked.has(app.id) || app.installed || app.state);
  return {
    el,
    first: picked ? go : (el.querySelector<HTMLElement>(".app-group:not(.hidden) .app-pick") ?? add),
    // Down from continue goes to the first app, not to whichever tile sits
    // nearest under the button.
    act(action) {
      if (action !== "down" || ctx.focus.get() !== go) return false;
      ctx.focus.set(el.querySelector<HTMLElement>(".app-group:not(.hidden) .app-pick") ?? add);
      return true;
    },
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

// "Build your own" (board 10): what to make, in a few words, typed on the
// phone, or here. The TV's agent will build it once it can; setup keeps it. The
// look step's "describe your own" keeps a theme the same way (S6.4).
export function addYourOwn(ctx: Ctx, kind?: "theme"): View {
  const theme = kind === "theme";
  const field = h("input", {
    class: "text-field wish-field",
    "data-focus": true,
    "data-action": "wish",
    type: "text",
    maxlength: theme ? "70" : "80",
    // An example of what to ask for, and no line of instructions.
    placeholder: theme ? "A calm forest at dusk" : "A puzzle game",
    "aria-label": theme ? "Theme to make" : "App to make",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const keep = async () => {
    const text = field.value.trim();
    if (!text) {
      ctx.toast("Describe it first", "fail");
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
    ctx.toast(`Saved: ${text}`, "ok");
    ctx.back();
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void keep();
    }
  });
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "keep", onclick: () => void keep() }, "Save");
  // Examples of what to make, with the Ask box building (ADR-068): each
  // fills the box, and OK keeps it.
  const examples = h("div", { class: "wish-actions wish-examples" });
  if (!theme) {
    void featureOn("askbuilds")
      .catch(() => false)
      .then((on) => {
        if (!on || !examples.isConnected) return;
        examples.append(
          ...EXAMPLES.map((example) =>
            h(
              "button",
              {
                class: "button",
                "data-focus": true,
                "data-example": example,
                onclick: () => {
                  field.value = example;
                  ctx.sounds.play("select");
                  field.focus();
                },
              },
              example,
            ),
          ),
        );
      });
  }
  const el = h(
    "div",
    { class: "setup-page" },
    h("div", {}, ...heading(theme ? "tv theme add" : "tv apps add", theme ? "Describe a theme" : "Build your own", ctx.reduced())),
    h("div", { class: "wish-row" }, h("span", { class: "wish-caret" }, ">"), field),
    examples,
    h("div", { class: "wish-actions" }, go),
    h("p", { class: "setup-note" }, theme ? "Made after setup: colours and a background or two" : "Built after setup, for $5 at most"),
  );
  return { el, first: field };
}
