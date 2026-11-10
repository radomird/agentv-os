// The Wi-Fi list and the fields a pick needs, the same for setup's Wi-Fi
// step (setup/welcome.ts) and Settings, network (launcher/pages/wifi.ts).
// Each says its own words. A network's name is never rewritten for a look:
// it's marked as its own, since "Home" and "home" are two networks.

import { h } from "./dom.ts";
import { glyph } from "./glyphs.ts";

export interface Listed {
  ssid: string;
  signal: number;
  secure: boolean;
  // The one the TV is on.
  current?: boolean;
}

// What was picked: a network from the list, or one that hides its name.
export interface Picked {
  ssid: string;
  secure: boolean;
  hidden: boolean;
}

// Signal bars for a network, out of four.
export function bars(signal: number): string {
  const full = Math.max(1, Math.min(4, Math.ceil(signal / 25)));
  return "▂▄▆█".slice(0, full);
}

// A row of the list: a network, or with null the row for one that hides
// its name, which says `other`.
export function networkRow(network: Listed | null, options: { other: string; class?: string; pick(picked: Picked): void }): HTMLButtonElement {
  return h(
    "button",
    {
      class: `${options.class ?? "network"}${network?.current ? " current" : ""}`,
      "data-focus": true,
      "data-ssid": network?.ssid ?? "",
      onclick: () => options.pick(network ? { ssid: network.ssid, secure: network.secure, hidden: false } : { ssid: "", secure: true, hidden: true }),
    },
    network?.current ? glyph("check", 24) : null,
    network ? h("span", { class: "network-name", "data-own-case": true }, network.ssid) : h("span", { class: "network-name" }, options.other),
    network?.secure ? glyph("lock", 24) : null,
    h("span", { class: "network-bars" }, network ? bars(network.signal) : ""),
  );
}

export interface JoinFields {
  name: HTMLInputElement | null;
  password: HTMLInputElement | null;
  go: HTMLButtonElement;
}

// The fields a pick needs and the button that joins: the name for a network
// that hides it, the password for one that has one. Enter in a field joins.
// A password field's text never leaves the TV's page: the phone's keyboard
// types into it, and the typing bar shows dots.
export function joinFields(
  picked: Picked,
  words: { name: string; password: string; join: string; placeholders?: boolean },
  join: (ssid: string, password: string) => void,
  fieldClass = "text-field",
): JoinFields {
  const field = (type: string, label: string) =>
    h("input", { class: fieldClass, type, "data-focus": true, "data-field": type === "password" ? "password" : "name", "aria-label": label, placeholder: words.placeholders ? label : undefined, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const name = picked.hidden ? field("text", words.name) : null;
  const password = picked.secure ? field("password", words.password) : null;
  const go = h("button", { class: "button primary", "data-focus": true, "data-action": "join", onclick: () => join(name ? name.value : picked.ssid, password?.value ?? "") }, words.join);
  for (const input of [name, password]) {
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        go.click();
      }
    });
  }
  return { name, password, go };
}
