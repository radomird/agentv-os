// AgenTV's phone companion (ADR-008, ADR-023, stage 4): the page a phone
// opens from the TV's QR code, on the same network. It pairs with the code
// the TV shows, keeps the token the box gives it, and is then a remote for
// the TV, with a d-pad, Back, Home and play or pause, and a keyboard: what's
// typed in its text box goes to the TV, the phone keyboard's dictation too.
// It works in any phone's browser; the iOS app will do more.

const TOKEN = "agentv-phone-token";
const app = document.getElementById("app")!;

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function token(): string | null {
  try {
    return localStorage.getItem(TOKEN);
  } catch {
    return null;
  }
}

function keep(value: string | null): void {
  try {
    if (value) localStorage.setItem(TOKEN, value);
    else localStorage.removeItem(TOKEN);
  } catch {
    // A private window keeps it only while the page is open.
  }
}

let toastTimer = 0;
function toast(text: string): void {
  const el = document.getElementById("toast")!;
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("on"), 3000);
}

class Unpaired extends Error {}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Unpaired(data.error ?? "this phone isn't paired");
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "the tv didn't answer");
  return data as T;
}

// What the phone is called on the TV's list.
function phoneName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return "iphone";
  if (/iPad/.test(agent)) return "ipad";
  if (/Android/.test(agent)) return "android phone";
  return "phone";
}

interface Viewer {
  id: string;
  name: string;
  role: "adult" | "kid";
  avatar: string;
}

function avatar(viewer: Viewer): HTMLElement {
  return h("span", { class: `avatar avatar-${viewer.avatar}` }, viewer.name.slice(0, 1).toLowerCase());
}

// --- Pairing ------------------------------------------------------------------

async function pair(code: string): Promise<boolean> {
  try {
    const reply = await api<{ token: string }>("POST", "/api/phone/pair", { code, name: phoneName() });
    keep(reply.token);
    return true;
  } catch (error) {
    toast(`${(error as Error).message}.`);
    return false;
  }
}

function pairView(): void {
  const field = h("input", { class: "field code", type: "text", inputmode: "text", autocapitalize: "characters", autocomplete: "one-time-code", maxlength: "7", placeholder: "ABC123", "aria-label": "the code on the tv" }) as HTMLInputElement;
  const go = async () => {
    if (await pair(field.value)) void main();
  };
  app.replaceChildren(
    h(
      "div",
      { class: "page" },
      h("div", { class: "prompt" }, h("b", {}, "~"), " $ tv pair"),
      h("h1", {}, "pair with the tv"),
      h("p", { class: "note" }, "type the code on the tv. it's in settings → phones → pair a phone."),
      field,
      h("button", { class: "button primary", type: "button", onclick: () => void go() }, "pair"),
    ),
  );
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void go();
  });
}

// --- The remote and the keyboard ----------------------------------------------

async function send(event: Record<string, unknown>): Promise<void> {
  try {
    await api("POST", "/api/phone/remote", event);
    navigator.vibrate?.(8);
  } catch (error) {
    if (error instanceof Unpaired) {
      keep(null);
      pairView();
      return;
    }
    toast(`${(error as Error).message}.`);
  }
}

function remote(): HTMLElement {
  const key = (name: string, label: string, extra = "") =>
    h("button", { class: `pad-key ${extra}`, type: "button", "aria-label": name, "data-key": name, onclick: () => void send({ key: name }) }, label);
  return h(
    "div",
    { class: "remote" },
    h("div", { class: "dpad" }, h("span", {}), key("up", "▲"), h("span", {}), key("left", "◀"), key("enter", "ok", "ok"), key("right", "▶"), h("span", {}), key("down", "▼"), h("span", {})),
    h("div", { class: "row" }, key("back", "back", "wide"), key("home", "home", "wide"), key("playpause", "⏯", "wide")),
  );
}

function typing(): HTMLElement {
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
    h("button", { class: "button primary", type: "button", "data-action": "send", onclick: () => void go() }, "send to tv"),
    h("div", { class: "row" }, h("button", { class: "pad-key wide", type: "button", "data-key": "backspace", onclick: () => void send({ key: "backspace" }) }, "⌫"), h("button", { class: "pad-key wide", type: "button", "data-key": "enter", onclick: () => void send({ key: "enter" }) }, "↵")),
    h("p", { class: "note" }, "the keyboard's microphone works here too."),
  );
}

async function main(): Promise<void> {
  // A code from the TV's QR code pairs this phone, once.
  const code = new URLSearchParams(location.search).get("code");
  if (code) {
    history.replaceState(null, "", "/");
    if (!token() || !(await stateOrNull())) await pair(code);
  }
  if (!token()) return pairView();
  const state = await stateOrNull();
  if (!state) return pairView();
  let mode: "remote" | "type" = "remote";
  const body = h("div", {});
  const tabs = h("div", { class: "tabs" });
  const draw = () => {
    tabs.replaceChildren(
      ...(["remote", "type"] as const).map((m) => h("button", { type: "button", class: `tab${m === mode ? " on" : ""}`, "data-mode": m, onclick: () => ((mode = m), draw()) }, m)),
    );
    body.replaceChildren(mode === "remote" ? remote() : typing());
  };
  draw();
  app.replaceChildren(h("div", { class: "page" }, h("div", { class: "top" }, h("span", { class: "who" }, avatar(state.viewer), state.viewer.name), tabs), body));
}

async function stateOrNull(): Promise<{ viewer: Viewer } | null> {
  try {
    return await api<{ viewer: Viewer }>("GET", "/api/phone/state");
  } catch (error) {
    if (error instanceof Unpaired) keep(null);
    else toast(`${(error as Error).message}.`);
    return null;
  }
}

void main();
