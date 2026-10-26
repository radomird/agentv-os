// The setup hotspot's captive page (ADR-007, stage 4): a phone that joins
// AgenTV's own Wi-Fi from the QR code on the TV opens it on its own. It lists
// the networks the box could see, takes the home Wi-Fi's password and hands
// both to the box, which joins that network and closes its own. The phone
// loses this page then and goes back to the home Wi-Fi, where the TV shows a
// code to pair it with. If the password was wrong, the hotspot comes back,
// and so does the phone, to this page and the reason.

import { glyph } from "../launcher/glyphs.ts";
import { h, prompt, toast } from "./lib.ts";

const app = document.getElementById("app")!;

interface Network {
  ssid: string;
  signal: number;
  secure: boolean;
}

interface Joining {
  on: boolean;
  joining: string | null;
  error: string | null;
}

let networks: Network[] = [];
let watching = 0;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "the tv didn't answer");
  return data as T;
}

// How strong a network is, in four steps.
const bars = (signal: number) => "▂▄▆█".slice(0, Math.max(1, Math.min(4, Math.ceil(signal / 25))));

function list(note?: string): void {
  clearInterval(watching);
  const rows = networks.map((network) =>
    h(
      "button",
      { class: "viewer network", type: "button", "data-ssid": network.ssid, onclick: () => form(network) },
      glyph("wifi", 24),
      h("span", { class: "network-name" }, network.ssid),
      network.secure ? glyph("lock", 18) : null,
      h("span", { class: "viewer-role", "aria-label": `signal ${network.signal}%` }, bars(network.signal)),
    ),
  );
  app.replaceChildren(
    h(
      "div",
      { class: "page" },
      prompt("tv setup wi-fi"),
      h("h1", {}, "pick your wi-fi"),
      h("p", { class: `note${note ? " bad" : ""}` }, note ?? "the tv joins it, and your phone goes back to it after."),
      ...rows,
      h("button", { class: "button", type: "button", "data-ssid": "", onclick: () => form(null) }, glyph("plus", 20), h("span", {}, "another network")),
    ),
  );
}

// A network from the list, or one that hides its name.
function form(network: Network | null): void {
  const name = network
    ? null
    : (h("input", { class: "field", type: "text", autocapitalize: "none", autocomplete: "off", spellcheck: "false", maxlength: "32", placeholder: "its name", "aria-label": "the network's name" }) as HTMLInputElement);
  const password =
    network && !network.secure
      ? null
      : (h("input", { class: "field", type: "password", autocapitalize: "none", autocomplete: "off", spellcheck: "false", maxlength: "64", placeholder: "its password", "aria-label": "the wi-fi password" }) as HTMLInputElement);
  const join = async () => {
    const ssid = network?.ssid ?? name!.value.trim();
    const typed = password?.value ?? "";
    if (!ssid) return toast("type the network's name");
    if (password && network?.secure && typed.length < 8) return toast("a wi-fi password is at least 8 characters");
    try {
      await call("POST", "/api/setup/wifi", { ssid, password: typed });
    } catch (error) {
      return toast((error as Error).message);
    }
    joining(ssid);
  };
  for (const field of [name, password]) {
    field?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void join();
    });
  }
  app.replaceChildren(
    h(
      "div",
      { class: "page" },
      prompt("tv setup wi-fi"),
      h("h1", { class: "with-icon" }, glyph("wifi", 26), h("span", {}, network?.ssid ?? "another network")),
      h("p", { class: "note" }, "your phone leaves this network while the tv joins."),
      name,
      password,
      h("button", { class: "button primary", type: "button", "data-action": "join", onclick: () => void join() }, "join"),
      h("button", { class: "button", type: "button", onclick: () => list() }, glyph("back", 20), h("span", {}, "back")),
    ),
  );
  (name ?? password)?.focus();
}

// The box is joining it. If this page hears back, it didn't work.
function joining(ssid: string): void {
  app.replaceChildren(
    h(
      "div",
      { class: "page" },
      h("div", { class: "pair-icons" }, glyph("tv", 40), glyph("right", 24), glyph("wifi", 40)),
      prompt("tv setup wi-fi"),
      h("h1", {}, `joining ${ssid}`),
      h("p", { class: "note" }, "once it's on, go back to that wi-fi and scan the new code on the tv."),
    ),
  );
  clearInterval(watching);
  watching = window.setInterval(() => {
    call<Joining>("GET", "/api/setup/state")
      .then((state) => {
        if (state.joining || !state.error) return;
        list(state.error);
      })
      .catch(() => {
        // The hotspot is down while the tv tries.
      });
  }, 2000);
}

async function start(): Promise<void> {
  try {
    const [found, state] = await Promise.all([
      call<{ networks: Network[] }>("GET", "/api/setup/networks"),
      call<Joining>("GET", "/api/setup/state"),
    ]);
    networks = found.networks;
    if (state.joining) joining(state.joining);
    else list(state.error ?? undefined);
  } catch (error) {
    app.replaceChildren(h("div", { class: "page" }, prompt("tv setup wi-fi"), h("h1", {}, "the tv isn't answering"), h("p", { class: "note bad" }, (error as Error).message)));
  }
}

void start();
