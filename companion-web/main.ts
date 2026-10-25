// AgenTV's phone companion (ADR-008, ADR-023, ADR-032, stage 4): the page a
// phone opens from the TV's QR code, on the same network. It pairs with the
// code the TV shows and keeps the token the box gives it. Then it's:
// - a remote: a d-pad, Back, Home and play or pause;
// - a keyboard: what's typed in its text box goes to the TV, the phone
//   keyboard's dictation too, and on AgenTV's sign-in screen, a name and a
//   password the phone's password manager can fill;
// - who's watching, arrange home, the update notice with Install tonight,
//   and the parent PIN, which also unlocks the TV.
// It works in any phone's browser; the iOS app will do more.

import { glyph, type Glyph } from "../launcher/glyphs.ts";
import { arrange } from "./arrange.ts";
import { api, avatar, h, keep, prompt, toast, token, Unpaired, type Viewer } from "./lib.ts";
import { askPin, withPin } from "./pad.ts";

const app = document.getElementById("app")!;

interface Update {
  version: string;
  installed: string | null;
  omarchy: string | null;
  notes: string[];
  tonight: boolean;
  later: boolean;
  installing: boolean;
}

interface State {
  phone: { id: string; name: string };
  viewer: Viewer;
  viewers: Viewer[];
  pin: { set: boolean; locked: boolean };
  signIn: { name: string } | null;
  update: Update | null;
}

type Mode = "remote" | "type" | "home" | "who" | "update";
let state: State | null = null;
let mode: Mode = "remote";

// A version as people read it: no package release or build after it.
const shown = (version: string) => version.replace(/\.r\d+\.g[0-9a-f]+/, "").replace(/-\d+$/, "");

// What the phone is called on the TV's list.
function phoneName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return "iphone";
  if (/iPad/.test(agent)) return "ipad";
  if (/Android/.test(agent)) return "android phone";
  return "phone";
}

const failed = (error: unknown) => {
  if (error instanceof Unpaired) {
    keep(null);
    state = null;
    pairView();
    return;
  }
  toast(`${(error as Error).message}.`);
};

// --- Pairing ------------------------------------------------------------------

async function pair(code: string): Promise<boolean> {
  try {
    keep((await api<{ token: string }>("POST", "/api/phone/pair", { code, name: phoneName() })).token);
    return true;
  } catch (error) {
    toast(`${(error as Error).message}.`);
    return false;
  }
}

function pairView(): void {
  const field = h("input", { class: "field code", type: "text", autocapitalize: "characters", autocomplete: "one-time-code", maxlength: "7", placeholder: "ABC123", "aria-label": "the code on the tv" }) as HTMLInputElement;
  const go = async () => {
    if (await pair(field.value)) void start();
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void go();
  });
  app.replaceChildren(
    h(
      "div",
      { class: "page" },
      h("div", { class: "pair-icons" }, glyph("phone", 40), glyph("right", 24), glyph("tv", 40)),
      prompt("tv pair"),
      h("h1", {}, "pair with the tv"),
      h("p", { class: "note" }, "type the code on the tv. it's in settings → phones → pair a phone."),
      field,
      h("button", { class: "button primary", type: "button", onclick: () => void go() }, "pair"),
    ),
  );
}

// --- The remote and the keyboard ----------------------------------------------

async function send(event: Record<string, unknown>): Promise<void> {
  try {
    await api("POST", "/api/phone/remote", event);
    navigator.vibrate?.(8);
  } catch (error) {
    failed(error);
  }
}

// A button with an icon, and a word beside it when there's room.
function iconButton(icon: Glyph, label: string, props: Record<string, unknown>, size = 24): HTMLButtonElement {
  return h("button", { type: "button", ...props }, glyph(icon, size), label ? h("span", {}, label) : null);
}

function remote(): HTMLElement {
  const key = (name: string, icon: Glyph | null, label: string, extra = "", aria = name) =>
    icon
      ? iconButton(icon, label, { class: `pad-key ${extra}`, "aria-label": aria, "data-key": name, onclick: () => void send({ key: name }) }, label ? 24 : 36)
      : h("button", { class: `pad-key ${extra}`, type: "button", "aria-label": aria, "data-key": name, onclick: () => void send({ key: name }) }, label);
  return h(
    "div",
    { class: "remote" },
    h(
      "div",
      { class: "dpad" },
      h("span", {}),
      key("up", "up", ""),
      h("span", {}),
      key("left", "left", ""),
      key("enter", null, "ok", "ok"),
      key("right", "right", ""),
      h("span", {}),
      key("down", "down", ""),
      h("span", {}),
    ),
    h("div", { class: "row" }, key("back", "back", "back", "wide"), key("home", "home", "home", "wide"), key("playpause", "play-pause", "", "wide", "play or pause")),
  );
}

// On AgenTV's sign-in screen (ADR-032): fields the phone's password manager
// fills, typed into the service's own form on the TV. Nothing keeps them.
function signIn(name: string): HTMLElement {
  const user = h("input", { class: "field", type: "email", name: "username", id: "username", autocomplete: "username", autocapitalize: "off", spellcheck: "false", required: true }) as HTMLInputElement;
  const pass = h("input", { class: "field", type: "password", name: "password", id: "password", autocomplete: "current-password", required: true }) as HTMLInputElement;
  const form = h(
    "form",
    { class: "typing", method: "post", action: "#" },
    h("p", { class: "label" }, `signing in to ${name.toLowerCase()} on the tv`),
    h("label", { for: "username", class: "label" }, "email or name"),
    user,
    h("label", { for: "password", class: "label" }, "password"),
    pass,
    h("button", { class: "button primary", type: "submit", "data-action": "sign-in" }, glyph("lock", 20), h("span", {}, "sign in on the tv")),
    h("p", { class: "note" }, "your phone's password manager can fill these. agentv never keeps them."),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = { username: user.value, password: pass.value };
    pass.value = "";
    void api("POST", "/api/phone/sign-in", body).then(
      () => toast("sent to the tv.", true),
      (error) => failed(error),
    );
  });
  return form;
}

function typing(): HTMLElement {
  if (state?.signIn) return signIn(state.signIn.name);
  const field = h("input", { class: "field", id: "tv-text", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "type or dictate" }) as HTMLInputElement;
  const go = async () => {
    if (!field.value) return;
    const text = field.value;
    field.value = "";
    await send({ text });
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void go();
  });
  return h(
    "div",
    { class: "typing" },
    h("label", { for: "tv-text", class: "label" }, "typing on tv"),
    field,
    iconButton("tv", "send to tv", { class: "button primary", "data-action": "send", onclick: () => void go() }, 20),
    h(
      "div",
      { class: "row" },
      iconButton("backspace", "", { class: "pad-key wide", "aria-label": "delete", "data-key": "backspace", onclick: () => void send({ key: "backspace" }) }, 28),
      iconButton("enter", "", { class: "pad-key wide", "aria-label": "enter", "data-key": "enter", onclick: () => void send({ key: "enter" }) }, 28),
    ),
    h("p", { class: "note with-icon" }, glyph("mic", 16), h("span", {}, "the keyboard's microphone works here too.")),
  );
}

// --- Who's watching (S4.2) ------------------------------------------------------

function who(): HTMLElement {
  const watch = async (viewer: Viewer) => {
    try {
      const done = await withPin(`watching as ${viewer.name}`, (grant) => api("POST", "/api/phone/viewer", { id: viewer.id }, grant));
      if (done === null) return;
      mode = "remote";
      await refresh(true);
    } catch (error) {
      failed(error);
    }
  };
  return h(
    "div",
    { class: "typing" },
    prompt("who watches?"),
    h("h1", {}, "who's watching?"),
    ...(state?.viewers ?? []).map((viewer) =>
      h(
        "button",
        { type: "button", class: `viewer${viewer.id === state?.viewer.id ? " on" : ""}`, "data-viewer": viewer.id, onclick: () => void watch(viewer) },
        avatar(viewer),
        h("span", {}, viewer.name),
        h("span", { class: "viewer-role" }, [viewer.role === "kid" ? "kid" : "", viewer.id === state?.viewer.id ? "watching" : ""].filter(Boolean).join(" · ")),
      ),
    ),
    h("p", { class: "note" }, "from a kid's profile to an adult's needs the parent pin."),
  );
}

// --- The update notice (S4.8, board 34) -------------------------------------------

function updatePage(update: Update): HTMLElement {
  const act = async (what: string, path: string, body?: unknown, pin = false) => {
    try {
      const done = pin ? await withPin(what, (grant) => api("POST", path, body, grant)) : await api("POST", path, body);
      if (done === null) return;
      await refresh(true);
    } catch (error) {
      failed(error);
    }
  };
  const name = update.version === "packages" ? "updates are ready" : `agentv ${shown(update.version)} is ready`;
  const parts: (HTMLElement | null)[] = [
    prompt("tv updates"),
    h("h1", {}, name),
    update.omarchy ? h("p", { class: "note" }, `it comes with omarchy ${shown(update.omarchy)}, tested last night.`) : null,
    update.notes.length ? h("p", { class: "label" }, "what's new") : null,
    update.notes.length ? h("ul", { class: "notes" }, ...update.notes.map((note) => h("li", {}, h("b", {}, "+"), ` ${note}`))) : null,
  ];
  if (update.installing) {
    parts.push(h("p", { class: "note" }, "it's installing now. the tv shows how it's going."));
  } else {
    parts.push(
      update.tonight ? h("p", { class: "note" }, "it installs tonight, between 2 and 5.") : null,
      update.tonight
        ? h("button", { class: "button", type: "button", "data-action": "not-tonight", onclick: () => void act("", "/api/phone/updates/tonight", { version: null }) }, "not tonight")
        : iconButton("clock", "install tonight", { class: "button primary", "data-action": "tonight", onclick: () => void act("installing tonight", "/api/phone/updates/tonight", { version: update.version }, true) }, 20),
      iconButton(
        "download",
        state?.pin.set ? "install now with pin" : "install now",
        { class: "button", "data-action": "install", onclick: () => void act("installing the update", "/api/phone/updates/install", undefined, true) },
        20,
      ),
      h(
        "button",
        {
          class: "button",
          type: "button",
          "data-action": "later",
          onclick: () =>
            void act("", "/api/phone/updates/later").then(() => {
              mode = "remote";
              draw();
            }),
        },
        "later",
      ),
    );
  }
  return h("div", { class: "typing" }, ...parts.filter((part): part is HTMLElement => part !== null));
}

// --- The page ---------------------------------------------------------------------

function draw(): void {
  if (!state) return;
  const tabs = h(
    "div",
    { class: "tabs" },
    ...([
      ["remote", "remote"],
      ["type", "keyboard"],
      ["home", "grid"],
    ] as const).map(([m, icon]) =>
      iconButton(
        icon,
        m,
        {
          class: `tab${m === mode ? " on" : ""}`,
          "data-mode": m,
          onclick: () => {
            mode = m;
            draw();
          },
        },
        16,
      ),
    ),
  );
  const banners: HTMLElement[] = [];
  if (state.pin.locked) {
    banners.push(
      h(
        "button",
        {
          type: "button",
          class: "banner",
          "data-action": "unlock",
          onclick: () =>
            void askPin("unlocking the tv").then(async (grant) => {
              if (grant !== null) await refresh(true);
            }),
        },
        glyph("lock", 18),
        h("span", {}, "the tv is locked · unlock ›"),
      ),
    );
  }
  if (state.update && !state.update.later && mode !== "update") {
    const label = state.update.version === "packages" ? "updates are ready ›" : `agentv ${shown(state.update.version)} is ready ›`;
    banners.push(
      h(
        "button",
        {
          type: "button",
          class: "banner",
          "data-action": "update",
          onclick: () => {
            mode = "update";
            draw();
          },
        },
        glyph("download", 18),
        h("span", {}, label),
      ),
    );
  }
  const body = h("div", {});
  if (mode === "home") void arrange(body);
  else if (mode === "who") body.append(who());
  else if (mode === "update" && state.update) body.append(updatePage(state.update));
  else body.append(mode === "type" ? typing() : remote());
  const viewer = h(
    "button",
    {
      type: "button",
      class: "who",
      "data-action": "who",
      onclick: () => {
        mode = "who";
        draw();
      },
    },
    avatar(state.viewer),
    state.viewer.name,
  );
  app.replaceChildren(h("div", { class: "page" }, h("div", { class: "top" }, viewer, tabs), ...banners, body));
}

// Who's watching, the lock, a sign-in and an update, asked again every few
// seconds while the page shows. The page is drawn again when one changes,
// unless something is being typed or home is being arranged.
async function refresh(force = false): Promise<void> {
  let next: State;
  try {
    next = await api<State>("GET", "/api/phone/state");
  } catch (error) {
    if (error instanceof Unpaired) failed(error);
    return;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  state = next;
  const typingNow = document.activeElement instanceof HTMLInputElement;
  if (force || (changed && !typingNow && mode !== "home")) draw();
}

async function start(): Promise<void> {
  await refresh(true);
  if (!state) pairView();
}

async function main(): Promise<void> {
  // A code from the TV's QR code pairs this phone, once.
  const code = new URLSearchParams(location.search).get("code");
  if (code) {
    history.replaceState(null, "", "/");
    if (!token()) await pair(code);
    else {
      try {
        await api("GET", "/api/phone/state");
      } catch (error) {
        if (error instanceof Unpaired) {
          keep(null);
          await pair(code);
        }
      }
    }
  }
  if (!token()) return pairView();
  await start();
  setInterval(() => {
    if (document.visibilityState === "visible" && token() && state) void refresh();
  }, 2500);
}

void main();
