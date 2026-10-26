// The welcome screen (board 02): "hi.", and a QR code for the phone. With
// the setup hotspot on, it's the hotspot's: the phone joins it, the captive
// page picks the home Wi-Fi, and the box joins that. Once the box is online,
// on that Wi-Fi or a cable, it's the code that pairs the phone. A phone that
// pairs moves setup on. Enter carries on with a keyboard instead: on to
// getting ready when the box is online, or first to the Wi-Fi it can see,
// with its password typed on the TV.

import { glyph } from "../launcher/glyphs.ts";
import { h } from "../launcher/dom.ts";
import { setup, type Network, type SetupInfo } from "./api.ts";
import { heading, hi, prompt } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

// What's going on, for the status bar.
function info(about: SetupInfo): string {
  const phone = about.phones.length ? `${about.phones[about.phones.length - 1]} paired` : "phone waiting";
  if (about.hotspot.on) return `wifi hotspot · ${phone}`;
  if (about.network.via === "ethernet") return `ethernet · ${phone}`;
  if (about.network.via === "wi-fi") return `wifi ${about.network.name ?? ""} · ${phone}`.replace("  ", " ");
  return "no network yet";
}

export function welcome(ctx: Ctx): View {
  const line = h("p", { class: "welcome-line" }, "scan the code with your phone.");
  const qr = h("img", { class: "qr", alt: "" }) as HTMLImageElement;
  const label = h("span", { class: "qr-label" });
  const frame = h(
    "div",
    { class: "qr-frame" },
    h("span", { class: "qr-corner tl" }),
    h("span", { class: "qr-corner tr" }),
    h("span", { class: "qr-corner bl" }),
    h("span", { class: "qr-corner br" }),
    h("span", { class: "qr-box" }, qr),
  );
  const right = h("div", { class: "welcome-qr away" }, frame, label);
  const enterLabel = h("span", {}, ctx.info.phones.length ? "carry on" : "use a keyboard instead");
  const enter = h(
    "button",
    { class: "enter", "data-focus": true, "data-action": "enter", onclick: () => void carryOn() },
    h("span", { class: "key" }, "↵ enter"),
    enterLabel,
  );
  const el = h("div", { class: "setup-page welcome" }, h("div", { class: "welcome-left" }, prompt("tv setup"), hi(), line, enter), right);

  let pairing: { code: string; until: number; url: string | null } | null = null;
  let paired: string | null = null;
  let stopped = false;
  let timer = 0;

  const showQr = (src: string | null, text: string) => {
    if (src) {
      if (qr.getAttribute("src") !== src) qr.setAttribute("src", src);
      right.classList.remove("away");
    } else {
      right.classList.add("away");
      qr.removeAttribute("src");
    }
    label.textContent = text;
  };

  // A code that pairs the phone, a new one shortly before it runs out.
  const pairCode = async () => {
    if (pairing && pairing.until > Date.now() + 5000) return pairing;
    const next = await setup.pair().catch(() => null);
    pairing = next ? { code: next.code, until: Date.parse(next.until), url: next.url } : null;
    return pairing;
  };

  async function draw(): Promise<void> {
    const about = await ctx.refresh().catch(() => ctx.info);
    if (stopped) return;
    // The ring follows the button when a longer line moves it.
    requestAnimationFrame(() => ctx.focus.refresh());
    ctx.status(info(about));
    const { hotspot, network } = about;
    if (paired) {
      line.textContent = `${paired} is paired.`;
      showQr(null, "");
    } else if (hotspot.on && hotspot.ssid) {
      line.textContent = hotspot.error ? `${hotspot.error}. scan the code to try again.` : "scan the code with your phone.";
      showQr(`/api/hotspot/qr?${encodeURIComponent(hotspot.ssid)}`, hotspot.password ? `wifi ${hotspot.ssid} · password ${hotspot.password}` : `wifi ${hotspot.ssid}`);
    } else if (hotspot.joining) {
      line.textContent = `joining ${hotspot.joining}.`;
      showQr(null, "");
    } else if (network.online) {
      const code = await pairCode();
      if (stopped) return;
      line.textContent = about.phones.length ? "your phone is paired. scan the code to pair another." : "scan the code with your phone to pair it.";
      showQr(code?.url ? `/api/phones/qr?${code.code}` : null, code ? `code ${code.code}` : "");
    } else {
      line.textContent = "plug in a network cable, or press enter to pick a wi-fi.";
      showQr(null, "");
    }
  }

  // Enter: on with the keyboard once the box is online, or to the Wi-Fi it
  // can see first.
  async function carryOn(): Promise<void> {
    const { network, hotspot } = await ctx.refresh().catch(() => ctx.info);
    if (network.online) await ctx.finish("welcome", { keyboard: ctx.info.phones.length === 0 });
    else if (hotspot.on) ctx.open("welcome/wifi");
    else {
      ctx.toast("plug in a network cable first", "fail");
      ctx.sounds.play("failure");
    }
  }

  void draw();
  timer = window.setInterval(() => void draw(), 2000);

  return {
    el,
    first: enter,
    bright: true,
    info: info(ctx.info),
    heard(event, data) {
      // A phone paired: it says so, and setup moves on.
      const name = event === "phones" ? (data as { paired?: string }).paired : undefined;
      if (!name || paired) return;
      paired = name;
      ctx.sounds.play("confirm");
      void draw();
      setTimeout(() => {
        if (!stopped) void ctx.finish("welcome", { keyboard: false });
      }, 1500);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// Signal bars for a network, out of four.
function bars(signal: number): string {
  const full = Math.max(1, Math.min(4, Math.ceil(signal / 25)));
  return "▂▄▆█".slice(0, full);
}

// The Wi-Fi the box saw, picked and joined from the TV with a keyboard,
// for a household with no phone at hand.
export function wifi(ctx: Ctx): View {
  const list = h("div", { class: "networks" });
  const form = h("div", { class: "network-form hidden" });
  const el = h("div", { class: "setup-page" }, ...heading("tv setup · wifi", "pick your wi-fi.", ctx.reduced()), h("div", { class: "wifi" }, list, form));
  let picked: { ssid: string; secure: boolean; hidden: boolean } | null = null;

  const join = async (ssid: string, password: string) => {
    try {
      await setup.wifi(ssid, password);
    } catch (error) {
      ctx.toast((error as Error).message, "fail");
      ctx.sounds.play("failure");
      return;
    }
    ctx.sounds.play("confirm");
    ctx.back();
  };

  const pick = (network: { ssid: string; secure: boolean; hidden: boolean }) => {
    picked = network;
    const name = network.hidden ? (h("input", { class: "text-field", type: "text", "data-focus": true, "aria-label": "the network's name", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement) : null;
    const password = network.secure ? (h("input", { class: "text-field", type: "password", "data-focus": true, "aria-label": `the password for ${network.ssid || "the network"}`, autocomplete: "off" }) as HTMLInputElement) : null;
    const go = h(
      "button",
      { class: "button primary", "data-focus": true, "data-action": "join", onclick: () => void join(name ? name.value : network.ssid, password?.value ?? "") },
      "↵ join",
    );
    for (const input of [name, password]) {
      input?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          go.click();
        }
      });
    }
    const parts: (HTMLElement | null)[] = [
      h("div", { class: "panel-title" }, network.hidden ? "another network" : network.ssid),
      name ? h("label", { class: "field-label" }, "name") : null,
      name,
      password ? h("label", { class: "field-label" }, "password") : null,
      password,
      go,
    ];
    form.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null));
    form.classList.remove("hidden");
    ctx.focus.set(name ?? password ?? go);
  };

  const row = (network: Network | null) =>
    h(
      "button",
      {
        class: "network",
        "data-focus": true,
        "data-ssid": network?.ssid ?? "",
        onclick: () => pick(network ? { ssid: network.ssid, secure: network.secure, hidden: false } : { ssid: "", secure: true, hidden: true }),
      },
      h("span", { class: "network-name" }, network?.ssid ?? "another network"),
      network?.secure ? glyph("lock", 24) : null,
      h("span", { class: "network-bars" }, network ? bars(network.signal) : ""),
    );

  void setup.networks().then(
    (networks) => {
      list.replaceChildren(...networks.map(row), row(null));
      if (!picked) ctx.focus.setRoot(el.closest(".screen") ?? el);
    },
    () => list.replaceChildren(row(null)),
  );

  return { el, info: "↑↓ move · ↵ pick · esc back" };
}
