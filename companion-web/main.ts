// AgenTV's phone companion (ADR-008, ADR-023, ADR-032, ADR-037, stage 4): the
// page a phone opens from the TV's QR code, on the same network. It pairs
// with the code the TV shows and keeps the key it and the box agree on. Then it's:
// - a remote: a d-pad, Back, Home, play or pause and Settings;
// - a keyboard: what's typed in its text box goes to the TV, the phone
//   keyboard's dictation too, and on AgenTV's sign-in screen, a name and a
//   password the phone's password manager can fill;
// - playback while something plays, and a trackpad for Omarchy's desktop;
// - who's watching, arrange home, the update notice with Install tonight,
//   and the adult PIN, which also unlocks the TV;
// - Share → TV: a photo from the phone for the TV's background (S5.3);
// - ask your TV: a sentence for the box's agent, by dictation or typing,
//   and up to three to choose from when it found more than one (ADR-023).
// It follows the TV (ADR-037): a PIN pad whenever the TV asks for the PIN,
// the keyboard for a text field, playback while something plays, the
// trackpad on the desktop, and the d-pad otherwise. Every press shows,
// clicks and buzzes where the phone allows it, and nothing zooms.
// It works in any phone's browser; the iOS app will do more.

import { glyph, type Glyph } from "../launcher/glyphs.ts";
import { arrange } from "./arrange.ts";
import { buildBanner, buildNotices, buildPage, exportBanner, type Offer, type PhoneBuild, pushBanner, pushPage } from "./builds.ts";
import { feelOn, listen as listenFeel, setFeel } from "./feel.ts";
import { pair as pairWith } from "./channel.ts";
import { api, avatar, h, paired, prompt, toast, Unpaired, type Viewer } from "./lib.ts";
import { askPin, withPin } from "./pad.ts";
import { photoPage } from "./photo.ts";
import { Remote2 } from "./remote2.ts";
import { sayAnswer, sayBox, type Said } from "./say.ts";
import { sharePage } from "./share.ts";

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

// What's on the TV (ADR-037), and the page the remote opens on for it.
interface Tv {
  view: "trackpad" | "pin" | "keyboard" | "playback" | "remote";
  pin: { title: string; for: string; digits: number; error: string | null } | null;
  field: { kind: string; label?: string; app?: string; name?: string; value?: string } | null;
  playing: boolean;
}

interface State {
  version: number;
  phone: { id: string; name: string };
  // The feature switches: remote2 is the new remote (ADR-065).
  features?: { remote2?: boolean; askbuilds?: boolean };
  // What's playing, for the new remote's card.
  nowPlaying?: { title: string; app: string; left?: number } | null;
  viewer: Viewer;
  viewers: Viewer[];
  pin: { set: boolean; locked: boolean };
  signIn: { name: string } | null;
  update: Update | null;
  tv: Tv;
  // TV setup's step, while it's on (stage 5).
  setup: { step: string; part: string; muted: boolean } | null;
  // What setup's AI step asks of the phone (ADR-023): the provider's terms
  // for an adult to accept, then the key.
  ai: Ask | null;
  // The latest notices from page apps that declared them (ADR-043), newest
  // first.
  notices?: { app: string; name: string; text: string; at: string }[];
  // An adult's builds that aren't on home yet: how each is going, and the
  // ones waiting for a yes here (ADR-043, ADR-046).
  builds?: PhoneBuild[];
  // An app the TV offered for Export, to save here (ADR-045).
  export?: Offer | null;
  // The last sentence said to the TV, and what came of it (ADR-023).
  said?: Said | null;
}

interface Ask {
  ask: "terms" | "key";
  provider: string;
  path: "plan" | "key";
  name: string;
  maker: string;
  plan: string;
  terms: { id: string; name: string; url: string }[];
  summary: string;
  keyUrl: string;
}

type Mode = "remote" | "type" | "play" | "mouse" | "home" | "who" | "update" | "photo" | "share" | "build" | "push";
let state: State | null = null;
let mode: Mode = "remote";
// The build being approved, while it's open.
let approving: string | null = null;
// The photo page stays as it is while the page draws again around it, so a
// photo picked isn't lost when something changes on the TV.
let photoEl: HTMLElement | null = null;
let shareEl: HTMLElement | null = null;
// The push's page, kept while it's open so a redraw keeps what's typed.
let pushEl: HTMLElement | null = null;

// The page each thing on the TV opens. The PIN pad comes over whatever page
// is showing.
const FOLLOW: Record<Tv["view"], Mode | null> = { remote: "remote", keyboard: "type", playback: "play", trackpad: "mouse", pin: null };

// A version as people read it: no package release or build after it.
const shown = (version: string) => version.replace(/\.r\d+\.g[0-9a-f]+/, "").replace(/-\d+$/, "");

// What the phone is called on the TV's list.
function phoneName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return "iPhone";
  if (/iPad/.test(agent)) return "iPad";
  if (/Android/.test(agent)) return "Android phone";
  return "Phone";
}

// The new remote (remote2.ts), drawn when its switch is on.
const remote2 = new Remote2(app, {
  state: () => state,
  failed: (error) => failed(error),
  refresh: (force) => refresh(force),
  updatePage: () => (state?.update ? updatePage(state.update) : null),
});

// The TV said it doesn't know this phone. The phone still holds its key, so
// this is what keeps it on the pairing page, not asking, until it pairs.
let forgotten = false;

const failed = (error: unknown) => {
  if (error instanceof Unpaired) {
    // The phone keeps its key until a new pairing works: see channel.ts.
    state = null;
    forgotten = true;
    pairView();
    return;
  }
  toast((error as Error).message);
};

// --- Pairing ------------------------------------------------------------------

// With the secret from the TV's QR code, or the code typed from the TV.
async function pair(how: { secret: string } | { code: string }): Promise<boolean> {
  try {
    await pairWith(how, phoneName());
    // The phone's own time zone, for setup's location step to start from,
    // while setup is on.
    void api("POST", "/api/phone/zone", { zone: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => {});
    return true;
  } catch (error) {
    toast((error as Error).message);
    return false;
  }
}

function pairView(): void {
  const field = h("input", { class: "field code", type: "text", autocapitalize: "characters", autocomplete: "one-time-code", maxlength: "7", placeholder: "ABC123", "aria-label": "The code from your TV" }) as HTMLInputElement;
  const go = async () => {
    if (await pair({ code: field.value })) void start();
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
      h("h1", {}, "Pair with your TV"),
      h("p", { class: "note" }, "Type the code from your TV"),
      field,
      h("button", { class: "button primary", type: "button", onclick: () => void go() }, "Pair"),
    ),
  );
}

// A paired phone with nothing from the TV yet: the TV is off, restarting or
// out of reach. It says so until the first state comes, which draws the
// page in its place.
function waitView(): void {
  app.replaceChildren(h("div", { class: "page waiting" }, prompt("tv"), h("h1", {}, "waiting for the tv")));
}

// --- The remote and the keyboard ----------------------------------------------

// A key, text, or the trackpad's moves, to the TV. The press itself already
// showed, clicked and buzzed (feel.ts).
async function send(event: Record<string, unknown>): Promise<void> {
  try {
    await api("POST", "/api/phone/remote", event);
  } catch (error) {
    failed(error);
  }
}

// A button with an icon, and a word beside it when there's room.
function iconButton(icon: Glyph, label: string, props: Record<string, unknown>, size = 24): HTMLButtonElement {
  return h("button", { type: "button", ...props }, glyph(icon, size), label ? h("span", {}, label) : null);
}

function key(name: string, icon: Glyph | null, label: string, extra = "", aria = name.replace(/^./, (first) => first.toUpperCase())): HTMLButtonElement {
  return icon
    ? iconButton(icon, label, { class: `pad-key ${extra}`, "aria-label": aria, "data-key": name, onclick: () => void send({ key: name }) }, label ? 24 : 36)
    : h("button", { class: `pad-key ${extra}`, type: "button", "aria-label": aria, "data-key": name, onclick: () => void send({ key: name }) }, label);
}

// Settings on the TV (ADR-037), beside Back and Home. Not on a child's
// profile.
function settingsKey(): HTMLButtonElement | null {
  if (state?.viewer.role !== "adult") return null;
  return iconButton("settings", "", {
    class: "pad-key wide",
    "aria-label": "Settings",
    "data-action": "settings",
    onclick: () => void api("POST", "/api/phone/settings").catch(failed),
  }, 28);
}

// The switch for the click and the buzz.
function feelSwitch(): HTMLElement {
  const button = h(
    "button",
    {
      type: "button",
      class: "feel",
      "data-action": "feel",
      onclick: () => {
        setFeel(!feelOn());
        button.querySelector(".feel-value")!.textContent = feelOn() ? "On" : "Off";
      },
    },
    h("span", {}, "Click and buzz on each press"),
    h("span", { class: "feel-value" }, feelOn() ? "On" : "Off"),
  );
  return button;
}

// Ask the TV (ADR-023), over the remote and playback. Once a sentence is
// answered the page is drawn again, as for any change: only the answer
// while the box already holds the next one.
const sayDone = () => void refresh();
const asking = () => sayBox(state?.said, failed, sayDone);

function remote(): HTMLElement {
  return h(
    "div",
    { class: "remote" },
    asking(),
    h(
      "div",
      { class: "dpad" },
      h("span", {}),
      key("up", "up", ""),
      h("span", {}),
      key("left", "left", ""),
      key("enter", null, "OK", "ok", "OK"),
      key("right", "right", ""),
      h("span", {}),
      key("down", "down", ""),
      h("span", {}),
    ),
    h("div", { class: "row" }, key("back", "back", "Back", "wide"), key("home", "home", "Home", "wide"), key("playpause", "play-pause", "", "wide", "Play or pause"), settingsKey()),
    feelSwitch(),
  );
}

// While something plays on the TV: play or pause, next, and Back.
function playback(): HTMLElement {
  return h(
    "div",
    { class: "remote" },
    asking(),
    h("p", { class: "label" }, "Playing on your TV"),
    h("div", { class: "row play" }, key("playpause", "play-pause", "", "big", "Play or pause"), key("next", "next", "", "big", "Next")),
    h("div", { class: "row" }, key("back", "back", "Back", "wide"), key("home", "home", "Home", "wide"), settingsKey()),
    feelSwitch(),
  );
}

// Omarchy's desktop (ADR-008): drag to move the pointer, tap to click, and
// buttons for a right click and scrolling.
function trackpad(): HTMLElement {
  const area = h("div", { class: "trackpad", role: "application", "aria-label": "Trackpad", "data-action": "trackpad" });
  let last: { x: number; y: number } | null = null;
  let travelled = 0;
  let downAt = 0;
  let owed = [0, 0];
  let flushing = 0;
  const flush = () => {
    flushing = 0;
    const [dx, dy] = owed.map(Math.round);
    owed = [0, 0];
    if (dx || dy) void send({ move: [dx, dy] });
  };
  area.addEventListener("pointerdown", (event) => {
    area.setPointerCapture(event.pointerId);
    last = { x: event.clientX, y: event.clientY };
    travelled = 0;
    downAt = Date.now();
  });
  area.addEventListener("pointermove", (event) => {
    if (!last) return;
    // Twice the finger's way, so a phone's width crosses the TV.
    const dx = (event.clientX - last.x) * 2;
    const dy = (event.clientY - last.y) * 2;
    last = { x: event.clientX, y: event.clientY };
    travelled += Math.abs(dx) + Math.abs(dy);
    owed = [owed[0] + dx, owed[1] + dy];
    flushing ||= window.setTimeout(flush, 30);
  });
  const end = () => {
    if (last && travelled < 12 && Date.now() - downAt < 250) void send({ click: "left" });
    last = null;
    flush();
  };
  area.addEventListener("pointerup", end);
  area.addEventListener("pointercancel", () => {
    last = null;
  });
  const button = (label: string, action: string, event: Record<string, unknown>) =>
    h("button", { type: "button", class: "pad-key wide", "data-action": action, onclick: () => void send(event) }, label);
  return h(
    "div",
    { class: "remote" },
    area,
    h("div", { class: "row" }, button("Click", "click", { click: "left" }), button("Right click", "right-click", { click: "right" })),
    h("div", { class: "row" }, button("Scroll up", "scroll-up", { scroll: 3 }), button("Scroll down", "scroll-down", { scroll: -3 })),
  );
}

// The TV asks for the adult PIN (ADR-037): a pad here, whose digits go to the
// TV's pad, which shows a dot for each and checks it. The boxes here fill as
// the TV's do.
function tvPad(pin: NonNullable<Tv["pin"]>): HTMLElement {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "delete", "0", "ok"];
  const boxes = Array.from({ length: 4 }, (_, i) => h("span", { class: `pin-box${i < pin.digits ? " filled" : ""}` }));
  const note = h("p", { class: `note${pin.error ? " bad" : ""}` }, pin.error || pin.for);
  const press = (k: string) => {
    if (k === "delete") void send({ key: "backspace" });
    // The TV's pad checks the PIN at its fourth digit; OK only says so.
    else if (k === "ok") {
      if (pin.digits < 4) {
        note.textContent = "4 digits";
        note.classList.add("bad");
      }
    } else void send({ key: k });
  };
  return h(
    "div",
    { class: "overlay", id: "tv-pin", role: "dialog", "aria-label": "Adult PIN" },
    h(
      "div",
      { class: "page" },
      prompt("tv pin"),
      h("h1", {}, pin.title),
      note,
      h("div", { class: "pin-boxes" }, ...boxes),
      h(
        "div",
        { class: "pin-keys" },
        ...keys.map((k) =>
          k === "delete"
            ? h("button", { type: "button", class: "pin-key pin-delete", "aria-label": "Delete", "data-pin": "delete", onclick: () => press(k) }, glyph("backspace", 28))
            : h("button", { type: "button", class: `pin-key${k === "ok" ? " pin-ok" : ""}`, "data-pin": k, onclick: () => press(k) }, k === "ok" ? "OK" : k),
        ),
      ),
      h("button", { type: "button", class: "button", "data-action": "back", onclick: () => void send({ key: "back" }) }, "Back"),
    ),
  );
}

// Setup's AI step (ADR-023): the provider's terms, with a summary and a link
// to each, for an adult to read and accept here before anything of it
// installs. The TV keeps who accepted, on which phone, and when.
function termsPage(ask: Ask): HTMLElement {
  const accept = async () => {
    try {
      const done = await withPin("accepting the terms", (grant) => api("POST", "/api/phone/terms", { provider: ask.provider, path: ask.path }, grant));
      if (done === null) return;
      toast("Accepted. Back to your TV.", true);
      await refresh(true);
    } catch (error) {
      failed(error);
    }
  };
  return h(
    "div",
    { class: "page" },
    prompt("tv setup · ai"),
    h("h1", {}, `${ask.name} terms`),
    h("p", { class: "note" }, ask.summary),
    h("ul", { class: "terms" }, ...ask.terms.map((t) => h("li", {}, h("a", { href: t.url, target: "_blank", rel: "noopener noreferrer", "data-terms": t.id }, t.name)))),
    h("button", { class: "button primary", type: "button", "data-action": "accept", onclick: () => void accept() }, glyph("check", 20), h("span", {}, "I accept")),
    h("p", { class: "note" }, `You accept as ${state?.viewer.name ?? "an adult"}. Your TV notes who, when and on which phone.`),
  );
}

// The key (board 05): pasted here, kept where only root can read it, and
// never shown again.
function keyPage(ask: Ask): HTMLElement {
  const field = h("input", { class: "field", id: "api-key", type: "password", autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "Paste your key" }) as HTMLInputElement;
  const save = async () => {
    if (!field.value) return;
    const key = field.value;
    field.value = "";
    try {
      const done = await withPin("saving your key", (grant) => api("POST", "/api/phone/key", { key }, grant));
      if (done === null) return;
      toast("Key saved", true);
      await refresh(true);
    } catch (error) {
      failed(error);
    }
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void save();
  });
  // Pasting from a button needs a secure page, which a box on the home
  // network isn't; the field takes a long-press paste either way.
  const clipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
  const paste = window.isSecureContext && clipboard?.readText
    ? h("button", { class: "button", type: "button", "data-action": "paste", onclick: () => void clipboard.readText().then((text) => (field.value = text.trim()), () => {}) }, "Paste")
    : null;
  return h(
    "div",
    { class: "page" },
    prompt("tv setup · ai"),
    h("h1", {}, `${ask.name} API key`),
    h("p", { class: "note" }, "It stays on your TV"),
    h("label", { for: "api-key", class: "label" }, "Key"),
    h("div", { class: "key-row" }, field, paste),
    h("a", { href: ask.keyUrl, target: "_blank", rel: "noopener noreferrer", class: "link" }, "Get a key"),
    h("div", { class: "limits" }, h("b", {}, "Spending limits"), h("span", {}, "$5 an app, $20 a month")),
    h("button", { class: "button primary", type: "button", "data-action": "save-key", onclick: () => void save() }, glyph("lock", 20), h("span", {}, "Save")),
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
    h("p", { class: "label" }, `Signing in to ${name} on your TV`),
    h("label", { for: "username", class: "label" }, "Email or name"),
    user,
    h("label", { for: "password", class: "label" }, "Password"),
    pass,
    h("button", { class: "button primary", type: "submit", "data-action": "sign-in" }, glyph("lock", 20), h("span", {}, "Sign in")),
    h("p", { class: "note" }, "Your password manager can fill these. AgenTV never saves them."),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = { username: user.value, password: pass.value };
    pass.value = "";
    void api("POST", "/api/phone/sign-in", body).then(
      () => toast("Sent", true),
      (error) => failed(error),
    );
  });
  return form;
}

// The phone's keyboard opens for the TV's field: digits first for a number.
function typing(): HTMLElement {
  if (state?.signIn) return signIn(state.signIn.name);
  const kind = state?.tv.field?.kind ?? "text";
  const field = h("input", {
    class: "field",
    id: "tv-text",
    type: kind === "password" || kind === "email" || kind === "url" ? kind : "text",
    inputmode: kind === "number" ? "numeric" : kind === "email" ? "email" : kind === "url" ? "url" : kind === "search" ? "search" : "text",
    autocomplete: kind === "password" ? "current-password" : "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: kind === "number" ? "Type a number" : "Type or dictate",
  }) as HTMLInputElement;
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
    h("label", { for: "tv-text", class: "label" }, "Typing on TV"),
    field,
    iconButton("tv", "Send to TV", { class: "button primary", "data-action": "send", onclick: () => void go() }, 20),
    h(
      "div",
      { class: "row" },
      iconButton("backspace", "", { class: "pad-key wide", "aria-label": "Delete", "data-key": "backspace", onclick: () => void send({ key: "backspace" }) }, 28),
      iconButton("enter", "", { class: "pad-key wide", "aria-label": "Enter", "data-key": "enter", onclick: () => void send({ key: "enter" }) }, 28),
    ),
    h("p", { class: "note with-icon" }, glyph("mic", 16), h("span", {}, "Your keyboard's microphone works here too")),
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
    prompt("tv who"),
    h("h1", {}, "Who's watching?"),
    ...(state?.viewers ?? []).map((viewer) =>
      h(
        "button",
        { type: "button", class: `viewer${viewer.id === state?.viewer.id ? " on" : ""}`, "data-viewer": viewer.id, onclick: () => void watch(viewer) },
        avatar(viewer),
        h("span", {}, viewer.name),
        viewer.locked ? glyph("lock", 18) : null,
        h("span", { class: "viewer-role" }, [viewer.role === "child" ? "Child" : "", viewer.id === state?.viewer.id ? "Watching" : ""].filter(Boolean).join(" · ")),
      ),
    ),
    // With no PIN, a switch needs nothing, so nothing says it does (ADR-087).
    state?.pin.set ? h("p", { class: "note" }, "Adult and locked profiles need the PIN") : null,
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
  const name = update.version === "packages" ? "Update ready" : `AgenTV ${shown(update.version)} is ready`;
  const parts: (HTMLElement | null)[] = [
    prompt("tv updates"),
    h("h1", {}, name),
    update.omarchy ? h("p", { class: "note" }, `Includes Omarchy ${shown(update.omarchy)}`) : null,
    update.notes.length ? h("p", { class: "label" }, "What's new") : null,
    update.notes.length ? h("ul", { class: "notes" }, ...update.notes.map((note) => h("li", {}, h("b", {}, "+"), ` ${note}`))) : null,
  ];
  if (update.installing) {
    parts.push(h("p", { class: "note" }, "Installing now. Watch it on your TV."));
  } else {
    parts.push(
      update.tonight ? h("p", { class: "note" }, "It installs tonight between 2 and 5") : null,
      update.tonight
        ? h("button", { class: "button", type: "button", "data-action": "not-tonight", onclick: () => void act("", "/api/phone/updates/tonight", { version: null }) }, "Not tonight")
        : iconButton("clock", "Install tonight", { class: "button primary", "data-action": "tonight", onclick: () => void act("installing tonight", "/api/phone/updates/tonight", { version: update.version }, true) }, 20),
      iconButton(
        "download",
        "Install now",
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
        "Later",
      ),
    );
  }
  return h("div", { class: "typing" }, ...parts.filter((part): part is HTMLElement => part !== null));
}

// --- The page ---------------------------------------------------------------------

function draw(): void {
  if (!state) return;
  if (state.features?.remote2) {
    remote2.draw(true);
    drawAsk();
    drawPad();
    return;
  }
  document.getElementById("r2-sheet")?.remove();
  const tabs = h(
    "div",
    { class: "tabs" },
    ...([
      ["remote", "remote", "Remote"],
      ["type", "keyboard", "Type"],
      ["play", "play-pause", "Play"],
      ["mouse", "pointer", "Mouse"],
      ["home", "grid", "Home"],
    ] as const).map(([m, icon, label]) =>
      iconButton(
        icon,
        label,
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
  // During TV setup, where the TV is: the remote and the keyboard drive it.
  if (state.setup) {
    banners.push(h("p", { class: "note with-icon setup-step", "data-setup": state.setup.step }, glyph("tv", 16), h("span", {}, `TV setup · ${state.setup.part}`)));
  }
  // The setup soundtrack, muted from here or playing again (S5.4).
  if (state.setup) {
    const muted = state.setup.muted;
    banners.push(
      h(
        "button",
        {
          type: "button",
          class: "banner",
          "data-action": "setup-music",
          onclick: () =>
            void api("POST", "/api/phone/setup-music", { muted: !muted }).then(
              () => refresh(true),
              (error) => failed(error),
            ),
        },
        glyph("music", 18),
        h("span", {}, muted ? "Play setup music" : "Mute setup music"),
      ),
    );
  }
  // Setup's background: a photo from here.
  if (state.setup?.step === "background" && mode !== "photo") {
    banners.push(
      h(
        "button",
        {
          type: "button",
          class: "banner",
          "data-action": "photo",
          onclick: () => {
            mode = "photo";
            draw();
          },
        },
        glyph("photo", 18),
        h("span", {}, "Send a photo for the background"),
      ),
    );
  }
  if (state.pin.locked) {
    banners.push(
      h(
        "button",
        {
          type: "button",
          class: "banner",
          "data-action": "unlock",
          onclick: () =>
            void askPin("unlocking your TV").then(async (grant) => {
              if (grant !== null) await refresh(true);
            }),
        },
        glyph("lock", 18),
        h("span", {}, "Unlock your TV"),
      ),
    );
  }
  if (state.update && !state.update.later && mode !== "update") {
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
        h("span", {}, "Update ready"),
      ),
    );
  }
  // An app the TV offered for Export, to save here, or to push to GitHub.
  const saving = exportBanner(state.export, failed);
  if (saving) banners.push(saving);
  if (mode === "push" && !state.export?.github) mode = "remote";
  if (mode !== "push") pushEl = null;
  const pushing =
    mode === "push"
      ? null
      : pushBanner(state.export, () => {
          mode = "push";
          draw();
        });
  if (pushing) banners.push(pushing);
  // Your agent's build: the one waiting for a yes, or how the newest is going.
  if (mode !== "build") {
    const building = buildBanner(state.builds, (build) => {
      mode = "build";
      approving = build;
      draw();
    });
    if (building) banners.push(building);
  }
  const body = h("div", {});
  if (mode === "build" && approving) {
    body.append(
      buildPage(
        approving,
        () => {
          mode = "remote";
          approving = null;
          draw();
        },
        failed,
        () => refresh(true),
      ),
    );
  } else if (mode === "home") {
    void arrange(body).then(() =>
      body.append(
        h(
          "button",
          {
            type: "button",
            class: "button",
            "data-action": "photo",
            onclick: () => {
              mode = "photo";
              draw();
            },
          },
          glyph("photo", 18),
          h("span", {}, "Send a photo for the background"),
        ),
        // A link, a photo or a video for the TV to open (ADR-050).
        h(
          "button",
          {
            type: "button",
            class: "button",
            "data-action": "share",
            onclick: () => {
              mode = "share";
              draw();
            },
          },
          glyph("tv", 18),
          h("span", {}, "Send a link, photo or video"),
        ),
      ),
    );
  } else if (mode === "push" && state.export?.github) {
    pushEl ??= h(
      "div",
      {},
      ...pushPage(
        { ...state.export, github: state.export.github },
        () => {
          mode = "remote";
          draw();
        },
        failed,
      ),
    );
    body.append(pushEl);
  } else if (mode === "photo") body.append((photoEl ??= photoPage(failed)));
  else if (mode === "share") body.append((shareEl ??= sharePage(failed)));
  else if (mode === "who") body.append(who());
  else if (mode === "update" && state.update) body.append(updatePage(state.update));
  else if (mode === "type") body.append(typing());
  else if (mode === "play") body.append(playback());
  else if (mode === "mouse") body.append(trackpad());
  else body.append(remote());
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
  drawAsk();
  drawPad();
}

// The TV's PIN pad, over whatever's showing while the TV asks, and setup's
// AI step under it.
function drawPad(): void {
  document.getElementById("tv-pin")?.remove();
  if (state?.tv.pin) document.body.append(tvPad(state.tv.pin));
}

// What setup's AI step asks, over the remote while it does. Not drawn again
// while its field is being typed in.
let asked = "";
function drawAsk(): void {
  const now = state?.ai ? JSON.stringify(state.ai) : "";
  if (now === asked && document.getElementById("tv-ask")) return;
  asked = now;
  document.getElementById("tv-ask")?.remove();
  const ask = state?.ai;
  if (!ask) return;
  const page = ask.ask === "terms" ? termsPage(ask) : keyPage(ask);
  page.classList.add("ask");
  document.body.append(h("div", { class: "overlay", id: "tv-ask", role: "dialog", "aria-label": ask.ask === "terms" ? `${ask.name}'s terms` : `${ask.name} API key` }, page));
}

// Who's watching, the lock, a sign-in, an update and what's on the TV. With
// wait, the box answers when something changes, or after 25 s.
//
// When what's on the TV changes, the remote opens the page for it, unless
// home is being arranged or who's watching or the update is open; the PIN
// pad comes over anything. Otherwise the page is drawn again when something
// changed, unless something is being typed or home is being arranged.
async function refresh(force = false, wait = false): Promise<void> {
  let next: State;
  try {
    next = await api<State>("GET", wait && state ? `/api/phone/state?since=${state.version}` : "/api/phone/state");
  } catch (error) {
    if (error instanceof Unpaired) failed(error);
    if (wait) await new Promise((resolve) => setTimeout(resolve, 2000));
    return;
  }
  const before = state;
  state = next;
  try {
    took(next, before, force);
  } catch (error) {
    // A state that couldn't be drawn isn't kept: the next ask is for what
    // changed since the last one that could.
    state = before;
    throw error;
  }
}

function took(next: State, before: State | null, force: boolean): void {
  const { version: _then, ...was } = before ?? ({} as State);
  const { version: _now, ...now } = next;
  const changed = JSON.stringify(now) !== JSON.stringify(was);
  // A build that moved on says so here as it does on the TV.
  buildNotices(before?.builds, next.builds);
  // A page app's new notice shows here as it does on the TV.
  const notice = next.notices?.[0];
  if (before && notice && notice.at !== before.notices?.[0]?.at) toast(`${notice.name}: ${notice.text}`, true);
  // The new remote follows the TV from the first state on, and draws again
  // only what changed under a field being typed in.
  if (next.features?.remote2) {
    if (!before?.features?.remote2) remote2.draw(true);
    else remote2.draw(force);
    if (JSON.stringify(next.ai) !== JSON.stringify(before?.ai)) drawAsk();
    if (JSON.stringify(next.tv.pin) !== JSON.stringify(before?.tv.pin)) drawPad();
    return;
  }
  if (before?.features?.remote2) {
    draw();
    return;
  }
  const moved = before !== null && next.tv.view !== before.tv.view;
  const follow = FOLLOW[next.tv.view];
  if (moved && follow && (mode === "remote" || mode === "type" || mode === "play" || mode === "mouse")) {
    mode = follow;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    draw();
    return;
  }
  const typingNow = document.activeElement instanceof HTMLInputElement;
  if (force || (changed && !typingNow && mode !== "home")) draw();
  else {
    if (JSON.stringify(next.ai) !== JSON.stringify(before?.ai)) drawAsk();
    if (JSON.stringify(next.tv.pin) !== JSON.stringify(before?.tv.pin)) drawPad();
    if (JSON.stringify(next.said) !== JSON.stringify(before?.said)) sayAnswer(next.said, failed, sayDone);
  }
}

// Asks the box over and over, each ask waiting for the next change, while
// the page shows.
async function follow(): Promise<void> {
  for (;;) {
    try {
      // With no state yet, the first ask got no answer: this asks again.
      if (document.visibilityState === "visible" && paired() && !forgotten) await refresh(!state, true);
      else await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch {
      // One answer that couldn't be drawn doesn't stop the next from coming.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// The first state, and the page following the TV from then on, whichever way
// the phone got paired: the QR code, or the code typed on the pairing page.
// A paired phone follows even when that first ask got no answer, as while
// the TV restarts: its code is spent, so the pairing page would be a dead
// end. The pairing page is only for a phone the TV says it doesn't know.
let following = false;
async function start(): Promise<void> {
  forgotten = false;
  if (!state) waitView();
  await refresh(true);
  if (following) return;
  following = true;
  void follow();
}

async function main(): Promise<void> {
  // The secret in the TV's QR code pairs this phone, once. It comes after
  // the # in the address, which the browser keeps to itself.
  const secret = new URLSearchParams(location.hash.slice(1)).get("pair");
  const how = secret ? { secret } : null;
  if (how) {
    history.replaceState(null, "", "/");
    if (!paired()) await pair(how);
    else {
      try {
        await api("GET", "/api/phone/state");
      } catch (error) {
        if (error instanceof Unpaired) await pair(how);
      }
    }
  }
  if (!paired()) return pairView();
  await start();
}

listenFeel();

void main();
