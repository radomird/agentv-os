// The notice a TV that lost its network shows (ADR-084): the hotspot is
// open again, and home shows its QR code with one headline and one line. A
// phone that scans it joins the hotspot and gets the page that picks a
// Wi-Fi, as in setup. It takes no keys and no focus, and goes when the TV is
// back online. It's on home only, where nothing is under it: over Settings
// or Apps it would cover what's there, and Settings, network says "Offline"
// itself. The card is a toast to each look, so it's drawn as theirs are.

import { h } from "./dom.ts";

export interface OfflineHotspot {
  ssid: string;
  // The last pick from the phone didn't work.
  problem: boolean;
}

let el: HTMLElement | null = null;
let shown: OfflineHotspot | null = null;

function draw(): void {
  if (!shown) {
    el?.remove();
    el = null;
    return;
  }
  const card = h(
    "div",
    { class: "toast offline", id: "offline", "data-ssid": shown.ssid },
    h("span", { class: "pair-qr" }, h("img", { src: `/api/hotspot/qr?${encodeURIComponent(shown.ssid)}`, alt: "" })),
    h(
      "div",
      { class: "offline-text" },
      h("div", { class: "offline-title" }, "Your TV is offline"),
      h("div", { class: "offline-line" }, shown.problem ? "Couldn't join. Scan to try again." : "Scan to pick your Wi-Fi"),
    ),
  );
  if (el) el.replaceWith(card);
  else document.body.append(card);
  el = card;
}

// The hotspot as the daemon has it, or null once it's closed.
export function showOffline(hotspot: OfflineHotspot | null): void {
  const next = hotspot ? { ssid: hotspot.ssid, problem: hotspot.problem === true } : null;
  if (JSON.stringify(next) === JSON.stringify(shown) && Boolean(el) === Boolean(next)) return;
  shown = next;
  draw();
}
